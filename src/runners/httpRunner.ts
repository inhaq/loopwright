import { z } from "zod";
import type {
  AgentRunner,
  RunRequest,
  RunResult,
  RunnerProfile,
} from "./agentRunner.js";
import { redactAndTruncate } from "../engine/redaction.js";

/**
 * Generic, vendor-neutral runner for OpenAI-compatible chat endpoints.
 *
 * It targets the de-facto `POST {baseUrl}{path}` shape with a `messages` array
 * and a `choices[].message.content` response, which many providers and local
 * servers implement. Nothing here names a product: the endpoint, model, and
 * auth are all profile data.
 *
 *   - where to call: `baseUrl` + `path` (default `/chat/completions`)
 *   - auth without hard-coding secrets: `apiKeyEnv` names an env var holding the
 *     key (sent as `Authorization: Bearer ...`); custom `headers` values may
 *     reference `${VAR}` from the parent env too
 *   - the model comes from the profile's `model`
 *   - quota detection: HTTP status codes (default 429) and/or a body regex
 *   - a hard request timeout and bounded output capture
 *
 * The transport (`fetch`) is injectable so the runner is testable without a
 * network. Like CliRunner, transport/HTTP failures resolve to a result with
 * diagnostics in `meta` rather than throwing, so one bad call doesn't crash a
 * run; the role layer then treats empty/unparseable output as a retry.
 */

const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandEnvRefs(value: string, source: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REF_RE, (_m, name: string) => source[name] ?? "");
}

export const HttpRunnerOptionsSchema = z
  .object({
    /** base URL of the API, e.g. "https://host/v1" */
    baseUrl: z.string().url(),
    /** request path appended to baseUrl */
    path: z.string().default("/chat/completions"),
    /** name of the env var holding the API key (secret by reference, not value) */
    apiKeyEnv: z.string().optional(),
    /** extra headers; values may contain ${VAR} expanded from the parent env */
    headers: z.record(z.string()).default({}),
    /** hard request timeout before the call is aborted */
    timeoutMs: z.number().int().positive().default(2 * 60_000),
    /** rolling cap on captured response text */
    maxOutputChars: z.number().int().positive().default(2_000_000),
    /** sampling temperature, omitted from the body when unset */
    temperature: z.number().optional(),
    /** max_tokens, omitted from the body when unset */
    maxTokens: z.number().int().positive().optional(),
    /** merged into the request body (e.g. provider-specific knobs) */
    extraBody: z.record(z.unknown()).default({}),
    quota: z
      .object({
        /** HTTP status codes that indicate an exhausted usage/rate window */
        statusCodes: z.array(z.number().int()).default([429]),
        /** case-insensitive regex tested against an error response body */
        pattern: z
          .string()
          .optional()
          .refine(
            (p) => {
              if (p === undefined) return true;
              try {
                new RegExp(p, "i");
                return true;
              } catch {
                return false;
              }
            },
            { message: "quota.pattern must be a valid regular expression" },
          ),
      })
      .default({ statusCodes: [429] }),
  })
  .strict();

export type HttpRunnerOptions = z.infer<typeof HttpRunnerOptionsSchema>;

/** Minimal subset of the global fetch signature the runner depends on. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface HttpRunnerDeps {
  /** injectable transport; defaults to the global fetch */
  fetch?: FetchLike;
  /** env source for key/header expansion; defaults to process.env */
  env?: NodeJS.ProcessEnv;
}

/** Reads choices[0].message.content from an OpenAI-compatible response body. */
function extractContent(body: unknown): string {
  if (body === null || typeof body !== "object") return "";
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  const content = first?.message?.content;
  if (typeof content === "string") return content;
  // Some servers return a bare `text` field (completions-style); accept it too.
  if (typeof first?.text === "string") return first.text;
  return "";
}

export class HttpRunner implements AgentRunner {
  readonly profile: RunnerProfile;
  private readonly opts: HttpRunnerOptions;
  private readonly fetchImpl: FetchLike;
  private readonly env: NodeJS.ProcessEnv;
  /** quota body matcher, compiled once at construction (undefined when unset) */
  private readonly quotaPattern?: RegExp;

  constructor(profile: RunnerProfile, deps: HttpRunnerDeps = {}) {
    this.profile = profile;
    // Validate eagerly so a bad profile fails at construction, not mid-run.
    this.opts = HttpRunnerOptionsSchema.parse(profile.options ?? {});
    // Precompile the quota pattern now (the schema already proved it valid) so
    // a bad regex can never throw inside run()'s try/catch and get mistaken for
    // a transport failure.
    this.quotaPattern =
      this.opts.quota.pattern !== undefined
        ? new RegExp(this.opts.quota.pattern, "i")
        : undefined;
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    const resolved = deps.fetch ?? globalFetch;
    if (!resolved) {
      throw new Error(
        `HttpRunner "${profile.id}" has no fetch implementation available ` +
          `(global fetch missing; pass one via deps.fetch).`,
      );
    }
    this.fetchImpl = resolved;
    this.env = deps.env ?? process.env;
  }

  async run(req: RunRequest): Promise<RunResult> {
    const url = this.joinUrl(this.opts.baseUrl, this.opts.path);
    const headers = this.buildHeaders();
    const body = JSON.stringify(this.buildBody(req));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const started = Date.now();

    // External cancellation: if the run is cancelled, abort the in-flight fetch
    // immediately rather than waiting out the request timeout. If the signal has
    // already fired, abort before we even dispatch.
    const onAbort = (): void => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      const durationMs = Date.now() - started;

      if (!res.ok) {
        const errText = await safeText(res);
        const quotaExhausted =
          this.opts.quota.statusCodes.includes(res.status) ||
          (this.quotaPattern !== undefined && this.quotaPattern.test(errText));
        return {
          text: "",
          quotaExhausted,
          meta: {
            runnerId: this.profile.id,
            model: this.profile.model,
            status: res.status,
            durationMs,
            error: redactAndTruncate(errText, 2_000),
          },
        };
      }

      const json = await res.json();
      const raw = extractContent(json);
      const text =
        raw.length > this.opts.maxOutputChars ? raw.slice(0, this.opts.maxOutputChars) : raw;

      return {
        text,
        quotaExhausted: false,
        meta: {
          runnerId: this.profile.id,
          model: this.profile.model,
          status: res.status,
          durationMs,
          // surfaced for the usage/cost ledger (Milestone 5); shape is provider-defined
          usage: (json as { usage?: unknown })?.usage ?? null,
        },
      };
    } catch (err) {
      // Distinguish an external cancellation from a timeout: both abort the same
      // controller, so we check the caller's signal first.
      const cancelled = req.signal?.aborted ?? false;
      const aborted = controller.signal.aborted;
      return {
        text: "",
        quotaExhausted: false,
        meta: {
          runnerId: this.profile.id,
          model: this.profile.model,
          durationMs: Date.now() - started,
          timedOut: aborted && !cancelled,
          cancelled,
          error: cancelled
            ? "request cancelled"
            : aborted
              ? "request timed out"
              : String((err as Error).message ?? err),
        },
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  }

  private joinUrl(base: string, path: string): string {
    const b = base.endsWith("/") ? base.slice(0, -1) : base;
    const p = path.startsWith("/") ? path : `/${path}`;
    return `${b}${p}`;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const [k, v] of Object.entries(this.opts.headers)) {
      headers[k] = expandEnvRefs(v, this.env);
    }
    if (this.opts.apiKeyEnv) {
      const key = this.env[this.opts.apiKeyEnv];
      if (key) headers["authorization"] = `Bearer ${key}`;
    }
    return headers;
  }

  private buildBody(req: RunRequest): Record<string, unknown> {
    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });

    const body: Record<string, unknown> = {
      model: this.profile.model,
      messages,
      ...this.opts.extraBody,
    };
    if (this.opts.temperature !== undefined) body["temperature"] = this.opts.temperature;
    if (this.opts.maxTokens !== undefined) body["max_tokens"] = this.opts.maxTokens;
    return body;
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

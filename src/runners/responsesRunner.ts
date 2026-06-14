import { z } from "zod";
import type {
  AgentRunner,
  RunRequest,
  RunResult,
  RunnerProfile,
} from "./agentRunner.js";
import { redactAndTruncate } from "../engine/redaction.js";
import type { FetchLike, HttpRunnerDeps } from "./httpRunner.js";

/**
 * Runner for the OpenAI **Responses API** (`POST {baseUrl}/responses`).
 *
 * This is intentionally a SEPARATE runner from {@link HttpRunner}, which speaks
 * the older Chat Completions shape (`messages` -> `choices[].message.content`).
 * The Responses API has a different request body (`input` + `instructions`) and
 * a different result shape (`output[].content[].text`, with an `output_text`
 * convenience), so mixing the two behind one runner would be fragile. Keeping
 * them distinct means a profile's `kind` ("http" vs "http-responses") selects
 * the exact wire format, and each can evolve independently.
 *
 * Everything provider-specific is profile data:
 *   - where to call: `baseUrl` + `path` (default `/responses`)
 *   - auth by reference: `apiKeyEnv` names an env var holding the key (sent as
 *     `Authorization: Bearer ...`); custom `headers` values may reference
 *     `${VAR}` from the parent env
 *   - the model comes from the profile's `model`
 *   - quota detection: HTTP status codes (default 429) and/or a body regex
 *   - a hard request timeout and bounded output capture
 *
 * Like the other network runner, transport/HTTP failures resolve to a result
 * with diagnostics in `meta` rather than throwing, so one bad call never
 * crashes a run; the role layer treats empty/unparseable output as a retry.
 */

const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandEnvRefs(value: string, source: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REF_RE, (_m, name: string) => source[name] ?? "");
}

export const ResponsesRunnerOptionsSchema = z
  .object({
    /** base URL of the API, e.g. "https://api.openai.com/v1" */
    baseUrl: z.string().url(),
    /** request path appended to baseUrl */
    path: z.string().default("/responses"),
    /** name of the env var holding the API key (secret by reference, not value) */
    apiKeyEnv: z.string().optional(),
    /** extra headers; values may contain ${VAR} expanded from the parent env */
    headers: z.record(z.string()).default({}),
    /** hard request timeout before the call is aborted */
    timeoutMs: z.number().int().positive().default(5 * 60_000),
    /** rolling cap on captured response text */
    maxOutputChars: z.number().int().positive().default(2_000_000),
    /** sampling temperature, omitted from the body when unset */
    temperature: z.number().optional(),
    /** max_output_tokens, omitted from the body when unset */
    maxOutputTokens: z.number().int().positive().optional(),
    /**
     * Reasoning effort for reasoning models, e.g. "low" | "medium" | "high".
     * Sent as `reasoning: { effort }` when set; omitted otherwise.
     */
    reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
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

export type ResponsesRunnerOptions = z.infer<typeof ResponsesRunnerOptionsSchema>;

/**
 * Extracts the assistant text from a Responses API result. Prefers the
 * top-level `output_text` convenience (a string, or an array of strings some
 * gateways emit), then falls back to concatenating every `output_text` part
 * found under `output[].content[]`. Anything unexpected yields "".
 */
export function extractResponsesText(body: unknown): string {
  if (body === null || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;

  // 1) `output_text` convenience field.
  const ot = b["output_text"];
  if (typeof ot === "string" && ot.length > 0) return ot;
  if (Array.isArray(ot)) {
    const joined = ot.filter((x): x is string => typeof x === "string").join("");
    if (joined.length > 0) return joined;
  }

  // 2) Walk output[] -> content[] -> { type: "output_text", text }.
  const output = b["output"];
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (item === null || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      // Accept the canonical "output_text" and tolerate a bare {text}.
      if ((p["type"] === undefined || p["type"] === "output_text") && typeof p["text"] === "string") {
        parts.push(p["text"] as string);
      }
    }
  }
  return parts.join("");
}

/** Runner for the OpenAI Responses API. Transport is injectable for tests. */
export class ResponsesRunner implements AgentRunner {
  readonly profile: RunnerProfile;
  private readonly opts: ResponsesRunnerOptions;
  private readonly fetchImpl: FetchLike;
  private readonly env: NodeJS.ProcessEnv;
  private readonly quotaPattern?: RegExp;

  constructor(profile: RunnerProfile, deps: HttpRunnerDeps = {}) {
    this.profile = profile;
    // Validate eagerly so a bad profile fails at construction, not mid-run.
    this.opts = ResponsesRunnerOptionsSchema.parse(profile.options ?? {});
    this.quotaPattern =
      this.opts.quota.pattern !== undefined
        ? new RegExp(this.opts.quota.pattern, "i")
        : undefined;
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    const resolved = deps.fetch ?? globalFetch;
    if (!resolved) {
      throw new Error(
        `ResponsesRunner "${profile.id}" has no fetch implementation available ` +
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
      const raw = extractResponsesText(json);
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
          usage: (json as { usage?: unknown })?.usage ?? null,
        },
      };
    } catch (err) {
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
    const body: Record<string, unknown> = {
      // Spread caller-supplied knobs FIRST so they can never override the core
      // request fields (model/input) set below — otherwise a stray extraBody
      // value could silently diverge the sent prompt/model from the request.
      ...this.opts.extraBody,
      model: this.profile.model,
      // The Responses API takes `input` (the user turn) and a separate
      // `instructions` (the system framing), unlike Chat Completions' messages.
      input: req.prompt,
    };
    if (req.system) body["instructions"] = req.system;
    if (this.opts.temperature !== undefined) body["temperature"] = this.opts.temperature;
    if (this.opts.maxOutputTokens !== undefined) body["max_output_tokens"] = this.opts.maxOutputTokens;
    if (this.opts.reasoningEffort !== undefined) body["reasoning"] = { effort: this.opts.reasoningEffort };
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

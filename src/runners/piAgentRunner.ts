import { z } from "zod";
import path from "node:path";
import type {
  AgentRunner,
  RunRequest,
  RunResult,
  RunnerProfile,
} from "./agentRunner.js";
import { redactAndTruncate } from "../engine/redaction.js";

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  Type,
  getEnvApiKey,
  getModel,
  registerBuiltInApiProviders,
  type AssistantMessage,
  type Model,
  type Static,
  type TSchema,
} from "@earendil-works/pi-ai";

/** Defines a tool while inferring its parameter schema so `params` is typed. */
function defineTool<S extends TSchema>(def: {
  name: string;
  label: string;
  description: string;
  parameters: S;
  execute: (
    toolCallId: string,
    params: Static<S>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<Record<string, unknown>>>;
}): AgentTool {
  return def as unknown as AgentTool;
}

/**
 * Native agentic runner: drives a real multi-turn tool-calling loop
 * (@earendil-works/pi-agent-core + pi-ai) inside the request's working
 * directory, so ANY provider with an API key becomes a first-class
 * file-editing actor — no external CLI (codex/kiro) required.
 *
 * Unlike CliRunner (shells out, the loop is opaque) and HttpRunner (a single
 * chat completion that cannot edit files), this runner owns the inner loop: the
 * model reads, greps, edits, and runs commands via tools rooted at `req.cwd`
 * (the task's git worktree). The engine's `captureDiff` seam then reviews the
 * REAL `git diff` of that worktree, so the artifact the critic judges is the
 * artifact that gets integrated — the model's self-reported diff is no longer
 * trusted, and HTTP-style "returns a diff but edits nothing" can't happen.
 *
 * Everything provider-specific is profile data; the engine never names a model.
 * Heavy collaborators (the model, the execution env) are injectable so the real
 * Agent loop + real tools can be exercised offline in tests via pi's faux
 * provider.
 */

/** All tools this runner can expose; the profile may allowlist a subset. */
export const PI_AGENT_TOOL_NAMES = [
  "read_file",
  "list_dir",
  "write_file",
  "edit_file",
  "bash",
] as const;
export type PiAgentToolName = (typeof PI_AGENT_TOOL_NAMES)[number];

/**
 * Tools enabled when a profile doesn't specify an explicit allowlist. `bash`
 * is intentionally excluded: arbitrary shell execution by default materially
 * widens the prompt-injection / exfiltration surface, so it must be opted into
 * explicitly via the `tools` option.
 */
const DEFAULT_PI_AGENT_TOOL_NAMES: readonly PiAgentToolName[] = [
  "read_file",
  "list_dir",
  "write_file",
  "edit_file",
] as const;

const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** Tools whose first concern is a filesystem `path` argument. */
const PATH_TOOLS = new Set<PiAgentToolName>(["read_file", "list_dir", "write_file", "edit_file"]);

/**
 * Tool-call permission policy, enforced via pi's `beforeToolCall` hook.
 *
 * `confineToCwd` (default on) blocks the file tools from touching anything
 * outside the worktree root (absolute paths or `..` escapes), so a model can't
 * read `/etc/passwd` or write outside the task's isolated checkout. NOTE: this
 * confines the FILE tools only. `bash` is inherently unconfined — restrict it
 * with `denyBashPattern`, and for real isolation run the engine in a container
 * (see pi's containerization patterns).
 */
const SafetySchema = z
  .object({
    /** block file-tool paths that escape the worktree root */
    confineToCwd: z.boolean().default(true),
    /** case-insensitive regex; a matching `bash` command is blocked */
    denyBashPattern: z
      .string()
      .refine(
        (p) => {
          try {
            new RegExp(p, "i");
            return true;
          } catch {
            return false;
          }
        },
        { message: "denyBashPattern must be a valid regular expression" },
      )
      .optional(),
  })
  .strict()
  .default({ confineToCwd: true });

export const PiAgentRunnerOptionsSchema = z
  .object({
    /** provider id for pi-ai model resolution, e.g. "anthropic", "openai", "google" */
    provider: z.string().min(1),
    /** env var holding the API key; defaults to pi's per-provider env lookup */
    apiKeyEnv: z.string().optional(),
    /** reasoning budget passed through to thinking-capable models */
    thinkingLevel: ThinkingLevelSchema.default("off"),
    /** hard cap on agent turns (one LLM call + its tools) before we abort */
    maxTurns: z.number().int().positive().default(60),
    /** overall wall-clock budget before the run is aborted */
    timeoutMs: z.number().int().positive().default(10 * 60_000),
    /** restrict the toolset; defaults to the file tools (bash is opt-in) */
    tools: z.array(z.enum(PI_AGENT_TOOL_NAMES)).optional(),
    /** tool-call permission policy (path confinement + bash denylist) */
    safety: SafetySchema,
    /** rolling cap on the captured final answer text */
    maxOutputChars: z.number().int().positive().default(2_000_000),
  })
  .strict();

export type PiAgentRunnerOptions = z.infer<typeof PiAgentRunnerOptionsSchema>;

/** Injectable collaborators so the real loop is testable without a network. */
export interface PiAgentRunnerDeps {
  /** pre-resolved model (tests pass a faux model); else resolved from profile */
  model?: Model<any>;
  /** custom execution env factory (tests/sandboxing); else NodeExecutionEnv */
  createEnv?: (cwd: string) => ExecutionEnv;
  /** override the Agent stream function (tests/proxy backends) */
  streamFn?: NonNullable<ConstructorParameters<typeof Agent>[0]>["streamFn"];
  /** override API-key resolution (else profile.apiKeyEnv / pi env lookup) */
  getApiKey?: (provider: string) => string | undefined;
}

/** A coding-agent base prompt; the role framing (req.system) is appended. */
const BASE_SYSTEM_PROMPT =
  "You are an autonomous coding agent operating inside an isolated git " +
  "worktree. Use the provided tools to inspect the repository and make the " +
  "smallest correct change that satisfies the request. Edit files directly " +
  "with the tools — do not just describe changes. When the task asks for a " +
  "specific final reply (for example a JSON object), produce exactly that as " +
  "your last message after you have finished editing.";

let builtinsRegistered = false;
function ensureBuiltinProviders(): void {
  if (builtinsRegistered) return;
  registerBuiltInApiProviders();
  builtinsRegistered = true;
}

/** Joins text content blocks of an assistant message into plain text. */
function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function isQuotaMessage(text: string): boolean {
  return /quota|rate.?limit|\b429\b|insufficient[_\s-]?quota|too many requests/i.test(text);
}

/** True when `target` resolves to `root` or a path nested under it (lexical). */
function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export class PiAgentRunner implements AgentRunner {
  readonly profile: RunnerProfile;
  private readonly opts: PiAgentRunnerOptions;
  private readonly deps: PiAgentRunnerDeps;

  constructor(profile: RunnerProfile, deps: PiAgentRunnerDeps = {}) {
    this.profile = profile;
    // Validate eagerly so a bad profile fails at construction, not mid-run.
    this.opts = PiAgentRunnerOptionsSchema.parse(profile.options ?? {});
    this.deps = deps;
  }

  /** Builds the allowlisted toolset bound to one execution env. */
  private buildTools(env: ExecutionEnv): AgentTool[] {
    const enabled = new Set<PiAgentToolName>(this.opts.tools ?? DEFAULT_PI_AGENT_TOOL_NAMES);
    const all: AgentTool[] = [
      defineTool({
        name: "read_file",
        label: "Read File",
        description: "Read a UTF-8 text file's full contents.",
        parameters: Type.Object({
          path: Type.String({ description: "File path (relative to the workspace)." }),
        }),
        execute: async (_id, params, signal) => {
          const res = await env.readTextFile(params.path, signal);
          if (!res.ok) throw new Error(`read_file failed: ${res.error.message}`);
          return { content: [{ type: "text", text: res.value }], details: { path: params.path } };
        },
      }),
      defineTool({
        name: "list_dir",
        label: "List Directory",
        description: "List the entries of a directory.",
        parameters: Type.Object({
          path: Type.String({ description: "Directory path (relative to the workspace)." }),
        }),
        execute: async (_id, params, signal) => {
          const res = await env.listDir(params.path, signal);
          if (!res.ok) throw new Error(`list_dir failed: ${res.error.message}`);
          const text = res.value.map((f) => `${f.kind === "directory" ? "d" : "-"} ${f.name}`).join("\n");
          return { content: [{ type: "text", text: text || "(empty)" }], details: { path: params.path } };
        },
      }),
      defineTool({
        name: "write_file",
        label: "Write File",
        description: "Create or overwrite a text file with the given contents.",
        parameters: Type.Object({
          path: Type.String({ description: "File path (relative to the workspace)." }),
          content: Type.String({ description: "Full file contents to write." }),
        }),
        execute: async (_id, params, signal) => {
          const res = await env.writeFile(params.path, params.content, signal);
          if (!res.ok) throw new Error(`write_file failed: ${res.error.message}`);
          return {
            content: [{ type: "text", text: `Wrote ${params.content.length} chars to ${params.path}` }],
            details: { path: params.path, bytes: params.content.length },
          };
        },
      }),
      defineTool({
        name: "edit_file",
        label: "Edit File",
        description:
          "Replace an exact, unique substring in a file. `old_str` must occur " +
          "exactly once; include enough surrounding context to make it unique.",
        parameters: Type.Object({
          path: Type.String({ description: "File path (relative to the workspace)." }),
          old_str: Type.String({ description: "Exact text to replace (must be unique)." }),
          new_str: Type.String({ description: "Replacement text." }),
        }),
        execute: async (_id, params, signal) => {
          const read = await env.readTextFile(params.path, signal);
          if (!read.ok) throw new Error(`edit_file failed: ${read.error.message}`);
          const occurrences = read.value.split(params.old_str).length - 1;
          if (occurrences === 0) throw new Error(`edit_file: old_str not found in ${params.path}`);
          if (occurrences > 1) {
            throw new Error(
              `edit_file: old_str occurs ${occurrences} times in ${params.path}; add more context to make it unique`,
            );
          }
          const updated = read.value.replace(params.old_str, params.new_str);
          const write = await env.writeFile(params.path, updated, signal);
          if (!write.ok) throw new Error(`edit_file failed: ${write.error.message}`);
          return { content: [{ type: "text", text: `Edited ${params.path}` }], details: { path: params.path } };
        },
      }),
      defineTool({
        name: "bash",
        label: "Run Command",
        description: "Run a shell command in the workspace and capture its output.",
        parameters: Type.Object({
          command: Type.String({ description: "Shell command to execute." }),
        }),
        execute: async (_id, params, signal) => {
          const res = await env.exec(params.command, { ...(signal ? { abortSignal: signal } : {}) });
          if (!res.ok) throw new Error(`bash failed: ${res.error.message}`);
          const { stdout, stderr, exitCode } = res.value;
          const combined = redactAndTruncate(`${stdout}${stderr ? `\n${stderr}` : ""}`, 30_000);
          return { content: [{ type: "text", text: `exit ${exitCode}\n${combined}` }], details: { exitCode } };
        },
      }),
    ];
    return all.filter((t) => enabled.has(t.name as PiAgentToolName));
  }

  private resolveModel(): Model<any> {
    if (this.deps.model) return this.deps.model;
    ensureBuiltinProviders();
    // getModel is statically typed against the bundled model catalog; the
    // profile supplies dynamic strings, so we resolve through a loosened call.
    const resolve = getModel as unknown as (provider: string, modelId: string) => Model<any>;
    return resolve(this.opts.provider, this.profile.model);
  }

  private apiKey(): string | undefined {
    if (this.deps.getApiKey) return this.deps.getApiKey(this.opts.provider);
    if (this.opts.apiKeyEnv) return process.env[this.opts.apiKeyEnv];
    return getEnvApiKey(this.opts.provider);
  }

  async run(req: RunRequest): Promise<RunResult> {
    const started = Date.now();
    if (req.signal?.aborted) {
      return {
        text: "",
        meta: { runnerId: this.profile.id, model: this.profile.model, cancelled: true, durationMs: 0 },
      };
    }

    const env = (this.deps.createEnv ?? ((cwd) => new NodeExecutionEnv({ cwd })))(req.cwd);
    const systemPrompt = req.system ? `${BASE_SYSTEM_PROMPT}\n\n${req.system}` : BASE_SYSTEM_PROMPT;

    let model: Model<any>;
    try {
      model = this.resolveModel();
    } catch (err) {
      return {
        text: "",
        meta: {
          runnerId: this.profile.id,
          model: this.profile.model,
          durationMs: Date.now() - started,
          error: `model resolution failed: ${String((err as Error)?.message ?? err)}`,
        },
      };
    }

    const apiKey = this.apiKey();

    // Permission gate (pi's beforeToolCall hook): confine file tools to the
    // worktree and apply the optional bash denylist. A blocked call becomes an
    // error tool result the model sees and can recover from.
    const safety = this.opts.safety;
    const cwdRoot = path.resolve(req.cwd);
    const denyBash = safety.denyBashPattern ? new RegExp(safety.denyBashPattern, "i") : undefined;
    let blockedToolCalls = 0;

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: this.opts.thinkingLevel,
        tools: this.buildTools(env),
      },
      ...(this.deps.streamFn ? { streamFn: this.deps.streamFn } : {}),
      getApiKey: () => apiKey,
      beforeToolCall: async ({ toolCall, args }) => {
        const name = (toolCall as { name: string }).name as PiAgentToolName;
        if (safety.confineToCwd && PATH_TOOLS.has(name)) {
          const p = (args as { path?: unknown }).path;
          if (typeof p === "string" && !isInsideRoot(cwdRoot, path.resolve(cwdRoot, p))) {
            blockedToolCalls++;
            return { block: true, reason: `path "${p}" escapes the workspace root; refused` };
          }
        }
        if (name === "bash" && denyBash) {
          const command = String((args as { command?: unknown }).command ?? "");
          if (denyBash.test(command)) {
            blockedToolCalls++;
            return { block: true, reason: `command blocked by policy (denyBashPattern): ${command}` };
          }
        }
        return undefined;
      },
    });

    // Accumulate usage and bound turns. The watchdog/Stop button and the
    // per-runner timeout all converge on agent.abort(), which ends the loop
    // gracefully after the current turn.
    let turns = 0;
    let abortedForLimit = false;
    const usage = { input: 0, output: 0, total: 0 };
    let lastQuotaText = "";
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "turn_start") {
        if (turns >= this.opts.maxTurns) {
          abortedForLimit = true;
          agent.abort();
          return;
        }
        turns++;
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        const m = event.message as AssistantMessage;
        usage.input += m.usage?.input ?? 0;
        usage.output += m.usage?.output ?? 0;
        usage.total += m.usage?.totalTokens ?? 0;
        if (m.stopReason === "error" && m.errorMessage) lastQuotaText = m.errorMessage;
      }
    });

    let cancelled = false;
    let timedOut = false;
    const onAbort = (): void => {
      cancelled = true;
      agent.abort();
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      agent.abort();
    }, this.opts.timeoutMs);

    let runError: string | undefined;
    try {
      await agent.prompt(req.prompt);
    } catch (err) {
      runError = String((err as Error)?.message ?? err);
      if (isQuotaMessage(runError)) lastQuotaText = runError;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    }

    // Final answer = text of the last assistant message in the transcript.
    const messages = agent.state.messages;
    let text = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "assistant") {
        text = assistantText(m as AssistantMessage);
        break;
      }
    }
    if (text.length > this.opts.maxOutputChars) text = text.slice(0, this.opts.maxOutputChars);

    const quotaExhausted = lastQuotaText !== "" && isQuotaMessage(lastQuotaText);

    return {
      text,
      quotaExhausted,
      meta: {
        runnerId: this.profile.id,
        model: this.profile.model,
        provider: this.opts.provider,
        durationMs: Date.now() - started,
        turns,
        abortedForLimit,
        blockedToolCalls,
        cancelled,
        timedOut,
        // shape understood by observability/events.ts normalizeUsage()
        usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.total },
        ...(runError ? { error: redactAndTruncate(runError, 2_000) } : {}),
      },
    };
  }
}

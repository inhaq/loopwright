/**
 * Generic, vendor-neutral execution layer.
 *
 * A "runner" is any backend that can execute a natural-language prompt inside a
 * workspace and return a raw result. The orchestration loop never references a
 * specific product or model; it talks to ROLES (see ../adapters/agents.ts),
 * and each role is backed by a runner chosen via configuration.
 *
 * Adding a new backend = implement AgentRunner. Concrete runners are named by
 * their MECHANISM, never by a product/vendor:
 *   - CliRunner        drives a headless command-line agent as a subprocess
 *   - HttpRunner       calls an OpenAI-compatible chat-completions endpoint
 *   - ResponsesRunner  calls the OpenAI Responses API (`/v1/responses`)
 *   - PiAgentRunner    runs a native multi-turn tool-calling loop in-process
 *   - MockRunner       deterministic, for tests
 * Supporting another provider is usually just a new RunnerProfile; a genuinely
 * new transport is a new runner class. The engine never changes.
 */

import { z } from "zod";

export type RunnerKind = "cli" | "http" | "http-responses" | "mock" | "agent";

/**
 * Validates a runner profile loaded from configuration. The {@link RunnerProfile}
 * interface below remains the canonical type used throughout the engine; this
 * schema exists so config-supplied profiles fail fast with a clear message.
 */
export const RunnerProfileSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["cli", "http", "http-responses", "mock", "agent"]),
    model: z.string().default(""),
    options: z.record(z.unknown()).optional(),
  })
  .strict();

export interface RunnerProfile {
  /** stable id referenced by role bindings, e.g. "primary", "reviewer" */
  id: string;
  kind: RunnerKind;
  /** model identifier passed through to the backend (opaque to the engine) */
  model: string;
  /** backend-specific settings: command template, base URL, headers, etc. */
  options?: Record<string, unknown>;
}

export interface RunRequest {
  prompt: string;
  /** working directory the backend operates in (an isolated worktree, later) */
  cwd: string;
  /** optional system/role framing */
  system?: string;
  /**
   * Cooperative cancellation. When aborted, an HTTP backend aborts its in-flight
   * fetch and a CLI backend kills its subprocess tree, so clicking Stop during a
   * long model call returns promptly instead of waiting for the runner timeout.
   */
  signal?: AbortSignal;
  /**
   * Optional sink for mid-call activity (sub-step streaming). Backends that run
   * an inner agentic loop (e.g. the native agent runner) emit a {@link RunnerActivity}
   * as the model calls tools, so the engine can surface live progress instead of
   * a single opaque result. Single-shot backends (CLI/HTTP) simply ignore it.
   */
  onEvent?: (activity: RunnerActivity) => void;
  /**
   * Optional steering registration. Called once at the start of a run with a
   * `steer(text)` function bound to the live inner loop; the caller (a human
   * "nudge", a supervisor) may invoke it at any time while the run is in flight
   * to inject guidance that takes effect after the current turn. Backends with
   * no inner loop ignore it.
   */
  steering?: (steer: (text: string) => void) => void;
}

/**
 * A mid-call progress signal from a runner's inner loop. Vendor-neutral and
 * role-agnostic: the runner reports WHAT happened (a tool started/finished, a
 * turn began); the role layer enriches it with the role/runner identity before
 * it reaches the event stream.
 */
export interface RunnerActivity {
  phase: "turn_start" | "tool_start" | "tool_end";
  /** present for tool_start/tool_end */
  toolName?: string;
  /** correlates a tool_start with its tool_end */
  toolCallId?: string;
  /** present on tool_end: whether the tool reported an error */
  isError?: boolean;
  /** 1-based turn number, present on turn_start */
  turn?: number;
  at: string;
}

export interface RunResult {
  /** raw assistant text; higher layers parse and validate it */
  text: string;
  /** the backend signalled its usage/rate window is exhausted */
  quotaExhausted?: boolean;
  /** opaque diagnostics for observability: tokens, duration, exit code, etc. */
  meta?: Record<string, unknown>;
}

/** The single extension point every backend implements. */
export interface AgentRunner {
  readonly profile: RunnerProfile;
  run(req: RunRequest): Promise<RunResult>;
}

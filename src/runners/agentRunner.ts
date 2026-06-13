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
 *   - CliRunner   drives a headless command-line agent as a subprocess
 *   - HttpRunner  calls an OpenAI-compatible HTTP endpoint
 *   - MockRunner  deterministic, for tests
 * Supporting another provider is usually just a new RunnerProfile; a genuinely
 * new transport is a new runner class. The engine never changes.
 */

import { z } from "zod";

export type RunnerKind = "cli" | "http" | "mock";

/**
 * Validates a runner profile loaded from configuration. The {@link RunnerProfile}
 * interface below remains the canonical type used throughout the engine; this
 * schema exists so config-supplied profiles fail fast with a clear message.
 */
export const RunnerProfileSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["cli", "http", "mock"]),
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

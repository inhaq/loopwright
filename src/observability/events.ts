/**
 * Observability event shapes (Milestone 5).
 *
 * The store already persists transitions, attempts, and outcomes as typed
 * tables; these are the *other* structured events a full trace needs — chiefly
 * runner invocations (Req 11.1) — plus session lifecycle markers. They are
 * written to the store's generic event stream (EventRecord) and read back for
 * the usage ledger (Task 23) and trace view (Task 24).
 */

export type RoleName = "actor" | "critic";

/** Token usage, normalized from a provider's (free-form) usage object. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** One runner invocation, attributed to the role that made it. */
export interface RunnerCallEvent {
  role: RoleName;
  runnerId: string;
  model: string;
  promptChars: number;
  outputChars: number;
  durationMs: number;
  quotaExhausted: boolean;
  usage: TokenUsage;
  at: string;
}

export const EVENT_TYPES = {
  sessionStarted: "session_started",
  planReviewed: "plan_reviewed",
  runnerCall: "runner_call",
  sessionFinished: "session_finished",
} as const;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Normalizes a provider's usage object into {prompt,completion,total} tokens.
 * Accepts the common OpenAI-style keys and the input/output variant; missing
 * fields are zero, and a total is derived when absent.
 */
export function normalizeUsage(usage: unknown): TokenUsage {
  if (usage === null || typeof usage !== "object") return { ...ZERO_USAGE };
  const u = usage as Record<string, unknown>;
  const prompt = num(u["prompt_tokens"]) || num(u["input_tokens"]) || num(u["promptTokens"]);
  const completion =
    num(u["completion_tokens"]) || num(u["output_tokens"]) || num(u["completionTokens"]);
  const totalRaw = num(u["total_tokens"]) || num(u["totalTokens"]);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: totalRaw || prompt + completion,
  };
}

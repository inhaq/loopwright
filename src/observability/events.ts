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
  integration: "integration",
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
  // Prefer the first key that is actually PRESENT, not the first truthy one:
  // `||` would discard a legitimate 0 (e.g. an empty prompt) in favor of a
  // later alias, corrupting the usage ledger.
  const pick = (...keys: string[]): number => {
    for (const k of keys) if (k in u) return num(u[k]);
    return 0;
  };
  const prompt = pick("prompt_tokens", "input_tokens", "promptTokens");
  const completion = pick("completion_tokens", "output_tokens", "completionTokens");
  const totalRaw = pick("total_tokens", "totalTokens");
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: totalRaw || prompt + completion,
  };
}

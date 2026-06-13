import type { EventRecord } from "../storage/store.js";
import { EVENT_TYPES, type RoleName, type RunnerCallEvent } from "./events.js";

/**
 * Usage/cost ledger (Task 23): aggregates runner-call events per role and for
 * the run as a whole (Req 11.2). Cost is optional — supply per-1k-token rates
 * to get a dollar estimate; otherwise the ledger is token/call/duration counts.
 */

export interface RoleUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  /** number of calls that reported an exhausted quota */
  quotaHits: number;
  /** present only when rates were supplied */
  costUsd?: number;
}

export interface UsageLedger {
  perRole: Record<RoleName, RoleUsage>;
  total: RoleUsage;
}

/** Per-role pricing in dollars per 1,000 tokens. */
export type Rates = Partial<
  Record<RoleName, { per1kPrompt?: number; per1kCompletion?: number }>
>;

function emptyRole(): RoleUsage {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0, quotaHits: 0 };
}

function add(into: RoleUsage, e: RunnerCallEvent): void {
  into.calls += 1;
  into.promptTokens += e.usage.promptTokens;
  into.completionTokens += e.usage.completionTokens;
  into.totalTokens += e.usage.totalTokens;
  into.durationMs += e.durationMs;
  if (e.quotaExhausted) into.quotaHits += 1;
}

/** Pulls the runner-call events out of a session's generic event stream. */
export function runnerCalls(events: EventRecord[]): RunnerCallEvent[] {
  return events
    .filter((e) => e.type === EVENT_TYPES.runnerCall)
    .map((e) => e.data as unknown as RunnerCallEvent);
}

export function computeUsage(calls: RunnerCallEvent[], rates: Rates = {}): UsageLedger {
  const perRole: Record<RoleName, RoleUsage> = { actor: emptyRole(), critic: emptyRole() };
  for (const call of calls) {
    add(perRole[call.role], call);
  }

  for (const role of ["actor", "critic"] as const) {
    const rate = rates[role];
    if (rate) {
      const u = perRole[role];
      u.costUsd =
        (u.promptTokens / 1000) * (rate.per1kPrompt ?? 0) +
        (u.completionTokens / 1000) * (rate.per1kCompletion ?? 0);
    }
  }

  const total = emptyRole();
  for (const role of ["actor", "critic"] as const) {
    const u = perRole[role];
    total.calls += u.calls;
    total.promptTokens += u.promptTokens;
    total.completionTokens += u.completionTokens;
    total.totalTokens += u.totalTokens;
    total.durationMs += u.durationMs;
    total.quotaHits += u.quotaHits;
    if (u.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + u.costUsd;
  }

  return { perRole, total };
}

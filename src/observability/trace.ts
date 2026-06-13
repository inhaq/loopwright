import type {
  AttemptRecord,
  EventRecord,
  OutcomeRecord,
  SessionRecord,
  Store,
  TaskRecord,
  TransitionRecord,
} from "../storage/store.js";
import { computeUsage, runnerCalls, type Rates, type UsageLedger } from "./usage.js";

/**
 * Session trace inspection (Task 24): assembles a session's full, ordered story
 * from the store — lifecycle, per-task state history, build attempts, runner
 * calls, and outcomes — plus the computed usage ledger (Req 11.3). `formatTrace`
 * renders it for a human; the structured `SessionTrace` is what a UI consumes.
 */

export interface SessionTrace {
  session: SessionRecord | undefined;
  tasks: TaskRecord[];
  transitions: TransitionRecord[];
  attempts: AttemptRecord[];
  outcomes: OutcomeRecord[];
  events: EventRecord[];
  usage: UsageLedger;
}

export async function buildTrace(
  store: Store,
  sessionId: string,
  rates: Rates = {},
): Promise<SessionTrace> {
  const [session, tasks, transitions, attempts, events] = await Promise.all([
    store.getSession(sessionId),
    store.listTasks(sessionId),
    store.listTransitions(sessionId),
    store.listAttempts(sessionId),
    store.listEvents(sessionId),
  ]);

  const outcomes: OutcomeRecord[] = [];
  for (const t of tasks) {
    const o = await store.getOutcome(sessionId, t.taskId);
    if (o) outcomes.push(o);
  }

  return {
    session,
    tasks,
    transitions,
    attempts,
    outcomes,
    events,
    usage: computeUsage(runnerCalls(events), rates),
  };
}

function money(n: number | undefined): string {
  return n === undefined ? "" : ` $${n.toFixed(4)}`;
}

/** Renders a trace as readable text (CLI / logs). */
export function formatTrace(trace: SessionTrace): string {
  const lines: string[] = [];
  const s = trace.session;
  lines.push(`Session ${s?.id ?? "(unknown)"} — ${s?.status ?? "?"}`);
  if (s) {
    lines.push(`  goal: ${s.goal}`);
    lines.push(`  plan: approved=${s.planApproved ?? "?"} revisions=${s.planRevisions ?? 0}`);
  }

  lines.push("\n  Tasks:");
  for (const t of trace.tasks) {
    const verified = t.verified ? " (verified)" : "";
    lines.push(`    ${t.taskId.padEnd(12)} ${t.state}${verified}`);
    const tx = trace.transitions.filter((x) => x.taskId === t.taskId);
    for (const x of tx) lines.push(`        ${x.from} --(${x.event})--> ${x.to}  ${x.reason}`);
  }

  const u = trace.usage;
  lines.push("\n  Usage:");
  for (const role of ["actor", "critic"] as const) {
    const r = u.perRole[role];
    lines.push(
      `    ${role.padEnd(7)} calls=${r.calls} tokens=${r.totalTokens} ` +
        `(prompt ${r.promptTokens} / completion ${r.completionTokens}) ` +
        `quotaHits=${r.quotaHits}${money(r.costUsd)}`,
    );
  }
  lines.push(
    `    ${"TOTAL".padEnd(7)} calls=${u.total.calls} tokens=${u.total.totalTokens}${money(u.total.costUsd)}`,
  );

  return lines.join("\n");
}

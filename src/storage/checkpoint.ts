import type { LoopObserver, TaskOutcome } from "../engine/loop.js";
import type { Store } from "./store.js";

/**
 * Bridges the loop's observer hooks to a {@link Store} (Task 17). Each task
 * transition is checkpointed durably before the loop advances, so a crash
 * leaves the store at a consistent, resumable point; build attempts and the
 * terminal outcome are recorded too.
 */
export function storeObserver(store: Store, sessionId: string): LoopObserver {
  return {
    async transition(e) {
      await store.recordTransition({
        sessionId,
        taskId: e.taskId,
        from: e.from,
        event: e.event,
        to: e.to,
        reason: e.reason,
        at: e.at,
      });
    },
    async attempt(e) {
      await store.recordAttempt({
        sessionId,
        taskId: e.taskId,
        attempt: e.attempt,
        kind: "build",
        summary: e.summary,
        at: e.at,
      });
    },
    async outcome(o: TaskOutcome) {
      await store.recordOutcome({
        sessionId,
        taskId: o.taskId,
        finalState: o.finalState,
        verified: o.verified,
        at: new Date().toISOString(),
        outcome: o,
      });
    },
  };
}

/**
 * Composes multiple observers into one; each hook fans out to every observer in
 * order. Lets a run checkpoint to a store AND feed an event log simultaneously
 * (Milestone 5) without the loop knowing about either.
 */
export function combineObservers(...observers: Array<LoopObserver | undefined>): LoopObserver {
  const present = observers.filter((o): o is LoopObserver => o !== undefined);
  return {
    async transition(e) {
      for (const o of present) await o.transition?.(e);
    },
    async attempt(e) {
      for (const o of present) await o.attempt?.(e);
    },
    async outcome(o) {
      for (const obs of present) await obs.outcome?.(o);
    },
  };
}

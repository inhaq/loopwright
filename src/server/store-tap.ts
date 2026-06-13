import type { EventRecord, Store } from "../storage/store.js";

/**
 * Wraps a {@link Store} so that every {@link Store.recordEvent} call is also
 * forwarded to `onEvent`, without changing persistence behaviour. The engine
 * writes lifecycle markers and runner-call events to the store's generic event
 * stream; tapping `recordEvent` lets the server surface those live (over SSE)
 * while the underlying store remains the single source of truth for the trace.
 *
 * Every other method delegates straight through, so the wrapped store is
 * indistinguishable from the real one to `runGoal`.
 */
export function tapStoreEvents(
  store: Store,
  onEvent: (rec: Omit<EventRecord, "seq">) => void,
): Store {
  return {
    createSession: (rec) => store.createSession(rec),
    updateSession: (id, patch) => store.updateSession(id, patch),
    getSession: (id) => store.getSession(id),
    listSessions: () => store.listSessions(),
    recordTransition: (rec) => store.recordTransition(rec),
    recordAttempt: (rec) => store.recordAttempt(rec),
    recordOutcome: (rec) => store.recordOutcome(rec),
    getTask: (sessionId, taskId) => store.getTask(sessionId, taskId),
    listTasks: (sessionId) => store.listTasks(sessionId),
    getOutcome: (sessionId, taskId) => store.getOutcome(sessionId, taskId),
    listTransitions: (sessionId) => store.listTransitions(sessionId),
    listAttempts: (sessionId) => store.listAttempts(sessionId),
    listEvents: (sessionId) => store.listEvents(sessionId),
    async recordEvent(rec) {
      await store.recordEvent(rec);
      // Tap AFTER the durable write so a live subscriber never sees an event
      // that failed to persist.
      onEvent(rec);
    },
  };
}

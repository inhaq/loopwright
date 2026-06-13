/**
 * Task state machine for the actor-critic loop.
 *
 * The machine only enforces *legal transitions*. Decisions about WHEN to fire
 * an event (cycle caps, quota, etc.) live in the orchestrator loop, so this
 * module stays a pure, testable description of the lifecycle.
 */

export const TASK_STATES = [
  "PLANNED", // task accepted from the plan, not yet built
  "BUILDING", // actor is building or fixing
  "MECHANICAL_FAILED", // build/test/lint gate failed
  "CRITIC_REVIEWING", // passed mechanical gate, awaiting critic verdict
  "CHANGES_REQUIRED", // critic returned blocking findings
  "GREEN", // critic green pass (or nits only) -- success (terminal)
  "NEEDS_HUMAN", // exceeded caps / unrecoverable -- terminal
  "UNVERIFIED_BY_CRITIC", // critic unavailable, degraded fallback -- terminal
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TASK_EVENTS = [
  "BUILD_STARTED",
  "MECHANICAL_PASSED",
  "MECHANICAL_FAILED",
  "RETRY_BUILD",
  "CRITIC_GREEN",
  "CRITIC_CHANGES_REQUIRED",
  "CRITIC_UNAVAILABLE",
  "MALFORMED_GIVEUP",
  "EXCEEDED_LIMIT",
] as const;

export type TaskEvent = (typeof TASK_EVENTS)[number];

const TERMINAL_STATES = new Set<TaskState>([
  "GREEN",
  "NEEDS_HUMAN",
  "UNVERIFIED_BY_CRITIC",
]);

/** Legal (state, event) -> nextState transitions. Anything absent is illegal. */
const TRANSITIONS: Record<TaskState, Partial<Record<TaskEvent, TaskState>>> = {
  PLANNED: {
    BUILD_STARTED: "BUILDING",
  },
  BUILDING: {
    MECHANICAL_PASSED: "CRITIC_REVIEWING",
    MECHANICAL_FAILED: "MECHANICAL_FAILED",
  },
  MECHANICAL_FAILED: {
    RETRY_BUILD: "BUILDING",
    EXCEEDED_LIMIT: "NEEDS_HUMAN",
  },
  CRITIC_REVIEWING: {
    CRITIC_GREEN: "GREEN",
    CRITIC_CHANGES_REQUIRED: "CHANGES_REQUIRED",
    CRITIC_UNAVAILABLE: "UNVERIFIED_BY_CRITIC",
    MALFORMED_GIVEUP: "NEEDS_HUMAN",
    // review-cycle cap hit on the final cycle: stop directly from review
    EXCEEDED_LIMIT: "NEEDS_HUMAN",
  },
  CHANGES_REQUIRED: {
    RETRY_BUILD: "BUILDING",
    EXCEEDED_LIMIT: "NEEDS_HUMAN",
  },
  GREEN: {},
  NEEDS_HUMAN: {},
  UNVERIFIED_BY_CRITIC: {},
};

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(state: TaskState, event: TaskEvent): boolean {
  return TRANSITIONS[state][event] !== undefined;
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly state: TaskState,
    public readonly event: TaskEvent,
  ) {
    super(`Illegal transition: ${state} --(${event})-->`);
    this.name = "IllegalTransitionError";
  }
}

/** Returns the next state for a (state, event) pair, or throws if illegal. */
export function nextState(state: TaskState, event: TaskEvent): TaskState {
  const next = TRANSITIONS[state][event];
  if (next === undefined) {
    throw new IllegalTransitionError(state, event);
  }
  return next;
}

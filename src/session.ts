import { randomUUID } from "node:crypto";
import type { LoopwrightConfig } from "./config.js";
import type { TaskSpec } from "./schemas/plan.js";
import type { TaskState } from "./domain/stateMachine.js";
import type { Finding } from "./schemas/critic.js";
import { createRoles, type CreateRolesOptions } from "./adapters/roleBindings.js";
import {
  runPlanReview,
  runTask,
  type LoopObserver,
  type PlanOutcome,
  type TaskOutcome,
} from "./engine/loop.js";
import type { CommandExecutor } from "./engine/mechanicalGate.js";
import type { Store } from "./storage/store.js";
import { storeObserver, combineObservers } from "./storage/checkpoint.js";

/**
 * End-to-end run (Task 15): goal -> reviewed plan -> per-task actor-critic loop
 * -> session summary. This is the headless entrypoint a CLI or desktop shell
 * calls; it ties configuration, the role-binding layer, and the Milestone 1
 * loop together without adding any new orchestration policy.
 *
 * Tasks execute sequentially in dependency order here; a dependent is SKIPPED
 * when a prerequisite did not reach a usable terminal state. Bounded concurrency
 * and isolated worktrees arrive in Milestone 4 and will slot in behind this same
 * entrypoint.
 */

export type SessionTaskStatus = "completed" | "skipped" | "resumed";

export interface SessionTaskResult {
  taskId: string;
  status: SessionTaskStatus;
  /** present when status is "completed" or "resumed" */
  outcome?: TaskOutcome;
  /** dependency ids that prevented this task from running (status === "skipped") */
  blockedBy?: string[];
}

export interface SessionResult {
  goal: string;
  /** present when a store was provided; the id to resume with */
  sessionId?: string;
  plan: PlanOutcome;
  results: SessionTaskResult[];
  /** task ids by terminal outcome (declared order) */
  green: string[];
  unverified: string[];
  needsHuman: string[];
  skipped: string[];
  /** true only when every task reached a verified GREEN */
  allVerified: boolean;
}

export interface RunGoalOptions extends CreateRolesOptions {
  /** injectable mechanical-gate command runner (defaults to real subprocess) */
  executor?: CommandExecutor;
  /** persistence; when set, transitions/attempts/outcomes are checkpointed */
  store?: Store;
  /** resume an existing session id (with `store`); reuses completed tasks */
  sessionId?: string;
  /** when true (with `store`), skip tasks already completed (GREEN/unverified) */
  resume?: boolean;
  /** extra observer composed with the store checkpointer (e.g. event log) */
  observer?: LoopObserver;
}

/** Terminal task states that allow dependents to proceed (see scheduler, M4). */
function isUnblockingState(state: TaskState): boolean {
  return state === "GREEN" || state === "UNVERIFIED_BY_CRITIC";
}

function isUnblocking(outcome: TaskOutcome | undefined): boolean {
  return outcome !== undefined && isUnblockingState(outcome.finalState);
}

/** Orders tasks so dependencies precede dependents (stable; rejects cycles). */
function dependencyOrder(tasks: TaskSpec[]): TaskSpec[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const ordered: TaskSpec[] = [];
  const visit = (task: TaskSpec, stack: string[]): void => {
    if (visited.has(task.id)) return;
    if (stack.includes(task.id)) {
      // A back-edge means the plan's dependency graph is cyclic and cannot be
      // scheduled. Fail loudly with the offending cycle rather than silently
      // dropping the edge (which would yield a partial order and cascading
      // skips); plans are expected to be acyclic (enforced in critic review).
      const cycle = [...stack.slice(stack.indexOf(task.id)), task.id].join(" -> ");
      throw new Error(`Plan dependency cycle detected: ${cycle}`);
    }
    stack.push(task.id);
    for (const depId of task.dependencies) {
      const dep = byId.get(depId);
      if (dep) visit(dep, stack);
    }
    stack.pop();
    visited.add(task.id);
    ordered.push(task);
  };
  for (const t of tasks) visit(t, []);
  return ordered;
}

export async function runGoal(
  goal: string,
  config: LoopwrightConfig,
  opts: RunGoalOptions = {},
): Promise<SessionResult> {
  const { executor, store, sessionId: sessionIdOpt, resume, observer: extraObserver, ...roleOpts } =
    opts;
  const { actor, critic } = createRoles(config, roleOpts);
  const cwd = opts.cwd ?? ".";

  // Session bootstrap (only when persisting). A new id is minted if none given.
  const sessionId = sessionIdOpt ?? (store ? randomUUID() : undefined);
  if (store && sessionId) {
    const existing = await store.getSession(sessionId);
    const now = new Date().toISOString();
    if (!existing) {
      await store.createSession({ id: sessionId, goal, createdAt: now, updatedAt: now, status: "running" });
    } else {
      await store.updateSession(sessionId, { status: "running" });
    }
  }

  // Checkpoint to the store and (optionally) fan out to a caller-supplied
  // observer such as an event log. Absent both, the loop runs unobserved.
  const observer =
    (store && sessionId) || extraObserver
      ? combineObservers(
          store && sessionId ? storeObserver(store, sessionId) : undefined,
          extraObserver,
        )
      : undefined;

  const baseDeps = {
    actor,
    critic,
    config,
    cwd,
    ...(executor ? { executor } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(observer ? { observer } : {}),
  };

  const plan = await runPlanReview(goal, baseDeps);
  if (store && sessionId) {
    await store.updateSession(sessionId, {
      planApproved: plan.approved,
      planRevisions: plan.revisions,
    });
  }

  const outcomes = new Map<string, TaskOutcome>();
  const results: SessionTaskResult[] = [];

  for (const task of dependencyOrder(plan.plan.tasks)) {
    // Resume: a task already completed (GREEN/unverified) in a prior run is
    // reused as-is, so an interrupted run doesn't repeat finished work.
    if (resume && store && sessionId) {
      const prior = await store.getOutcome(sessionId, task.id);
      if (prior && isUnblockingState(prior.finalState)) {
        outcomes.set(task.id, prior.outcome);
        results.push({ taskId: task.id, status: "resumed", outcome: prior.outcome });
        opts.log?.(`[${task.id}] RESUMED -- ${prior.finalState} (skipped rebuild)`);
        continue;
      }
    }

    const blockedBy = task.dependencies.filter((d) => !isUnblocking(outcomes.get(d)));
    if (blockedBy.length > 0) {
      results.push({ taskId: task.id, status: "skipped", blockedBy });
      opts.log?.(`[${task.id}] SKIPPED -- blocked by ${blockedBy.join(", ")}`);
      continue;
    }
    const outcome = await runTask(task, baseDeps);
    outcomes.set(task.id, outcome);
    results.push({ taskId: task.id, status: "completed", outcome });
  }

  // Summaries in the plan's declared order for stable, readable output.
  const ordered = plan.plan.tasks.map(
    (t) => results.find((r) => r.taskId === t.id) as SessionTaskResult,
  );

  const green: string[] = [];
  const unverified: string[] = [];
  const needsHuman: string[] = [];
  const skipped: string[] = [];

  for (const r of ordered) {
    if (r.status === "skipped") skipped.push(r.taskId);
    else if (r.outcome?.finalState === "GREEN") green.push(r.taskId);
    else if (r.outcome?.finalState === "UNVERIFIED_BY_CRITIC") unverified.push(r.taskId);
    else needsHuman.push(r.taskId);
  }

  if (store && sessionId) {
    await store.updateSession(sessionId, {
      status: needsHuman.length > 0 ? "needs_human" : "completed",
    });
  }

  return {
    goal,
    ...(sessionId ? { sessionId } : {}),
    plan,
    results: ordered,
    green,
    unverified,
    needsHuman,
    skipped,
    allVerified: green.length === plan.plan.tasks.length,
  };
}

/** Flattens a session's still-open blocking findings for reporting. */
export function openBlockers(result: SessionResult): Finding[] {
  const out: Finding[] = [];
  for (const r of result.results) {
    if (r.outcome) out.push(...r.outcome.unresolvedBlockers);
  }
  return out;
}

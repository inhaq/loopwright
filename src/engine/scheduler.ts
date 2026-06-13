import type { TaskSpec } from "../schemas/plan.js";
import type { TaskState } from "../domain/stateMachine.js";
import { runTask, type LoopDeps, type TaskOutcome } from "./loop.js";

/**
 * Dependency-graph scheduler (Task 19).
 *
 * Runs a plan's tasks as a DAG: a task starts only once every dependency has
 * reached an *unblocking* terminal state, at most `config.maxParallel` build
 * concurrently, and a dependent is SKIPPED (transitively) when a prerequisite
 * does not reach a usable state — so nothing is built on a broken base.
 *
 * Responsibilities the per-task loop (runTask) deliberately doesn't own:
 * ordering, concurrency, and dependency-failure propagation. The graph is
 * validated up front (duplicate ids, missing/self refs, cycles) so a malformed
 * plan fails fast instead of deadlocking.
 *
 * Two seams keep later milestones additive:
 *   - `workspaceFor` resolves a per-task working directory (git worktrees,
 *     Task 20) — default is the shared cwd.
 *   - `resumeOutcome` lets a completed task from a prior run be reused without
 *     rebuilding (checkpoint/resume, Milestone 3).
 */

/**
 * Terminal states that allow dependents to proceed. UNVERIFIED_BY_CRITIC is
 * included because it's an intentional proceed-degraded outcome; NEEDS_HUMAN is
 * not — building dependents on it would compound the failure.
 */
const UNBLOCKING_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "GREEN",
  "UNVERIFIED_BY_CRITIC",
]);

export interface SchedulerDeps extends LoopDeps {
  /** resolves the working directory a task builds in; defaults to deps.cwd */
  workspaceFor?: (task: TaskSpec) => string | Promise<string>;
  /** reuse a prior completed outcome instead of rebuilding (resume) */
  resumeOutcome?: (task: TaskSpec) => Promise<TaskOutcome | undefined> | TaskOutcome | undefined;
  /** called after each task settles (for cleanup, e.g. worktree teardown) */
  onTaskSettled?: (task: TaskSpec, result: ScheduledResult) => void | Promise<void>;
}

export type ScheduledTaskStatus = "completed" | "skipped" | "resumed";

export interface ScheduledResult {
  taskId: string;
  status: ScheduledTaskStatus;
  /** present for "completed"/"resumed" */
  outcome?: TaskOutcome;
  /** dependency ids that prevented this task (status === "skipped") */
  blockedBy?: string[];
}

export class InvalidPlanGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPlanGraphError";
  }
}

/** Validates references and acyclicity; throws on the first problem found. */
export function validateGraph(tasks: TaskSpec[]): void {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new InvalidPlanGraphError(`Duplicate task id: "${t.id}".`);
    ids.add(t.id);
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      if (dep === t.id) throw new InvalidPlanGraphError(`Task "${t.id}" depends on itself.`);
      if (!byId.has(dep)) {
        throw new InvalidPlanGraphError(`Task "${t.id}" depends on unknown task "${dep}".`);
      }
    }
  }

  // Cycle detection via DFS coloring (WHITE=unseen, GRAY=on stack, BLACK=done).
  const color = new Map<string, 0 | 1 | 2>(tasks.map((t) => [t.id, 0]));
  const visit = (id: string, path: string[]): void => {
    color.set(id, 1);
    for (const dep of (byId.get(id) as TaskSpec).dependencies) {
      const c = color.get(dep);
      if (c === 1) {
        throw new InvalidPlanGraphError(`Dependency cycle detected: ${[...path, dep].join(" -> ")}.`);
      }
      if (c === 0) visit(dep, [...path, dep]);
    }
    color.set(id, 2);
  };
  for (const t of tasks) {
    if (color.get(t.id) === 0) visit(t.id, [t.id]);
  }
}

function isUnblocking(result: ScheduledResult | undefined): boolean {
  return (
    result !== undefined &&
    result.status !== "skipped" &&
    result.outcome !== undefined &&
    UNBLOCKING_STATES.has(result.outcome.finalState)
  );
}

/** A finished dependency blocks dependents if it was skipped or ended non-unblocking. */
function isBlocking(result: ScheduledResult | undefined): boolean {
  if (result === undefined) return false; // not finished yet
  return !isUnblocking(result);
}

/**
 * Executes all tasks honoring dependencies + the parallelism cap. Returns one
 * result per task in the input's declared order.
 */
export async function runScheduledTasks(
  tasks: TaskSpec[],
  deps: SchedulerDeps,
): Promise<ScheduledResult[]> {
  validateGraph(tasks);

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const workspaceFor = deps.workspaceFor ?? (() => deps.cwd);
  const maxParallel = Math.max(1, deps.config.maxParallel);

  const results = new Map<string, ScheduledResult>();
  const remaining = new Set(tasks.map((t) => t.id));

  // Resume pre-pass: reuse any task already completed in a prior run. Reused
  // tasks count as unblocking for their dependents.
  if (deps.resumeOutcome) {
    for (const t of tasks) {
      const prior = await deps.resumeOutcome(t);
      if (prior && UNBLOCKING_STATES.has(prior.finalState)) {
        const r: ScheduledResult = { taskId: t.id, status: "resumed", outcome: prior };
        results.set(t.id, r);
        remaining.delete(t.id);
        deps.log?.(`[${t.id}] RESUMED -- ${prior.finalState} (skipped rebuild)`);
        await deps.onTaskSettled?.(t, r);
      }
    }
  }

  const running = new Map<string, Promise<{ id: string; outcome: TaskOutcome }>>();

  const depsSatisfied = (t: TaskSpec): boolean =>
    t.dependencies.every((d) => isUnblocking(results.get(d)));
  const blockingDeps = (t: TaskSpec): string[] =>
    t.dependencies.filter((d) => isBlocking(results.get(d)));

  while (remaining.size > 0 || running.size > 0) {
    // 1) Cascade-skip remaining tasks whose dependency is already blocked.
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...remaining]) {
        const bad = blockingDeps(byId.get(id) as TaskSpec);
        if (bad.length > 0) {
          const r: ScheduledResult = { taskId: id, status: "skipped", blockedBy: bad };
          results.set(id, r);
          remaining.delete(id);
          deps.log?.(`[${id}] SKIPPED -- blocked by ${bad.join(", ")}`);
          await deps.onTaskSettled?.(byId.get(id) as TaskSpec, r);
          changed = true;
        }
      }
    }

    // 2) Launch ready tasks up to the parallelism cap.
    for (const id of [...remaining]) {
      if (running.size >= maxParallel) break;
      const task = byId.get(id) as TaskSpec;
      if (!depsSatisfied(task)) continue;
      remaining.delete(id);
      const cwd = await workspaceFor(task);
      deps.log?.(`[${id}] START`);
      running.set(
        id,
        runTask(task, { ...deps, cwd }).then((outcome) => ({ id, outcome })),
      );
    }

    // 3) Nothing running and nothing launchable: all work is resolved.
    if (running.size === 0) break;

    // 4) Wait for the next task to finish, record it, and re-evaluate.
    const { id, outcome } = await Promise.race(running.values());
    running.delete(id);
    const r: ScheduledResult = { taskId: id, status: "completed", outcome };
    results.set(id, r);
    deps.log?.(`[${id}] DONE -- ${outcome.finalState}`);
    await deps.onTaskSettled?.(byId.get(id) as TaskSpec, r);
  }

  return tasks.map(
    (t) =>
      results.get(t.id) ?? {
        taskId: t.id,
        status: "skipped" as const,
        blockedBy: [],
      },
  );
}

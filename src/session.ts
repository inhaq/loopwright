import type { LoopwrightConfig } from "./config.js";
import type { TaskSpec } from "./schemas/plan.js";
import type { Finding } from "./schemas/critic.js";
import { createRoles, type CreateRolesOptions } from "./adapters/roleBindings.js";
import { runPlanReview, runTask, type PlanOutcome, type TaskOutcome } from "./engine/loop.js";
import type { CommandExecutor } from "./engine/mechanicalGate.js";

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

export type SessionTaskStatus = "completed" | "skipped";

export interface SessionTaskResult {
  taskId: string;
  status: SessionTaskStatus;
  /** present when status === "completed" */
  outcome?: TaskOutcome;
  /** dependency ids that prevented this task from running (status === "skipped") */
  blockedBy?: string[];
}

export interface SessionResult {
  goal: string;
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
}

/** Terminal task states that allow dependents to proceed (see scheduler, M4). */
function isUnblocking(outcome: TaskOutcome | undefined): boolean {
  return (
    outcome !== undefined &&
    (outcome.finalState === "GREEN" || outcome.finalState === "UNVERIFIED_BY_CRITIC")
  );
}

/** Orders tasks so dependencies precede dependents (stable; assumes acyclic). */
function dependencyOrder(tasks: TaskSpec[]): TaskSpec[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const ordered: TaskSpec[] = [];
  const visit = (task: TaskSpec, stack: Set<string>): void => {
    if (visited.has(task.id)) return;
    if (stack.has(task.id)) return; // cycle guard; engine validates elsewhere
    stack.add(task.id);
    for (const depId of task.dependencies) {
      const dep = byId.get(depId);
      if (dep) visit(dep, stack);
    }
    stack.delete(task.id);
    visited.add(task.id);
    ordered.push(task);
  };
  for (const t of tasks) visit(t, new Set());
  return ordered;
}

export async function runGoal(
  goal: string,
  config: LoopwrightConfig,
  opts: RunGoalOptions = {},
): Promise<SessionResult> {
  const { executor, ...roleOpts } = opts;
  const { actor, critic } = createRoles(config, roleOpts);

  const cwd = opts.cwd ?? ".";
  const baseDeps = {
    actor,
    critic,
    config,
    cwd,
    ...(executor ? { executor } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  };

  const plan = await runPlanReview(goal, baseDeps);

  const outcomes = new Map<string, TaskOutcome>();
  const results: SessionTaskResult[] = [];

  for (const task of dependencyOrder(plan.plan.tasks)) {
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

  return {
    goal,
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

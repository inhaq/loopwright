import { randomUUID } from "node:crypto";
import type { LoopwrightConfig } from "./config.js";
import type { Finding } from "./schemas/critic.js";
import { createRoles, type CreateRolesOptions } from "./adapters/roleBindings.js";
import {
  runPlanReview,
  type LoopObserver,
  type PlanOutcome,
  type TaskOutcome,
} from "./engine/loop.js";
import { runScheduledTasks, type SchedulerDeps } from "./engine/scheduler.js";
import { integrate, type IntegrationResult } from "./engine/integrator.js";
import { GitWorktreeManager } from "./workspace/worktrees.js";
import type { IntegrationBranch } from "./engine/integrator.js";
import type { CommandExecutor } from "./engine/mechanicalGate.js";
import type { Store, SessionStatus } from "./storage/store.js";
import { storeObserver, combineObservers } from "./storage/checkpoint.js";
import type { RunnerCallSink } from "./observability/instrument.js";
import { EVENT_TYPES } from "./observability/events.js";

/**
 * End-to-end run (Task 15): goal -> reviewed plan -> per-task actor-critic loop
 * -> session summary. This is the headless entrypoint a CLI or desktop shell
 * calls; it ties configuration, the role-binding layer, persistence, and the
 * loop together without adding new orchestration policy.
 *
 * Task execution is delegated to the dependency-graph scheduler (Task 19), so
 * independent tasks run concurrently up to `config.maxParallel`, dependents
 * wait for (and are skipped on) unsatisfied prerequisites, and completed tasks
 * are reused on resume.
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
  /** present when worktrees were used: merge + full-verification result */
  integration?: IntegrationResult;
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
  /** per-task working directory provider (git worktrees, Task 20) */
  workspaceFor?: SchedulerDeps["workspaceFor"];
  /** called after each task settles (e.g. worktree teardown, Task 20) */
  onTaskSettled?: SchedulerDeps["onTaskSettled"];
  /**
   * When set (and config.useWorktrees), each task builds in an isolated git
   * worktree off this repo and the resulting branches are integrated + verified
   * after the run (Tasks 20, 21).
   */
  repoDir?: string;
}

export async function runGoal(
  goal: string,
  config: LoopwrightConfig,
  opts: RunGoalOptions = {},
): Promise<SessionResult> {
  const {
    executor,
    store,
    sessionId: sessionIdOpt,
    resume,
    observer: extraObserver,
    workspaceFor,
    onTaskSettled,
    repoDir,
    ...roleOpts
  } = opts;
  const cwd = opts.cwd ?? ".";

  // Session bootstrap (only when persisting). The id is computed first so every
  // event — including runner calls — can be attributed to it.
  const sessionId = sessionIdOpt ?? (store ? randomUUID() : undefined);
  if (store && sessionId) {
    const existing = await store.getSession(sessionId);
    const now = new Date().toISOString();
    if (!existing) {
      await store.createSession({ id: sessionId, goal, createdAt: now, updatedAt: now, status: "running" });
    } else {
      await store.updateSession(sessionId, { status: "running" });
    }
    await store.recordEvent({
      sessionId,
      at: now,
      type: EVENT_TYPES.sessionStarted,
      data: { goal },
    });
  }

  // Worktree manager is held here so the `finally` below can guarantee cleanup
  // even when the run throws partway through.
  let wtManager: GitWorktreeManager | undefined;

  try {
    // Roles, instrumented so every runner invocation emits a structured event
    // (Task 22). When persisting, calls are recorded to the store's event stream.
    const onRunnerCall: RunnerCallSink | undefined =
      store && sessionId
        ? (e) =>
            store.recordEvent({
              sessionId,
              at: e.at,
              type: EVENT_TYPES.runnerCall,
              data: e as unknown as Record<string, unknown>,
            })
        : roleOpts.onRunnerCall;
    const { actor, critic } = createRoles(config, {
      ...roleOpts,
      ...(onRunnerCall ? { onRunnerCall } : {}),
    });

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
      await store.recordEvent({
        sessionId,
        at: new Date().toISOString(),
        type: EVENT_TYPES.planReviewed,
        data: { approved: plan.approved, revisions: plan.revisions, openItems: plan.openItems.length },
      });
    }

    // Isolated worktrees + integration (Tasks 20, 21), opt-in via repoDir. Each
    // task builds in its own git worktree; on success its changes are committed
    // on a per-task branch for the integrator to merge after the run. `wt` is a
    // const so its non-undefined narrowing holds inside the closures below;
    // `wtManager` mirrors it for the `finally` cleanup.
    const useWorktrees = Boolean(repoDir) && config.useWorktrees;
    const wt = useWorktrees
      ? new GitWorktreeManager({ repoDir: repoDir as string, sessionId: sessionId ?? randomUUID() })
      : undefined;
    wtManager = wt;
    const greenBranches: IntegrationBranch[] = [];

    const schedulerExtra: Partial<SchedulerDeps> = {};
    if (wt) {
      schedulerExtra.workspaceFor = async (t) => (await wt.acquire(t.id)).path;
      schedulerExtra.onTaskSettled = async (t, r) => {
        const unblocking =
          r.outcome?.finalState === "GREEN" || r.outcome?.finalState === "UNVERIFIED_BY_CRITIC";
        if (r.status === "completed" && unblocking) {
          const { committed } = await wt.commit(t.id, `loopwright(${t.id}): ${t.title}`);
          const branch = wt.branchFor(t.id);
          if (committed && branch) greenBranches.push({ taskId: t.id, branch });
        } else if (r.status !== "resumed") {
          await wt.release(t.id, { deleteBranch: true });
        }
      };
    } else {
      if (workspaceFor) schedulerExtra.workspaceFor = workspaceFor;
      if (onTaskSettled) schedulerExtra.onTaskSettled = onTaskSettled;
    }

    // The scheduler owns ordering, the parallelism cap, dependency-failure
    // propagation, and (via resumeOutcome) reuse of completed tasks.
    const results = await runScheduledTasks(plan.plan.tasks, {
      ...baseDeps,
      ...schedulerExtra,
      ...(resume && store && sessionId
        ? { resumeOutcome: async (t) => (await store.getOutcome(sessionId, t.id))?.outcome }
        : {}),
    });

    const green: string[] = [];
    const unverified: string[] = [];
    const needsHuman: string[] = [];
    const skipped: string[] = [];

    for (const r of results) {
      if (r.status === "skipped") skipped.push(r.taskId);
      else if (r.outcome?.finalState === "GREEN") green.push(r.taskId);
      else if (r.outcome?.finalState === "UNVERIFIED_BY_CRITIC") unverified.push(r.taskId);
      else needsHuman.push(r.taskId);
    }

    if (store && sessionId) {
      await store.recordEvent({
        sessionId,
        at: new Date().toISOString(),
        type: EVENT_TYPES.sessionFinished,
        data: {
          green,
          unverified,
          needsHuman,
          skipped,
          allVerified: green.length === plan.plan.tasks.length,
        },
      });
    }

    // Integrate the per-task branches and run full verification on the result.
    let integration: IntegrationResult | undefined;
    if (wt && greenBranches.length > 0) {
      const branchTaskIds = new Set(greenBranches.map((b) => b.taskId));
      const verifyCommands = [
        ...new Set(
          plan.plan.tasks
            .filter((t) => branchTaskIds.has(t.id))
            .flatMap((t) => t.verifyCommands),
        ),
      ];
      integration = await integrate({
        repoDir: repoDir as string,
        branches: greenBranches,
        ...(verifyCommands.length ? { verifyCommands } : {}),
        ...(executor ? { executor } : {}),
        ...(opts.log ? { log: opts.log } : {}),
      });
    }

    // Durable final status is decided LAST, so an integration that surfaced
    // conflicts or failed verification (integration.ok === false) marks the
    // session needs_human rather than leaving the earlier "completed" optimism.
    if (store && sessionId) {
      if (integration) {
        await store.recordEvent({
          sessionId,
          at: new Date().toISOString(),
          type: EVENT_TYPES.integration,
          data: {
            ok: integration.ok,
            merged: integration.merged,
            conflicts: integration.conflicts,
            integrationBranch: integration.integrationBranch,
            verification: integration.verification ?? null,
          },
        });
      }
      await store.updateSession(sessionId, {
        status: finalSessionStatus(needsHuman.length, integration),
      });
    }

    return {
      goal,
      ...(sessionId ? { sessionId } : {}),
      plan,
      results,
      green,
      unverified,
      needsHuman,
      skipped,
      allVerified: green.length === plan.plan.tasks.length,
      ...(integration ? { integration } : {}),
    };
  } catch (err) {
    // Any throw (planning, runner execution, worktree setup, integration,
    // cleanup) must leave the durable session in a terminal state, not stuck
    // "running". Record a structured failure, then rethrow so callers (e.g. the
    // server's SSE error status) still see it.
    if (store && sessionId) {
      try {
        await store.recordEvent({
          sessionId,
          at: new Date().toISOString(),
          type: EVENT_TYPES.sessionFailed,
          data: { error: String((err as Error)?.message ?? err) },
        });
        await store.updateSession(sessionId, { status: "failed" });
      } catch {
        /* best effort: never mask the original error with a persistence error */
      }
    }
    throw err;
  } finally {
    // Release any worktrees still held — covers both the normal end of a
    // worktree run and a throw during the run/integration/cleanup, so a failed
    // run can't leave .loopwright worktrees/branches behind.
    if (wtManager) {
      for (const held of wtManager.list()) {
        try {
          await wtManager.release(held.taskId);
        } catch {
          /* best effort cleanup */
        }
      }
    }
  }
}

/**
 * Decides the durable final session status. Integration that surfaced conflicts
 * or failed verification (integration.ok === false) is blocking and downgrades
 * an otherwise-complete session to needs_human.
 */
export function finalSessionStatus(
  needsHumanCount: number,
  integration?: { ok: boolean },
): SessionStatus {
  if (needsHumanCount > 0) return "needs_human";
  if (integration && !integration.ok) return "needs_human";
  return "completed";
}

/** Flattens a session's still-open blocking findings for reporting. */
export function openBlockers(result: SessionResult): Finding[] {
  const out: Finding[] = [];
  for (const r of result.results) {
    if (r.outcome) out.push(...r.outcome.unresolvedBlockers);
  }
  return out;
}

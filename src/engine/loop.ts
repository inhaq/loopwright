import type { LoopwrightConfig } from "../config.js";
import type { Plan, TaskSpec } from "../schemas/plan.js";
import {
  blockers as blockersOf,
  nits as nitsOf,
  normalizeReview,
  type Finding,
} from "../schemas/critic.js";
import type {
  MechanicalGateResult,
  TaskArtifactBundle,
} from "../schemas/artifact.js";
import {
  isTerminal,
  nextState,
  type TaskEvent,
  type TaskState,
} from "../domain/stateMachine.js";
import { runMechanicalGate, type CommandExecutor } from "./mechanicalGate.js";
import { guardProgress } from "./watchdog.js";
import { redact, redactAndTruncate } from "./redaction.js";
import { parseCriticResponse, REPAIR_HINT } from "./criticParser.js";
import type {
  Actor,
  BuildFeedback,
  Critic,
  CriticRequest,
  CriticRawResponse,
} from "../adapters/agents.js";

export interface LoopDeps {
  actor: Actor;
  critic: Critic;
  config: LoopwrightConfig;
  /** working directory the mechanical gate runs in (a worktree, later) */
  cwd: string;
  /** injectable command runner for the mechanical gate (tests/build/lint) */
  executor?: CommandExecutor;
  log?: (line: string) => void;
  /** optional observer for checkpointing / event logging (Milestones 3, 5) */
  observer?: LoopObserver;
  /**
   * No-progress threshold (ms) for the stuck watchdog; overrides
   * config.stuckThresholdMs when set. <= 0 disables it. (Milestone 3, Task 18)
   */
  stuckThresholdMs?: number;
}

/** A single state transition, surfaced to observers as it happens. */
export interface TransitionEvent {
  taskId: string;
  from: TaskState;
  event: TaskEvent;
  to: TaskState;
  reason: string;
  at: string;
}

/** A completed build attempt, surfaced to observers. */
export interface AttemptEvent {
  taskId: string;
  /** 1-based attempt number */
  attempt: number;
  summary: string;
  at: string;
}

/**
 * Observer hooks fired by the loop. Each is optional and awaited, so a store
 * (Milestone 3) can checkpoint every transition durably before the loop
 * advances, and the event log (Milestone 5) can record the same stream. When no
 * observer is supplied the loop behaves exactly as before.
 */
export interface LoopObserver {
  transition?(e: TransitionEvent): void | Promise<void>;
  attempt?(e: AttemptEvent): void | Promise<void>;
  outcome?(o: TaskOutcome): void | Promise<void>;
}

export interface HistoryEntry {
  at: string;
  from: TaskState;
  event: TaskEvent;
  to: TaskState;
  reason: string;
}

export interface TaskOutcome {
  taskId: string;
  finalState: TaskState;
  /** true ONLY when the real critic gave a green pass. Never true on fallback. */
  verified: boolean;
  history: HistoryEntry[];
  buildAttempts: number;
  reviewCycles: number;
  nits: Finding[];
  /** blocking findings still open when we stopped (NEEDS_HUMAN) */
  unresolvedBlockers: Finding[];
  /** human-readable reason for any non-GREEN terminal state */
  degradedReason?: string;
  lastDiff: string;
}

// ---------------------------------------------------------------------------
// Critic acquisition: handles quota exhaustion + retry-once-on-malformed.
// ---------------------------------------------------------------------------

type ReviewOutcome =
  | { kind: "green"; nits: Finding[] }
  | { kind: "changes"; blockers: Finding[]; nits: Finding[] }
  | { kind: "unavailable"; selfReviewNotes: Finding[]; reason: string } // -> UNVERIFIED_BY_CRITIC
  | { kind: "paused"; reason: string } // -> NEEDS_HUMAN
  | { kind: "malformed"; reason: string }; // -> NEEDS_HUMAN

async function askCritic(
  critic: Critic,
  baseReq: CriticRequest,
): Promise<{ resp: CriticRawResponse; req: CriticRequest }> {
  const resp = await critic.review(baseReq);
  return { resp, req: baseReq };
}

/** Runs the degraded path when the critic is unavailable (quota dry). */
async function fallbackUnavailable(
  deps: LoopDeps,
  bundle: TaskArtifactBundle,
): Promise<ReviewOutcome> {
  if (deps.config.criticFallback === "pause") {
    return { kind: "paused", reason: "Critic unavailable (quota) and fallback=pause." };
  }
  // actor self-review: best-effort, clearly marked as NOT a real critic pass.
  try {
    const resp = await deps.actor.selfReview(bundle);
    const parsed = parseCriticResponse(resp.text);
    // Only carry NON-blocking findings forward: in the degraded path these
    // become informational nits, and a blocker mislabeled as a nit would be
    // misleading (the result is already surfaced as UNVERIFIED_BY_CRITIC).
    const notes = parsed.ok ? nitsOf(normalizeReview(parsed.review).review) : [];
    return {
      kind: "unavailable",
      selfReviewNotes: notes,
      reason: "Critic quota exhausted; result self-reviewed by actor (UNVERIFIED).",
    };
  } catch {
    return {
      kind: "unavailable",
      selfReviewNotes: [],
      reason: "Critic quota exhausted; self-review unavailable (UNVERIFIED).",
    };
  }
}

async function obtainTaskReview(
  deps: LoopDeps,
  bundle: TaskArtifactBundle,
): Promise<ReviewOutcome> {
  // attempt 1
  let { resp } = await askCritic(deps.critic, { kind: "task", bundle });
  if (resp.quotaExhausted) return fallbackUnavailable(deps, bundle);

  let parsed = parseCriticResponse(resp.text);
  if (!parsed.ok) {
    // single retry with a corrective hint
    deps.log?.(`critic response malformed (${parsed.error}); retrying once`);
    resp = (await askCritic(deps.critic, {
      kind: "task",
      bundle,
      repairHint: REPAIR_HINT,
    })).resp;
    if (resp.quotaExhausted) return fallbackUnavailable(deps, bundle);
    parsed = parseCriticResponse(resp.text);
    if (!parsed.ok) {
      return {
        kind: "malformed",
        reason: `Critic returned unparseable output twice: ${parsed.error}`,
      };
    }
  }

  const { review } = normalizeReview(parsed.review);
  const nits = nitsOf(review);
  if (review.verdict === "green") return { kind: "green", nits };
  return { kind: "changes", blockers: blockersOf(review), nits };
}

// ---------------------------------------------------------------------------
// Artifact bundle assembly (everything redacted before it leaves the engine).
// ---------------------------------------------------------------------------

function buildBundle(
  task: TaskSpec,
  diff: string,
  touchedFiles: string[],
  gate: MechanicalGateResult,
): TaskArtifactBundle {
  return {
    task,
    diff: redactAndTruncate(diff),
    touchedFiles: touchedFiles.map((f) => redact(f)),
    mechanicalGate: gate, // step output already redacted by the gate runner
    testCommands: task.verifyCommands,
  };
}

// ---------------------------------------------------------------------------
// Single-task actor-critic loop.
// ---------------------------------------------------------------------------

export async function runTask(
  task: TaskSpec,
  deps: LoopDeps,
): Promise<TaskOutcome> {
  const { config } = deps;
  const history: HistoryEntry[] = [];
  const stuckThresholdMs = deps.stuckThresholdMs ?? config.stuckThresholdMs;

  let state: TaskState = "PLANNED";
  let buildAttempts = 0;
  let reviewCycles = 0;
  let mechFixAttempts = 0;
  const accumulatedNits: Finding[] = [];
  let unresolvedBlockers: Finding[] = [];
  let degradedReason: string | undefined;

  let feedback: BuildFeedback | undefined;
  let lastDiff = "";
  let lastTouched: string[] = [];
  let lastGate: MechanicalGateResult = { passed: true, steps: [] };

  const fire = async (event: TaskEvent, reason: string): Promise<TaskState> => {
    const from = state;
    state = nextState(from, event);
    const at = new Date().toISOString();
    history.push({ at, from, event, to: state, reason });
    deps.log?.(`[${task.id}] ${from} --(${event})--> ${state}  ${reason}`);
    await deps.observer?.transition?.({ taskId: task.id, from, event, to: state, reason, at });
    return state;
  };

  state = await fire("BUILD_STARTED", "initial build");

  while (!isTerminal(state)) {
    switch (state) {
      case "BUILDING": {
        buildAttempts++;
        const guardedBuild = await guardProgress(deps.actor.build(task, feedback), stuckThresholdMs);
        if (guardedBuild.stuck) {
          degradedReason = `No progress within ${guardedBuild.elapsedMs}ms while building (stuck).`;
          await fire("STUCK_ABORTED", degradedReason);
          break;
        }
        const built = guardedBuild.value;
        feedback = undefined;
        lastDiff = built.diff;
        lastTouched = built.touchedFiles;
        await deps.observer?.attempt?.({
          taskId: task.id,
          attempt: buildAttempts,
          summary: built.summary,
          at: new Date().toISOString(),
        });

        if (config.mechanicalGate) {
          lastGate = await runMechanicalGate(task.verifyCommands, {
            cwd: deps.cwd,
            ...(deps.executor ? { executor: deps.executor } : {}),
          });
          if (lastGate.passed) {
            await fire("MECHANICAL_PASSED", `gate passed (${lastGate.steps.length} step(s))`);
          } else {
            const failed = lastGate.steps.find((s) => !s.passed);
            await fire("MECHANICAL_FAILED", `gate failed: ${failed?.command ?? "unknown"}`);
          }
        } else {
          lastGate = { passed: true, steps: [] };
          await fire("MECHANICAL_PASSED", "mechanical gate disabled by config");
        }
        break;
      }

      case "MECHANICAL_FAILED": {
        if (mechFixAttempts >= config.mechanicalFixMax) {
          degradedReason = `Mechanical gate still failing after ${mechFixAttempts} fix attempt(s).`;
          await fire("EXCEEDED_LIMIT", degradedReason);
          break;
        }
        mechFixAttempts++;
        feedback = { mechanicalFailure: lastGate };
        await fire("RETRY_BUILD", `actor fixing mechanical failure (attempt ${mechFixAttempts})`);
        break;
      }

      case "CRITIC_REVIEWING": {
        const bundle = buildBundle(task, lastDiff, lastTouched, lastGate);
        const guardedReview = await guardProgress(obtainTaskReview(deps, bundle), stuckThresholdMs);
        if (guardedReview.stuck) {
          degradedReason = `No progress within ${guardedReview.elapsedMs}ms during critic review (stuck).`;
          await fire("STUCK_ABORTED", degradedReason);
          break;
        }
        const review = guardedReview.value;

        switch (review.kind) {
          case "green": {
            accumulatedNits.push(...review.nits);
            await fire("CRITIC_GREEN", "critic green pass");
            break;
          }
          case "changes": {
            accumulatedNits.push(...review.nits);
            reviewCycles++;
            if (reviewCycles >= config.taskReviewCyclesMax) {
              unresolvedBlockers = review.blockers;
              degradedReason = `Critic still blocking after ${reviewCycles} review cycle(s).`;
              await fire("EXCEEDED_LIMIT", degradedReason);
            } else {
              feedback = { criticBlockers: review.blockers };
              await fire(
                "CRITIC_CHANGES_REQUIRED",
                `${review.blockers.length} blocker(s) (cycle ${reviewCycles})`,
              );
            }
            break;
          }
          case "unavailable": {
            accumulatedNits.push(...review.selfReviewNotes);
            degradedReason = review.reason;
            await fire("CRITIC_UNAVAILABLE", review.reason);
            break;
          }
          case "paused": {
            degradedReason = review.reason;
            await fire("MALFORMED_GIVEUP", review.reason); // routes to NEEDS_HUMAN
            break;
          }
          case "malformed": {
            degradedReason = review.reason;
            await fire("MALFORMED_GIVEUP", review.reason);
            break;
          }
        }
        break;
      }

      case "CHANGES_REQUIRED": {
        await fire("RETRY_BUILD", "actor addressing critic blockers");
        break;
      }
    }
  }

  const outcome: TaskOutcome = {
    taskId: task.id,
    finalState: state,
    verified: state === "GREEN",
    history,
    buildAttempts,
    reviewCycles,
    nits: accumulatedNits,
    unresolvedBlockers,
    ...(degradedReason ? { degradedReason } : {}),
    lastDiff,
  };
  await deps.observer?.outcome?.(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Plan-review loop (critic gates the DAG before any building starts).
// ---------------------------------------------------------------------------

export interface PlanHistoryEntry {
  at: string;
  round: number;
  verdict: "green" | "changes_required" | "unavailable" | "malformed";
  blockers: number;
  note: string;
}

export interface PlanOutcome {
  plan: Plan;
  approved: boolean;
  proceededWithOpenItems: boolean;
  openItems: Finding[];
  revisions: number;
  history: PlanHistoryEntry[];
}

async function obtainPlanReview(
  deps: LoopDeps,
  goal: string,
  plan: Plan,
): Promise<ReviewOutcome> {
  let resp = await deps.critic.review({ kind: "plan", goal, plan });
  if (resp.quotaExhausted) {
    return { kind: "unavailable", selfReviewNotes: [], reason: "Critic unavailable for plan review." };
  }
  let parsed = parseCriticResponse(resp.text);
  if (!parsed.ok) {
    resp = await deps.critic.review({ kind: "plan", goal, plan, repairHint: REPAIR_HINT });
    if (resp.quotaExhausted) {
      return { kind: "unavailable", selfReviewNotes: [], reason: "Critic unavailable for plan review." };
    }
    parsed = parseCriticResponse(resp.text);
    if (!parsed.ok) {
      return { kind: "malformed", reason: `Plan review unparseable: ${parsed.error}` };
    }
  }
  const { review } = normalizeReview(parsed.review);
  if (review.verdict === "green") return { kind: "green", nits: nitsOf(review) };
  return { kind: "changes", blockers: blockersOf(review), nits: nitsOf(review) };
}

export async function runPlanReview(
  goal: string,
  deps: LoopDeps,
): Promise<PlanOutcome> {
  const { config } = deps;
  const history: PlanHistoryEntry[] = [];

  let draft = await deps.actor.draftPlan(goal);
  let plan = draft.plan;
  let revisions = 0;

  for (;;) {
    const review = await obtainPlanReview(deps, goal, plan);
    const round = revisions + 1;

    if (review.kind === "green") {
      history.push({ at: new Date().toISOString(), round, verdict: "green", blockers: 0, note: "plan approved" });
      return { plan, approved: true, proceededWithOpenItems: false, openItems: [], revisions, history };
    }

    if (review.kind === "unavailable" || review.kind === "malformed") {
      history.push({
        at: new Date().toISOString(),
        round,
        verdict: review.kind,
        blockers: 0,
        note: `${review.reason} -- proceeding with unverified plan`,
      });
      return { plan, approved: false, proceededWithOpenItems: true, openItems: [], revisions, history };
    }

    if (review.kind === "paused") {
      history.push({ at: new Date().toISOString(), round, verdict: "malformed", blockers: 0, note: review.reason });
      return { plan, approved: false, proceededWithOpenItems: true, openItems: [], revisions, history };
    }

    // changes_required
    history.push({
      at: new Date().toISOString(),
      round,
      verdict: "changes_required",
      blockers: review.blockers.length,
      note: `${review.blockers.length} blocker(s)`,
    });

    if (revisions >= config.planReviewMax) {
      return {
        plan,
        approved: false,
        proceededWithOpenItems: true,
        openItems: review.blockers,
        revisions,
        history,
      };
    }

    revisions++;
    draft = await deps.actor.draftPlan(goal, review.blockers);
    plan = draft.plan;
  }
}

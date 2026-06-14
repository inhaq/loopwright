import type { Plan, TaskSpec } from "../schemas/plan.js";
import type { Finding } from "../schemas/critic.js";
import type {
  MechanicalGateResult,
  TaskArtifactBundle,
} from "../schemas/artifact.js";

/**
 * Role interfaces the orchestration loop depends on. Roles are vendor-neutral:
 * each is backed by an AgentRunner (see ../runners/agentRunner.ts) chosen via
 * config, so the engine never knows or cares which provider/model is behind a
 * role. Phase 0 ships mock implementations; real implementations wrap a runner
 * plus prompt templates. Adapters return RAW text where a model would; the
 * engine owns parsing/validation so every backend goes through one contract.
 */

export interface BuildFeedback {
  /** present when the previous attempt failed the mechanical gate */
  mechanicalFailure?: MechanicalGateResult;
  /** present when the critic returned blocking findings to fix */
  criticBlockers?: Finding[];
}

export interface ActorBuildResult {
  /** unified diff produced by this attempt (raw; redacted by the engine) */
  diff: string;
  touchedFiles: string[];
  summary: string;
}

export interface PlanDraftResult {
  plan: Plan;
  /** notes the actor wants the critic/human to see */
  notes?: string;
}

/** The ACTOR role: plans, builds, fixes. The high-volume workhorse. */
export interface Actor {
  /** Draft or revise the plan. `feedback` carries critic blockers on revision. */
  draftPlan(goal: string, feedback?: Finding[]): Promise<PlanDraftResult>;

  /**
   * Build the task, or fix it given feedback from a previous failed attempt.
   * `cwd` is the working directory the build should operate in — the task's
   * isolated git worktree when worktrees are enabled — so a file-editing runner
   * edits inside that worktree rather than a shared/default directory. It is
   * passed per call (not bound to the role) so parallel tasks in different
   * worktrees never collide.
   */
  build(task: TaskSpec, feedback?: BuildFeedback, cwd?: string): Promise<ActorBuildResult>;

  /**
   * Degraded self-review used ONLY when the critic is unavailable (quota dry).
   * Returns raw text in the same contract the critic uses, so it parses
   * identically -- but the result is recorded as UNVERIFIED_BY_CRITIC. `cwd` is
   * the task's working directory (see {@link Actor.build}).
   */
  selfReview(bundle: TaskArtifactBundle, cwd?: string): Promise<CriticRawResponse>;
}

export type CriticRequest =
  | { kind: "plan"; goal: string; plan: Plan; repairHint?: string }
  | { kind: "task"; bundle: TaskArtifactBundle; repairHint?: string };

export interface CriticRawResponse {
  /** raw model text; the engine parses + validates it */
  text: string;
  /** set when the provider reports the quota/rate window is exhausted */
  quotaExhausted?: boolean;
}

/** The CRITIC role: reviews the plan + each task. The scarce, gating resource. */
export interface Critic {
  /** Review a plan or a task. `cwd` is the task's working directory (worktree). */
  review(req: CriticRequest, cwd?: string): Promise<CriticRawResponse>;
}

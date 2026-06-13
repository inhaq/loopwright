import type { Plan, TaskSpec } from "../schemas/plan.js";
import type { Finding } from "../schemas/critic.js";
import type { TaskArtifactBundle } from "../schemas/artifact.js";
import type {
  Actor,
  ActorBuildResult,
  BuildFeedback,
  Critic,
  CriticRawResponse,
  CriticRequest,
  PlanDraftResult,
} from "./agents.js";
import {
  type CommandExecutor,
  type CommandOutcome,
} from "../engine/mechanicalGate.js";

/**
 * Deterministic, scriptable mocks. They let us validate the orchestration loop
 * end-to-end before any real agent backend exists. Responses are scripted
 * as queues consumed in order (the last entry repeats if the queue runs out).
 */

// ---- critic response builders --------------------------------------------

export function criticGreen(summary = "Looks correct.", nits: Finding[] = []): CriticRawResponse {
  return { text: JSON.stringify({ verdict: "green", summary, findings: nits }) };
}

export function criticBlock(findings: Finding[], summary = "Changes required."): CriticRawResponse {
  return { text: JSON.stringify({ verdict: "changes_required", summary, findings }) };
}

/** Wrap valid JSON in a markdown fence + prose to exercise the extractor. */
export function criticFenced(summary = "Done.", findings: Finding[] = []): CriticRawResponse {
  const json = JSON.stringify({ verdict: findings.some((f) => f.severity === "blocker") ? "changes_required" : "green", summary, findings });
  return { text: `Here is my review:\n\n\`\`\`json\n${json}\n\`\`\`\nThanks!` };
}

export function criticMalformed(text = "Sorry, I cannot produce JSON right now."): CriticRawResponse {
  return { text };
}

export function criticQuotaExhausted(): CriticRawResponse {
  return { text: "", quotaExhausted: true };
}

// ---- scripted executor (mechanical gate) ----------------------------------

/**
 * Build a CommandExecutor from a responder keyed by command + per-command call
 * index, so you can simulate "fails first, passes after the fix".
 */
export function scriptedExecutor(
  responder: (command: string, callIndex: number) => { exitCode: number; output?: string },
): CommandExecutor {
  const counts = new Map<string, number>();
  return async (command: string): Promise<CommandOutcome> => {
    const idx = counts.get(command) ?? 0;
    counts.set(command, idx + 1);
    const r = responder(command, idx);
    return { exitCode: r.exitCode, output: r.output ?? "", durationMs: 1 };
  };
}

// ---- mock actor -----------------------------------------------------------

export interface MockActorOptions {
  /** plans[0] is the initial draft; plans[n] is returned after the n-th revision */
  plans: Plan[];
  /** optional custom build behavior; defaults to a synthetic diff */
  build?: (task: TaskSpec, feedback: BuildFeedback | undefined, attempt: number) => ActorBuildResult;
  selfReview?: CriticRawResponse;
}

export class MockActor implements Actor {
  private planCalls = 0;
  private buildCounts = new Map<string, number>();

  constructor(private readonly opts: MockActorOptions) {}

  async draftPlan(_goal: string, _feedback?: Finding[]): Promise<PlanDraftResult> {
    const idx = Math.min(this.planCalls, this.opts.plans.length - 1);
    this.planCalls++;
    return { plan: this.opts.plans[idx] as Plan };
  }

  async build(task: TaskSpec, feedback?: BuildFeedback): Promise<ActorBuildResult> {
    const attempt = this.buildCounts.get(task.id) ?? 0;
    this.buildCounts.set(task.id, attempt + 1);
    if (this.opts.build) return this.opts.build(task, feedback, attempt);
    const reason = feedback?.criticBlockers
      ? "addressing critic blockers"
      : feedback?.mechanicalFailure
        ? "fixing failed checks"
        : "initial build";
    return {
      diff: `--- a/src/${task.id}.ts\n+++ b/src/${task.id}.ts\n@@ attempt ${attempt} (${reason}) @@`,
      touchedFiles: [`src/${task.id}.ts`],
      summary: `${task.id}: ${reason} (attempt ${attempt})`,
    };
  }

  async selfReview(_bundle: TaskArtifactBundle): Promise<CriticRawResponse> {
    return (
      this.opts.selfReview ??
      criticGreen("Actor self-review: no blockers spotted (UNVERIFIED).")
    );
  }
}

// ---- mock critic ----------------------------------------------------------

export interface MockCriticOptions {
  planResponses?: CriticRawResponse[];
  taskResponses?: Record<string, CriticRawResponse[]>;
  fallback?: CriticRawResponse;
}

export class MockCritic implements Critic {
  private planIdx = 0;
  private taskIdx = new Map<string, number>();

  constructor(private readonly opts: MockCriticOptions = {}) {}

  private take(queue: CriticRawResponse[] | undefined, idx: number): CriticRawResponse {
    if (queue && queue.length > 0) {
      return queue[Math.min(idx, queue.length - 1)] as CriticRawResponse;
    }
    return this.opts.fallback ?? criticGreen();
  }

  async review(req: CriticRequest): Promise<CriticRawResponse> {
    if (req.kind === "plan") {
      const r = this.take(this.opts.planResponses, this.planIdx);
      this.planIdx++;
      return r;
    }
    const id = req.bundle.task.id;
    const idx = this.taskIdx.get(id) ?? 0;
    this.taskIdx.set(id, idx + 1);
    return this.take(this.opts.taskResponses?.[id], idx);
  }
}

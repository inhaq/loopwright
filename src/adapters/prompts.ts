import { z } from "zod";
import { TaskSpecSchema, type Plan, type TaskSpec } from "../schemas/plan.js";
import type { Finding } from "../schemas/critic.js";
import type { TaskArtifactBundle } from "../schemas/artifact.js";
import type { BuildFeedback } from "./agents.js";

/**
 * Role prompt templates + the wire contracts the runner output must satisfy.
 *
 * The role-binding layer (see runnerRoles.ts) turns a vendor-neutral
 * AgentRunner into a working Actor/Critic by pairing it with these prompts.
 * Prompts are data, not code: every template is overridable so an operator can
 * tune wording per backend without touching the engine.
 *
 * Two output styles:
 *   - The CRITIC and the actor's degraded self-review emit the rubric JSON the
 *     engine already validates (schemas/critic + engine/criticParser).
 *   - The ACTOR's plan/build outputs use the small JSON contracts defined here
 *     and are validated with the same last-valid-JSON scan as the critic.
 */

// ---------------------------------------------------------------------------
// Actor output wire contracts (validated by runnerRoles via parseLastValidJson)
// ---------------------------------------------------------------------------

/**
 * Plan draft payload. The goal is injected by the engine (the model is given
 * it, but the authoritative goal is never taken from model output), so the
 * model only returns the task list plus optional notes.
 */
export const ActorPlanOutputSchema = z
  .object({
    tasks: z.array(TaskSpecSchema).min(1),
    notes: z.string().optional(),
  })
  .strip();
export type ActorPlanOutput = z.infer<typeof ActorPlanOutputSchema>;

/** Build payload: a unified diff plus the files it touched and a short summary. */
export const ActorBuildOutputSchema = z
  .object({
    diff: z.string(),
    touchedFiles: z.array(z.string()).default([]),
    summary: z.string().default(""),
  })
  .strip();
export type ActorBuildOutput = z.infer<typeof ActorBuildOutputSchema>;

// ---------------------------------------------------------------------------
// Shared rendering helpers
// ---------------------------------------------------------------------------

function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return "(none)";
  return findings
    .map(
      (f, i) =>
        `  ${i + 1}. [${f.severity}/${f.category}]${f.location ? ` (${f.location})` : ""} ${f.detail}`,
    )
    .join("\n");
}

function renderTask(task: TaskSpec): string {
  return [
    `id: ${task.id}`,
    `title: ${task.title}`,
    `description: ${task.description || "(none)"}`,
    `acceptanceCriteria:\n${task.acceptanceCriteria.map((c) => `  - ${c}`).join("\n")}`,
    `verifyCommands: ${task.verifyCommands.length ? task.verifyCommands.join(", ") : "(none)"}`,
    `dependencies: ${task.dependencies.length ? task.dependencies.join(", ") : "(none)"}`,
  ].join("\n");
}

function renderGate(bundle: TaskArtifactBundle): string {
  const g = bundle.mechanicalGate;
  if (g.steps.length === 0) {
    return `mechanical gate: passed=${g.passed} (no verify commands ran)`;
  }
  const steps = g.steps
    .map(
      (s) =>
        `  - ${s.command} -> exit ${s.exitCode} (${s.passed ? "pass" : "FAIL"})\n` +
        `    output: ${s.output.slice(0, 1500)}`,
    )
    .join("\n");
  return `mechanical gate: passed=${g.passed}\n${steps}`;
}

function renderBundle(bundle: TaskArtifactBundle): string {
  return [
    "TASK:",
    renderTask(bundle.task),
    "",
    renderGate(bundle),
    "",
    `touchedFiles: ${bundle.touchedFiles.length ? bundle.touchedFiles.join(", ") : "(none)"}`,
    "",
    "DIFF:",
    bundle.diff || "(empty diff)",
  ].join("\n");
}

function renderBuildFeedback(feedback?: BuildFeedback): string {
  if (!feedback) return "";
  const parts: string[] = [];
  if (feedback.mechanicalFailure) {
    const failed = feedback.mechanicalFailure.steps.find((s) => !s.passed);
    parts.push(
      "The previous attempt FAILED the mechanical gate. Make the next attempt " +
        "different so it passes. Failing step:\n" +
        (failed
          ? `  ${failed.command} -> exit ${failed.exitCode}\n  output: ${failed.output.slice(0, 2000)}`
          : "  (unknown step)"),
    );
  }
  if (feedback.criticBlockers && feedback.criticBlockers.length > 0) {
    parts.push(
      "The critic raised BLOCKERS you must resolve:\n" +
        renderFindings(feedback.criticBlockers),
    );
  }
  return parts.length ? `\n\nPRIOR FAILURE CONTEXT:\n${parts.join("\n\n")}` : "";
}

// ---------------------------------------------------------------------------
// Critic JSON contract (mirrors schemas/critic; kept in one place for prompts)
// ---------------------------------------------------------------------------

const CRITIC_JSON_CONTRACT =
  'Reply with ONLY a JSON object (no prose, no markdown fences) matching:\n' +
  '{"verdict":"green"|"changes_required","summary":string,' +
  '"findings":[{"severity":"blocker"|"nit","category":' +
  '"correctness"|"requirements"|"test_integrity"|"breakage"|"security"|"style"|"other",' +
  '"detail":string,"location":string}]}';

const RUBRIC_RULES =
  "Rubric (enforced): a finding may be a `blocker` ONLY when its category is " +
  "one of correctness, requirements, test_integrity, breakage, security. " +
  "Anything else (style, other) is a `nit` and must NEVER demand another " +
  "change cycle. Set verdict to `changes_required` if and only if at least one " +
  "real blocker exists; otherwise `green`. Do not block on taste or preference.";

// ---------------------------------------------------------------------------
// Prompt template interfaces
// ---------------------------------------------------------------------------

export interface ActorPromptTemplates {
  system: string;
  /** draft (or, with blockers, revise) the plan for a goal */
  draftPlan(goal: string, blockers?: Finding[]): string;
  /** build a task, or fix it given feedback from a prior failed attempt */
  build(task: TaskSpec, feedback?: BuildFeedback): string;
  /** degraded self-review when the critic is unavailable (emits rubric JSON) */
  selfReview(bundle: TaskArtifactBundle): string;
}

export interface CriticPromptTemplates {
  system: string;
  /** review the decomposition before any building starts */
  planReview(goal: string, plan: Plan, repairHint?: string): string;
  /** review a built task result (diff + gate output) */
  taskReview(bundle: TaskArtifactBundle, repairHint?: string): string;
}

// ---------------------------------------------------------------------------
// Default templates (vendor-neutral)
// ---------------------------------------------------------------------------

const ACTOR_PLAN_CONTRACT =
  'Reply with ONLY a JSON object (no prose, no markdown fences) matching:\n' +
  '{"tasks":[{"id":string,"title":string,"description":string,' +
  '"acceptanceCriteria":[string,...],"verifyCommands":[string,...],' +
  '"dependencies":[string,...]}],"notes":string}\n' +
  "Rules: ids are unique and short; every task has at least one acceptance " +
  "criterion AND at least one machine-checkable verifyCommand (build/test/lint) " +
  "so its done-state is verifiable; dependencies reference other task ids only.";

const ACTOR_BUILD_CONTRACT =
  'Reply with ONLY a JSON object (no prose, no markdown fences) matching:\n' +
  '{"diff":string,"touchedFiles":[string,...],"summary":string}\n' +
  "`diff` is a unified diff of your changes; `touchedFiles` lists the paths it " +
  "changes; `summary` is one or two sentences. Do not include secrets.";

export const DEFAULT_ACTOR_PROMPTS: ActorPromptTemplates = {
  system:
    "You are the Actor in an actor-critic engineering loop: the high-volume " +
    "worker that decomposes goals into verifiable tasks, builds each task, and " +
    "fixes issues from feedback. You are vendor-neutral and reply with strict " +
    "JSON when asked. Favor small, verifiable units of work.",

  draftPlan(goal, blockers) {
    const revision =
      blockers && blockers.length > 0
        ? `\n\nThis is a REVISION. The critic blocked the previous plan; ` +
          `resolve every blocker below:\n${renderFindings(blockers)}`
        : "";
    return (
      `Decompose this goal into a plan of dependent tasks.\n\nGOAL: ${goal}` +
      revision +
      `\n\n${ACTOR_PLAN_CONTRACT}`
    );
  },

  build(task, feedback) {
    return (
      `Build the following task. Produce the smallest change that fully ` +
      `satisfies its acceptance criteria and will pass its verifyCommands.\n\n` +
      `${renderTask(task)}` +
      `${renderBuildFeedback(feedback)}` +
      `\n\n${ACTOR_BUILD_CONTRACT}`
    );
  },

  selfReview(bundle) {
    return (
      "The critic is unavailable, so review your OWN work honestly as a " +
      "stand-in. Be conservative; do not hide problems.\n\n" +
      `${renderBundle(bundle)}\n\n${RUBRIC_RULES}\n\n${CRITIC_JSON_CONTRACT}`
    );
  },
};

export const DEFAULT_CRITIC_PROMPTS: CriticPromptTemplates = {
  system:
    "You are the Critic in an actor-critic engineering loop: the scarce, " +
    "gating reviewer. You hold the green-pass gate and only block on " +
    "substantive problems, never on taste. You are vendor-neutral and reply " +
    "with strict rubric JSON.",

  planReview(goal, plan, repairHint) {
    const hint = repairHint ? `\n\n${repairHint}` : "";
    return (
      `Review this PLAN before any building starts. Check that the tasks fully ` +
      `cover the goal, each task has a machine-checkable done-state ` +
      `(verifyCommands), and the dependencies are coherent and acyclic.\n\n` +
      `GOAL: ${goal}\n\nPLAN:\n${JSON.stringify(plan, null, 2)}\n\n` +
      `${RUBRIC_RULES}\n\n${CRITIC_JSON_CONTRACT}${hint}`
    );
  },

  taskReview(bundle, repairHint) {
    const hint = repairHint ? `\n\n${repairHint}` : "";
    return (
      `Review this built TASK result. The mechanical gate (build/test/lint) ` +
      `already ran; reason over its real output, do not replace it. Focus on ` +
      `correctness, requirements coverage, test integrity, regressions, and ` +
      `security.\n\n${renderBundle(bundle)}\n\n` +
      `${RUBRIC_RULES}\n\n${CRITIC_JSON_CONTRACT}${hint}`
    );
  },
};

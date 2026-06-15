import type { z } from "zod";
import { PlanSchema } from "../schemas/plan.js";
import type { TaskSpec } from "../schemas/plan.js";
import type { Finding } from "../schemas/critic.js";
import type { TaskArtifactBundle } from "../schemas/artifact.js";
import type { AgentRunner, RunnerActivity } from "../runners/agentRunner.js";
import { parseLastValidJson, type JsonParseResult } from "../engine/jsonExtract.js";
import type { RoleName, RunnerActivityEvent } from "../observability/events.js";
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
  ActorBuildOutputSchema,
  ActorPlanOutputSchema,
  DEFAULT_ACTOR_PROMPTS,
  DEFAULT_CRITIC_PROMPTS,
  type ActorPromptTemplates,
  type CriticPromptTemplates,
} from "./prompts.js";

/**
 * The role-binding layer: turns a vendor-neutral {@link AgentRunner} plus role
 * prompt templates into working {@link Actor} / {@link Critic} implementations.
 *
 * This is the seam the rest of Milestone 2 plugs into: any backend (CliRunner
 * today, HttpRunner next) becomes a usable actor/critic with no engine changes.
 *
 * Division of responsibility, kept consistent with the mocks:
 *   - The ACTOR's `draftPlan`/`build` return STRUCTURED data, so this layer
 *     parses + validates the runner's JSON here (with a single repair retry).
 *   - The ACTOR's `selfReview` and the CRITIC's `review` return RAW text in the
 *     critic contract; the engine owns parsing/rubric enforcement, so we pass
 *     the text straight through (including the quota-exhausted signal).
 *
 * Roles never carry a per-call working directory in their signatures yet
 * (isolated worktrees are Milestone 4), so the workspace is fixed per binding
 * via `cwd` and threaded into every runner call.
 */

/** Thrown when a runner-backed actor cannot produce usable structured output. */
export class RunnerRoleError extends Error {
  readonly quotaExhausted: boolean;
  constructor(message: string, opts: { quotaExhausted?: boolean } = {}) {
    super(message);
    this.name = "RunnerRoleError";
    this.quotaExhausted = opts.quotaExhausted ?? false;
  }
}

/** Appended to the original prompt on the single retry after malformed output. */
const PARSE_REPAIR_NUDGE =
  "Your previous reply could not be parsed. Reply with ONLY the JSON object " +
  "described above - no prose, no markdown fences, no trailing commentary.";

export interface RunnerActorOptions {
  prompts?: ActorPromptTemplates;
  /** workspace the runner operates in (single dir until worktrees land) */
  cwd?: string;
  /** retry once with a corrective nudge when output won't parse (default true) */
  repairOnce?: boolean;
  log?: (line: string) => void;
  /** cooperative cancellation, threaded into every runner call */
  signal?: AbortSignal;
  /** sink for mid-call runner activity (sub-step streaming), if any */
  onActivity?: (e: RunnerActivityEvent) => void;
  /**
   * Steering registration. Threaded into each runner call as `req.steering`;
   * a runner with an inner loop invokes it with a `steer(text)` bound to that
   * live call, so a supervisor can nudge the in-flight work.
   */
  onSteer?: (steer: (text: string) => void) => void;
}

export interface RunnerCriticOptions {
  prompts?: CriticPromptTemplates;
  cwd?: string;
  log?: (line: string) => void;
  /** cooperative cancellation, threaded into every runner call */
  signal?: AbortSignal;
  /** sink for mid-call runner activity (sub-step streaming), if any */
  onActivity?: (e: RunnerActivityEvent) => void;
  /** steering registration, threaded into each runner call as req.steering */
  onSteer?: (steer: (text: string) => void) => void;
}

/**
 * Builds the per-call `onEvent` sink that enriches a runner's vendor-neutral
 * {@link RunnerActivity} with the role + runner identity before forwarding it
 * to the role's activity sink. Returns undefined when no sink is configured, so
 * runners that stream skip the work entirely.
 */
function activityForwarder(
  runner: AgentRunner,
  role: RoleName,
  onActivity: ((e: RunnerActivityEvent) => void) | undefined,
): ((a: RunnerActivity) => void) | undefined {
  if (!onActivity) return undefined;
  return (a: RunnerActivity) =>
    onActivity({
      role,
      runnerId: runner.profile.id,
      model: runner.profile.model,
      phase: a.phase,
      ...(a.toolName !== undefined ? { toolName: a.toolName } : {}),
      ...(a.toolCallId !== undefined ? { toolCallId: a.toolCallId } : {}),
      ...(a.isError !== undefined ? { isError: a.isError } : {}),
      ...(a.turn !== undefined ? { turn: a.turn } : {}),
      at: a.at,
    });
}

/** Actor role backed by an AgentRunner + prompt templates. */
export class RunnerActor implements Actor {
  private readonly runner: AgentRunner;
  private readonly prompts: ActorPromptTemplates;
  private readonly cwd: string;
  private readonly repairOnce: boolean;
  private readonly log: ((line: string) => void) | undefined;
  private readonly signal: AbortSignal | undefined;
  /** per-call activity sink, enriched with role identity (undefined = off) */
  private readonly onEvent: ((a: RunnerActivity) => void) | undefined;
  /** steering registration passed as req.steering on every run (undefined = off) */
  private readonly steerRegister: ((steer: (text: string) => void) => void) | undefined;

  constructor(runner: AgentRunner, opts: RunnerActorOptions = {}) {
    this.runner = runner;
    this.prompts = opts.prompts ?? DEFAULT_ACTOR_PROMPTS;
    this.cwd = opts.cwd ?? ".";
    this.repairOnce = opts.repairOnce ?? true;
    this.log = opts.log;
    this.signal = opts.signal;
    this.onEvent = activityForwarder(runner, "actor", opts.onActivity);
    this.steerRegister = opts.onSteer;
  }

  async draftPlan(goal: string, feedback?: Finding[]): Promise<PlanDraftResult> {
    const prompt = this.prompts.draftPlan(goal, feedback);
    const out = await this.runStructured(prompt, ActorPlanOutputSchema, "plan draft");
    // The goal is authoritative from the engine, never taken from model output.
    const plan = PlanSchema.parse({ goal, tasks: out.tasks });
    return out.notes !== undefined ? { plan, notes: out.notes } : { plan };
  }

  async build(task: TaskSpec, feedback?: BuildFeedback, cwd?: string): Promise<ActorBuildResult> {
    const prompt = this.prompts.build(task, feedback);
    const out = await this.runStructured(
      prompt,
      ActorBuildOutputSchema,
      `build of task "${task.id}"`,
      cwd ?? this.cwd,
    );
    return {
      diff: out.diff,
      touchedFiles: out.touchedFiles,
      summary: out.summary,
    };
  }

  /**
   * Degraded self-review (critic unavailable). Returns raw text in the critic
   * contract so the engine parses it identically and records the outcome as
   * UNVERIFIED_BY_CRITIC.
   */
  async selfReview(bundle: TaskArtifactBundle, cwd?: string): Promise<CriticRawResponse> {
    const res = await this.runner.run({
      prompt: this.prompts.selfReview(bundle),
      cwd: cwd ?? this.cwd,
      system: this.prompts.system,
      ...(this.signal ? { signal: this.signal } : {}),
      ...(this.onEvent ? { onEvent: this.onEvent } : {}),
      ...(this.steerRegister ? { steering: this.steerRegister } : {}),
    });
    return { text: res.text, quotaExhausted: res.quotaExhausted };
  }

  /** Run the runner and parse JSON, retrying once with a nudge if it won't parse. */
  private async runStructured<S extends z.ZodTypeAny>(
    prompt: string,
    schema: S,
    what: string,
    cwd: string = this.cwd,
  ): Promise<z.output<S>> {
    let res = await this.runner.run({
      prompt,
      cwd,
      system: this.prompts.system,
      ...(this.signal ? { signal: this.signal } : {}),
      ...(this.onEvent ? { onEvent: this.onEvent } : {}),
      ...(this.steerRegister ? { steering: this.steerRegister } : {}),
    });
    if (res.quotaExhausted) {
      throw new RunnerRoleError(`Actor ${what} failed: runner quota exhausted.`, {
        quotaExhausted: true,
      });
    }

    let parsed: JsonParseResult<z.output<S>> = parseLastValidJson(res.text, schema, what);
    if (!parsed.ok && this.repairOnce) {
      this.log?.(`actor ${what} output unparseable (${parsed.error}); retrying once`);
      res = await this.runner.run({
        prompt: `${prompt}\n\n${PARSE_REPAIR_NUDGE}`,
        cwd,
        system: this.prompts.system,
        ...(this.signal ? { signal: this.signal } : {}),
        ...(this.onEvent ? { onEvent: this.onEvent } : {}),
        ...(this.steerRegister ? { steering: this.steerRegister } : {}),
      });
      if (res.quotaExhausted) {
        throw new RunnerRoleError(`Actor ${what} failed: runner quota exhausted.`, {
          quotaExhausted: true,
        });
      }
      parsed = parseLastValidJson(res.text, schema, what);
    }

    if (!parsed.ok) {
      throw new RunnerRoleError(`Actor ${what} produced unusable output: ${parsed.error}`);
    }
    return parsed.value;
  }
}

/** Critic role backed by an AgentRunner + prompt templates. */
export class RunnerCritic implements Critic {
  private readonly runner: AgentRunner;
  private readonly prompts: CriticPromptTemplates;
  private readonly cwd: string;
  private readonly signal: AbortSignal | undefined;
  /** per-call activity sink, enriched with role identity (undefined = off) */
  private readonly onEvent: ((a: RunnerActivity) => void) | undefined;
  /** steering registration passed as req.steering on every run (undefined = off) */
  private readonly steerRegister: ((steer: (text: string) => void) => void) | undefined;

  constructor(runner: AgentRunner, opts: RunnerCriticOptions = {}) {
    this.runner = runner;
    this.prompts = opts.prompts ?? DEFAULT_CRITIC_PROMPTS;
    this.cwd = opts.cwd ?? ".";
    this.signal = opts.signal;
    this.onEvent = activityForwarder(runner, "critic", opts.onActivity);
    this.steerRegister = opts.onSteer;
  }

  /**
   * Reviews a plan or a task. Returns raw text + the quota signal; the engine
   * parses, enforces the rubric, and applies the retry/give-up policy. The
   * `repairHint` the engine passes on its single retry is forwarded into the
   * prompt so the backend gets the corrective nudge.
   */
  async review(req: CriticRequest, cwd?: string): Promise<CriticRawResponse> {
    const prompt =
      req.kind === "plan"
        ? this.prompts.planReview(req.goal, req.plan, req.repairHint)
        : this.prompts.taskReview(req.bundle, req.repairHint);
    const res = await this.runner.run({
      prompt,
      cwd: cwd ?? this.cwd,
      system: this.prompts.system,
      ...(this.signal ? { signal: this.signal } : {}),
      ...(this.onEvent ? { onEvent: this.onEvent } : {}),
      ...(this.steerRegister ? { steering: this.steerRegister } : {}),
    });
    return { text: res.text, quotaExhausted: res.quotaExhausted };
  }
}

import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { RunnerProfileSchema } from "./runners/agentRunner.js";

/**
 * Loopwright (actor-critic) configuration. Validated with zod so a bad env
 * fails fast with a clear message.
 *
 * Model identifiers and backends are intentionally NOT hard-coded here -- they
 * come from runner profiles (see runners/agentRunner.ts), so the engine stays
 * decoupled from any specific provider or model.
 */

const CriticFallbackSchema = z.enum(["actor_self_review", "pause"]);
export type CriticFallback = z.infer<typeof CriticFallbackSchema>;

const ENV_PREFIX = "LOOPWRIGHT_";

/**
 * Env-string boolean. `z.coerce.boolean()` is unsafe here: it uses JS
 * `Boolean(str)`, so "false"/"0" (non-empty strings) coerce to `true`, which
 * would make boolean toggles impossible to disable via env. This maps common
 * truthy/falsy spellings explicitly and leaves real booleans untouched.
 */
const EnvBoolean = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const n = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(n)) return true;
  if (["0", "false", "no", "off"].includes(n)) return false;
  return v; // anything else falls through to z.boolean() validation
}, z.boolean());

function defaultDbPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Loopwright",
    "sessions.db",
  );
}

/**
 * Validates a string as a safe git ref name (branch/prefix). This is the
 * fail-fast boundary: a ref with whitespace or an invalid token would otherwise
 * blow up much later during branch creation / push / PR, after a whole session
 * has run. Mirrors the core rules `git check-ref-format` enforces. An empty
 * string is allowed (callers treat it as "use the default").
 */
const GIT_REF_CHARS = /^[A-Za-z0-9._/-]+$/;
function isSafeRefName(s: string): boolean {
  if (s === "") return true; // empty => use default downstream
  if (!GIT_REF_CHARS.test(s)) return false; // rejects spaces, ~^:?*[\ , etc.
  if (s.includes("..") || s.includes("//")) return false;
  if (s.startsWith("/") || s.endsWith("/")) return false;
  if (s.startsWith(".") || s.endsWith(".")) return false;
  if (s.endsWith(".lock")) return false;
  return true;
}
const REF_NAME_MESSAGE =
  "must be a valid git ref name (no spaces or any of ~^:?*[\\, no .. // leading/trailing . or /)";

/**
 * Runner profiles supplied as a JSON array string (env-friendly), e.g.
 * `LOOPWRIGHT_RUNNERS='[{"id":"primary","kind":"cli","model":"m","options":{...}}]'`.
 * An empty/blank value means "no profiles"; anything that isn't valid JSON falls
 * through to array validation so the failure is explicit rather than silent.
 */
const RunnerProfilesEnv = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s === "") return [];
  try {
    return JSON.parse(s);
  } catch {
    return v; // not an array -> clear zod error below
  }
}, z.array(RunnerProfileSchema).default([]));

const RawConfigSchema = z.object({
  // role -> runner binding. These reference runner-profile ids / model strings;
  // there is no vendor default so nothing is locked to a specific provider.
  actorModel: z.string().default(""),
  criticModel: z.string().default(""),

  // runner profiles + which profile backs each role (see adapters/roleBindings)
  runners: RunnerProfilesEnv,
  /** id of the runner profile that backs the actor role */
  actorRunner: z.string().default(""),
  /** id of the runner profile that backs the critic role */
  criticRunner: z.string().default(""),

  // loop caps
  planReviewMax: z.coerce.number().int().min(0).default(2),
  taskReviewCyclesMax: z.coerce.number().int().min(1).default(3),
  /** how many times the actor may re-attempt after a mechanical-gate failure */
  mechanicalFixMax: z.coerce.number().int().min(1).default(3),

  mechanicalGate: EnvBoolean.default(true),
  criticFallback: CriticFallbackSchema.default("actor_self_review"),

  // execution
  maxParallel: z.coerce.number().int().min(1).default(2),
  stuckThresholdMs: z.coerce.number().int().min(1000).default(120_000),
  useWorktrees: EnvBoolean.default(true),

  // repository + branch naming
  /**
   * Default repository directory for runs. Usually supplied per-run via the API
   * body (`repoDir`); this env fallback lets the headless server target a repo
   * without a UI. Empty means "no repo" (runs build in cwd without worktrees).
   */
  repoDir: z.string().default(""),
  /** prefix for task + integration branch names: `<prefix>/<session>/<slug>` */
  branchPrefix: z
    .string()
    .default("loopwright")
    .refine((s) => s !== "" && isSafeRefName(s), { message: REF_NAME_MESSAGE }),

  // publishing (push + PR). All opt-in and OFF by default so a run never
  // touches a remote unless the user explicitly asked for it.
  /** when false, build + integrate locally but never push (Req: dry run) */
  dryRun: EnvBoolean.default(false),
  /** push the integration branch to a remote after a successful integration */
  pushToRemote: EnvBoolean.default(false),
  /** git remote to push to */
  remote: z.string().default("origin"),
  /** override the remote branch name to push to (default: the integration branch) */
  pushBranch: z.string().default("").refine(isSafeRefName, { message: REF_NAME_MESSAGE }),
  /** open a pull request after pushing (requires the gh CLI or a token) */
  openPr: EnvBoolean.default(false),
  /** base branch for the pull request (default: the remote's default branch) */
  prBase: z.string().default("").refine(isSafeRefName, { message: REF_NAME_MESSAGE }),
  /** pull request title (default: derived from the goal) */
  prTitle: z.string().default(""),
  /** pull request body (default: a generated summary) */
  prBody: z.string().default(""),
  /** open the pull request as a draft (recommended default) */
  prDraft: EnvBoolean.default(true),
  /**
   * Push even when the safety gate would refuse (failed integration, merge
   * conflicts, failed verification, or tasks needing a human). Off by default
   * so a broken run never reaches a remote without an explicit override.
   */
  pushOverrideSafety: EnvBoolean.default(false),

  dbPath: z.string().default(defaultDbPath()),
});

export type LoopwrightConfig = z.infer<typeof RawConfigSchema>;

/** Build config from a record of env-style values (defaults to process.env). */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): LoopwrightConfig {
  return RawConfigSchema.parse({
    actorModel: env[`${ENV_PREFIX}ACTOR_MODEL`],
    criticModel: env[`${ENV_PREFIX}CRITIC_MODEL`],
    runners: env[`${ENV_PREFIX}RUNNERS`],
    actorRunner: env[`${ENV_PREFIX}ACTOR_RUNNER`],
    criticRunner: env[`${ENV_PREFIX}CRITIC_RUNNER`],
    planReviewMax: env[`${ENV_PREFIX}PLAN_REVIEW_MAX`],
    taskReviewCyclesMax: env[`${ENV_PREFIX}TASK_REVIEW_CYCLES_MAX`],
    mechanicalFixMax: env[`${ENV_PREFIX}MECHANICAL_FIX_MAX`],
    mechanicalGate: env[`${ENV_PREFIX}MECHANICAL_GATE`],
    criticFallback: env[`${ENV_PREFIX}CRITIC_FALLBACK`],
    maxParallel: env[`${ENV_PREFIX}MAX_PARALLEL`],
    stuckThresholdMs: env[`${ENV_PREFIX}STUCK_THRESHOLD_MS`],
    useWorktrees: env[`${ENV_PREFIX}USE_WORKTREES`],
    repoDir: env[`${ENV_PREFIX}REPO_DIR`],
    branchPrefix: env[`${ENV_PREFIX}BRANCH_PREFIX`],
    dryRun: env[`${ENV_PREFIX}DRY_RUN`],
    pushToRemote: env[`${ENV_PREFIX}PUSH_TO_REMOTE`],
    remote: env[`${ENV_PREFIX}REMOTE`],
    pushBranch: env[`${ENV_PREFIX}PUSH_BRANCH`],
    openPr: env[`${ENV_PREFIX}OPEN_PR`],
    prBase: env[`${ENV_PREFIX}PR_BASE`],
    prTitle: env[`${ENV_PREFIX}PR_TITLE`],
    prBody: env[`${ENV_PREFIX}PR_BODY`],
    prDraft: env[`${ENV_PREFIX}PR_DRAFT`],
    pushOverrideSafety: env[`${ENV_PREFIX}PUSH_OVERRIDE_SAFETY`],
    dbPath: env[`${ENV_PREFIX}DB_PATH`],
  });
}

import { z } from "zod";
import os from "node:os";
import path from "node:path";

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

const RawConfigSchema = z.object({
  // role -> runner binding. These reference runner-profile ids / model strings;
  // there is no vendor default so nothing is locked to a specific provider.
  actorModel: z.string().default(""),
  criticModel: z.string().default(""),

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
    planReviewMax: env[`${ENV_PREFIX}PLAN_REVIEW_MAX`],
    taskReviewCyclesMax: env[`${ENV_PREFIX}TASK_REVIEW_CYCLES_MAX`],
    mechanicalFixMax: env[`${ENV_PREFIX}MECHANICAL_FIX_MAX`],
    mechanicalGate: env[`${ENV_PREFIX}MECHANICAL_GATE`],
    criticFallback: env[`${ENV_PREFIX}CRITIC_FALLBACK`],
    maxParallel: env[`${ENV_PREFIX}MAX_PARALLEL`],
    stuckThresholdMs: env[`${ENV_PREFIX}STUCK_THRESHOLD_MS`],
    useWorktrees: env[`${ENV_PREFIX}USE_WORKTREES`],
    dbPath: env[`${ENV_PREFIX}DB_PATH`],
  });
}

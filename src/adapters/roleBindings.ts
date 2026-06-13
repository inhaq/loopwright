import type { LoopwrightConfig } from "../config.js";
import type { RunnerProfile } from "../runners/agentRunner.js";
import { createRunner, type RunnerFactory } from "../runners/runnerFactory.js";
import type { Actor, Critic } from "./agents.js";
import { RunnerActor, RunnerCritic } from "./runnerRoles.js";
import type { ActorPromptTemplates, CriticPromptTemplates } from "./prompts.js";

/**
 * Configuration -> roles wiring (Task 13.3).
 *
 * Given validated config, this resolves the runner profile bound to each role,
 * builds the runner via the factory, and binds it (with prompt templates) into
 * a working Actor / Critic. The result is what the loop in engine/loop.ts
 * consumes -- so a profile + prompts becomes a usable backend with zero engine
 * changes.
 *
 * Bindings are explicit (`actorRunner` / `criticRunner` name a profile id) and
 * misconfiguration fails fast with a message naming the available ids, per the
 * configuration requirement.
 */

/** Thrown when role->runner configuration cannot be resolved. */
export class RoleBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleBindingError";
  }
}

export interface CreateRolesOptions {
  /** runner constructor; injectable so tests can avoid real subprocess/HTTP */
  factory?: RunnerFactory;
  actorPrompts?: ActorPromptTemplates;
  criticPrompts?: CriticPromptTemplates;
  /** workspace the runners operate in (single dir until worktrees, Milestone 4) */
  cwd?: string;
  log?: (line: string) => void;
}

function resolveProfile(
  profiles: Map<string, RunnerProfile>,
  role: "actor" | "critic",
  boundId: string,
  modelOverride: string,
): RunnerProfile {
  const envVar = role === "actor" ? "LOOPWRIGHT_ACTOR_RUNNER" : "LOOPWRIGHT_CRITIC_RUNNER";
  const available = [...profiles.keys()];

  if (boundId === "") {
    throw new RoleBindingError(
      `No runner bound to the ${role} role. Set ${envVar} to one of the ` +
        `configured runner profile ids: ${available.length ? available.join(", ") : "(none configured)"}.`,
    );
  }

  const profile = profiles.get(boundId);
  if (!profile) {
    throw new RoleBindingError(
      `${role} role is bound to unknown runner profile "${boundId}". ` +
        `Available profile ids: ${available.length ? available.join(", ") : "(none configured)"}.`,
    );
  }

  // An explicit per-role model (LOOPWRIGHT_ACTOR_MODEL / _CRITIC_MODEL) overrides
  // the profile's model, so one profile can back both roles with different models.
  return modelOverride ? { ...profile, model: modelOverride } : profile;
}

/**
 * Builds the actor and critic from configuration. Throws RoleBindingError on
 * any unresolved/ambiguous binding so a misconfigured run stops immediately.
 */
export function createRoles(
  config: LoopwrightConfig,
  opts: CreateRolesOptions = {},
): { actor: Actor; critic: Critic } {
  const factory = opts.factory ?? createRunner;
  const profiles = new Map(config.runners.map((p) => [p.id, p]));

  const actorProfile = resolveProfile(profiles, "actor", config.actorRunner, config.actorModel);
  const criticProfile = resolveProfile(profiles, "critic", config.criticRunner, config.criticModel);

  const actor = new RunnerActor(factory(actorProfile), {
    ...(opts.actorPrompts ? { prompts: opts.actorPrompts } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });

  const critic = new RunnerCritic(factory(criticProfile), {
    ...(opts.criticPrompts ? { prompts: opts.criticPrompts } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });

  return { actor, critic };
}

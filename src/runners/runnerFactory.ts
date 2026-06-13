import type { AgentRunner, RunnerProfile } from "./agentRunner.js";
import { CliRunner } from "./cliRunner.js";
import { HttpRunner } from "./httpRunner.js";
import { MockRunner } from "./mockRunner.js";

/**
 * Constructs an AgentRunner from a profile, dispatching purely on the profile's
 * `kind`. This is the one place runner mechanisms are enumerated; adding a
 * backend means adding a case here (and its runner class), never touching the
 * engine or the roles.
 *
 * The factory is injectable wherever roles are built (see adapters/roleBindings)
 * so tests can swap in fakes without going through real subprocess/HTTP runners.
 */
export type RunnerFactory = (profile: RunnerProfile) => AgentRunner;

/** Thrown when a profile names a runner mechanism that isn't available. */
export class UnknownRunnerKindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownRunnerKindError";
  }
}

export const createRunner: RunnerFactory = (profile) => {
  switch (profile.kind) {
    case "cli":
      return new CliRunner(profile);
    case "mock":
      return MockRunner.fromProfile(profile);
    case "http":
      return new HttpRunner(profile);
    default: {
      // Exhaustiveness guard: a new RunnerKind must be handled above.
      const exhaustive: never = profile.kind;
      throw new UnknownRunnerKindError(`Unknown runner kind: ${String(exhaustive)}.`);
    }
  }
};

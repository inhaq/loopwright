import { z } from "zod";
import type {
  AgentRunner,
  RunRequest,
  RunResult,
  RunnerProfile,
} from "./agentRunner.js";

/**
 * Deterministic runner for tests and dry runs. It never spawns a process or
 * makes a network call; it just replays scripted responses, so the role-binding
 * layer and the loop can be exercised end-to-end without a real backend.
 *
 * Scripting options (most flexible first):
 *   - `respond(req, callIndex)` -> a string (becomes `{ text }`) or a RunResult
 *   - `responses` -> a queue consumed in order; the LAST entry repeats once the
 *     queue is exhausted (matches the mock actor/critic convention)
 *
 * Every request is recorded on `.requests` for assertions.
 */

export interface MockRunnerOptions {
  responses?: Array<string | RunResult>;
  respond?: (req: RunRequest, callIndex: number) => string | RunResult;
}

/** Profile options recognized when a "mock" runner is built from configuration. */
const MockProfileOptionsSchema = z
  .object({
    responses: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              text: z.string().default(""),
              quotaExhausted: z.boolean().optional(),
            })
            .strip(),
        ]),
      )
      .default([]),
  })
  .strip();

function toResult(r: string | RunResult): RunResult {
  return typeof r === "string" ? { text: r } : r;
}

export class MockRunner implements AgentRunner {
  readonly profile: RunnerProfile;
  /** every request this runner received, in order (for test assertions) */
  readonly requests: RunRequest[] = [];

  private readonly opts: MockRunnerOptions;
  private calls = 0;

  constructor(profile: RunnerProfile, opts: MockRunnerOptions = {}) {
    this.profile = profile;
    this.opts = opts;
  }

  /** Build a MockRunner from a RunnerProfile's `options` (config-driven path). */
  static fromProfile(profile: RunnerProfile): MockRunner {
    const parsed = MockProfileOptionsSchema.parse(profile.options ?? {});
    return new MockRunner(profile, { responses: parsed.responses });
  }

  async run(req: RunRequest): Promise<RunResult> {
    const i = this.calls++;
    this.requests.push(req);

    if (this.opts.respond) {
      return toResult(this.opts.respond(req, i));
    }
    const queue = this.opts.responses ?? [];
    if (queue.length === 0) {
      return { text: "" };
    }
    const entry = queue[Math.min(i, queue.length - 1)] as string | RunResult;
    return toResult(entry);
  }
}

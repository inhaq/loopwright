import type { AgentRunner, RunRequest, RunResult } from "../runners/agentRunner.js";
import { normalizeUsage, type RoleName, type RunnerCallEvent } from "./events.js";

export type RunnerCallSink = (e: RunnerCallEvent) => void | Promise<void>;

/**
 * Wraps a runner so every invocation emits a {@link RunnerCallEvent} attributed
 * to its role (Task 22). The wrapper is transparent — it returns the underlying
 * result unchanged — and times the call itself rather than trusting backend
 * metadata, while still surfacing the provider's token `usage` for the ledger.
 */
export function instrumentRunner(
  runner: AgentRunner,
  role: RoleName,
  onCall: RunnerCallSink,
): AgentRunner {
  return {
    profile: runner.profile,
    async run(req: RunRequest): Promise<RunResult> {
      const started = Date.now();
      const res = await runner.run(req);
      const event: RunnerCallEvent = {
        role,
        runnerId: runner.profile.id,
        model: runner.profile.model,
        promptChars: req.prompt.length,
        outputChars: res.text.length,
        durationMs: Date.now() - started,
        quotaExhausted: res.quotaExhausted ?? false,
        usage: normalizeUsage(res.meta?.usage),
        at: new Date().toISOString(),
      };
      await onCall(event);
      return res;
    },
  };
}

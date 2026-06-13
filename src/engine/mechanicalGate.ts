import { spawn } from "node:child_process";
import {
  type MechanicalGateResult,
  type MechanicalStepResult,
} from "../schemas/artifact.js";
import { redactAndTruncate } from "./redaction.js";
import { killProcessTree, detachForTreeKill } from "./processTree.js";

/**
 * Runs a task's verify commands (build/test/lint) as the cheap, deterministic
 * gate that must pass BEFORE the scarce critic is ever invoked.
 *
 * The command executor is injectable so the loop and tests can drive the gate
 * deterministically without spawning real subprocesses.
 */

export interface CommandOutcome {
  exitCode: number;
  /** combined stdout+stderr, raw (redaction happens in the gate) */
  output: string;
  durationMs: number;
}

export type CommandExecutor = (
  command: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<CommandOutcome>;

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_CAPTURED_CHARS = 200_000;
/** exit code used to signal a command was killed for exceeding the timeout */
export const TIMEOUT_EXIT_CODE = 124;

export interface ShellExecutorOptions {
  /** hard wall-clock limit before the child is SIGKILLed */
  timeoutMs?: number;
  /** rolling cap on captured output so a runaway log can't exhaust memory */
  maxCapturedChars?: number;
}

/**
 * Creates a shell CommandExecutor with two safeguards a hung/chatty verify
 * command would otherwise breach: a hard timeout (kills the child and returns
 * {@link TIMEOUT_EXIT_CODE}) and bounded capture (keeps only the most recent
 * tail in memory, well before the post-exit redaction/truncation step).
 */
export function createShellExecutor(
  opts: ShellExecutorOptions = {},
): CommandExecutor {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxCapturedChars ?? DEFAULT_MAX_CAPTURED_CHARS;

  return (command, cwd, signal) =>
    new Promise((resolve) => {
      const started = Date.now();
      // If already cancelled, don't even spawn.
      if (signal?.aborted) {
        resolve({ exitCode: TIMEOUT_EXIT_CODE, output: "[cancelled]", durationMs: 0 });
        return;
      }
      // Spawn detached on POSIX so the timeout/cancellation handlers can kill
      // the entire process group, not just the immediate shell. See
      // killProcessTree / detachForTreeKill.
      const child = spawn(command, { cwd, shell: true, detached: detachForTreeKill });
      let output = "";
      let timedOut = false;
      let cancelled = false;

      const append = (buf: Buffer) => {
        output += buf.toString();
        if (output.length > maxChars) output = output.slice(-maxChars);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);

      // Cancellation: kill the whole process tree so a long verify/build
      // command (and any descendants it spawned, e.g. `npm test`) stops
      // promptly when the run is cancelled.
      const onAbort = (): void => {
        cancelled = true;
        killProcessTree(child);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (err) => {
        cleanup();
        resolve({
          exitCode: 127,
          output: `${output}\n${err.message}`,
          durationMs: Date.now() - started,
        });
      });
      child.on("close", (code) => {
        cleanup();
        resolve({
          exitCode: timedOut || cancelled ? TIMEOUT_EXIT_CODE : (code ?? 1),
          output: timedOut
            ? `${output}\n[killed: exceeded ${timeoutMs}ms timeout]`
            : cancelled
              ? `${output}\n[killed: run cancelled]`
              : output,
          durationMs: Date.now() - started,
        });
      });
    });
}

/** Default executor: runs the command in a shell with timeout + bounded capture. */
export const defaultExecutor: CommandExecutor = createShellExecutor();

export interface MechanicalGateOptions {
  cwd: string;
  executor?: CommandExecutor;
  /** cancels in-flight commands when aborted */
  signal?: AbortSignal;
}

/**
 * Runs all commands in order. Stops at the first failure (fail-fast) so the
 * actor gets a focused signal rather than a wall of cascading errors.
 */
export async function runMechanicalGate(
  commands: string[],
  opts: MechanicalGateOptions,
): Promise<MechanicalGateResult> {
  const executor = opts.executor ?? defaultExecutor;
  const steps: MechanicalStepResult[] = [];

  // No verify commands declared = nothing to mechanically prove, so this is a
  // pass at the mechanical layer ONLY. GREEN is still gated by the critic's
  // semantic review, and a task with no machine-checkable DoD is expected to be
  // caught by the critic during plan review rather than blocked by the schema.
  if (commands.length === 0) {
    return { passed: true, steps: [] };
  }

  for (const command of commands) {
    const outcome = await executor(command, opts.cwd, opts.signal);
    const passed = outcome.exitCode === 0;
    steps.push({
      command,
      exitCode: outcome.exitCode,
      passed,
      durationMs: outcome.durationMs,
      output: redactAndTruncate(outcome.output),
    });
    if (!passed) {
      return { passed: false, steps };
    }
  }

  return { passed: true, steps };
}

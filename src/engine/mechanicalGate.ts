import { spawn } from "node:child_process";
import {
  type MechanicalGateResult,
  type MechanicalStepResult,
} from "../schemas/artifact.js";
import { redactAndTruncate } from "./redaction.js";

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
) => Promise<CommandOutcome>;

/** Default executor: runs the command in a shell, capturing combined output. */
export const defaultExecutor: CommandExecutor = (command, cwd) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true });
    let output = "";
    const append = (buf: Buffer) => {
      output += buf.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      resolve({
        exitCode: 127,
        output: `${output}\n${err.message}`,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        output,
        durationMs: Date.now() - started,
      });
    });
  });

export interface MechanicalGateOptions {
  cwd: string;
  executor?: CommandExecutor;
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

  // No verify commands declared = nothing to mechanically prove. We treat this
  // as a (loud) pass; the loop surfaces it so a missing DoD is visible.
  if (commands.length === 0) {
    return { passed: true, steps: [] };
  }

  for (const command of commands) {
    const outcome = await executor(command, opts.cwd);
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

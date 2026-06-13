import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  AgentRunner,
  RunRequest,
  RunResult,
  RunnerProfile,
} from "./agentRunner.js";
import { redactAndTruncate } from "../engine/redaction.js";
import { killProcessTree, detachForTreeKill } from "../engine/processTree.js";

/**
 * Generic, vendor-neutral runner that drives a headless command-line agent as a
 * subprocess. It knows nothing about any specific product; everything is
 * described by the profile's `options`:
 *
 *   - how to invoke it: `command` + `args` (with {{prompt}} {{model}}
 *     {{system}} {{cwd}} placeholders), and whether the prompt goes via an arg
 *     or stdin
 *   - what environment to pass (values may reference ${VARS} from the parent
 *     env, so secrets like an API key flow through without being hard-coded)
 *   - how to read the answer: whole stdout, the last line, a JSONL event
 *     stream, or a file the CLI writes
 *   - how to detect an exhausted usage/rate window: an output regex and/or a
 *     set of exit codes
 *
 * Supporting another command-line backend is a new profile, not new code.
 */

const PLACEHOLDER_KEYS = ["prompt", "model", "system", "cwd"] as const;
type PlaceholderVars = Record<(typeof PLACEHOLDER_KEYS)[number], string>;

export const CliRunnerOptionsSchema = z
  .object({
    /** executable to run, e.g. a headless agent CLI */
    command: z.string().min(1),
    /** argv template; supports {{prompt}} {{model}} {{system}} {{cwd}} */
    args: z.array(z.string()).default([]),
    /** how the prompt is delivered to the process */
    promptVia: z.enum(["arg", "stdin"]).default("arg"),
    /** extra env vars; values may contain ${VAR} expanded from the parent env */
    env: z.record(z.string()).default({}),
    /** hard wall-clock limit before the child is SIGKILLed */
    timeoutMs: z.number().int().positive().default(10 * 60_000),
    /** rolling cap on captured output per stream (bytes-ish) */
    maxCapturedChars: z.number().int().positive().default(2_000_000),
    output: z
      .object({
        mode: z.enum(["stdout", "last-line", "json-stream", "file"]).default("stdout"),
        /** json-stream: dotted path to the text within an event object */
        textPath: z.string().default("text"),
        /** json-stream: only consider events where `event[typeField] === type` */
        typeField: z.string().optional(),
        type: z.string().optional(),
        /** file: path (template) the CLI writes its final message to */
        file: z.string().optional(),
      })
      .default({ mode: "stdout", textPath: "text" }),
    quota: z
      .object({
        /** case-insensitive regex tested against combined stdout+stderr */
        pattern: z.string().optional(),
        /** exit codes that indicate an exhausted usage/rate window */
        exitCodes: z.array(z.number().int()).default([]),
      })
      .default({ exitCodes: [] }),
  })
  .strict();

export type CliRunnerOptions = z.infer<typeof CliRunnerOptionsSchema>;

const TEMPLATE_RE = /\{\{(prompt|model|system|cwd)\}\}/g;
const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Replaces {{prompt}}/{{model}}/{{system}}/{{cwd}} placeholders in a string. */
function fillTemplate(s: string, vars: PlaceholderVars): string {
  return s.replace(TEMPLATE_RE, (_m, key: keyof PlaceholderVars) => vars[key] ?? "");
}

/** Expands ${VAR} references in a value from the given environment source. */
function expandEnvRefs(value: string, source: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REF_RE, (_m, name: string) => source[name] ?? "");
}

/** Reads a dotted path (e.g. "message.content") from a nested object, safely. */
function getByPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/** Picks the answer text out of a JSONL event stream (last matching event). */
function parseJsonStream(stdout: string, opts: CliRunnerOptions["output"]): string {
  let last = "";
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (opts.typeField !== undefined && opts.type !== undefined) {
      if (getByPath(event, opts.typeField) !== opts.type) continue;
    }
    const text = getByPath(event, opts.textPath);
    if (typeof text === "string") last = text;
  }
  return last;
}

/** A captured subprocess result, before output-mode extraction. */
interface SpawnCapture {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  spawnError?: string;
}

/** Drives a headless command-line agent as a subprocess per its RunnerProfile. */
export class CliRunner implements AgentRunner {
  readonly profile: RunnerProfile;
  private readonly opts: CliRunnerOptions;

  /** Validates the profile's options eagerly so a bad profile fails fast. */
  constructor(profile: RunnerProfile) {
    this.profile = profile;
    // Validate eagerly so a bad profile fails at construction, not mid-run.
    this.opts = CliRunnerOptionsSchema.parse(profile.options ?? {});
  }

  /** Runs the configured command for one request and returns the parsed result. */
  async run(req: RunRequest): Promise<RunResult> {
    const vars: PlaceholderVars = {
      prompt: req.prompt,
      model: this.profile.model,
      system: req.system ?? "",
      cwd: req.cwd,
    };

    const args = this.opts.args.map((a) => fillTemplate(a, vars));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(this.opts.env)) {
      env[k] = expandEnvRefs(v, process.env);
    }

    const cap = await this.spawnCapture(args, req, env);

    const combined = `${cap.stdout}\n${cap.stderr}`;
    const quotaExhausted =
      this.opts.quota.exitCodes.includes(cap.exitCode) ||
      (this.opts.quota.pattern !== undefined &&
        new RegExp(this.opts.quota.pattern, "i").test(combined));

    const text = await this.extractText(cap.stdout, vars, req.cwd);

    return {
      text,
      quotaExhausted,
      meta: {
        runnerId: this.profile.id,
        model: this.profile.model,
        command: this.opts.command,
        exitCode: cap.exitCode,
        durationMs: cap.durationMs,
        timedOut: cap.timedOut,
        ...(cap.spawnError ? { spawnError: cap.spawnError } : {}),
        // redacted so diagnostics can be logged without leaking secrets
        stderr: redactAndTruncate(cap.stderr, 2_000),
      },
    };
  }

  /** Spawns the command (no shell) with timeout + bounded per-stream capture. */
  private spawnCapture(
    args: string[],
    req: RunRequest,
    env: NodeJS.ProcessEnv,
  ): Promise<SpawnCapture> {
    const { command, promptVia, timeoutMs, maxCapturedChars } = this.opts;
    return new Promise((resolve) => {
      const started = Date.now();
      // Already cancelled before we spawned: don't launch the subprocess at all.
      if (req.signal?.aborted) {
        resolve({
          stdout: "",
          stderr: "[cancelled]",
          exitCode: 124,
          timedOut: false,
          durationMs: 0,
          spawnError: "run cancelled",
        });
        return;
      }
      const child = spawn(command, args, {
        cwd: req.cwd,
        env,
        shell: false,
        detached: detachForTreeKill,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;

      child.stdout.on("data", (b: Buffer) => {
        stdout += b.toString();
        if (stdout.length > maxCapturedChars) stdout = stdout.slice(-maxCapturedChars);
      });
      child.stderr.on("data", (b: Buffer) => {
        stderr += b.toString();
        if (stderr.length > maxCapturedChars) stderr = stderr.slice(-maxCapturedChars);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);

      // External cancellation: kill the whole subprocess tree so a long model
      // call stops promptly instead of waiting out the runner timeout.
      const onAbort = (): void => {
        cancelled = true;
        killProcessTree(child);
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      };

      child.on("error", (err) => {
        cleanup();
        resolve({
          stdout,
          stderr,
          exitCode: 127,
          timedOut,
          durationMs: Date.now() - started,
          spawnError: err.message,
        });
      });
      child.on("close", (code) => {
        cleanup();
        resolve({
          stdout,
          stderr,
          exitCode: timedOut || cancelled ? 124 : (code ?? 1),
          timedOut,
          durationMs: Date.now() - started,
        });
      });

      // Deliver the prompt (and always close stdin so the child doesn't block).
      if (promptVia === "stdin") child.stdin.write(req.prompt);
      child.stdin.end();
    });
  }

  /** Extracts the answer text from captured stdout per the configured mode. */
  private async extractText(
    stdout: string,
    vars: PlaceholderVars,
    cwd: string,
  ): Promise<string> {
    const out = this.opts.output;
    switch (out.mode) {
      case "stdout":
        return stdout.trim();
      case "last-line": {
        const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        return lines.length > 0 ? (lines[lines.length - 1] as string) : "";
      }
      case "json-stream":
        return parseJsonStream(stdout, out);
      case "file": {
        if (out.file === undefined) return "";
        const target = fillTemplate(out.file, vars);
        const resolved = path.isAbsolute(target) ? target : path.join(cwd, target);
        try {
          return (await readFile(resolved, "utf8")).trim();
        } catch {
          return "";
        }
      }
    }
  }
}

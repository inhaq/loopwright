import { spawn } from "node:child_process";

/**
 * Minimal injectable git transport. Worktree isolation (Task 20) and the
 * integrator (Task 21) talk to git only through this, so they can be unit
 * tested with a fake and exercised for real against a temp repo.
 */

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitExec = (args: string[], cwd: string) => Promise<GitResult>;

/** Default GitExec: runs the real `git` binary (no shell) and captures output. */
export const spawnGit: GitExec = (args, cwd) =>
  new Promise<GitResult>((resolve) => {
    const child = spawn("git", args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", (err) => resolve({ stdout, stderr: String(err.message), exitCode: 127 }));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });

export class GitError extends Error {
  constructor(
    message: string,
    readonly result: GitResult,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Runs git and throws GitError on a non-zero exit, with captured output. */
export async function git(exec: GitExec, args: string[], cwd: string): Promise<GitResult> {
  const res = await exec(args, cwd);
  if (res.exitCode !== 0) {
    throw new GitError(
      `git ${args.join(" ")} failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`,
      res,
    );
  }
  return res;
}

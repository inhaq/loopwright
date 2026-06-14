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

/**
 * True when `dir` is inside a git working tree. Used by the server to validate
 * a caller-selected repo folder before a run, and to fail fast with a clear
 * message rather than deep inside worktree setup. Never throws: a missing dir,
 * a non-repo, or git not being installed all resolve to `false`.
 */
export async function isGitRepo(dir: string, exec: GitExec = spawnGit): Promise<boolean> {
  try {
    const res = await exec(["rev-parse", "--is-inside-work-tree"], dir);
    return res.exitCode === 0 && res.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Returns the configured fetch URL for a named remote, or `undefined` when the
 * remote does not exist. Distinguishes a genuinely-missing remote (returns
 * `undefined`) from a real git execution failure (throws `GitError`), so the
 * publisher doesn't misreport a broken repo / missing binary as "no remote".
 */
export async function remoteUrl(
  dir: string,
  remote: string,
  exec: GitExec = spawnGit,
): Promise<string | undefined> {
  const res = await exec(["remote", "get-url", remote], dir);
  if (res.exitCode === 0) {
    const url = res.stdout.trim();
    return url === "" ? undefined : url;
  }
  // "No such remote" is the expected not-configured signal; anything else is a
  // real failure we must surface rather than mask as a missing remote.
  const message = `${res.stderr}\n${res.stdout}`.toLowerCase();
  if (message.includes("no such remote")) return undefined;
  throw new GitError(`git remote get-url ${remote} failed (exit ${res.exitCode})`, res);
}

/** Whether the named remote is configured on the repo at `dir`. */
export async function hasRemote(
  dir: string,
  remote: string,
  exec: GitExec = spawnGit,
): Promise<boolean> {
  try {
    return (await remoteUrl(dir, remote, exec)) !== undefined;
  } catch {
    // A predicate must stay total: an execution failure means "not usable".
    return false;
  }
}

/** The short subject line of the latest commit on `ref` (default HEAD). */
export async function commitCount(
  dir: string,
  ref: string,
  baseRef: string | undefined,
  exec: GitExec = spawnGit,
): Promise<number> {
  try {
    const range = baseRef ? `${baseRef}..${ref}` : ref;
    const res = await exec(["rev-list", "--count", range], dir);
    if (res.exitCode !== 0) return 0;
    return Number.parseInt(res.stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

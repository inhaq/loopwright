import path from "node:path";
import { rm } from "node:fs/promises";
import { git, spawnGit, type GitExec } from "./git.js";

/**
 * Isolated workspaces via git worktrees (Task 20).
 *
 * Concurrent tasks must not clobber each other's files (Req 9.2). Each task
 * gets its own git worktree on a dedicated branch cut from a base ref, so it
 * builds against a clean, independent checkout. After a task finishes, its
 * changes are committed on that branch for the integrator to merge (Task 21),
 * then the worktree directory is removed.
 *
 * git is injected so this is unit-testable with a fake and verifiable for real
 * against a temp repository.
 */

export interface Worktree {
  taskId: string;
  /** absolute path to the isolated checkout */
  path: string;
  /** branch the worktree is on */
  branch: string;
}

export interface WorktreeManagerOptions {
  /** the source repository all worktrees branch from */
  repoDir: string;
  /** namespaces branches/dirs so parallel sessions don't collide */
  sessionId: string;
  /** base ref to branch each worktree from (default: HEAD) */
  baseRef?: string;
  /** parent directory for worktree checkouts (default: <repo>/.loopwright/worktrees) */
  root?: string;
  /** branch name prefix (default: "loopwright") */
  branchPrefix?: string;
  git?: GitExec;
}

/** Makes a filesystem/branch-safe slug from a task id. */
function slug(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class GitWorktreeManager {
  private readonly repoDir: string;
  private readonly sessionId: string;
  private readonly baseRef: string;
  private readonly root: string;
  private readonly branchPrefix: string;
  private readonly exec: GitExec;
  private readonly active = new Map<string, Worktree>();

  constructor(opts: WorktreeManagerOptions) {
    this.repoDir = opts.repoDir;
    this.sessionId = opts.sessionId;
    this.baseRef = opts.baseRef ?? "HEAD";
    this.root = opts.root ?? path.join(opts.repoDir, ".loopwright", "worktrees", opts.sessionId);
    this.branchPrefix = opts.branchPrefix ?? "loopwright";
    this.exec = opts.git ?? spawnGit;
  }

  /** Creates an isolated worktree + branch for a task and returns its path. */
  async acquire(taskId: string): Promise<Worktree> {
    const existing = this.active.get(taskId);
    if (existing) return existing;

    const branch = `${this.branchPrefix}/${this.sessionId}/${slug(taskId)}`;
    const wtPath = path.join(this.root, slug(taskId));

    // `-B` resets the branch if a stale one lingers from an aborted run, so
    // re-running a task can't fail on "branch already exists".
    await git(this.exec, ["worktree", "add", "-f", "-B", branch, wtPath, this.baseRef], this.repoDir);

    const wt: Worktree = { taskId, path: wtPath, branch };
    this.active.set(taskId, wt);
    return wt;
  }

  /**
   * Commits everything in the worktree on its branch. Returns whether there was
   * anything to commit (a no-op change set commits nothing). The committed
   * branch is what the integrator merges.
   */
  async commit(taskId: string, message: string): Promise<{ committed: boolean }> {
    const wt = this.active.get(taskId);
    if (!wt) throw new Error(`No active worktree for task "${taskId}".`);
    await git(this.exec, ["add", "-A"], wt.path);
    const status = await git(this.exec, ["status", "--porcelain"], wt.path);
    if (status.stdout.trim() === "") return { committed: false };
    await git(this.exec, ["commit", "-m", message], wt.path);
    return { committed: true };
  }

  /** Removes the worktree directory (and optionally deletes its branch). */
  async release(taskId: string, opts: { deleteBranch?: boolean } = {}): Promise<void> {
    const wt = this.active.get(taskId);
    if (!wt) return;
    try {
      await git(this.exec, ["worktree", "remove", "--force", wt.path], this.repoDir);
    } catch {
      // best-effort: if git can't remove it (already gone), drop the dir directly
      await rm(wt.path, { recursive: true, force: true });
      await this.exec(["worktree", "prune"], this.repoDir);
    }
    if (opts.deleteBranch) {
      await this.exec(["branch", "-D", wt.branch], this.repoDir);
    }
    this.active.delete(taskId);
  }

  branchFor(taskId: string): string | undefined {
    return this.active.get(taskId)?.branch;
  }

  list(): Worktree[] {
    return [...this.active.values()];
  }
}

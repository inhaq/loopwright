import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import { GitWorktreeManager } from "../src/workspace/worktrees.js";
import { spawnGit } from "../src/workspace/git.js";

/** Initializes a throwaway git repo with one commit; returns its path. */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loopwright-wt-"));
  const run = (args: string[]) => spawnGit(args, dir);
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);
  await writeFile(join(dir, "README.md"), "base\n");
  await run(["add", "-A"]);
  await run(["commit", "-q", "-m", "init"]);
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("GitWorktreeManager (real git)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await initRepo();
  });

  it("gives each task an isolated checkout on its own branch", async () => {
    const mgr = new GitWorktreeManager({ repoDir: repo, sessionId: "s1" });
    const a = await mgr.acquire("task-a");
    const b = await mgr.acquire("task-b");

    expect(a.path).not.toBe(b.path);
    expect(await exists(a.path)).toBe(true);
    expect(await exists(join(a.path, "README.md"))).toBe(true);
    expect(a.branch).toContain("task-a");

    // edits in one worktree don't appear in the other (isolation)
    await writeFile(join(a.path, "only-a.txt"), "hi\n");
    expect(await exists(join(b.path, "only-a.txt"))).toBe(false);
  });

  it("commits a worktree's changes on its branch and reports whether anything changed", async () => {
    const mgr = new GitWorktreeManager({ repoDir: repo, sessionId: "s1" });
    const wt = await mgr.acquire("task-a");

    expect((await mgr.commit("task-a", "no changes")).committed).toBe(false);

    await writeFile(join(wt.path, "feature.txt"), "work\n");
    expect((await mgr.commit("task-a", "add feature")).committed).toBe(true);

    // the commit lives on the task branch
    const log = await spawnGit(["log", "--oneline", wt.branch], repo);
    expect(log.stdout).toContain("add feature");
  });

  it("removes the worktree directory on release", async () => {
    const mgr = new GitWorktreeManager({ repoDir: repo, sessionId: "s1" });
    const wt = await mgr.acquire("task-a");
    expect(await exists(wt.path)).toBe(true);
    await mgr.release("task-a", { deleteBranch: true });
    expect(await exists(wt.path)).toBe(false);
    expect(mgr.list()).toHaveLength(0);
  });
});

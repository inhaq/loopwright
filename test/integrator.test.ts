import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { integrate } from "../src/engine/integrator.js";
import { GitWorktreeManager } from "../src/workspace/worktrees.js";
import { spawnGit } from "../src/workspace/git.js";
import { scriptedExecutor } from "../src/adapters/mocks.js";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loopwright-int-"));
  const run = (args: string[]) => spawnGit(args, dir);
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);
  await writeFile(join(dir, "base.txt"), "base\n");
  await run(["add", "-A"]);
  await run(["commit", "-q", "-m", "init"]);
  return dir;
}

/** Builds a task branch by editing `file` to `content` and committing it. */
async function makeBranch(repo: string, taskId: string, file: string, content: string): Promise<string> {
  const mgr = new GitWorktreeManager({ repoDir: repo, sessionId: "s" });
  const wt = await mgr.acquire(taskId);
  await writeFile(join(wt.path, file), content);
  await mgr.commit(taskId, `work ${taskId}`);
  await mgr.release(taskId); // keeps the branch
  return wt.branch;
}

describe("integrate (real git)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await initRepo();
  });

  it("merges branches that touch different files and runs verification", async () => {
    const ba = await makeBranch(repo, "a", "a.txt", "from a\n");
    const bb = await makeBranch(repo, "b", "b.txt", "from b\n");

    const result = await integrate({
      repoDir: repo,
      branches: [
        { taskId: "a", branch: ba },
        { taskId: "b", branch: bb },
      ],
      verifyCommands: ["verify"],
      executor: scriptedExecutor(() => ({ exitCode: 0, output: "ok" })),
    });

    expect(result.merged).toEqual(["a", "b"]);
    expect(result.conflicts).toEqual([]);
    expect(result.verification?.passed).toBe(true);
    expect(result.ok).toBe(true);

    // both files exist on the integration branch
    const show = await spawnGit(["ls-tree", "--name-only", result.integrationBranch], repo);
    expect(show.stdout).toContain("a.txt");
    expect(show.stdout).toContain("b.txt");
  });

  it("surfaces a conflict instead of merging it, and reports the file", async () => {
    const ba = await makeBranch(repo, "a", "shared.txt", "version A\n");
    const bb = await makeBranch(repo, "b", "shared.txt", "version B\n");

    const result = await integrate({
      repoDir: repo,
      branches: [
        { taskId: "a", branch: ba },
        { taskId: "b", branch: bb },
      ],
    });

    expect(result.merged).toEqual(["a"]); // first merges clean
    expect(result.conflicts).toHaveLength(1); // second conflicts
    expect(result.conflicts[0]?.taskId).toBe("b");
    expect(result.conflicts[0]?.files).toContain("shared.txt");
    expect(result.ok).toBe(false);
  });

  it("marks ok=false when verification fails even with clean merges", async () => {
    const ba = await makeBranch(repo, "a", "a.txt", "from a\n");
    const result = await integrate({
      repoDir: repo,
      branches: [{ taskId: "a", branch: ba }],
      verifyCommands: ["verify"],
      executor: scriptedExecutor(() => ({ exitCode: 1, output: "tests failed" })),
    });
    expect(result.merged).toEqual(["a"]);
    expect(result.verification?.passed).toBe(false);
    expect(result.ok).toBe(false);
  });
});

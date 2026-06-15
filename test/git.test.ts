import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  commitCount,
  hasRemote,
  isGitRepo,
  remoteUrl,
  spawnGit,
  worktreeDiff,
} from "../src/workspace/git.js";

/** Initializes a throwaway git repo and returns its path. */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loopwright-git-"));
  const run = (args: string[]) => spawnGit(args, dir);
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);
  await writeFile(join(dir, "base.txt"), "base\n");
  await run(["add", "-A"]);
  await run(["commit", "-q", "-m", "init"]);
  return dir;
}

describe("git helpers", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await initRepo();
  });

  it("isGitRepo is true inside a repo and false elsewhere", async () => {
    expect(await isGitRepo(repo)).toBe(true);
    const plain = await mkdtemp(join(tmpdir(), "loopwright-plain-"));
    expect(await isGitRepo(plain)).toBe(false);
    // A non-existent path must resolve to false, not throw.
    expect(await isGitRepo(join(plain, "does-not-exist"))).toBe(false);
  });

  it("reports remotes via hasRemote / remoteUrl", async () => {
    expect(await hasRemote(repo, "origin")).toBe(false);
    expect(await remoteUrl(repo, "origin")).toBeUndefined();

    await spawnGit(["remote", "add", "origin", "https://example.com/x.git"], repo);
    expect(await hasRemote(repo, "origin")).toBe(true);
    expect(await remoteUrl(repo, "origin")).toBe("https://example.com/x.git");
  });

  it("counts commits in a range", async () => {
    // One commit on HEAD so far.
    expect(await commitCount(repo, "HEAD", undefined)).toBe(1);

    await spawnGit(["checkout", "-q", "-b", "feature"], repo);
    await writeFile(join(repo, "feature.txt"), "x\n");
    await spawnGit(["add", "-A"], repo);
    await spawnGit(["commit", "-q", "-m", "feature work"], repo);

    // feature is one commit ahead of main.
    expect(await commitCount(repo, "feature", "main")).toBe(1);
  });

  it("worktreeDiff captures modified AND newly created files", async () => {
    // No changes yet.
    expect((await worktreeDiff(repo)).trim()).toBe("");

    // Modify a tracked file and add a brand-new (untracked) file.
    await writeFile(join(repo, "base.txt"), "base\nmore\n");
    await writeFile(join(repo, "new.txt"), "hello\n");

    const diff = await worktreeDiff(repo);
    expect(diff).toContain("base.txt");
    expect(diff).toContain("+more");
    // The untracked file must appear as an addition (intent-to-add).
    expect(diff).toContain("new.txt");
    expect(diff).toContain("+hello");
  });

  it("worktreeDiff never throws on a non-repo and returns empty", async () => {
    const plain = await mkdtemp(join(tmpdir(), "loopwright-plain-"));
    expect(await worktreeDiff(plain)).toBe("");
  });
});

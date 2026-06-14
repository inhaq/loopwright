import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { runGoal } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import type { AgentRunner, RunnerProfile, RunRequest } from "../src/runners/agentRunner.js";
import { criticGreen, scriptedExecutor } from "../src/adapters/mocks.js";
import { spawnGit } from "../src/workspace/git.js";
import { MemoryStore } from "../src/storage/store.js";

/**
 * End-to-end worktree + integrate + publish test. The actor runner ACTUALLY
 * edits a file inside the per-task worktree (proving the cwd now reaches the
 * runner), the changes are committed on a task branch, integrated onto a named
 * integration branch, and pushed to a bare remote. This exercises the full
 * "select repo, run goal, update code, push to GitHub" path the desktop app
 * drives, minus the UI.
 */

const TASK_ID_RE = /id:\s*(\S+)/;

const planJson = JSON.stringify({
  tasks: [
    {
      id: "t1",
      title: "Add a file",
      description: "d",
      acceptanceCriteria: ["file exists"],
      verifyCommands: ["check"],
      dependencies: [],
    },
  ],
});

/**
 * A runner that plays both roles. On a BUILD prompt it writes a real file into
 * the task's worktree (req.cwd) and returns a build descriptor; plan + reviews
 * return green. The file write is what the worktree later commits + integrates.
 */
function fileEditingRunner(profile: RunnerProfile): AgentRunner {
  const respond = (req: RunRequest): string => {
    const p = req.prompt;
    if (p.includes("Decompose this goal")) return planJson;
    if (p.includes("Build the following task")) {
      const id = TASK_ID_RE.exec(p)?.[1] ?? "t?";
      // The crucial assertion of item 3/5: a file-editing runner edits files
      // INSIDE the worktree it was handed, not a shared/default directory.
      writeFileSync(join(req.cwd, `${id}.txt`), `built by ${id}\n`);
      return JSON.stringify({
        diff: `--- /dev/null\n+++ b/${id}.txt`,
        touchedFiles: [`${id}.txt`],
        summary: `created ${id}.txt`,
      });
    }
    // plan review + task review both green
    return criticGreen("looks good").text;
  };
  return new MockRunner(profile, { respond });
}

const factory = (profile: RunnerProfile): AgentRunner => fileEditingRunner(profile);
const okExecutor = scriptedExecutor(() => ({ exitCode: 0, output: "ok" }));

async function initRepoWithRemote(): Promise<{ repo: string; remote: string }> {
  const remote = await mkdtemp(join(tmpdir(), "loopwright-e2e-remote-"));
  await spawnGit(["init", "-q", "--bare", "-b", "main"], remote);

  const repo = await mkdtemp(join(tmpdir(), "loopwright-e2e-"));
  await spawnGit(["init", "-q", "-b", "main"], repo);
  await spawnGit(["config", "user.email", "t@example.com"], repo);
  await spawnGit(["config", "user.name", "T"], repo);
  await writeFile(join(repo, "README.md"), "# repo\n");
  await spawnGit(["add", "-A"], repo);
  await spawnGit(["commit", "-q", "-m", "init"], repo);
  await spawnGit(["remote", "add", "origin", remote], repo);
  return { repo, remote };
}

function publishConfig(extra: Record<string, string> = {}) {
  return loadConfig({
    LOOPWRIGHT_RUNNERS: '[{"id":"primary","kind":"mock","model":"m"}]',
    LOOPWRIGHT_ACTOR_RUNNER: "primary",
    LOOPWRIGHT_CRITIC_RUNNER: "primary",
    LOOPWRIGHT_USE_WORKTREES: "true",
    LOOPWRIGHT_MAX_PARALLEL: "1",
    ...extra,
  });
}

describe("runGoal: worktree -> integrate -> publish", () => {
  let repo: string;
  let remote: string;
  beforeEach(async () => {
    ({ repo, remote } = await initRepoWithRemote());
  });

  it("edits files in the worktree, integrates, and pushes to the remote", async () => {
    const store = new MemoryStore();
    const config = publishConfig({ LOOPWRIGHT_PUSH_TO_REMOTE: "true" });

    const result = await runGoal("Add a healthz file", config, {
      factory,
      executor: okExecutor,
      store,
      repoDir: repo,
    });

    expect(result.green).toEqual(["t1"]);
    expect(result.integration?.ok).toBe(true);
    expect(result.integration?.merged).toEqual(["t1"]);
    // Branch is named from the goal slug (item 12).
    expect(result.integration?.integrationBranch).toContain("add-a-healthz-file");

    // Publish happened and pushed the integration branch to the bare remote.
    expect(result.publish?.pushed).toBe(true);
    const branches = await spawnGit(["branch", "--list"], remote);
    expect(branches.stdout).toContain(result.integration!.integrationBranch);

    // The actor's file edit made it onto the integration branch.
    const tree = await spawnGit(
      ["ls-tree", "--name-only", result.integration!.integrationBranch],
      repo,
    );
    expect(tree.stdout).toContain("t1.txt");

    // A publish event was recorded for the trace/UI.
    const events = await store.listEvents(result.sessionId!);
    expect(events.some((e) => e.type === "publish")).toBe(true);
  });

  it("dry run integrates locally but does not push", async () => {
    const config = publishConfig({
      LOOPWRIGHT_PUSH_TO_REMOTE: "true",
      LOOPWRIGHT_DRY_RUN: "true",
    });

    const result = await runGoal("Add a file", config, {
      factory,
      executor: okExecutor,
      repoDir: repo,
    });

    expect(result.integration?.ok).toBe(true);
    // No publish result on a dry run.
    expect(result.publish).toBeUndefined();
    // Nothing was pushed to the remote.
    const branches = await spawnGit(["branch", "--list"], remote);
    expect(branches.stdout.trim()).toBe("");
  });
});

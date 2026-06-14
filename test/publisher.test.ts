import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { publish, publishSafety, redactRemoteUrl, type PrCreator } from "../src/engine/publisher.js";
import { spawnGit } from "../src/workspace/git.js";
import type { IntegrationResult } from "../src/engine/integrator.js";

const okIntegration = (branch: string): IntegrationResult => ({
  merged: ["a"],
  conflicts: [],
  integrationBranch: branch,
  verification: { passed: true, steps: [] },
  ok: true,
});

describe("publishSafety", () => {
  it("passes for a clean integration with no human-needed tasks", () => {
    expect(publishSafety({ integration: okIntegration("b"), needsHuman: [] })).toBeUndefined();
    expect(publishSafety({})).toBeUndefined();
  });

  it("refuses on merge conflicts", () => {
    const r = publishSafety({
      integration: {
        merged: ["a"],
        conflicts: [{ taskId: "b", branch: "br-b", files: ["x.ts"] }],
        integrationBranch: "i",
        ok: false,
      },
    });
    expect(r?.refusal).toBe("merge-conflicts");
  });

  it("refuses on failed verification and includes the failed command output", () => {
    const r = publishSafety({
      integration: {
        merged: ["a"],
        conflicts: [],
        integrationBranch: "i",
        verification: {
          passed: false,
          steps: [{ command: "npm test", exitCode: 1, passed: false, durationMs: 5, output: "boom" }],
        },
        ok: false,
      },
    });
    expect(r?.refusal).toBe("verification-failed");
    expect(r?.reason).toContain("npm test");
    expect(r?.reason).toContain("boom");
  });

  it("refuses when tasks need a human", () => {
    const r = publishSafety({ integration: okIntegration("b"), needsHuman: ["t3"] });
    expect(r?.refusal).toBe("needs-human");
  });
});

describe("redactRemoteUrl", () => {
  it("strips embedded credentials from https remotes", () => {
    expect(redactRemoteUrl("https://user:ghp_secret@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
    expect(redactRemoteUrl("https://x-access-token:tok@github.com/o/r.git")).not.toContain("tok");
  });

  it("leaves credential-free and SSH remotes unchanged", () => {
    expect(redactRemoteUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
    // SSH scp-like syntax isn't a parseable URL and carries no secret.
    expect(redactRemoteUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });
});

describe("publish (real git, bare remote)", () => {
  let repo: string;
  let remote: string;

  beforeEach(async () => {
    remote = await mkdtemp(join(tmpdir(), "loopwright-remote-"));
    await spawnGit(["init", "-q", "--bare", "-b", "main"], remote);

    repo = await mkdtemp(join(tmpdir(), "loopwright-pub-"));
    await spawnGit(["init", "-q", "-b", "main"], repo);
    await spawnGit(["config", "user.email", "t@example.com"], repo);
    await spawnGit(["config", "user.name", "T"], repo);
    await writeFile(join(repo, "base.txt"), "base\n");
    await spawnGit(["add", "-A"], repo);
    await spawnGit(["commit", "-q", "-m", "init"], repo);
    // Build an integration branch to publish.
    await spawnGit(["checkout", "-q", "-b", "loopwright/s/feature"], repo);
    await writeFile(join(repo, "feature.txt"), "x\n");
    await spawnGit(["add", "-A"], repo);
    await spawnGit(["commit", "-q", "-m", "feature"], repo);
    await spawnGit(["checkout", "-q", "main"], repo);
  });

  it("pushes the integration branch to the remote", async () => {
    await spawnGit(["remote", "add", "origin", remote], repo);
    const result = await publish({
      repoDir: repo,
      branch: "loopwright/s/feature",
      remote: "origin",
      push: true,
      integration: okIntegration("loopwright/s/feature"),
    });
    expect(result.pushed).toBe(true);
    expect(result.error).toBeUndefined();

    // The branch now exists on the bare remote.
    const branches = await spawnGit(["branch", "--list"], remote);
    expect(branches.stdout).toContain("loopwright/s/feature");
  });

  it("returns a clear error when the remote is missing (no push)", async () => {
    const result = await publish({
      repoDir: repo,
      branch: "loopwright/s/feature",
      remote: "origin",
      push: true,
      integration: okIntegration("loopwright/s/feature"),
    });
    expect(result.pushed).toBe(false);
    expect(result.refused).toBe("no-remote");
    expect(result.reason).toContain("origin");
  });

  it("refuses to push a failed integration unless overridden", async () => {
    await spawnGit(["remote", "add", "origin", remote], repo);
    const failed: IntegrationResult = {
      merged: [],
      conflicts: [{ taskId: "b", branch: "br", files: ["f"] }],
      integrationBranch: "loopwright/s/feature",
      ok: false,
    };

    const refused = await publish({
      repoDir: repo,
      branch: "loopwright/s/feature",
      remote: "origin",
      push: true,
      integration: failed,
    });
    expect(refused.pushed).toBe(false);
    expect(refused.refused).toBe("merge-conflicts");

    // The same push goes through with the explicit override.
    const overridden = await publish({
      repoDir: repo,
      branch: "loopwright/s/feature",
      remote: "origin",
      push: true,
      overrideSafety: true,
      integration: failed,
    });
    expect(overridden.pushed).toBe(true);
  });

  it("opens a PR via the injected creator after a successful push", async () => {
    await spawnGit(["remote", "add", "origin", remote], repo);
    const calls: Array<Record<string, unknown>> = [];
    const prCreator: PrCreator = async (input) => {
      calls.push(input as unknown as Record<string, unknown>);
      return { url: "https://example.com/pr/1" };
    };

    const result = await publish({
      repoDir: repo,
      branch: "loopwright/s/feature",
      remote: "origin",
      push: true,
      openPr: true,
      prBase: "main",
      prTitle: "My PR",
      prDraft: true,
      integration: okIntegration("loopwright/s/feature"),
      prCreator,
    });

    expect(result.pushed).toBe(true);
    expect(result.pr?.created).toBe(true);
    expect(result.pr?.url).toBe("https://example.com/pr/1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.head).toBe("loopwright/s/feature");
    expect(calls[0]!.base).toBe("main");
    expect(calls[0]!.draft).toBe(true);
  });

  it("captures a PR creation failure without failing the push", async () => {
    await spawnGit(["remote", "add", "origin", remote], repo);
    const prCreator: PrCreator = async () => {
      throw new Error("gh not authenticated");
    };
    const result = await publish({
      repoDir: repo,
      branch: "loopwright/s/feature",
      remote: "origin",
      push: true,
      openPr: true,
      integration: okIntegration("loopwright/s/feature"),
      prCreator,
    });
    expect(result.pushed).toBe(true);
    expect(result.pr?.created).toBe(false);
    expect(result.pr?.error).toContain("gh not authenticated");
  });

  it("redacts credentials from the remote URL it reports on a failed push", async () => {
    // A credentialed HTTPS remote that cannot actually be pushed to; the push
    // fails, but the reported remoteUrl must not leak the embedded token.
    await spawnGit(
      ["remote", "add", "origin", "https://user:supersecret@127.0.0.1:1/o/r.git"],
      repo,
    );
    const result = await publish({
      repoDir: repo,
      branch: "loopwright/s/feature",
      remote: "origin",
      push: true,
      integration: okIntegration("loopwright/s/feature"),
    });
    expect(result.pushed).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.remoteUrl ?? "").not.toContain("supersecret");
  });
});

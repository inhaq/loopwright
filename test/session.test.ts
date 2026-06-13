import { describe, it, expect } from "vitest";
import { runGoal, openBlockers, finalSessionStatus } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import type { AgentRunner, RunnerProfile, RunRequest } from "../src/runners/agentRunner.js";
import { criticGreen, criticBlock, scriptedExecutor } from "../src/adapters/mocks.js";
import { MemoryStore } from "../src/storage/store.js";

/**
 * End-to-end session tests. The whole config -> createRoles -> plan review ->
 * per-task loop path runs against MockRunners injected through the factory, so
 * the wiring is exercised without a network or subprocess.
 */

const TASK_ID_RE = /id:\s*(\S+)/;

const planJson = JSON.stringify({
  tasks: [
    {
      id: "t1",
      title: "First",
      description: "d",
      acceptanceCriteria: ["works"],
      verifyCommands: ["check"],
      dependencies: [],
    },
    {
      id: "t2",
      title: "Second",
      description: "d",
      acceptanceCriteria: ["works"],
      verifyCommands: ["check"],
      dependencies: ["t1"],
    },
  ],
});

const buildJson = (id: string) =>
  JSON.stringify({ diff: `--- ${id}`, touchedFiles: [`${id}.ts`], summary: `built ${id}` });

/**
 * One responder serving both roles; each runner only receives its own role's
 * prompts. `taskVerdict` decides the critic's task-review outcome per task id.
 */
function responder(taskVerdict: (taskId: string) => "green" | "block") {
  return (req: RunRequest): string => {
    const p = req.prompt;
    if (p.includes("Decompose this goal")) return planJson;
    if (p.includes("Build the following task")) {
      const id = TASK_ID_RE.exec(p)?.[1] ?? "t?";
      return buildJson(id);
    }
    if (p.includes("Review this PLAN")) return criticGreen("plan ok").text;
    // task review
    const id = TASK_ID_RE.exec(p)?.[1] ?? "t?";
    return taskVerdict(id) === "green"
      ? criticGreen("looks correct").text
      : criticBlock([
          { severity: "blocker", category: "correctness", detail: "bug", location: id },
        ]).text;
  };
}

function configWithMockRoles() {
  return loadConfig({
    LOOPWRIGHT_RUNNERS: '[{"id":"primary","kind":"mock","model":"m"}]',
    LOOPWRIGHT_ACTOR_RUNNER: "primary",
    LOOPWRIGHT_CRITIC_RUNNER: "primary",
  });
}

function mockFactory(taskVerdict: (taskId: string) => "green" | "block") {
  const respond = responder(taskVerdict);
  return (profile: RunnerProfile): AgentRunner => new MockRunner(profile, { respond });
}

const okExecutor = scriptedExecutor(() => ({ exitCode: 0, output: "ok" }));

describe("runGoal end-to-end", () => {
  it("drives a multi-task plan to all-verified GREEN in dependency order", async () => {
    const config = configWithMockRoles();
    const result = await runGoal("build a feature", config, {
      factory: mockFactory(() => "green"),
      executor: okExecutor,
    });

    expect(result.plan.approved).toBe(true);
    expect(result.green).toEqual(["t1", "t2"]);
    expect(result.allVerified).toBe(true);
    expect(result.results.every((r) => r.status === "completed")).toBe(true);
  });

  it("skips a dependent when its prerequisite needs human attention", async () => {
    const config = configWithMockRoles();
    // t1 is always blocked -> exhausts review cycles -> NEEDS_HUMAN; t2 depends on it.
    const result = await runGoal("g", config, {
      factory: mockFactory((id) => (id === "t1" ? "block" : "green")),
      executor: okExecutor,
    });

    expect(result.needsHuman).toContain("t1");
    expect(result.skipped).toContain("t2");
    expect(result.allVerified).toBe(false);

    const t2 = result.results.find((r) => r.taskId === "t2");
    expect(t2?.status).toBe("skipped");
    expect(t2?.blockedBy).toEqual(["t1"]);

    // t1's unresolved blockers are reportable
    expect(openBlockers(result).length).toBeGreaterThan(0);
  });

  it("fails fast when no runner is bound to a role", async () => {
    const config = loadConfig({
      LOOPWRIGHT_RUNNERS: '[{"id":"primary","kind":"mock","model":"m"}]',
      // no actor/critic runner bound
    });
    await expect(runGoal("g", config, { executor: okExecutor })).rejects.toThrow();
  });

  it("persists 'failed' + a failure event when the run throws", async () => {
    const store = new MemoryStore();
    const config = configWithMockRoles();
    // A runner that throws makes plan review (and thus runGoal) reject.
    const throwingFactory = (profile: RunnerProfile): AgentRunner => ({
      profile,
      run: async () => {
        throw new Error("kaboom");
      },
    });

    await expect(
      runGoal("g", config, { store, factory: throwingFactory, executor: okExecutor }),
    ).rejects.toThrow(/kaboom/);

    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    // The durable session is terminal (failed), not stuck "running".
    expect(sessions[0]!.status).toBe("failed");
    const events = await store.listEvents(sessions[0]!.id);
    expect(events.some((e) => e.type === "session_failed")).toBe(true);
  });
});

describe("finalSessionStatus", () => {
  it("is completed only when nothing needs a human and integration (if any) is ok", () => {
    expect(finalSessionStatus(0)).toBe("completed");
    expect(finalSessionStatus(0, { ok: true })).toBe("completed");
  });

  it("is needs_human when a task needs attention", () => {
    expect(finalSessionStatus(2)).toBe("needs_human");
  });

  it("is needs_human when integration failed, even with no task blockers", () => {
    // A clean per-task run that fails to integrate (conflicts / failed verify)
    // must not be reported as completed.
    expect(finalSessionStatus(0, { ok: false })).toBe("needs_human");
  });
});

import { describe, it, expect } from "vitest";
import { runGoal } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/storage/store.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import type { AgentRunner, RunnerProfile, RunRequest } from "../src/runners/agentRunner.js";
import { criticGreen, criticBlock, scriptedExecutor } from "../src/adapters/mocks.js";

/**
 * Checkpoint + resume (Task 17): a first run persists outcomes; a second run
 * with `resume` reuses completed tasks instead of rebuilding them.
 */

const TASK_ID_RE = /id:\s*(\S+)/;

const planJson = JSON.stringify({
  tasks: [
    { id: "t1", title: "First", description: "d", acceptanceCriteria: ["ok"], verifyCommands: ["check"], dependencies: [] },
    { id: "t2", title: "Second", description: "d", acceptanceCriteria: ["ok"], verifyCommands: ["check"], dependencies: ["t1"] },
  ],
});

const buildJson = (id: string) =>
  JSON.stringify({ diff: `--- ${id}`, touchedFiles: [`${id}.ts`], summary: `built ${id}` });

function responder(taskVerdict: () => "green" | "block") {
  return (req: RunRequest): string => {
    const p = req.prompt;
    if (p.includes("Decompose this goal")) return planJson;
    if (p.includes("Build the following task")) return buildJson(TASK_ID_RE.exec(p)?.[1] ?? "t?");
    if (p.includes("Review this PLAN")) return criticGreen("plan ok").text;
    return taskVerdict() === "green"
      ? criticGreen("ok").text
      : criticBlock([{ severity: "blocker", category: "correctness", detail: "bug", location: "x" }]).text;
  };
}

const config = () =>
  loadConfig({
    LOOPWRIGHT_RUNNERS: '[{"id":"primary","kind":"mock","model":"m"}]',
    LOOPWRIGHT_ACTOR_RUNNER: "primary",
    LOOPWRIGHT_CRITIC_RUNNER: "primary",
  });

const factory = (verdict: () => "green" | "block") => {
  const respond = responder(verdict);
  return (profile: RunnerProfile): AgentRunner => new MockRunner(profile, { respond });
};

const okExecutor = scriptedExecutor(() => ({ exitCode: 0, output: "ok" }));

describe("checkpoint + resume", () => {
  it("checkpoints transitions and outcomes to the store during a run", async () => {
    const store = new MemoryStore();
    const result = await runGoal("g", config(), {
      store,
      factory: factory(() => "green"),
      executor: okExecutor,
    });

    expect(result.sessionId).toBeDefined();
    const sid = result.sessionId as string;

    expect((await store.getSession(sid))?.status).toBe("completed");
    expect((await store.getOutcome(sid, "t1"))?.verified).toBe(true);
    expect((await store.listTransitions(sid)).length).toBeGreaterThan(0);
    expect((await store.getTask(sid, "t2"))?.state).toBe("GREEN");
  });

  it("reuses completed tasks on resume instead of rebuilding them", async () => {
    const store = new MemoryStore();

    // First run: everything passes and is persisted.
    const first = await runGoal("g", config(), {
      store,
      factory: factory(() => "green"),
      executor: okExecutor,
    });
    const sid = first.sessionId as string;
    expect(first.green).toEqual(["t1", "t2"]);

    // Second run with the SAME session + resume. The factory would now BLOCK
    // every task review, so any rebuilt task would end NEEDS_HUMAN. Because the
    // tasks are reused from the checkpoint, the run stays all-green.
    const second = await runGoal("g", config(), {
      store,
      sessionId: sid,
      resume: true,
      factory: factory(() => "block"),
      executor: okExecutor,
    });

    expect(second.results.every((r) => r.status === "resumed")).toBe(true);
    expect(second.green).toEqual(["t1", "t2"]);
    expect(second.needsHuman).toEqual([]);
    expect(second.allVerified).toBe(true);
  });

  it("re-runs a task that did not complete, and can then finish it", async () => {
    const store = new MemoryStore();

    // First run: t1 is blocked -> NEEDS_HUMAN, so t2 is skipped.
    const first = await runGoal("g", config(), {
      store,
      factory: factory(() => "block"),
      executor: okExecutor,
    });
    const sid = first.sessionId as string;
    expect(first.needsHuman).toContain("t1");
    expect(first.skipped).toContain("t2");

    // Resume with a now-passing critic: t1 is re-run (not completed before) and
    // t2 then proceeds, reaching all-green.
    const second = await runGoal("g", config(), {
      store,
      sessionId: sid,
      resume: true,
      factory: factory(() => "green"),
      executor: okExecutor,
    });
    expect(second.green).toEqual(["t1", "t2"]);
    expect(second.allVerified).toBe(true);
  });
});

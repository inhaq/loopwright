import { describe, it, expect } from "vitest";
import { RunnerActor, RunnerCritic, RunnerRoleError } from "../src/adapters/runnerRoles.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import type { AgentRunner, RunnerProfile, RunRequest, RunResult } from "../src/runners/agentRunner.js";
import type { RunnerActivityEvent } from "../src/observability/events.js";
import type { TaskSpec } from "../src/schemas/plan.js";
import type { TaskArtifactBundle } from "../src/schemas/artifact.js";
import { loadConfig } from "../src/config.js";
import { runPlanReview, runTask } from "../src/engine/loop.js";
import { criticGreen, criticBlock, scriptedExecutor } from "../src/adapters/mocks.js";

const profile: RunnerProfile = { id: "p", kind: "mock", model: "test-model" };

function mock(respond: (prompt: string, i: number) => string | RunResult): MockRunner {
  return new MockRunner(profile, { respond: (req, i) => respond(req.prompt, i) });
}

const planJson = (taskId = "t1", verify: string[] = ["check"]) =>
  JSON.stringify({
    tasks: [
      {
        id: taskId,
        title: "Do the thing",
        description: "details",
        acceptanceCriteria: ["it works"],
        verifyCommands: verify,
        dependencies: [],
      },
    ],
    notes: "drafted",
  });

const buildJson = (id: string) =>
  JSON.stringify({
    diff: `--- a/${id}.ts\n+++ b/${id}.ts`,
    touchedFiles: [`${id}.ts`],
    summary: `built ${id}`,
  });

const sampleTask: TaskSpec = {
  id: "t1",
  title: "Do the thing",
  description: "",
  acceptanceCriteria: ["it works"],
  verifyCommands: ["check"],
  dependencies: [],
};

const sampleBundle: TaskArtifactBundle = {
  task: sampleTask,
  diff: "--- a\n+++ b",
  touchedFiles: ["t1.ts"],
  mechanicalGate: { passed: true, steps: [] },
  testCommands: ["check"],
};

describe("RunnerActor.draftPlan", () => {
  it("parses a plan wrapped in prose and injects the engine's goal authoritatively", async () => {
    const runner = mock(() => `Sure! Here is the plan:\n\n${planJson()}\n\nLet me know.`);
    const actor = new RunnerActor(runner);
    const { plan, notes } = await actor.draftPlan("My real goal");
    expect(plan.goal).toBe("My real goal"); // never taken from model output
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.id).toBe("t1");
    expect(notes).toBe("drafted");
  });

  it("includes critic blockers in the revision prompt", async () => {
    const runner = mock(() => planJson());
    const actor = new RunnerActor(runner);
    await actor.draftPlan("g", [
      { severity: "blocker", category: "requirements", detail: "needs a DoD", location: "plan" },
    ]);
    expect(runner.requests[0]?.prompt).toContain("REVISION");
    expect(runner.requests[0]?.prompt).toContain("needs a DoD");
  });

  it("retries once with a nudge when output is unparseable, then succeeds", async () => {
    const runner = mock((_p, i) => (i === 0 ? "no json here" : planJson()));
    const actor = new RunnerActor(runner);
    const { plan } = await actor.draftPlan("g");
    expect(plan.tasks).toHaveLength(1);
    expect(runner.requests).toHaveLength(2);
    expect(runner.requests[1]?.prompt).toContain("could not be parsed");
  });

  it("throws RunnerRoleError after two unparseable replies", async () => {
    const runner = mock(() => "still no json");
    const actor = new RunnerActor(runner);
    await expect(actor.draftPlan("g")).rejects.toBeInstanceOf(RunnerRoleError);
  });

  it("does not retry when repairOnce is disabled", async () => {
    const runner = mock(() => "no json");
    const actor = new RunnerActor(runner, { repairOnce: false });
    await expect(actor.draftPlan("g")).rejects.toBeInstanceOf(RunnerRoleError);
    expect(runner.requests).toHaveLength(1);
  });

  it("surfaces quota exhaustion as a RunnerRoleError flagged quotaExhausted", async () => {
    const runner = mock(() => ({ text: "", quotaExhausted: true }));
    const actor = new RunnerActor(runner);
    await expect(actor.draftPlan("g")).rejects.toMatchObject({
      name: "RunnerRoleError",
      quotaExhausted: true,
    });
  });
});

describe("RunnerActor.build", () => {
  it("parses diff/touchedFiles/summary", async () => {
    const runner = mock(() => buildJson("t1"));
    const actor = new RunnerActor(runner);
    const r = await actor.build(sampleTask);
    expect(r.touchedFiles).toEqual(["t1.ts"]);
    expect(r.summary).toBe("built t1");
    expect(r.diff).toContain("t1.ts");
  });

  it("feeds prior mechanical failure context into the next prompt", async () => {
    const runner = mock(() => buildJson("t1"));
    const actor = new RunnerActor(runner);
    await actor.build(sampleTask, {
      mechanicalFailure: {
        passed: false,
        steps: [
          { command: "check", exitCode: 1, passed: false, durationMs: 1, output: "boom" },
        ],
      },
    });
    expect(runner.requests[0]?.prompt).toContain("PRIOR FAILURE CONTEXT");
    expect(runner.requests[0]?.prompt).toContain("boom");
  });
});

describe("RunnerActor.selfReview / RunnerCritic.review (raw passthrough)", () => {
  it("selfReview returns raw text + quota without parsing", async () => {
    const runner = mock(() => ({ text: "anything at all", quotaExhausted: true }));
    const actor = new RunnerActor(runner);
    const r = await actor.selfReview(sampleBundle);
    expect(r.text).toBe("anything at all");
    expect(r.quotaExhausted).toBe(true);
  });

  it("critic forwards goal+plan and the repair hint into the prompt", async () => {
    const runner = mock(() => criticGreen().text);
    const critic = new RunnerCritic(runner);
    await critic.review({
      kind: "plan",
      goal: "ship it",
      plan: { goal: "ship it", tasks: [sampleTask] },
      repairHint: "PLEASE-REPAIR",
    });
    expect(runner.requests[0]?.prompt).toContain("ship it");
    expect(runner.requests[0]?.prompt).toContain("PLEASE-REPAIR");
  });

  it("critic passes the raw review text straight through (engine parses it)", async () => {
    const runner = mock(() => criticGreen("all good").text);
    const critic = new RunnerCritic(runner);
    const r = await critic.review({ kind: "task", bundle: sampleBundle });
    expect(r.text).toContain("all good");
  });
});

describe("runner-backed roles drive the real loop", () => {
  it("reaches a verified GREEN through plan review + per-task loop", async () => {
    const config = loadConfig({});

    const actor = new RunnerActor(
      mock((prompt) => (prompt.includes("Decompose this goal") ? planJson() : buildJson("t1"))),
    );
    const critic = new RunnerCritic(mock(() => criticGreen("looks correct").text));

    const executor = scriptedExecutor(() => ({ exitCode: 0, output: "ok" }));

    const plan = await runPlanReview("build a feature", { actor, critic, config, cwd: ".", executor });
    expect(plan.approved).toBe(true);

    const outcome = await runTask(plan.plan.tasks[0] as TaskSpec, {
      actor,
      critic,
      config,
      cwd: ".",
      executor,
    });
    expect(outcome.finalState).toBe("GREEN");
    expect(outcome.verified).toBe(true);
  });

  it("a critic blocker drives an actor fix cycle to resolution", async () => {
    const config = loadConfig({});

    const actor = new RunnerActor(
      mock((prompt) => (prompt.includes("Decompose this goal") ? planJson() : buildJson("t1"))),
    );
    // First task review blocks on correctness; second pass is green.
    const critic = new RunnerCritic(
      mock((prompt, i) => {
        if (prompt.includes("Review this PLAN")) return criticGreen("plan ok").text;
        return i === 1
          ? criticBlock([
              { severity: "blocker", category: "correctness", detail: "off by one", location: "x" },
            ]).text
          : criticGreen("fixed").text;
      }),
    );
    const executor = scriptedExecutor(() => ({ exitCode: 0, output: "ok" }));

    const plan = await runPlanReview("g", { actor, critic, config, cwd: ".", executor });
    const outcome = await runTask(plan.plan.tasks[0] as TaskSpec, {
      actor,
      critic,
      config,
      cwd: ".",
      executor,
    });
    expect(outcome.finalState).toBe("GREEN");
    expect(outcome.reviewCycles).toBe(1);
    expect(outcome.buildAttempts).toBe(2);
  });
});


describe("runner activity streaming (sub-step events)", () => {
  const ts = () => new Date().toISOString();

  it("forwards actor runner activity enriched with the role + runner identity", async () => {
    const runner: AgentRunner = {
      profile,
      async run(req: RunRequest): Promise<RunResult> {
        req.onEvent?.({ phase: "turn_start", turn: 1, at: ts() });
        req.onEvent?.({ phase: "tool_start", toolName: "edit_file", toolCallId: "c1", at: ts() });
        req.onEvent?.({ phase: "tool_end", toolName: "edit_file", toolCallId: "c1", isError: false, at: ts() });
        return { text: buildJson("t1") };
      },
    };
    const events: RunnerActivityEvent[] = [];
    const actor = new RunnerActor(runner, { onActivity: (e) => events.push(e) });

    await actor.build(sampleTask, undefined, ".");

    expect(events.map((e) => e.phase)).toEqual(["turn_start", "tool_start", "tool_end"]);
    expect(events.every((e) => e.role === "actor")).toBe(true);
    expect(events.every((e) => e.runnerId === "p" && e.model === "test-model")).toBe(true);
    const end = events.find((e) => e.phase === "tool_end");
    expect(end?.toolName).toBe("edit_file");
    expect(end?.toolCallId).toBe("c1");
    expect(end?.isError).toBe(false);
  });

  it("attributes critic runner activity to the critic role", async () => {
    const runner: AgentRunner = {
      profile,
      async run(req: RunRequest): Promise<RunResult> {
        req.onEvent?.({ phase: "tool_start", toolName: "read_file", toolCallId: "x", at: ts() });
        return { text: criticGreen().text };
      },
    };
    const events: RunnerActivityEvent[] = [];
    const critic = new RunnerCritic(runner, { onActivity: (e) => events.push(e) });

    await critic.review({ kind: "task", bundle: sampleBundle });

    expect(events).toHaveLength(1);
    expect(events[0]?.role).toBe("critic");
    expect(events[0]?.toolName).toBe("read_file");
  });

  it("does no work and forwards nothing when no activity sink is configured", async () => {
    let called = false;
    const runner: AgentRunner = {
      profile,
      async run(req: RunRequest): Promise<RunResult> {
        if (req.onEvent) called = true; // role must not pass an onEvent when sink is off
        return { text: buildJson("t1") };
      },
    };
    const actor = new RunnerActor(runner);
    await actor.build(sampleTask, undefined, ".");
    expect(called).toBe(false);
  });
});

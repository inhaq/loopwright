import { describe, it, expect } from "vitest";
import { normalizeUsage, type RunnerCallEvent } from "../src/observability/events.js";
import { instrumentRunner } from "../src/observability/instrument.js";
import { computeUsage } from "../src/observability/usage.js";
import { buildTrace, formatTrace } from "../src/observability/trace.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import type { AgentRunner, RunnerProfile, RunRequest } from "../src/runners/agentRunner.js";
import { runGoal } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/storage/store.js";
import { criticGreen, scriptedExecutor } from "../src/adapters/mocks.js";

describe("normalizeUsage", () => {
  it("reads OpenAI-style keys", () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("reads input/output keys and derives a missing total", () => {
    expect(normalizeUsage({ input_tokens: 7, output_tokens: 3 })).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    });
  });

  it("is zero for missing/garbage usage", () => {
    expect(normalizeUsage(undefined)).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(normalizeUsage("nope")).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });
});

describe("instrumentRunner", () => {
  it("emits a role-attributed event with char counts and normalized usage", async () => {
    const profile: RunnerProfile = { id: "p", kind: "mock", model: "m" };
    const base = new MockRunner(profile, {
      respond: () => ({ text: "answer", meta: { usage: { prompt_tokens: 8, completion_tokens: 2 } } }),
    });
    const events: RunnerCallEvent[] = [];
    const wrapped = instrumentRunner(base, "critic", (e) => {
      events.push(e);
    });

    const res = await wrapped.run({ prompt: "hello", cwd: "." } as RunRequest);
    expect(res.text).toBe("answer"); // transparent passthrough

    expect(events).toHaveLength(1);
    const e = events[0] as RunnerCallEvent;
    expect(e.role).toBe("critic");
    expect(e.runnerId).toBe("p");
    expect(e.promptChars).toBe("hello".length);
    expect(e.outputChars).toBe("answer".length);
    expect(e.usage).toEqual({ promptTokens: 8, completionTokens: 2, totalTokens: 10 });
  });
});

describe("computeUsage", () => {
  const call = (role: "actor" | "critic", p: number, c: number, quota = false): RunnerCallEvent => ({
    role,
    runnerId: "r",
    model: "m",
    promptChars: 0,
    outputChars: 0,
    durationMs: 5,
    quotaExhausted: quota,
    usage: { promptTokens: p, completionTokens: c, totalTokens: p + c },
    at: "t",
  });

  it("aggregates per role and overall, and applies optional rates", () => {
    const ledger = computeUsage(
      [call("actor", 100, 50), call("actor", 100, 50), call("critic", 200, 0, true)],
      { actor: { per1kPrompt: 1, per1kCompletion: 2 } },
    );
    expect(ledger.perRole.actor.calls).toBe(2);
    expect(ledger.perRole.actor.totalTokens).toBe(300);
    expect(ledger.perRole.critic.quotaHits).toBe(1);
    expect(ledger.total.totalTokens).toBe(500);
    // actor cost: 200/1000*1 + 100/1000*2 = 0.2 + 0.2 = 0.4
    expect(ledger.perRole.actor.costUsd).toBeCloseTo(0.4, 6);
  });
});

// ---- end-to-end: a real run records the event stream + trace -------------

const TASK_ID_RE = /id:\s*(\S+)/;
const planJson = JSON.stringify({
  tasks: [{ id: "t1", title: "T", description: "d", acceptanceCriteria: ["ok"], verifyCommands: ["check"], dependencies: [] }],
});
const buildJson = (id: string) => JSON.stringify({ diff: `--- ${id}`, touchedFiles: [`${id}.ts`], summary: `built ${id}` });

function factory() {
  const respond = (req: RunRequest): string => {
    const p = req.prompt;
    if (p.includes("Decompose this goal")) return planJson;
    if (p.includes("Build the following task")) return buildJson(TASK_ID_RE.exec(p)?.[1] ?? "t?");
    return criticGreen("ok").text; // plan + task reviews
  };
  return (profile: RunnerProfile): AgentRunner => new MockRunner(profile, { respond });
}

describe("session trace (end-to-end)", () => {
  it("records runner calls + lifecycle and builds an inspectable trace", async () => {
    const store = new MemoryStore();
    const config = loadConfig({
      LOOPWRIGHT_RUNNERS: '[{"id":"primary","kind":"mock","model":"m"}]',
      LOOPWRIGHT_ACTOR_RUNNER: "primary",
      LOOPWRIGHT_CRITIC_RUNNER: "primary",
    });

    const result = await runGoal("ship it", config, {
      store,
      factory: factory(),
      executor: scriptedExecutor(() => ({ exitCode: 0, output: "ok" })),
    });
    const sid = result.sessionId as string;

    const events = await store.listEvents(sid);
    const types = events.map((e) => e.type);
    expect(types).toContain("session_started");
    expect(types).toContain("plan_reviewed");
    expect(types).toContain("runner_call");
    expect(types).toContain("session_finished");

    const trace = await buildTrace(store, sid);
    // actor: draftPlan + build; critic: plan review + task review
    expect(trace.usage.perRole.actor.calls).toBeGreaterThanOrEqual(2);
    expect(trace.usage.perRole.critic.calls).toBeGreaterThanOrEqual(2);
    expect(trace.usage.total.calls).toBe(trace.usage.perRole.actor.calls + trace.usage.perRole.critic.calls);
    expect(trace.transitions.length).toBeGreaterThan(0);

    const text = formatTrace(trace);
    expect(text).toContain(sid);
    expect(text).toContain("Usage:");
    expect(text).toContain("t1");
  });
});

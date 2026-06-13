import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type LoopwrightServer, type RunGoalImpl } from "../src/server/server.js";
import { MemoryStore } from "../src/storage/store.js";
import { loadConfig, type LoopwrightConfig } from "../src/config.js";
import { EVENT_TYPES } from "../src/observability/events.js";
import type { SessionResult } from "../src/session.js";
import type { TaskOutcome } from "../src/engine/loop.js";

/**
 * Server transport tests (Task 25.1). The engine itself is covered elsewhere;
 * here we verify the HTTP/SSE surface that the desktop shell consumes — start a
 * run, observe it live, and read its trace — using a simulated `runGoal` that
 * drives the exact hooks the real engine uses (store events, observer
 * transitions/outcomes, log lines). A fixed token exercises the auth boundary.
 */

const baseConfig: LoopwrightConfig = loadConfig({});
const TOKEN = "test-token";
const auth = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...extra,
  authorization: `Bearer ${TOKEN}`,
});

function greenOutcome(taskId: string): TaskOutcome {
  return {
    taskId,
    finalState: "GREEN",
    verified: true,
    history: [],
    buildAttempts: 1,
    reviewCycles: 1,
    nits: [],
    unresolvedBlockers: [],
    lastDiff: "diff --git a/x b/x",
  };
}

/**
 * A stand-in for the real engine that performs the same side effects the
 * server relies on: it persists session + lifecycle events to the store
 * (tapped for live streaming), records a task transition + outcome, and emits
 * observer + log callbacks. Returns a minimal but well-formed SessionResult.
 */
const simulatedRun: RunGoalImpl = async (goal, _config, opts = {}) => {
  const store = opts.store!;
  const sessionId = opts.sessionId!;
  const now = new Date().toISOString();

  await store.createSession({ id: sessionId, goal, createdAt: now, updatedAt: now, status: "running" });
  await store.recordEvent({ sessionId, at: now, type: EVENT_TYPES.sessionStarted, data: { goal } });
  await store.recordEvent({
    sessionId,
    at: now,
    type: EVENT_TYPES.runnerCall,
    data: { role: "actor", runnerId: "primary", model: "m", promptChars: 10, outputChars: 20, durationMs: 5, quotaExhausted: false, usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 }, at: now },
  });

  opts.log?.("building task-1");
  await opts.observer?.transition?.({ taskId: "task-1", from: "PLANNED", event: "BUILD_STARTED", to: "BUILDING", reason: "start", at: now });
  await store.recordTransition({ sessionId, taskId: "task-1", from: "CRITIC_REVIEWING", event: "CRITIC_GREEN", to: "GREEN", reason: "ok", at: now });

  const outcome = greenOutcome("task-1");
  await store.recordOutcome({ sessionId, taskId: "task-1", finalState: "GREEN", verified: true, at: now, outcome });
  await opts.observer?.outcome?.(outcome);

  await store.updateSession(sessionId, { status: "completed", planApproved: true, planRevisions: 0 });
  await store.recordEvent({ sessionId, at: now, type: EVENT_TYPES.sessionFinished, data: { green: ["task-1"] } });

  const result: SessionResult = {
    goal,
    sessionId,
    plan: { plan: { tasks: [] } as never, approved: true, proceededWithOpenItems: false, openItems: [], revisions: 0, history: [] },
    results: [{ taskId: "task-1", status: "completed", outcome }],
    green: ["task-1"],
    unverified: [],
    needsHuman: [],
    skipped: [],
    allVerified: true,
  };
  return result;
};

let server: LoopwrightServer;
let base: string;

async function startServer(runGoalImpl: RunGoalImpl = simulatedRun): Promise<void> {
  server = createServer({ store: new MemoryStore(), config: baseConfig, runGoalImpl, baseEnv: {}, token: TOKEN });
  const port = await server.start(0);
  base = `http://127.0.0.1:${port}`;
}

/** Starts a run and returns its session id (with auth). */
async function startRun(goal: string): Promise<string> {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify({ goal }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

afterEach(async () => {
  await server?.stop();
});

/** Reads SSE messages from a stream until `done` returns true (or it ends). */
async function readSse(
  res: Response,
  done: (msgs: Array<{ id: number; event: string; data: any }>) => boolean,
): Promise<Array<{ id: number; event: string; data: any }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const msgs: Array<{ id: number; event: string; data: any }> = [];
  let buf = "";
  try {
    while (!done(msgs)) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (frame.startsWith(":")) continue; // heartbeat comment
        const m: { id: number; event: string; data: any } = { id: -1, event: "", data: undefined };
        for (const line of frame.split("\n")) {
          if (line.startsWith("id: ")) m.id = Number.parseInt(line.slice(4), 10);
          else if (line.startsWith("event: ")) m.event = line.slice(7);
          else if (line.startsWith("data: ")) m.data = JSON.parse(line.slice(6));
        }
        msgs.push(m);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return msgs;
}

describe("server: health + validation", () => {
  beforeEach(() => startServer());

  it("reports health without a token", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects a run with no goal", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ goal: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("404s unknown api routes and missing traces", async () => {
    expect((await fetch(`${base}/api/nope`, { headers: auth() })).status).toBe(404);
    expect((await fetch(`${base}/api/sessions/ghost/trace`, { headers: auth() })).status).toBe(404);
    // Streaming a session that was never started must not implicitly create it.
    expect((await fetch(`${base}/api/runs/ghost/stream`, { headers: auth() })).status).toBe(404);
  });
});

describe("server: auth boundary", () => {
  beforeEach(() => startServer());

  it("rejects /api requests without the token", async () => {
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    const run = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "do it" }),
    });
    expect(run.status).toBe(401);
    // A wrong token is rejected too.
    expect((await fetch(`${base}/api/sessions`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("accepts the token via query param (for EventSource)", async () => {
    const sessionId = await startRun("observe");
    const res = await fetch(`${base}/api/runs/${sessionId}/stream?token=${TOKEN}`);
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });
});

describe("server: run lifecycle + trace", () => {
  beforeEach(() => startServer());

  it("starts a run, persists it, and serves its trace + session list", async () => {
    const sessionId = await startRun("ship it");
    expect(sessionId).toBeTruthy();

    // The simulated run is synchronous in effect; poll the trace until done.
    let trace: any;
    for (let i = 0; i < 50; i++) {
      const t = await fetch(`${base}/api/sessions/${sessionId}/trace`, { headers: auth() });
      if (t.status === 200) {
        trace = await t.json();
        if (trace.trace.session?.status === "completed") break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(trace, "trace did not reach completed state within polling window").toBeDefined();
    expect(trace.trace.session.goal).toBe("ship it");
    expect(trace.trace.session.status).toBe("completed");
    expect(trace.trace.tasks.map((t: any) => t.taskId)).toContain("task-1");
    expect(trace.trace.usage.total.calls).toBe(1);
    expect(typeof trace.text).toBe("string");

    const list = (await (await fetch(`${base}/api/sessions`, { headers: auth() })).json()) as { sessions: any[] };
    expect(list.sessions.some((s) => s.id === sessionId)).toBe(true);
  });

  it("surfaces an engine error as a terminal error status over SSE", async () => {
    await server.stop();
    server = createServer({
      store: new MemoryStore(),
      config: baseConfig,
      baseEnv: {},
      token: TOKEN,
      runGoalImpl: async () => {
        throw new Error("boom");
      },
    });
    base = `http://127.0.0.1:${await server.start(0)}`;

    const sessionId = await startRun("explode");
    const stream = await fetch(`${base}/api/runs/${sessionId}/stream`, { headers: auth() });
    const msgs = await readSse(stream, (m) => m.some((x) => x.event === "status" && x.data.phase === "error"));
    const err = msgs.find((m) => m.event === "status" && m.data.phase === "error");
    expect(err?.data.error).toContain("boom");
  });
});

describe("server: live SSE stream", () => {
  beforeEach(() => startServer());

  it("replays buffered messages then signals done, in order with monotonic ids", async () => {
    const sessionId = await startRun("observe me");

    const stream = await fetch(`${base}/api/runs/${sessionId}/stream`, { headers: auth() });
    const msgs = await readSse(stream, (m) => m.some((x) => x.event === "status" && x.data.phase === "done"));

    const types = msgs.map((m) => m.event);
    expect(types[0]).toBe("status"); // running
    expect(types).toContain("transition");
    expect(types).toContain("outcome");
    expect(types).toContain("event"); // store lifecycle / runner_call
    expect(types).toContain("log");

    // ids are strictly increasing
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i]!.id).toBeGreaterThan(msgs[i - 1]!.id);
    }

    const done = msgs.find((m) => m.event === "status" && m.data.phase === "done");
    expect(done?.data.result.allVerified).toBe(true);
  });

  it("resumes from Last-Event-ID, skipping already-seen messages", async () => {
    const sessionId = await startRun("resume me");

    // Let the run finish so the whole buffer exists.
    const first = await fetch(`${base}/api/runs/${sessionId}/stream`, { headers: auth() });
    const all = await readSse(first, (m) => m.some((x) => x.event === "status" && x.data.phase === "done"));
    expect(all.length).toBeGreaterThan(1);
    const cutoff = all[1]!.id;

    const resumed = await fetch(`${base}/api/runs/${sessionId}/stream`, {
      headers: auth({ "last-event-id": String(cutoff) }),
    });
    const rest = await readSse(resumed, (m) => m.some((x) => x.event === "status" && x.data.phase === "done"));
    expect(rest.every((m) => m.id > cutoff)).toBe(true);
    // Derive the expected replay count by comparison rather than assuming a
    // zero-based, gapless id scheme.
    const expected = all.filter((m) => m.id > cutoff).length;
    expect(rest.length).toBe(expected);
  });
});

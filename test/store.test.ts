import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { MemoryStore, JsonFileStore, openStore } from "../src/storage/store.js";
import type { TaskOutcome } from "../src/engine/loop.js";

const outcome = (taskId: string, finalState: TaskOutcome["finalState"]): TaskOutcome => ({
  taskId,
  finalState,
  verified: finalState === "GREEN",
  history: [],
  buildAttempts: 1,
  reviewCycles: 0,
  nits: [],
  unresolvedBlockers: [],
  lastDiff: `--- ${taskId}`,
});

describe("MemoryStore", () => {
  it("records a transition and keeps the task state in lockstep", async () => {
    const store = new MemoryStore();
    await store.createSession({
      id: "s1",
      goal: "g",
      createdAt: "t0",
      updatedAt: "t0",
      status: "running",
    });
    await store.recordTransition({
      sessionId: "s1",
      taskId: "t1",
      from: "PLANNED",
      event: "BUILD_STARTED",
      to: "BUILDING",
      reason: "start",
      at: "t1",
    });
    const task = await store.getTask("s1", "t1");
    expect(task?.state).toBe("BUILDING");
    expect(task?.verified).toBe(false);
    expect((await store.listTransitions("s1"))).toHaveLength(1);
  });

  it("records a terminal outcome and reflects it on the task record", async () => {
    const store = new MemoryStore();
    await store.createSession({ id: "s", goal: "g", createdAt: "t", updatedAt: "t", status: "running" });
    await store.recordOutcome({
      sessionId: "s",
      taskId: "t1",
      finalState: "GREEN",
      verified: true,
      at: "t2",
      outcome: outcome("t1", "GREEN"),
    });
    const got = await store.getOutcome("s", "t1");
    expect(got?.verified).toBe(true);
    expect((await store.getTask("s", "t1"))?.state).toBe("GREEN");
  });

  it("records build attempts per session", async () => {
    const store = new MemoryStore();
    await store.recordAttempt({ sessionId: "s", taskId: "t1", attempt: 1, kind: "build", summary: "first", at: "t" });
    await store.recordAttempt({ sessionId: "s", taskId: "t1", attempt: 2, kind: "build", summary: "fix", at: "t" });
    expect(await store.listAttempts("s")).toHaveLength(2);
  });

  it("openStore returns a MemoryStore for ':memory:'", async () => {
    expect(await openStore(":memory:")).toBeInstanceOf(MemoryStore);
  });
});

describe("JsonFileStore", () => {
  it("persists across reopen (durable checkpoint)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loopwright-store-"));
    const file = join(dir, "nested", "sessions.db");

    const store = await JsonFileStore.open(file);
    await store.createSession({ id: "s1", goal: "ship", createdAt: "t", updatedAt: "t", status: "running" });
    await store.recordTransition({
      sessionId: "s1",
      taskId: "t1",
      from: "PLANNED",
      event: "BUILD_STARTED",
      to: "BUILDING",
      reason: "start",
      at: "t",
    });
    await store.recordOutcome({
      sessionId: "s1",
      taskId: "t1",
      finalState: "GREEN",
      verified: true,
      at: "t",
      outcome: outcome("t1", "GREEN"),
    });

    // the file is real JSON on disk
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.version).toBe(1);

    // a fresh handle sees the persisted state
    const reopened = await JsonFileStore.open(file);
    expect((await reopened.getSession("s1"))?.goal).toBe("ship");
    expect((await reopened.getOutcome("s1", "t1"))?.verified).toBe(true);
    expect((await reopened.getTask("s1", "t1"))?.state).toBe("GREEN");
  });

  it("serializes concurrent writes without corrupting the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loopwright-store-"));
    const file = join(dir, "sessions.db");
    const store = await JsonFileStore.open(file);
    await store.createSession({ id: "s", goal: "g", createdAt: "t", updatedAt: "t", status: "running" });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.recordTransition({
          sessionId: "s",
          taskId: `t${i}`,
          from: "PLANNED",
          event: "BUILD_STARTED",
          to: "BUILDING",
          reason: "r",
          at: "t",
        }),
      ),
    );

    const raw = JSON.parse(await readFile(file, "utf8")); // must be valid JSON
    expect(raw.transitions).toHaveLength(20);
  });
});

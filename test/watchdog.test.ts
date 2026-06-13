import { describe, it, expect } from "vitest";
import { guardProgress, ProgressWatchdog } from "../src/engine/watchdog.js";
import { runTask } from "../src/engine/loop.js";
import { loadConfig } from "../src/config.js";
import { MockCritic, scriptedExecutor } from "../src/adapters/mocks.js";
import type { Actor } from "../src/adapters/agents.js";
import type { TaskSpec } from "../src/schemas/plan.js";

describe("guardProgress", () => {
  it("returns the value when the op settles within the threshold", async () => {
    const r = await guardProgress(Promise.resolve(42), 1000);
    expect(r).toEqual({ stuck: false, value: 42 });
  });

  it("reports stuck when the op does not settle in time", async () => {
    const never = new Promise<number>(() => {});
    const r = await guardProgress(never, 20);
    expect(r.stuck).toBe(true);
  });

  it("disables the guard for a non-positive threshold", async () => {
    const r = await guardProgress(Promise.resolve("ok"), 0);
    expect(r).toEqual({ stuck: false, value: "ok" });
  });

  it("propagates the underlying rejection", async () => {
    await expect(guardProgress(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom");
  });
});

describe("ProgressWatchdog", () => {
  it("becomes stuck once the threshold elapses since the last ping", () => {
    let now = 1000;
    const wd = new ProgressWatchdog(100, () => now);
    expect(wd.isStuck()).toBe(false);
    now = 1099;
    expect(wd.isStuck()).toBe(false);
    now = 1101;
    expect(wd.isStuck()).toBe(true);
    wd.ping();
    expect(wd.isStuck()).toBe(false);
  });
});

describe("loop stuck detection", () => {
  it("routes a hung build to NEEDS_HUMAN with a stuck reason", async () => {
    const task: TaskSpec = {
      id: "t1",
      title: "hangs",
      description: "",
      acceptanceCriteria: ["x"],
      verifyCommands: ["check"],
      dependencies: [],
    };
    const hangingActor: Actor = {
      async draftPlan() {
        throw new Error("unused");
      },
      build: () => new Promise(() => {}), // never resolves
      async selfReview() {
        return { text: "" };
      },
    };
    const config = loadConfig({});
    const outcome = await runTask(task, {
      actor: hangingActor,
      critic: new MockCritic(),
      config,
      cwd: ".",
      executor: scriptedExecutor(() => ({ exitCode: 0 })),
      stuckThresholdMs: 20, // dep override bypasses the config minimum
    });

    expect(outcome.finalState).toBe("NEEDS_HUMAN");
    expect(outcome.degradedReason).toMatch(/stuck/i);
  });
});

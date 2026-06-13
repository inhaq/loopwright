import { describe, it, expect } from "vitest";
import { runScheduledTasks, validateGraph, InvalidPlanGraphError } from "../src/engine/scheduler.js";
import { loadConfig, type LoopwrightConfig } from "../src/config.js";
import { MockActor, MockCritic, criticBlock, criticGreen } from "../src/adapters/mocks.js";
import type { CommandExecutor } from "../src/engine/mechanicalGate.js";
import type { TaskSpec } from "../src/schemas/plan.js";

const task = (id: string, dependencies: string[] = [], verify = ["check"]): TaskSpec => ({
  id,
  title: id,
  description: "",
  acceptanceCriteria: ["x"],
  verifyCommands: verify,
  dependencies,
});

const cfg = (maxParallel: number): LoopwrightConfig =>
  loadConfig({ LOOPWRIGHT_MAX_PARALLEL: String(maxParallel) });

/** Records the order in which gate commands run. */
function recordingExecutor(): { exec: CommandExecutor; order: string[] } {
  const order: string[] = [];
  const exec: CommandExecutor = async (command) => {
    order.push(command);
    return { exitCode: 0, output: "", durationMs: 1 };
  };
  return { exec, order };
}

/** Tracks the peak number of gate commands running at once. */
function concurrencyExecutor(delayMs: number): { exec: CommandExecutor; max: () => number } {
  let active = 0;
  let peak = 0;
  const exec: CommandExecutor = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, delayMs));
    active--;
    return { exitCode: 0, output: "", durationMs: delayMs };
  };
  return { exec, max: () => peak };
}

const greenDeps = (config: LoopwrightConfig, executor: CommandExecutor) => ({
  actor: new MockActor({ plans: [] }),
  critic: new MockCritic({ fallback: criticGreen() }),
  config,
  cwd: ".",
  executor,
});

describe("validateGraph", () => {
  it("rejects duplicate ids, missing deps, self-deps, and cycles", () => {
    expect(() => validateGraph([task("a"), task("a")])).toThrow(InvalidPlanGraphError);
    expect(() => validateGraph([task("a", ["ghost"])])).toThrow(/unknown task/);
    expect(() => validateGraph([task("a", ["a"])])).toThrow(/itself/);
    expect(() => validateGraph([task("a", ["b"]), task("b", ["a"])])).toThrow(/cycle/i);
  });

  it("accepts a valid DAG (diamond)", () => {
    expect(() =>
      validateGraph([task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])]),
    ).not.toThrow();
  });
});

describe("runScheduledTasks ordering + concurrency", () => {
  it("runs a dependency before its dependents", async () => {
    const { exec, order } = recordingExecutor();
    const tasks = [
      task("a", [], ["check-a"]),
      task("b", ["a"], ["check-b"]),
      task("c", ["a"], ["check-c"]),
    ];
    const results = await runScheduledTasks(tasks, greenDeps(cfg(2), exec));
    expect(results.every((r) => r.status === "completed")).toBe(true);
    expect(order.indexOf("check-a")).toBeLessThan(order.indexOf("check-b"));
    expect(order.indexOf("check-a")).toBeLessThan(order.indexOf("check-c"));
  });

  it("never exceeds the parallelism cap", async () => {
    const { exec, max } = concurrencyExecutor(25);
    const tasks = [task("a"), task("b"), task("c"), task("d")]; // all independent
    await runScheduledTasks(tasks, greenDeps(cfg(2), exec));
    expect(max()).toBeLessThanOrEqual(2);
    expect(max()).toBeGreaterThan(1); // actually ran in parallel
  });

  it("returns results in the input's declared order", async () => {
    const { exec } = recordingExecutor();
    const tasks = [task("a"), task("b", ["a"]), task("c", ["a"])];
    const results = await runScheduledTasks(tasks, greenDeps(cfg(3), exec));
    expect(results.map((r) => r.taskId)).toEqual(["a", "b", "c"]);
  });
});

describe("runScheduledTasks failure propagation + resume", () => {
  it("skips dependents (transitively) when a prerequisite fails", async () => {
    const { exec } = recordingExecutor();
    const config = cfg(2);
    const deps = {
      actor: new MockActor({ plans: [] }),
      // task "a" is always blocked -> NEEDS_HUMAN; others would be green
      critic: new MockCritic({
        taskResponses: {
          a: [criticBlock([{ severity: "blocker", category: "correctness", detail: "bug", location: "a" }])],
        },
        fallback: criticGreen(),
      }),
      config,
      cwd: ".",
      executor: exec,
    };
    const tasks = [task("a"), task("b", ["a"]), task("c", ["b"])];
    const results = await runScheduledTasks(tasks, deps);

    const byId = Object.fromEntries(results.map((r) => [r.taskId, r]));
    expect(byId.a?.outcome?.finalState).toBe("NEEDS_HUMAN");
    expect(byId.b?.status).toBe("skipped");
    expect(byId.b?.blockedBy).toEqual(["a"]);
    expect(byId.c?.status).toBe("skipped"); // transitively blocked via b
  });

  it("reuses a completed task via resumeOutcome without rebuilding", async () => {
    const { exec, order } = recordingExecutor();
    const tasks = [task("a", [], ["check-a"])];
    const results = await runScheduledTasks(tasks, {
      ...greenDeps(cfg(2), exec),
      resumeOutcome: () => ({
        taskId: "a",
        finalState: "GREEN",
        verified: true,
        history: [],
        buildAttempts: 1,
        reviewCycles: 0,
        nits: [],
        unresolvedBlockers: [],
        lastDiff: "",
      }),
    });
    expect(results[0]?.status).toBe("resumed");
    // the gate never ran because the task was reused from the prior outcome
    expect(order).toEqual([]);
  });
});

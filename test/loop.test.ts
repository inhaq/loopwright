import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Plan, TaskSpec } from "../src/schemas/plan.js";
import type { Finding } from "../src/schemas/critic.js";
import { runPlanReview, runTask, type LoopDeps } from "../src/engine/loop.js";
import {
  MockActor,
  MockCritic,
  criticBlock,
  criticGreen,
  criticMalformed,
  criticQuotaExhausted,
  scriptedExecutor,
} from "../src/adapters/mocks.js";

const blocker: Finding = { severity: "blocker", category: "correctness", detail: "wrong", location: "x.ts" };
const nit: Finding = { severity: "nit", category: "style", detail: "naming", location: "x.ts" };

function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "t1",
    title: "Task",
    description: "",
    acceptanceCriteria: ["does the thing"],
    verifyCommands: ["check"],
    dependencies: [],
    ...overrides,
  };
}

function makeDeps(
  partial: { actor: MockActor; critic: MockCritic; exec?: ReturnType<typeof scriptedExecutor>; env?: Record<string, string> },
): LoopDeps {
  return {
    actor: partial.actor,
    critic: partial.critic,
    config: loadConfig(partial.env ?? {}),
    cwd: ".",
    executor: partial.exec ?? scriptedExecutor(() => ({ exitCode: 0 })),
  };
}

const onePlan = (t: TaskSpec): Plan => ({ goal: "g", tasks: [t] });

describe("single-task loop", () => {
  it("reaches GREEN after a mechanical fix and a critic fix cycle", async () => {
    const t = task();
    const actor = new MockActor({ plans: [onePlan(t)] });
    const critic = new MockCritic({ taskResponses: { t1: [criticBlock([blocker]), criticGreen()] } });
    const exec = scriptedExecutor((_c, i) => ({ exitCode: i === 0 ? 1 : 0 }));

    const out = await runTask(t, makeDeps({ actor, critic, exec }));
    expect(out.finalState).toBe("GREEN");
    expect(out.verified).toBe(true);
    expect(out.buildAttempts).toBe(3); // initial + mech fix + critic fix
    expect(out.reviewCycles).toBe(1);
  });

  it("treats a nit-only review as green WITHOUT another cycle", async () => {
    const t = task();
    const actor = new MockActor({ plans: [onePlan(t)] });
    const critic = new MockCritic({ taskResponses: { t1: [criticGreen("ok", [nit])] } });

    const out = await runTask(t, makeDeps({ actor, critic }));
    expect(out.finalState).toBe("GREEN");
    expect(out.buildAttempts).toBe(1);
    expect(out.reviewCycles).toBe(0);
    expect(out.nits).toHaveLength(1);
  });

  it("goes to NEEDS_HUMAN after exceeding the review-cycle cap", async () => {
    const t = task();
    const actor = new MockActor({ plans: [onePlan(t)] });
    const critic = new MockCritic({ fallback: criticBlock([blocker]) }); // always blocks

    const out = await runTask(t, makeDeps({ actor, critic }));
    expect(out.finalState).toBe("NEEDS_HUMAN");
    expect(out.verified).toBe(false);
    expect(out.reviewCycles).toBe(3); // taskReviewCyclesMax default
    expect(out.unresolvedBlockers).toHaveLength(1);
    expect(out.degradedReason).toBeTruthy();
  });

  it("goes to NEEDS_HUMAN after exceeding the mechanical-fix cap", async () => {
    const t = task();
    const actor = new MockActor({ plans: [onePlan(t)] });
    const critic = new MockCritic({ fallback: criticGreen() });
    const exec = scriptedExecutor(() => ({ exitCode: 1 })); // always fails

    const out = await runTask(t, makeDeps({ actor, critic, exec }));
    expect(out.finalState).toBe("NEEDS_HUMAN");
    expect(out.buildAttempts).toBe(4); // initial + 3 fix attempts (mechanicalFixMax)
    expect(out.reviewCycles).toBe(0); // critic never reached
  });

  it("falls back to UNVERIFIED_BY_CRITIC when critic quota is exhausted", async () => {
    const t = task();
    const actor = new MockActor({ plans: [onePlan(t)] });
    const critic = new MockCritic({ taskResponses: { t1: [criticQuotaExhausted()] } });

    const out = await runTask(t, makeDeps({ actor, critic }));
    expect(out.finalState).toBe("UNVERIFIED_BY_CRITIC");
    expect(out.verified).toBe(false); // crucially NOT identical to a real green
    expect(out.degradedReason).toContain("UNVERIFIED");
  });

  it("pauses to NEEDS_HUMAN when fallback=pause and quota is exhausted", async () => {
    const t = task();
    const actor = new MockActor({ plans: [onePlan(t)] });
    const critic = new MockCritic({ taskResponses: { t1: [criticQuotaExhausted()] } });

    const out = await runTask(t, makeDeps({ actor, critic, env: { LOOPWRIGHT_CRITIC_FALLBACK: "pause" } }));
    expect(out.finalState).toBe("NEEDS_HUMAN");
    expect(out.verified).toBe(false);
  });

  it("retries once on malformed JSON then recovers to GREEN", async () => {
    const t = task();
    const actor = new MockActor({ plans: [onePlan(t)] });
    const critic = new MockCritic({ taskResponses: { t1: [criticMalformed(), criticGreen()] } });

    const out = await runTask(t, makeDeps({ actor, critic }));
    expect(out.finalState).toBe("GREEN");
    expect(out.buildAttempts).toBe(1);
  });

  it("goes to NEEDS_HUMAN when the critic is malformed twice", async () => {
    const t = task();
    const actor = new MockActor({ plans: [onePlan(t)] });
    const critic = new MockCritic({ taskResponses: { t1: [criticMalformed(), criticMalformed()] } });

    const out = await runTask(t, makeDeps({ actor, critic }));
    expect(out.finalState).toBe("NEEDS_HUMAN");
    expect(out.degradedReason).toContain("unparseable");
  });
});

describe("plan-review loop", () => {
  it("approves after one revision", async () => {
    const draft = onePlan(task({ verifyCommands: [] }));
    const revised = onePlan(task({ verifyCommands: ["check"] }));
    const actor = new MockActor({ plans: [draft, revised] });
    const critic = new MockCritic({
      planResponses: [criticBlock([{ severity: "blocker", category: "requirements", detail: "no DoD", location: "" }]), criticGreen()],
    });

    const out = await runPlanReview("g", makeDeps({ actor, critic }));
    expect(out.approved).toBe(true);
    expect(out.revisions).toBe(1);
    expect(out.proceededWithOpenItems).toBe(false);
  });

  it("proceeds with open items when the plan can't be approved within the cap", async () => {
    const actor = new MockActor({ plans: [onePlan(task())] });
    const critic = new MockCritic({
      planResponses: [criticBlock([{ severity: "blocker", category: "requirements", detail: "x", location: "" }])],
      fallback: criticBlock([{ severity: "blocker", category: "requirements", detail: "x", location: "" }]),
    });

    const out = await runPlanReview("g", makeDeps({ actor, critic }));
    expect(out.approved).toBe(false);
    expect(out.proceededWithOpenItems).toBe(true);
    expect(out.revisions).toBe(2); // planReviewMax default
    expect(out.openItems.length).toBeGreaterThan(0);
  });
});


describe("fallback self-review", () => {
  it("never surfaces blocker-severity findings as nits", async () => {
    const t = task();
    const actor = new MockActor({ plans: [onePlan(t)], selfReview: criticBlock([blocker, nit]) });
    const critic = new MockCritic({ taskResponses: { t1: [criticQuotaExhausted()] } });

    const out = await runTask(t, makeDeps({ actor, critic }));
    expect(out.finalState).toBe("UNVERIFIED_BY_CRITIC");
    expect(out.nits.every((f) => f.severity === "nit")).toBe(true);
    expect(out.nits).toHaveLength(1); // the blocker was filtered out
  });
});


describe("ground-truth diff capture (captureDiff)", () => {
  /** A critic that records the diff it was asked to review, then passes green. */
  class RecordingCritic extends MockCritic {
    seenDiff: string | undefined;
    constructor() {
      super({ fallback: criticGreen() });
    }
    override async review(req: Parameters<MockCritic["review"]>[0]) {
      if (req.kind === "task") this.seenDiff = req.bundle.diff;
      return super.review(req);
    }
  }

  it("reviews the captured worktree diff instead of the model's self-reported diff", async () => {
    const t = task();
    const actor = new MockActor({ plans: [onePlan(t)] }); // synthetic model diff
    const critic = new RecordingCritic();

    const out = await runTask(t, {
      ...makeDeps({ actor, critic }),
      captureDiff: () => "REAL WORKTREE DIFF\n+added line",
    });

    expect(out.finalState).toBe("GREEN");
    expect(out.lastDiff).toBe("REAL WORKTREE DIFF\n+added line");
    expect(critic.seenDiff).toContain("REAL WORKTREE DIFF"); // redaction keeps body
    expect(critic.seenDiff).not.toContain("attempt 0"); // not the model's diff
  });

  it("falls back to the model diff when capture returns empty (e.g. non-editing runner)", async () => {
    const t = task();
    const actor = new MockActor({ plans: [onePlan(t)] });
    const critic = new MockCritic({ fallback: criticGreen() });

    const out = await runTask(t, {
      ...makeDeps({ actor, critic }),
      captureDiff: () => "   ", // whitespace-only => treated as no diff
    });

    expect(out.finalState).toBe("GREEN");
    expect(out.lastDiff).toContain(`src/${t.id}.ts`); // the model's synthetic diff
  });

  it("falls back to the model diff when capture throws", async () => {
    const t = task();
    const actor = new MockActor({ plans: [onePlan(t)] });
    const critic = new MockCritic({ fallback: criticGreen() });

    const out = await runTask(t, {
      ...makeDeps({ actor, critic }),
      captureDiff: () => {
        throw new Error("git exploded");
      },
    });

    expect(out.finalState).toBe("GREEN");
    expect(out.lastDiff).toContain(`src/${t.id}.ts`);
  });
});

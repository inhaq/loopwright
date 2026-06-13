/**
 * Fake end-to-end run with mocked actor/critic.
 *
 * Validates the orchestration (plan review -> per-task build/gate/review loop,
 * cycle caps, nits-don't-loop, quota fallback) WITHOUT any real agent backend.
 * Run with: npm run demo
 */
import { loadConfig } from "./config.js";
import type { Plan } from "./schemas/plan.js";
import type { Finding } from "./schemas/critic.js";
import { runPlanReview, runTask, type TaskOutcome } from "./engine/loop.js";
import {
  MockActor,
  MockCritic,
  criticBlock,
  criticFenced,
  criticGreen,
  criticQuotaExhausted,
  scriptedExecutor,
} from "./adapters/mocks.js";

const GOAL = "Add a rate limiter to the public API";

// The actor's first draft is missing a verify command on task-b; after the
// critic blocks the plan, the revised draft adds it.
const draftPlan: Plan = {
  goal: GOAL,
  tasks: [
    {
      id: "task-a",
      title: "Implement token-bucket limiter",
      description: "Core limiter module",
      acceptanceCriteria: ["Requests beyond the limit get HTTP 429"],
      verifyCommands: ["npm test -- limiter"],
      dependencies: [],
    },
    {
      id: "task-b",
      title: "Wire limiter into middleware",
      description: "Apply limiter to all /api routes",
      acceptanceCriteria: ["All /api routes are rate limited"],
      verifyCommands: [], // <-- missing DoD; critic should block the plan
      dependencies: ["task-a"],
    },
    {
      id: "task-c",
      title: "Add limiter metrics",
      description: "Expose counters for throttled requests",
      acceptanceCriteria: ["A counter increments on each 429"],
      verifyCommands: ["npm run build:metrics"],
      dependencies: ["task-a"],
    },
  ],
};

const revisedPlan: Plan = {
  ...draftPlan,
  tasks: draftPlan.tasks.map((t) =>
    t.id === "task-b" ? { ...t, verifyCommands: ["npm run build:mw"] } : t,
  ),
};

const correctnessBlocker: Finding = {
  severity: "blocker",
  category: "correctness",
  detail: "Limiter resets the bucket on every request, so it never throttles.",
  location: "src/task-a.ts:42",
};

const styleNit: Finding = {
  severity: "nit",
  category: "style",
  detail: "Prefer a named constant over the magic number 100.",
  location: "src/task-b.ts:10",
};

const planRequirementsBlocker: Finding = {
  severity: "blocker",
  category: "requirements",
  detail: "task-b has no verifyCommands, so its done-state isn't machine-checkable.",
  location: "plan.tasks[task-b]",
};

async function main(): Promise<void> {
  const config = loadConfig({}); // all defaults

  const actor = new MockActor({ plans: [draftPlan, revisedPlan] });

  const critic = new MockCritic({
    // round 1 blocks the plan; round 2 (after revision) approves it
    planResponses: [criticBlock([planRequirementsBlocker], "Plan needs a DoD for task-b."), criticGreen("Plan approved.")],
    taskResponses: {
      // build fails the gate once, then a correctness blocker, then green
      "task-a": [criticBlock([correctnessBlocker]), criticGreen("Throttling now correct.")],
      // passes immediately with only a style nit (must NOT trigger another cycle)
      "task-b": [criticFenced("Looks good.", [styleNit])],
      // critic out of quota -> degraded fallback (UNVERIFIED_BY_CRITIC)
      "task-c": [criticQuotaExhausted()],
    },
  });

  // task-a's test command fails on the first run, passes after the fix.
  const executor = scriptedExecutor((command, callIndex) => {
    if (command.includes("npm test -- limiter") && callIndex === 0) {
      return { exitCode: 1, output: "FAIL limiter.test.ts: expected 429, got 200" };
    }
    return { exitCode: 0, output: "ok" };
  });

  const log = (line: string) => console.log("   " + line);

  console.log(`\n=== GOAL: ${GOAL} ===\n`);

  // ---- Plan review loop ----
  console.log("--- Plan review ---");
  const planOutcome = await runPlanReview(GOAL, { actor, critic, config, cwd: ".", executor, log });
  console.log(
    `Plan: approved=${planOutcome.approved} revisions=${planOutcome.revisions} ` +
      `openItems=${planOutcome.openItems.length}\n`,
  );

  // ---- Per-task loops ----
  const outcomes: TaskOutcome[] = [];
  for (const task of planOutcome.plan.tasks) {
    console.log(`--- Task ${task.id}: ${task.title} ---`);
    const outcome = await runTask(task, { actor, critic, config, cwd: ".", executor, log });
    outcomes.push(outcome);
    console.log(
      `Result: ${outcome.finalState}  verified=${outcome.verified}  ` +
        `builds=${outcome.buildAttempts}  reviewCycles=${outcome.reviewCycles}  ` +
        `nits=${outcome.nits.length}` +
        (outcome.degradedReason ? `\n   degraded: ${outcome.degradedReason}` : "") +
        (outcome.unresolvedBlockers.length
          ? `\n   unresolved blockers: ${outcome.unresolvedBlockers.length}`
          : "") +
        "\n",
    );
  }

  // ---- Summary ----
  console.log("=== SUMMARY ===");
  for (const o of outcomes) {
    const badge = o.verified ? "GREEN (verified)" : o.finalState;
    console.log(`  ${o.taskId.padEnd(8)} ${badge}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

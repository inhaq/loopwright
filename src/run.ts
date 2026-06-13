/**
 * Headless CLI entrypoint for a real run (Task 15).
 *
 * Reads the goal from argv and everything else from the environment (runner
 * profiles + role bindings + caps; see config.ts), then drives the full
 * actor-critic session and prints a summary. Backends are entirely config:
 *
 *   LOOPWRIGHT_RUNNERS='[{"id":"primary","kind":"http","model":"<model>",
 *     "options":{"baseUrl":"https://host/v1","apiKeyEnv":"MY_API_KEY"}}]'
 *   LOOPWRIGHT_ACTOR_RUNNER=primary
 *   LOOPWRIGHT_CRITIC_RUNNER=primary
 *
 * Run with: npm start -- "your goal here" [--resume <sessionId>]
 *
 * Progress is checkpointed to the store at config.dbPath, so an interrupted run
 * can be resumed by id without repeating completed tasks.
 */
import { loadConfig } from "./config.js";
import { runGoal, openBlockers } from "./session.js";
import { openStore } from "./storage/store.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Optional: `--resume <sessionId>` to continue a previously interrupted run.
  let resumeId: string | undefined;
  const resumeIdx = args.indexOf("--resume");
  if (resumeIdx !== -1) {
    resumeId = args[resumeIdx + 1];
    args.splice(resumeIdx, resumeId ? 2 : 1);
  }
  const goal = args.join(" ").trim();
  if (!goal) {
    console.error('Usage: npm start -- "your goal here" [--resume <sessionId>]');
    process.exit(2);
  }

  const config = loadConfig();
  const store = await openStore(config.dbPath);
  const log = (line: string) => console.log("   " + line);

  console.log(`\n=== GOAL: ${goal} ===\n`);
  const result = await runGoal(goal, config, {
    log,
    store,
    ...(resumeId ? { sessionId: resumeId, resume: true } : {}),
  });

  console.log("\n=== SUMMARY ===");
  if (result.sessionId) {
    console.log(`session: ${result.sessionId}  (resume with: npm start -- "<goal>" --resume ${result.sessionId})`);
  }
  console.log(
    `plan: approved=${result.plan.approved} revisions=${result.plan.revisions} ` +
      `openItems=${result.plan.openItems.length}`,
  );
  for (const r of result.results) {
    const badge =
      r.status === "skipped"
        ? `SKIPPED (blocked by ${r.blockedBy?.join(", ") ?? "?"})`
        : r.status === "resumed"
          ? `RESUMED (${r.outcome?.finalState})`
          : r.outcome?.verified
            ? "GREEN (verified)"
            : (r.outcome?.finalState ?? "UNKNOWN");
    console.log(`  ${r.taskId.padEnd(10)} ${badge}`);
  }

  const blockers = openBlockers(result);
  if (blockers.length > 0) {
    console.log(`\nOpen blockers (${blockers.length}):`);
    for (const b of blockers) console.log(`  - [${b.category}] ${b.detail} (${b.location})`);
  }

  // Non-zero exit when anything needs human attention, so CI/scripts can react.
  process.exit(result.needsHuman.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

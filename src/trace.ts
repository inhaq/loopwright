/**
 * Inspect a persisted session's full trace (Task 24).
 *
 * Run with: npm run trace -- <sessionId>
 * Reads the store at config.dbPath and prints lifecycle, per-task state history,
 * and the usage ledger.
 */
import { loadConfig } from "./config.js";
import { openStore } from "./storage/store.js";
import { buildTrace, formatTrace } from "./observability/trace.js";

async function main(): Promise<void> {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error("Usage: npm run trace -- <sessionId>");
    process.exit(2);
  }

  const config = loadConfig();
  const store = await openStore(config.dbPath);
  const trace = await buildTrace(store, sessionId);

  if (!trace.session) {
    console.error(`No session "${sessionId}" found in ${config.dbPath}.`);
    process.exit(1);
  }

  console.log(formatTrace(trace));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

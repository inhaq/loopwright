/**
 * Engine server entrypoint (Task 25.1).
 *
 * Boots the HTTP/SSE server over the headless engine and prints a single
 * machine-readable line once listening, so a parent process (the Tauri shell)
 * can discover the bound port:
 *
 *   {"loopwright":"listening","host":"127.0.0.1","port":53187,"token":"…"}
 *
 * Configuration comes entirely from the environment (see config.ts). Bind
 * settings:
 *   LOOPWRIGHT_PORT        port to bind (default 0 = ephemeral)
 *   LOOPWRIGHT_HOST        host to bind (default 127.0.0.1, loopback only)
 *   LOOPWRIGHT_STATIC_DIR  optional dir of built frontend assets to serve
 *   LOOPWRIGHT_TOKEN       bearer token required on /api (default: random)
 *   LOOPWRIGHT_ALLOW_NON_LOOPBACK  opt-in to bind a non-loopback host (unsafe)
 *
 * Compiled to a single binary via `bun build --compile` and shipped as a
 * Tauri sidecar; also runnable directly (`npm run serve`) to use the UI from a
 * browser without any desktop toolchain.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { openStore } from "../storage/store.js";
import { reconcileInterruptedSessions } from "../session.js";
import { createServer, isLoopbackHost } from "./server.js";
import { createTelegramRelayFromEnv } from "../notify/telegram.js";

function envFlag(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await openStore(config.dbPath);

  // Reconcile sessions left "running" by a previous process that was killed or
  // crashed mid-run (e.g. the desktop "restart engine" button), so they don't
  // stay stuck running forever.
  const reconciled = await reconcileInterruptedSessions(store);
  if (reconciled > 0) {
    console.error(`Marked ${reconciled} interrupted session(s) as failed on startup.`);
  }

  // Resolve to an absolute path so the server's path-traversal guard works even
  // when a relative LOOPWRIGHT_STATIC_DIR is supplied.
  const staticEnv = process.env.LOOPWRIGHT_STATIC_DIR;
  const staticDir = staticEnv ? path.resolve(staticEnv) : undefined;
  // The supervising process (Tauri) may pin the token via env; otherwise a
  // fresh random one is generated and reported on the readiness line.
  const token = process.env.LOOPWRIGHT_TOKEN || randomUUID();

  // Optional phone updates: a Telegram relay that pushes final run status and
  // accepts replies (as new goals) over OUTBOUND long-polling only — no inbound
  // port, so the engine stays loopback-only. Absent config => no relay.
  const relay = createTelegramRelayFromEnv(process.env, (line) => console.error(line));

  const server = createServer({
    store,
    config,
    token,
    // When a graceful shutdown finishes (signal or POST /api/shutdown), exit.
    onShutdown: () => process.exit(0),
    ...(relay ? { notifier: relay } : {}),
    ...(staticDir ? { staticDir } : {}),
  });

  // The relay needs to launch chat-initiated runs through the same validated
  // path the UI uses; hand it the server once both exist.
  if (relay) {
    relay.attach(server);
    relay.start();
  }

  const port = Number.parseInt(process.env.LOOPWRIGHT_PORT ?? "0", 10) || 0;
  const host = process.env.LOOPWRIGHT_HOST ?? "127.0.0.1";

  // The engine serves a token-authenticated local API (and, with a static dir,
  // injects that token into index.html). Binding a non-loopback host would
  // expose both over the network, contradicting the security model — refuse
  // unless explicitly opted in.
  if (!isLoopbackHost(host) && !envFlag(process.env.LOOPWRIGHT_ALLOW_NON_LOOPBACK)) {
    console.error(
      `Refusing to bind non-loopback host "${host}". The engine exposes a local, ` +
        `token-authenticated API. Set LOOPWRIGHT_ALLOW_NON_LOOPBACK=1 to override (unsafe).`,
    );
    process.exit(1);
  }

  const bound = await server.start(port, host);

  // Single-line, parseable readiness signal for the supervising process.
  console.log(JSON.stringify({ loopwright: "listening", host, port: bound, token }));

  // Graceful shutdown on signals: stop() aborts in-flight runs (killing their
  // detached subprocess trees) and closes SSE streams before the process exits,
  // so a SIGTERM/SIGINT can't orphan active work or hang on open streams.
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    relay?.stop();
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

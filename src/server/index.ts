/**
 * Engine server entrypoint (Task 25.1).
 *
 * Boots the HTTP/SSE server over the headless engine and prints a single
 * machine-readable line once listening, so a parent process (the Tauri shell)
 * can discover the bound port:
 *
 *   {"loopwright":"listening","host":"127.0.0.1","port":53187}
 *
 * Configuration comes entirely from the environment (see config.ts). Bind
 * settings:
 *   LOOPWRIGHT_PORT        port to bind (default 0 = ephemeral)
 *   LOOPWRIGHT_HOST        host to bind (default 127.0.0.1, loopback only)
 *   LOOPWRIGHT_STATIC_DIR  optional dir of built frontend assets to serve
 *
 * Compiled to a single binary via `bun build --compile` and shipped as a
 * Tauri sidecar; also runnable directly (`npm run serve`) to use the UI from a
 * browser without any desktop toolchain.
 */
import path from "node:path";
import { loadConfig } from "../config.js";
import { openStore } from "../storage/store.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await openStore(config.dbPath);

  // Resolve to an absolute path so the server's path-traversal guard works even
  // when a relative LOOPWRIGHT_STATIC_DIR is supplied.
  const staticEnv = process.env.LOOPWRIGHT_STATIC_DIR;
  const staticDir = staticEnv ? path.resolve(staticEnv) : undefined;
  const server = createServer({
    store,
    config,
    ...(staticDir ? { staticDir } : {}),
  });

  const port = Number.parseInt(process.env.LOOPWRIGHT_PORT ?? "0", 10) || 0;
  const host = process.env.LOOPWRIGHT_HOST ?? "127.0.0.1";
  const bound = await server.start(port, host);

  // Single-line, parseable readiness signal for the supervising process.
  console.log(JSON.stringify({ loopwright: "listening", host, port: bound }));

  const shutdown = (): void => {
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

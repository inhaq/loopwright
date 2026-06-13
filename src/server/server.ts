import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig, type LoopwrightConfig } from "../config.js";
import { runGoal as defaultRunGoal, type RunGoalOptions, type SessionResult } from "../session.js";
import type { Store } from "../storage/store.js";
import { buildTrace, formatTrace } from "../observability/trace.js";
import type { Rates } from "../observability/usage.js";
import type { LoopObserver } from "../engine/loop.js";
import { RunHub, type RunStatusData } from "./hub.js";
import { tapStoreEvents } from "./store-tap.js";

/**
 * The engine HTTP/SSE server (Task 25.1).
 *
 * This is a thin transport over the headless engine: it exposes `runGoal` and
 * `buildTrace` over HTTP and streams a run's live progress over Server-Sent
 * Events. It adds NO orchestration policy — start, observe, and review map
 * directly onto existing engine entry points (Req 13.3). The Tauri shell runs
 * this as a sidecar, but it is equally usable from a browser, which is what
 * makes the desktop experience reproducible without a GUI toolchain.
 */

/** Body accepted by POST /api/runs. */
export interface StartRunBody {
  goal: string;
  /**
   * Env-style overrides (LOOPWRIGHT_* keys) merged over the process env before
   * `loadConfig`. This is how runner profiles, role bindings, and caps are
   * supplied per run. `LOOPWRIGHT_DB_PATH` is ignored here: persistence always
   * targets the server's configured store so the trace endpoint can read it.
   */
  env?: Record<string, string>;
  /** resume an existing session id (reuses completed tasks) */
  sessionId?: string;
  resume?: boolean;
}

export type RunGoalImpl = (
  goal: string,
  config: LoopwrightConfig,
  opts?: RunGoalOptions,
) => Promise<SessionResult>;

export interface CreateServerOptions {
  /** durable store shared by runs (writes) and the trace endpoint (reads) */
  store: Store;
  /** base config; fixes the runner-neutral defaults and (crucially) dbPath */
  config: LoopwrightConfig;
  /** injectable engine entrypoint (defaults to the real runGoal) */
  runGoalImpl?: RunGoalImpl;
  /** optional per-1k-token rates for the usage ledger in traces */
  rates?: Rates;
  /** directory of built frontend assets to serve (optional) */
  staticDir?: string;
  /** base env for per-run config resolution (defaults to process.env) */
  baseEnv?: Record<string, string | undefined>;
}

export interface LoopwrightServer {
  /** the underlying http.Server (call .listen yourself, or use start()) */
  http: Server;
  hub: RunHub;
  /** listen on a port (0 = ephemeral) and resolve with the bound port */
  start(port?: number, host?: string): Promise<number>;
  stop(): Promise<void>;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...corsHeaders() });
  res.end(payload);
}

function corsHeaders(): Record<string, string> {
  // The Tauri webview origin (tauri://localhost or http://localhost) differs
  // from the sidecar origin, and browser dev may serve the UI elsewhere. This
  // server only ever binds to loopback, so a permissive CORS policy is safe.
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,last-event-id",
  };
}

async function readJsonBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export function createServer(opts: CreateServerOptions): LoopwrightServer {
  const { store, config, staticDir } = opts;
  const runGoalImpl = opts.runGoalImpl ?? defaultRunGoal;
  const baseEnv = opts.baseEnv ?? process.env;
  const rates = opts.rates ?? {};
  const hub = new RunHub();

  const http = createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, { error: String(err?.message ?? err) });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (pathname === "/api/health") {
      return send(res, 200, { ok: true });
    }

    if (pathname === "/api/runs" && method === "POST") {
      return startRun(req, res);
    }

    const streamMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stream$/);
    if (streamMatch && method === "GET") {
      return streamRun(req, res, decodeURIComponent(streamMatch[1] as string));
    }

    if (pathname === "/api/sessions" && method === "GET") {
      const sessions = await store.listSessions();
      sessions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return send(res, 200, { sessions });
    }

    const traceMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/trace$/);
    if (traceMatch && method === "GET") {
      const id = decodeURIComponent(traceMatch[1] as string);
      const trace = await buildTrace(store, id, rates);
      if (!trace.session) return send(res, 404, { error: `no session "${id}"` });
      return send(res, 200, {
        trace,
        text: formatTrace(trace),
        phase: hub.phase(id) ?? null,
      });
    }

    if (pathname.startsWith("/api/")) {
      return send(res, 404, { error: "not found" });
    }

    if (staticDir) return serveStatic(res, pathname, staticDir);
    return send(res, 404, { error: "not found" });
  }

  async function startRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: StartRunBody;
    try {
      body = ((await readJsonBody(req)) ?? {}) as StartRunBody;
    } catch (err) {
      return send(res, 400, { error: `invalid JSON body: ${String((err as Error).message)}` });
    }
    const goal = (body.goal ?? "").trim();
    if (!goal) return send(res, 400, { error: "goal is required" });

    // Resolve per-run config from the merged env, but never let a caller
    // redirect persistence away from the server's store.
    const mergedEnv: Record<string, string | undefined> = { ...baseEnv, ...(body.env ?? {}) };
    delete mergedEnv.LOOPWRIGHT_DB_PATH;
    let runConfig: LoopwrightConfig;
    try {
      runConfig = loadConfig(mergedEnv);
    } catch (err) {
      return send(res, 400, { error: `invalid config: ${String((err as Error).message)}` });
    }
    runConfig.dbPath = config.dbPath;

    const sessionId = body.sessionId ?? randomUUID();
    if (hub.has(sessionId) && hub.phase(sessionId) === "running") {
      return send(res, 409, { error: `session ${sessionId} is already running` });
    }

    // Live wiring: the observer streams transitions/attempts/outcomes; the
    // tapping store streams lifecycle + runner-call events; `log` streams the
    // engine's human-readable lines. All flow through the same hub channel.
    const observer: LoopObserver = {
      transition: (e) => void hub.publish(sessionId, "transition", e),
      attempt: (e) => void hub.publish(sessionId, "attempt", e),
      outcome: (o) => void hub.publish(sessionId, "outcome", o),
    };
    const tappedStore = tapStoreEvents(store, (rec) => hub.publish(sessionId, "event", rec));

    hub.publish(sessionId, "status", { phase: "running" } satisfies RunStatusData);

    // Fire-and-forget: the run proceeds in the background and the client
    // follows it over SSE. Errors are surfaced as a terminal status message.
    void runGoalImpl(goal, runConfig, {
      store: tappedStore,
      sessionId,
      resume: body.resume ?? false,
      observer,
      log: (line) => void hub.publish(sessionId, "log", { line }),
    })
      .then((result) => {
        hub.publish(sessionId, "status", { phase: "done", result } satisfies RunStatusData);
      })
      .catch((err: unknown) => {
        hub.publish(sessionId, "status", {
          phase: "error",
          error: String((err as Error)?.message ?? err),
        } satisfies RunStatusData);
      });

    send(res, 202, { sessionId });
  }

  function streamRun(req: IncomingMessage, res: ServerResponse, sessionId: string): void {
    // Unknown session: don't let an SSE connection implicitly create a channel
    // (which would reserve the id). Report 404 so the client can fall back to
    // the trace endpoint for a past run.
    if (!hub.has(sessionId)) {
      return send(res, 404, { error: `no active run for session "${sessionId}"` });
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...corsHeaders(),
    });

    // Resume support: a reconnecting client passes the id of the last message
    // it processed so the hub replays only what it missed.
    const lastIdHeader = req.headers["last-event-id"];
    const afterId = lastIdHeader !== undefined ? Number.parseInt(String(lastIdHeader), 10) : -1;

    const write = (msg: { id: number; type: string; data: unknown }): void => {
      res.write(`id: ${msg.id}\n`);
      res.write(`event: ${msg.type}\n`);
      res.write(`data: ${JSON.stringify(msg.data)}\n\n`);
    };

    const unsubscribe = hub.subscribe(
      sessionId,
      (msg) => write(msg),
      Number.isFinite(afterId) ? afterId : -1,
    );

    // Heartbeat keeps intermediaries from closing an idle stream during long
    // model calls.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", close);
    res.on("close", close);
  }

  async function serveStatic(res: ServerResponse, pathname: string, dir: string): Promise<void> {
    // Normalize the asset root to an absolute path so the traversal guard below
    // compares like with like even when `dir` came in relative (e.g. a relative
    // LOOPWRIGHT_STATIC_DIR), which would otherwise reject every request.
    const root = path.resolve(dir);
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const resolved = path.resolve(root, rel);
    // Path-traversal guard: never serve outside the asset directory.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return send(res, 403, { error: "forbidden" });
    }
    const file = await resolveFile(resolved, root);
    if (!file) return send(res, 404, { error: "not found" });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream",
      ...corsHeaders(),
    });
    createReadStream(file).pipe(res);
  }

  /** Returns an existing file path, falling back to the SPA index.html. */
  async function resolveFile(resolved: string, dir: string): Promise<string | undefined> {
    try {
      const s = await stat(resolved);
      if (s.isFile()) return resolved;
    } catch {
      /* fall through to SPA fallback */
    }
    const index = path.join(dir, "index.html");
    try {
      const s = await stat(index);
      if (s.isFile()) return index;
    } catch {
      /* no index */
    }
    return undefined;
  }

  return {
    http,
    hub,
    start(port = 0, host = "127.0.0.1"): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => {
          http.off("error", reject);
          const addr = http.address();
          const bound = typeof addr === "object" && addr ? addr.port : port;
          resolve(bound);
        });
      });
    },
    stop(): Promise<void> {
      return new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

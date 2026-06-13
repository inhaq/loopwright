import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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
 * directly onto existing engine entry points (Req 13.3).
 *
 * Security model: a run accepts per-request runner profiles, which can spawn
 * local processes (`cli` runners) and forward stored secrets to arbitrary
 * endpoints. The server therefore binds loopback only and guards every `/api`
 * route (except health) with TWO layers:
 *   1. an unguessable per-process bearer token, delivered out-of-band to the
 *      trusted UI (a Tauri command, or injected into the served index.html),
 *      so a page on another origin can never obtain it;
 *   2. a CORS origin allowlist (loopback + the Tauri webview), so cross-site
 *      pages get no CORS grant even before the token check.
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
  /**
   * Bearer token required on every `/api` route except health. Defaults to a
   * fresh random token; pass a fixed value (e.g. in tests, or from the Tauri
   * shell) to control it.
   */
  token?: string;
  /** max runs that may be active concurrently before new ones get 429 */
  maxActiveRuns?: number;
  /** how long (ms) to retain a finished run's event buffer before releasing it */
  retainMs?: number;
  /** most recent messages retained per run for SSE replay */
  maxBufferPerRun?: number;
  /**
   * Invoked once a graceful shutdown (via stop() or POST /api/shutdown) has
   * finished tearing the server down — e.g. the entrypoint passes
   * `() => process.exit(0)`.
   */
  onShutdown?: () => void;
  /**
   * How long (ms) stop() waits for in-flight connections to drain before
   * force-closing any that remain (idle keep-alive sockets, slow clients).
   */
  shutdownGraceMs?: number;
}

export interface LoopwrightServer {
  /** the underlying http.Server (call .listen yourself, or use start()) */
  http: Server;
  hub: RunHub;
  /** the per-process auth token clients must present */
  token: string;
  /** listen on a port (0 = ephemeral) and resolve with the bound port */
  start(port?: number, host?: string): Promise<number>;
  stop(): Promise<void>;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function send(res: ServerResponse, status: number, body: unknown, cors: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...cors });
  res.end(payload);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True for hosts that only accept connections from the local machine. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Caller-supplied session ids flow into git branch names and worktree
 * directory paths (see workspace/worktrees.ts), so they must be a bounded,
 * filesystem- and ref-safe token. We accept letters, digits, `_` and `-` only
 * (which covers the UUIDs we mint for new runs) and forbid `.`/`/` so a value
 * like `../../etc` or `..` can never escape the worktree root or forge a ref.
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether a caller-supplied session id is safe to use in paths/refs. */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/** Loopback and the Tauri webview are the only origins ever granted CORS. */
function originAllowed(origin: string): boolean {
  if (origin === "tauri://localhost") return true;
  try {
    const u = new URL(origin);
    if (u.hostname === "tauri.localhost") return true;
    return LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * CORS headers for a request. Same-origin / non-browser requests (no Origin)
 * need none; cross-origin requests get a grant only for allowlisted origins,
 * and the specific origin is echoed rather than `*` so the policy is explicit.
 */
function corsHeadersFor(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return {};
  if (!originAllowed(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,last-event-id",
    "access-control-max-age": "600",
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
  const token = opts.token ?? randomUUID();
  const maxActiveRuns = opts.maxActiveRuns ?? 4;
  const retainMs = opts.retainMs ?? 5 * 60_000;
  const onShutdown = opts.onShutdown;
  const shutdownGraceMs = opts.shutdownGraceMs ?? 3_000;
  const hub = new RunHub(opts.maxBufferPerRun);
  let activeRuns = 0;
  /** abort controllers for in-flight runs, keyed by session id (for cancel) */
  const controllers = new Map<string, AbortController>();
  /** open SSE responses, so a graceful shutdown can end them deterministically */
  const sseClients = new Set<ServerResponse>();
  /** memoized graceful-shutdown promise so stop() is safe to call repeatedly */
  let closing: Promise<void> | undefined;

  /**
   * Constant-time bearer-token check. The token is read from the Authorization
   * header; the `token` query param is accepted ONLY where `allowQuery` is set
   * (the SSE stream, since EventSource can't send headers) so tokens don't leak
   * into URLs/logs for ordinary requests.
   */
  function authorized(req: IncomingMessage, url: URL, allowQuery: boolean): boolean {
    const auth = req.headers.authorization;
    let provided: string | undefined;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) provided = auth.slice(7);
    else if (allowQuery) provided = url.searchParams.get("token") ?? undefined;
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

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
    const cors = corsHeadersFor(req);

    if (method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    // Health is intentionally unauthenticated (no sensitive data) so the UI can
    // show connectivity before it has resolved the token.
    if (pathname === "/api/health") {
      return send(res, 200, { ok: true }, cors);
    }

    // Everything else under /api requires the token. This is the boundary that
    // stops a page on another origin from starting runs (which can execute
    // local commands and exfiltrate secrets via runner profiles). Only the SSE
    // stream may carry the token as a query param (EventSource can't set
    // headers); all other routes require the Authorization header.
    const isStream = method === "GET" && /^\/api\/runs\/[^/]+\/stream$/.test(pathname);
    if (pathname.startsWith("/api/")) {
      if (!authorized(req, url, isStream)) return send(res, 401, { error: "unauthorized" }, cors);
    }

    if (pathname === "/api/runs" && method === "POST") {
      return startRun(req, res, cors);
    }

    const streamMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stream$/);
    if (streamMatch && method === "GET") {
      return streamRun(req, res, decodeURIComponent(streamMatch[1] as string), cors);
    }

    const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (cancelMatch && method === "POST") {
      const id = decodeURIComponent(cancelMatch[1] as string);
      const controller = controllers.get(id);
      if (!controller) return send(res, 404, { error: `no active run for session "${id}"` }, cors);
      controller.abort();
      return send(res, 202, { cancelling: true }, cors);
    }

    // Graceful shutdown: the desktop shell calls this before killing the
    // sidecar so in-flight runs are cancelled (which kills their detached
    // subprocess trees) and SSE clients are closed cleanly, rather than being
    // hard-killed and orphaning work. Token-protected like the rest of /api.
    if (pathname === "/api/shutdown" && method === "POST") {
      send(res, 202, { shuttingDown: true }, cors);
      // Defer so the 202 flushes before the server tears itself down.
      setImmediate(() => {
        void closeServer().then(() => onShutdown?.());
      });
      return;
    }

    if (pathname === "/api/sessions" && method === "GET") {
      const sessions = await store.listSessions();
      sessions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return send(res, 200, { sessions }, cors);
    }

    const traceMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/trace$/);
    if (traceMatch && method === "GET") {
      const id = decodeURIComponent(traceMatch[1] as string);
      const trace = await buildTrace(store, id, rates);
      if (!trace.session) return send(res, 404, { error: `no session "${id}"` }, cors);
      return send(res, 200, {
        trace,
        text: formatTrace(trace),
        phase: hub.phase(id) ?? null,
      }, cors);
    }

    if (pathname.startsWith("/api/")) {
      return send(res, 404, { error: "not found" }, cors);
    }

    if (staticDir) return serveStatic(res, pathname);
    return send(res, 404, { error: "not found" }, cors);
  }

  async function startRun(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
    let body: StartRunBody;
    try {
      body = ((await readJsonBody(req)) ?? {}) as StartRunBody;
    } catch (err) {
      return send(res, 400, { error: `invalid JSON body: ${String((err as Error).message)}` }, cors);
    }
    const goal = (body.goal ?? "").trim();
    if (!goal) return send(res, 400, { error: "goal is required" }, cors);

    // Resolve per-run config from the merged env, but never let a caller
    // redirect persistence away from the server's store.
    const mergedEnv: Record<string, string | undefined> = { ...baseEnv, ...(body.env ?? {}) };
    delete mergedEnv.LOOPWRIGHT_DB_PATH;
    let runConfig: LoopwrightConfig;
    try {
      runConfig = loadConfig(mergedEnv);
    } catch (err) {
      return send(res, 400, { error: `invalid config: ${String((err as Error).message)}` }, cors);
    }
    runConfig.dbPath = config.dbPath;

    // A caller-supplied session id becomes part of git branch names and
    // worktree paths, so reject anything outside the bounded safe format before
    // it reaches the filesystem/git. New runs without an id get a safe UUID.
    if (body.sessionId !== undefined && !isValidSessionId(body.sessionId)) {
      return send(
        res,
        400,
        { error: "sessionId must match /^[A-Za-z0-9_-]{1,64}$/" },
        cors,
      );
    }
    const sessionId = body.sessionId ?? randomUUID();
    if (hub.has(sessionId) && hub.phase(sessionId) === "running") {
      return send(res, 409, { error: `session ${sessionId} is already running` }, cors);
    }
    // Admission control: cap concurrent background runs so repeated clicks, a
    // buggy UI, or a leaked token can't kick off unbounded expensive work.
    if (activeRuns >= maxActiveRuns) {
      return send(
        res,
        429,
        { error: `too many active runs (max ${maxActiveRuns}); wait for one to finish` },
        cors,
      );
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

    activeRuns += 1;
    // Per-run abort controller so POST /api/runs/:id/cancel can stop it.
    const controller = new AbortController();
    controllers.set(sessionId, controller);
    // Begin a fresh hub channel for this run: discards any retained buffer from
    // a previous run that reused this session id (so the stream can't replay
    // stale events) and yields a generation token for the cleanup guard below.
    const generation = hub.start(sessionId);
    hub.publish(sessionId, "status", { phase: "running" } satisfies RunStatusData);

    // Frees the active-run slot and, after a grace period, releases the run's
    // in-memory event buffer (late viewers can still catch up until then; the
    // durable trace remains available from the store afterwards). The
    // generation guard ensures this never drops a newer run on the same id.
    const settle = (): void => {
      activeRuns = Math.max(0, activeRuns - 1);
      controllers.delete(sessionId);
      const timer = setTimeout(() => hub.forget(sessionId, generation), retainMs);
      if (typeof timer.unref === "function") timer.unref();
    };

    // Fire-and-forget: the run proceeds in the background and the client
    // follows it over SSE. Errors (including cancellation) surface as a terminal
    // status message.
    void runGoalImpl(goal, runConfig, {
      store: tappedStore,
      sessionId,
      resume: body.resume ?? false,
      observer,
      log: (line) => void hub.publish(sessionId, "log", { line }),
      signal: controller.signal,
    })
      .then((result) => {
        hub.publish(sessionId, "status", { phase: "done", result } satisfies RunStatusData);
        settle();
      })
      .catch((err: unknown) => {
        hub.publish(sessionId, "status", {
          phase: "error",
          error: String((err as Error)?.message ?? err),
        } satisfies RunStatusData);
        settle();
      });

    send(res, 202, { sessionId }, cors);
  }

  function streamRun(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    cors: Record<string, string>,
  ): void {
    // Unknown session: don't let an SSE connection implicitly create a channel
    // (which would reserve the id). Report 404 so the client can fall back to
    // the trace endpoint for a past run.
    if (!hub.has(sessionId)) {
      return send(res, 404, { error: `no active run for session "${sessionId}"` }, cors);
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...cors,
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

    // Track this stream so a graceful shutdown can end it; otherwise the
    // long-lived keep-alive connection would block http.close() indefinitely.
    sseClients.add(res);

    // Heartbeat keeps intermediaries from closing an idle stream during long
    // model calls.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      sseClients.delete(res);
    };
    req.on("close", close);
    res.on("close", close);
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    // Static assets are served WITHOUT CORS headers. The standalone browser UI
    // loads them same-origin (no CORS needed), and withholding CORS stops a
    // page on another origin from reading the injected token out of index.html.
    const dir = staticDir as string;
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

    // index.html is served same-origin to the trusted UI; inject the auth token
    // so the browser build can authenticate without an unauthenticated token
    // endpoint that another origin could read.
    if (path.basename(file) === "index.html") {
      const html = await readFile(file, "utf8");
      const tag = `<script>window.__LOOPWRIGHT_TOKEN__=${JSON.stringify(token)}</script>`;
      const injected = html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : tag + html;
      // index.html carries the live API token, so it must never be cached to
      // disk (hashed asset files below can still cache normally).
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(injected);
      return;
    }

    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream",
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

  /**
   * Graceful teardown: stop in-flight work and close connections so the
   * process can exit promptly without orphaning runs.
   *   1. Abort every active run. The cooperative cancel handlers (HttpRunner,
   *      CliRunner, the mechanical gate) fire synchronously and kill detached
   *      subprocess trees, so no shell/build descendants are left running.
   *   2. End open SSE streams — these are long-lived and would otherwise keep
   *      http.close() from ever completing.
   *   3. Stop accepting new connections and wait for drain, then force-close
   *      anything still lingering after the grace period.
   * Memoized so concurrent stop()/shutdown callers share one teardown.
   */
  function closeServer(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      for (const controller of controllers.values()) controller.abort();
      for (const res of sseClients) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
      sseClients.clear();
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        http.close(() => finish());
        const timer = setTimeout(() => {
          // Drop any sockets still open (idle keep-alive, slow clients) so the
          // close callback can fire and we don't hang on shutdown.
          http.closeAllConnections?.();
          finish();
        }, shutdownGraceMs);
        if (typeof timer.unref === "function") timer.unref();
      });
    })();
    return closing;
  }

  return {
    http,
    hub,
    token,
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
      return closeServer();
    },
  };
}

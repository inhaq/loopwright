import type { RunMessage, SessionRecord, TraceResponse } from "./types.js";

/**
 * Client for the engine server. The app runs in two contexts:
 *
 *  - Inside Tauri: the engine runs as a sidecar on a loopback port the Rust
 *    side chose; we ask it for the URL (and the secret-storage commands are
 *    available).
 *  - In a plain browser (served by `npm run serve`): the API is same-origin.
 *
 * Everything below is written so the browser path needs no Tauri at all.
 */

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let cachedBase: string | undefined;
let cachedToken: string | undefined;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Resolves the engine base URL ("" means same-origin). */
export async function apiBase(): Promise<string> {
  if (cachedBase !== undefined) return cachedBase;
  if (isTauri()) {
    // Fail fast: surfacing the real startup/invoke error is far safer than
    // silently routing API + secret traffic to an arbitrary local port.
    cachedBase = await tauriInvoke<string>("engine_url");
  } else {
    cachedBase = "";
  }
  return cachedBase;
}

/**
 * The per-process bearer token guarding the engine API. In Tauri it comes from
 * a command (never crosses an origin boundary); in the browser build it is
 * injected into the served index.html as `window.__LOOPWRIGHT_TOKEN__`, so only
 * a page actually loaded from the loopback server can read it.
 */
async function authToken(): Promise<string> {
  if (cachedToken !== undefined) return cachedToken;
  if (isTauri()) {
    cachedToken = await tauriInvoke<string>("engine_token");
  } else {
    cachedToken = (window as unknown as { __LOOPWRIGHT_TOKEN__?: string }).__LOOPWRIGHT_TOKEN__ ?? "";
  }
  return cachedToken;
}

async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const t = await authToken();
  return t ? { ...extra, authorization: `Bearer ${t}` } : extra;
}

/** Re-spawns the engine sidecar (Tauri only) so newly stored secrets apply. */
export async function restartEngine(): Promise<void> {
  if (!isTauri()) return;
  // A restart yields a fresh process with a new token + port; drop both caches
  // so they are re-resolved on the next request.
  cachedBase = await tauriInvoke<string>("restart_engine");
  cachedToken = undefined;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch((await apiBase()) + path, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface StartRunBody {
  goal: string;
  env?: Record<string, string>;
  sessionId?: string;
  resume?: boolean;
}

export async function startRun(body: StartRunBody): Promise<string> {
  const res = await fetch((await apiBase()) + "/api/runs", {
    method: "POST",
    headers: await authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const { sessionId } = (await res.json()) as { sessionId: string };
  return sessionId;
}

export async function listSessions(): Promise<SessionRecord[]> {
  const { sessions } = await getJson<{ sessions: SessionRecord[] }>("/api/sessions");
  return sessions;
}

export async function getTrace(sessionId: string): Promise<TraceResponse> {
  return getJson<TraceResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/trace`);
}

export async function health(): Promise<boolean> {
  try {
    const { ok } = await getJson<{ ok: boolean }>("/api/health");
    return ok === true;
  } catch {
    return false;
  }
}

/**
 * Subscribes to a run's live event stream. Returns a function that closes it.
 * Uses the native EventSource, which transparently reconnects and replays via
 * Last-Event-ID; the server's hub honours that header to avoid duplicates.
 */
export async function openStream(
  sessionId: string,
  onMessage: (msg: RunMessage) => void,
  onError?: (err: Event) => void,
): Promise<() => void> {
  // EventSource cannot set headers, so the token rides as a query param (the
  // server accepts it either way). Resolve against the document base so a
  // same-origin ("") base still produces an absolute URL.
  const t = await authToken();
  const url = new URL(
    (await apiBase()) + `/api/runs/${encodeURIComponent(sessionId)}/stream`,
    typeof window !== "undefined" ? window.location.href : "http://127.0.0.1",
  );
  if (t) url.searchParams.set("token", t);
  const es = new EventSource(url.toString());
  const types: RunMessage["type"][] = ["status", "transition", "attempt", "outcome", "event", "log"];
  for (const type of types) {
    es.addEventListener(type, (ev) => {
      const me = ev as MessageEvent<string>;
      onMessage({ id: Number(me.lastEventId), type, data: JSON.parse(me.data) });
    });
  }
  if (onError) es.onerror = onError;
  return () => es.close();
}

// --- Secret storage (Tauri only; OS keychain) -----------------------------

export async function listSecretKeys(): Promise<string[]> {
  if (!isTauri()) return [];
  return tauriInvoke<string[]>("list_secret_keys");
}

export async function setSecret(key: string, value: string): Promise<void> {
  await tauriInvoke<void>("set_secret", { key, value });
}

export async function deleteSecret(key: string): Promise<void> {
  await tauriInvoke<void>("delete_secret", { key });
}

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

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Resolves the engine base URL ("" means same-origin). */
export async function apiBase(): Promise<string> {
  if (cachedBase !== undefined) return cachedBase;
  if (isTauri()) {
    try {
      cachedBase = await tauriInvoke<string>("engine_url");
    } catch {
      cachedBase = "http://127.0.0.1:4317"; // fallback to a conventional port
    }
  } else {
    cachedBase = "";
  }
  return cachedBase;
}

/** Re-spawns the engine sidecar (Tauri only) so newly stored secrets apply. */
export async function restartEngine(): Promise<void> {
  if (!isTauri()) return;
  cachedBase = await tauriInvoke<string>("restart_engine");
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch((await apiBase()) + path);
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
    headers: { "content-type": "application/json" },
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
  const url = (await apiBase()) + `/api/runs/${encodeURIComponent(sessionId)}/stream`;
  const es = new EventSource(url);
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

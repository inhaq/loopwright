/**
 * Telegram notify + control relay (loopback-safe).
 *
 * This is the "phone updates" layer. It does TWO things, both over OUTBOUND
 * HTTPS to api.telegram.org — it never opens an inbound port, so the engine
 * stays loopback-only and is never exposed publicly:
 *
 *   1. Push: when a run finishes, send the final status (and key links such as
 *      a PR url) to a single allowlisted Telegram chat.
 *   2. Control: long-poll Telegram for replies from that same chat. A message
 *      is treated as a new goal and submitted as a run — reusing the most
 *      recent run's preset/repo configuration — so the user can keep the engine
 *      working from their phone. Only messages from the configured chat id are
 *      ever acted on.
 *
 * The Telegram transport (`fetch`) and the run submitter are injected, so the
 * relay is unit-testable without a network or a live engine.
 */

import type { RunFinishedInfo, StartRunBody, SubmitResult } from "../server/server.js";

export type { RunFinishedInfo, SubmitResult };

/** The slice of the server the relay needs to drive runs from chat messages. */
export interface RunSubmitter {
  submitRun(body: StartRunBody): Promise<SubmitResult>;
  /** the most recent run's env + repo, reused for chat-initiated runs */
  lastRunConfig(): { env: Record<string, string>; repoDir?: string } | undefined;
}

/** Minimal fetch shape the relay depends on (global fetch satisfies it). */
export type TelegramFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface TelegramConfig {
  /** bot token from @BotFather */
  botToken: string;
  /** the single chat id allowed to receive notifications and issue commands */
  chatId: string;
  /** Telegram Bot API base (override for tests); default https://api.telegram.org */
  apiBase?: string;
  /** injectable transport; defaults to the global fetch */
  fetchImpl?: TelegramFetch;
  log?: (line: string) => void;
  /**
   * When true (default), the first poll discards any backlog so the relay never
   * acts on messages sent before it started. Tests set false to act immediately.
   */
  skipBacklog?: boolean;
  /** long-poll timeout in seconds for getUpdates (default 50) */
  pollTimeoutSec?: number;
}

/** Builds the final-status message for a finished run. Exported for tests. */
export function formatFinalStatus(info: RunFinishedInfo): string {
  const goalLine = `“${info.goal}”`;
  if (info.phase === "error") {
    return [`❌ Loopwright run failed`, goalLine, info.error ?? "unknown error", `session ${info.sessionId}`].join("\n");
  }

  const r = info.result;
  const needsHuman = r?.needsHuman.length ?? 0;
  const integrationBad = Boolean(r?.integration && r.integration.ok === false);
  const head = needsHuman > 0 || integrationBad ? "⚠️ Loopwright: needs attention" : "✅ Loopwright: completed";

  const lines: string[] = [head, goalLine];
  if (r) {
    lines.push(`green ${r.green.length} · unverified ${r.unverified.length} · needs-human ${r.needsHuman.length}`);
    if (r.integration) {
      lines.push(`integration: ${r.integration.ok ? "merged + verified" : "failed (conflicts or verification)"}`);
    }
    if (r.publish?.pushed) lines.push(`pushed → ${r.publish.remote}/${r.publish.pushBranch}`);
    if (r.publish?.pr?.url) lines.push(`PR: ${r.publish.pr.url}`);
  }
  lines.push(`session ${info.sessionId}`);
  if (needsHuman > 0 || integrationBad) {
    lines.push("Reply with a new goal to keep me working.");
  }
  return lines.join("\n");
}

interface TgUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id?: number | string } };
}

const HELP_TEXT =
  "Loopwright relay\n" +
  "Send any message and I'll run it as a new goal, reusing the repo + presets " +
  "from your last run. Commands: /help.";

export class TelegramRelay {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly apiBase: string;
  private readonly fetchImpl: TelegramFetch;
  private readonly log: (line: string) => void;
  private readonly pollTimeoutSec: number;

  private submitter: RunSubmitter | undefined;
  private offset: number | undefined;
  private primed: boolean;
  private running = false;
  private abort: AbortController | undefined;

  constructor(cfg: TelegramConfig) {
    this.botToken = cfg.botToken;
    this.chatId = String(cfg.chatId);
    this.apiBase = (cfg.apiBase ?? "https://api.telegram.org").replace(/\/$/, "");
    const globalFetch = (globalThis as { fetch?: TelegramFetch }).fetch;
    const resolved = cfg.fetchImpl ?? globalFetch;
    if (!resolved) throw new Error("TelegramRelay has no fetch implementation available.");
    this.fetchImpl = resolved;
    this.log = cfg.log ?? (() => {});
    this.pollTimeoutSec = cfg.pollTimeoutSec ?? 50;
    // primed=true means "act on the next batch immediately" (no backlog skip).
    this.primed = cfg.skipBacklog === false;
  }

  /** Supplies the run submitter (the engine server). Call before start(). */
  attach(submitter: RunSubmitter): void {
    this.submitter = submitter;
  }

  /** Notifier hook: invoked by the server when a run reaches a terminal state. */
  runFinished(info: RunFinishedInfo): void {
    void this.sendMessage(formatFinalStatus(info)).catch((err) =>
      this.log(`telegram: failed to send final status: ${String((err as Error)?.message ?? err)}`),
    );
  }

  /** Begins the long-poll control loop (does nothing if already running). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.log("telegram: relay started (long-polling for messages)");
    void this.loop();
  }

  /** Stops the control loop and aborts any in-flight long poll. */
  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        if (!this.running) break;
        this.log(`telegram: poll error: ${String((err as Error)?.message ?? err)}`);
        await delay(3000);
      }
    }
  }

  /**
   * Performs one getUpdates long-poll and handles the returned messages. The
   * first batch is discarded (offset advanced only) unless backlog handling was
   * enabled, so the relay never acts on messages sent before it started.
   */
  async pollOnce(): Promise<void> {
    const updates = await this.getUpdates();
    const handleNow = this.primed;
    for (const u of updates) {
      this.offset = u.update_id + 1;
      if (handleNow) await this.handleUpdate(u);
    }
    this.primed = true;
  }

  /** Acts on a single update: ignores other chats; runs the text as a goal. */
  async handleUpdate(u: TgUpdate): Promise<void> {
    const msg = u.message;
    const text = msg?.text?.trim();
    if (!text) return;
    // Allowlist: only the configured chat may receive output or issue commands.
    if (String(msg?.chat?.id ?? "") !== this.chatId) {
      this.log(`telegram: ignoring message from unauthorized chat ${String(msg?.chat?.id)}`);
      return;
    }

    if (text === "/start" || text === "/help") {
      await this.sendMessage(HELP_TEXT);
      return;
    }

    if (!this.submitter) {
      await this.sendMessage("Relay is not ready yet — try again in a moment.");
      return;
    }
    const last = this.submitter.lastRunConfig();
    if (!last) {
      await this.sendMessage(
        "I don't have a run configuration yet. Start one run from the desktop app first, then I'll reuse its repo + presets for messages from here.",
      );
      return;
    }

    const result = await this.submitter.submitRun({
      goal: text,
      env: last.env,
      ...(last.repoDir ? { repoDir: last.repoDir } : {}),
    });
    if (result.ok) {
      await this.sendMessage(`▶️ Starting run\n“${text}”\nsession ${result.sessionId}`);
    } else {
      await this.sendMessage(`Couldn't start that run (${result.status}): ${result.error}`);
    }
  }

  /** Long-polls Telegram for new updates. Returns [] on a non-ok response. */
  private async getUpdates(): Promise<TgUpdate[]> {
    this.abort = new AbortController();
    const params = new URLSearchParams({
      timeout: String(this.pollTimeoutSec),
      allowed_updates: JSON.stringify(["message"]),
    });
    if (this.offset !== undefined) params.set("offset", String(this.offset));
    const url = `${this.apiBase}/bot${this.botToken}/getUpdates?${params.toString()}`;
    const res = await this.fetchImpl(url, { method: "GET", signal: this.abort.signal });
    if (!res.ok) {
      // Throw so the loop applies its backoff: a persistent error (e.g. 401 on a
      // bad token) would otherwise spin tightly, hammering Telegram.
      throw new Error(`getUpdates returned ${res.status}`);
    }
    const body = (await res.json()) as { ok?: boolean; result?: TgUpdate[] };
    return Array.isArray(body.result) ? body.result : [];
  }

  /** Sends a text message to the configured chat. Resolves true on success. */
  async sendMessage(text: string): Promise<boolean> {
    const url = `${this.apiBase}/bot${this.botToken}/sendMessage`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      this.log(`telegram: sendMessage returned ${res.status}: ${await safeText(res)}`);
      return false;
    }
    return true;
  }
}

/**
 * Builds a relay from the engine environment, or returns undefined when Telegram
 * is not configured. Accepts both the explicit LOOPWRIGHT_TELEGRAM_* names and
 * the plain TELEGRAM_* secret names (which the desktop shell can store and
 * inject without the reserved LOOPWRIGHT_ prefix).
 */
export function createTelegramRelayFromEnv(
  env: Record<string, string | undefined>,
  log?: (line: string) => void,
): TelegramRelay | undefined {
  const botToken = env.LOOPWRIGHT_TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  const chatId = env.LOOPWRIGHT_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return undefined;
  return new TelegramRelay({ botToken, chatId, ...(log ? { log } : {}) });
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

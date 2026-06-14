import { describe, it, expect } from "vitest";
import {
  TelegramRelay,
  formatFinalStatus,
  createTelegramRelayFromEnv,
  type TelegramFetch,
  type RunSubmitter,
} from "../src/notify/telegram.js";
import type { SessionResult } from "../src/session.js";
import type { StartRunBody } from "../src/server/server.js";

interface TgUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id?: number | string } };
}

/** A fake Telegram transport: scripts getUpdates batches, records sendMessage. */
function fakeTelegram(batches: TgUpdate[][]) {
  const sent: Array<{ chat_id: string; text: string }> = [];
  const getUpdatesUrls: string[] = [];
  let batch = 0;
  const fetchImpl: TelegramFetch = async (url, init) => {
    if (url.includes("/getUpdates")) {
      getUpdatesUrls.push(url);
      const result = batches[batch] ?? [];
      batch += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true, result }), text: async () => "" };
    }
    if (url.includes("/sendMessage")) {
      sent.push(JSON.parse(init?.body ?? "{}"));
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
  return { fetchImpl, sent, getUpdatesUrls };
}

function fakeSubmitter(last?: { env: Record<string, string>; repoDir?: string }) {
  const calls: StartRunBody[] = [];
  const submitter: RunSubmitter & { calls: StartRunBody[] } = {
    calls,
    submitRun: async (body) => {
      calls.push(body);
      return { ok: true, sessionId: "sess-1" };
    },
    lastRunConfig: () => last,
  };
  return submitter;
}

const sessionResult = (over: Partial<SessionResult>): SessionResult =>
  ({
    goal: "g",
    plan: {} as never,
    results: [],
    green: [],
    unverified: [],
    needsHuman: [],
    skipped: [],
    allVerified: true,
    ...over,
  }) as SessionResult;

describe("formatFinalStatus", () => {
  it("formats a completed run with counts", () => {
    const msg = formatFinalStatus({
      sessionId: "abc",
      goal: "Add /healthz",
      phase: "done",
      result: sessionResult({ green: ["t1", "t2"], allVerified: true }),
    });
    expect(msg).toContain("✅ Loopwright: completed");
    expect(msg).toContain("“Add /healthz”");
    expect(msg).toContain("green 2");
    expect(msg).toContain("session abc");
  });

  it("flags needs-attention and includes a PR link when present", () => {
    const msg = formatFinalStatus({
      sessionId: "abc",
      goal: "g",
      phase: "done",
      result: sessionResult({
        needsHuman: ["t3"],
        publish: { pushed: true, remote: "origin", branch: "b", pushBranch: "b", pr: { created: true, url: "https://gh/pr/1" } } as never,
      }),
    });
    expect(msg).toContain("⚠️ Loopwright: needs attention");
    expect(msg).toContain("PR: https://gh/pr/1");
    expect(msg).toContain("Reply with a new goal");
  });

  it("formats a failed run", () => {
    const msg = formatFinalStatus({ sessionId: "abc", goal: "g", phase: "error", error: "boom" });
    expect(msg).toContain("❌ Loopwright run failed");
    expect(msg).toContain("boom");
  });
});

describe("TelegramRelay.runFinished", () => {
  it("sends the final status to the configured chat", async () => {
    const tg = fakeTelegram([]);
    const relay = new TelegramRelay({ botToken: "T", chatId: "42", fetchImpl: tg.fetchImpl });
    relay.runFinished({ sessionId: "s", goal: "do it", phase: "done", result: sessionResult({}) });
    // runFinished fires the send without awaiting; let the microtask settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.chat_id).toBe("42");
    expect(tg.sent[0]?.text).toContain("Loopwright");
  });
});

describe("TelegramRelay control channel", () => {
  it("runs a message from the allowlisted chat as a new goal, reusing last config", async () => {
    const tg = fakeTelegram([]);
    const submitter = fakeSubmitter({ env: { LOOPWRIGHT_RUNNERS: "[]" }, repoDir: "/repo" });
    const relay = new TelegramRelay({ botToken: "T", chatId: "42", fetchImpl: tg.fetchImpl, skipBacklog: false });
    relay.attach(submitter);

    await relay.handleUpdate({ update_id: 1, message: { text: "Fix the bug", chat: { id: 42 } } });

    expect(submitter.calls).toHaveLength(1);
    expect(submitter.calls[0]).toMatchObject({ goal: "Fix the bug", repoDir: "/repo", env: { LOOPWRIGHT_RUNNERS: "[]" } });
    expect(tg.sent[0]?.text).toContain("▶️ Starting run");
    expect(tg.sent[0]?.text).toContain("sess-1");
  });

  it("ignores messages from any other chat", async () => {
    const tg = fakeTelegram([]);
    const submitter = fakeSubmitter({ env: {}, repoDir: "/repo" });
    const relay = new TelegramRelay({ botToken: "T", chatId: "42", fetchImpl: tg.fetchImpl, skipBacklog: false });
    relay.attach(submitter);

    await relay.handleUpdate({ update_id: 1, message: { text: "do it", chat: { id: 999 } } });
    expect(submitter.calls).toHaveLength(0);
    expect(tg.sent).toHaveLength(0);
  });

  it("replies with help and does not start a run for /help", async () => {
    const tg = fakeTelegram([]);
    const submitter = fakeSubmitter({ env: {}, repoDir: "/repo" });
    const relay = new TelegramRelay({ botToken: "T", chatId: "42", fetchImpl: tg.fetchImpl, skipBacklog: false });
    relay.attach(submitter);

    await relay.handleUpdate({ update_id: 1, message: { text: "/help", chat: { id: 42 } } });
    expect(submitter.calls).toHaveLength(0);
    expect(tg.sent[0]?.text).toContain("Loopwright relay");
  });

  it("asks the user to start from desktop when there is no run config yet", async () => {
    const tg = fakeTelegram([]);
    const submitter = fakeSubmitter(undefined);
    const relay = new TelegramRelay({ botToken: "T", chatId: "42", fetchImpl: tg.fetchImpl, skipBacklog: false });
    relay.attach(submitter);

    await relay.handleUpdate({ update_id: 1, message: { text: "do something", chat: { id: 42 } } });
    expect(submitter.calls).toHaveLength(0);
    expect(tg.sent[0]?.text).toContain("don't have a run configuration");
  });
});

describe("TelegramRelay polling", () => {
  it("skips the initial backlog, then handles later messages, advancing the offset", async () => {
    // First poll returns a backlog message (must be skipped); second returns a new one.
    const tg = fakeTelegram([
      [{ update_id: 5, message: { text: "old", chat: { id: 42 } } }],
      [{ update_id: 6, message: { text: "new goal", chat: { id: 42 } } }],
    ]);
    const submitter = fakeSubmitter({ env: {}, repoDir: "/repo" });
    const relay = new TelegramRelay({ botToken: "T", chatId: "42", fetchImpl: tg.fetchImpl });
    relay.attach(submitter);

    await relay.pollOnce(); // backlog: advances offset, no handling
    expect(submitter.calls).toHaveLength(0);

    await relay.pollOnce(); // handles "new goal"
    expect(submitter.calls).toHaveLength(1);
    expect(submitter.calls[0]?.goal).toBe("new goal");

    // The second getUpdates must carry offset=6 (5 + 1) to ack the backlog.
    expect(tg.getUpdatesUrls[1]).toContain("offset=6");
  });
});

describe("createTelegramRelayFromEnv", () => {
  it("returns undefined when not configured", () => {
    expect(createTelegramRelayFromEnv({})).toBeUndefined();
  });
  it("builds a relay from TELEGRAM_* secret names", () => {
    const relay = createTelegramRelayFromEnv({ TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42" });
    expect(relay).toBeInstanceOf(TelegramRelay);
  });
});

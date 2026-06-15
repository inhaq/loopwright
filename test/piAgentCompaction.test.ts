import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerFauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxProviderRegistration,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createCompactionTransform,
  findCompactionCut,
  type CompactionOptions,
} from "../src/runners/piAgentRunner.js";

/**
 * Context compaction is the pi `transformContext` seam: when the transcript
 * grows past budget, the older middle is summarized (via pi's generateSummary)
 * and replaced with a single summary message, keeping the prompt + recent tail.
 * Tested directly against the faux provider so the real summarization path runs
 * offline and deterministically.
 */

const ts = () => Date.now();
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: ts() });
const toolResult = (id: string, text: string): AgentMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read_file",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: ts(),
});
const assistantToolCall = (id: string): AgentMessage =>
  fauxAssistantMessage(fauxToolCall("read_file", { path: "f.txt" }, { id }), { stopReason: "toolUse" });
const assistantText = (text: string): AgentMessage =>
  fauxAssistantMessage(text, { stopReason: "stop" });

/** A transcript as transformContext sees it: prompt + read turns, last message
 *  a toolResult (the state right before the next assistant turn). */
function transcript(): AgentMessage[] {
  const big = "x".repeat(4_000);
  return [
    user("build the thing"),
    assistantToolCall("c1"),
    toolResult("c1", big),
    assistantToolCall("c2"),
    toolResult("c2", big),
    assistantToolCall("c3"),
    toolResult("c3", big),
  ];
}

const opts = (over: Partial<CompactionOptions> = {}): CompactionOptions => ({
  enabled: true,
  keepRecentTokens: 50,
  reserveTokens: 200,
  ...over,
});

describe("findCompactionCut", () => {
  it("snaps the retained-tail start to an assistant turn boundary", () => {
    const msgs = transcript();
    const cut = findCompactionCut(msgs, 50);
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(msgs.length);
    expect(msgs[cut]?.role).toBe("assistant"); // never starts the tail on a dangling toolResult
  });

  it("keeps everything (cut at 1) when the budget covers the whole tail", () => {
    const msgs = transcript();
    expect(findCompactionCut(msgs, 10_000_000)).toBe(1);
  });
});

describe("createCompactionTransform", () => {
  let faux: FauxProviderRegistration;
  beforeEach(() => {
    faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-coder", contextWindow: 200_000, maxTokens: 8_192 }],
    });
  });
  afterEach(() => faux.unregister());

  it("returns undefined when compaction is disabled", () => {
    expect(createCompactionTransform(opts({ enabled: false }), faux.getModel(), "k")).toBeUndefined();
  });

  it("summarizes the middle and keeps prompt + recent tail when over threshold", async () => {
    faux.setResponses([fauxAssistantMessage("COMPACTED SUMMARY", { stopReason: "stop" })]);
    const transform = createCompactionTransform(opts({ thresholdTokens: 1 }), faux.getModel(), "k");
    expect(transform).toBeDefined();

    const msgs = transcript();
    const out = await transform!(msgs);

    expect(out.length).toBeLessThan(msgs.length);
    expect(out[0]).toBe(msgs[0]); // original prompt retained verbatim
    expect(out[1]?.role).toBe("compactionSummary");
    expect((out[1] as { summary: string }).summary).toContain("COMPACTED SUMMARY");
    expect(out[2]?.role).toBe("assistant"); // retained tail starts on a turn boundary
  });

  it("leaves the transcript untouched when under threshold", async () => {
    const transform = createCompactionTransform(opts({ thresholdTokens: 10_000_000 }), faux.getModel(), "k");
    const msgs = transcript();
    const out = await transform!(msgs);
    expect(out).toBe(msgs); // same reference: no compaction performed
  });

  it("does not compact a transcript that is too short to have a safe cut", async () => {
    const transform = createCompactionTransform(opts({ thresholdTokens: 1 }), faux.getModel(), "k");
    const msgs: AgentMessage[] = [user("hi"), assistantText("done")];
    const out = await transform!(msgs);
    expect(out).toBe(msgs);
  });
});

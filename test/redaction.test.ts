import { describe, it, expect } from "vitest";
import { redact, redactAndTruncate } from "../src/engine/redaction.js";

describe("redaction", () => {
  it("redacts secret-looking env assignments but keeps the key", () => {
    const out = redact("OPENAI_API_KEY=sk-abcdef0123456789abcdef\nFOO=bar");
    expect(out).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(out).toContain("FOO=bar");
    expect(out).not.toContain("sk-abcdef");
  });

  it("redacts standalone OpenAI keys", () => {
    const out = redact("token is sk-proj-ABCDEFGHIJKLMNOP1234 in logs");
    expect(out).not.toContain("sk-proj-ABCDEFGHIJKLMNOP1234");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts bearer tokens and AWS keys without leaking the token", () => {
    const out = redact("Authorization: Bearer abcdef12345678");
    expect(out).not.toContain("abcdef12345678");
    expect(out).toContain("[REDACTED]");
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED]");
  });

  it("strips usernames from absolute home paths", () => {
    expect(redact("/Users/alice/project/src/x.ts")).toBe("/Users/[user]/project/src/x.ts");
    expect(redact("/home/bob/repo")).toBe("/home/[user]/repo");
  });

  it("leaves benign content untouched", () => {
    const benign = "function add(a, b) { return a + b; }";
    expect(redact(benign)).toBe(benign);
  });

  it("truncates overly long output while keeping head and tail", () => {
    const big = "START" + "x".repeat(20_000) + "END";
    const out = redactAndTruncate(big, 1_000);
    expect(out.length).toBeLessThan(2_000);
    expect(out).toContain("START");
    expect(out).toContain("END");
    expect(out).toContain("truncated");
  });

  it("truncates multi-line output on line boundaries, reporting omitted lines", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line-${i}: ${"y".repeat(40)}`);
    const out = redactAndTruncate(lines.join("\n"), 600);

    expect(out).toContain("line-0:"); // first line kept
    expect(out).toContain("line-299:"); // last line kept
    expect(out).toContain("lines truncated");
    expect(out).not.toContain("line-150:"); // a middle line dropped

    // Every retained line in the head/tail segments is complete (no mid-line cut).
    const segments = out.split(/\n\.\.\.\[[^\]]*\]\.\.\.\n/);
    expect(segments).toHaveLength(2);
    for (const seg of segments) {
      for (const ln of seg.split("\n").filter(Boolean)) {
        expect(ln).toMatch(/^line-\d+: y{40}$/);
      }
    }
  });

  it("falls back to a hard char slice for a single very long line", () => {
    const big = "START" + "x".repeat(5_000) + "END";
    const out = redactAndTruncate(big, 500);
    expect(out).toContain("START");
    expect(out).toContain("END");
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(1_000);
  });

  it("still redacts secrets in the retained head/tail after truncation", () => {
    const text =
      "OPENAI_API_KEY=sk-abcdef0123456789abcdef\n" + "log line\n".repeat(2_000) + "trailing FOO=bar";
    const out = redactAndTruncate(text, 400);
    expect(out).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(out).not.toContain("sk-abcdef");
    expect(out).toContain("trailing FOO=bar");
  });
});


describe("redaction hardening", () => {
  it("redacts bearer tokens regardless of casing", () => {
    expect(redact("authorization: bearer abcdef12345678")).not.toContain("abcdef12345678");
    expect(redact("BEARER ABCDEF12345678")).not.toContain("ABCDEF12345678");
  });

  it("strips the username from Windows home paths", () => {
    const out = redact("C:\\Users\\Alice\\project\\x.ts");
    expect(out).toContain("C:\\Users\\[user]");
    expect(out).not.toContain("Alice");
  });
});

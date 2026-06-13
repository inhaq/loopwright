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

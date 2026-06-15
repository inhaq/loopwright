import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  extractJsonCandidates,
  parseJsonWithRepair,
  parseLastValidJson,
  repairJson,
} from "../src/engine/jsonExtract.js";

describe("repairJson", () => {
  it("leaves already-valid JSON byte-for-byte unchanged", () => {
    const valid = '{"a":"b\\n c","n":1,"u":"\\u00e9"}';
    expect(repairJson(valid)).toBe(valid);
    expect(JSON.parse(repairJson(valid))).toEqual({ a: "b\n c", n: 1, u: "é" });
  });

  it("escapes a raw newline inside a string", () => {
    const broken = '{"summary":"line one\nline two"}';
    expect(() => JSON.parse(broken)).toThrow();
    const fixed = parseJsonWithRepair<{ summary: string }>(broken);
    expect(fixed.summary).toBe("line one\nline two");
  });

  it("escapes raw tab/return control characters inside strings", () => {
    const broken = '{"s":"a\tb\rc"}';
    expect(() => JSON.parse(broken)).toThrow();
    expect(parseJsonWithRepair<{ s: string }>(broken).s).toBe("a\tb\rc");
  });

  it("doubles a backslash before an invalid escape (e.g. a Windows path)", () => {
    const broken = '{"path":"C:\\Users\\me"}';
    expect(() => JSON.parse(broken)).toThrow();
    expect(parseJsonWithRepair<{ path: string }>(broken).path).toBe("C:\\Users\\me");
  });

  it("preserves valid \\uXXXX escapes", () => {
    const broken = '{"s":"snow \\u2603 man\nnext"}'; // valid unicode + raw newline
    const fixed = parseJsonWithRepair<{ s: string }>(broken);
    expect(fixed.s).toBe("snow \u2603 man\nnext");
  });

  it("rethrows the original error when repair changes nothing", () => {
    // Structurally broken (missing value) — not a string-literal problem.
    expect(() => parseJsonWithRepair('{"a":}')).toThrow();
  });
});

describe("parseLastValidJson with repair", () => {
  const schema = z.object({ diff: z.string(), summary: z.string() });

  it("recovers a build payload whose diff contains raw newlines", () => {
    // The kind of output a model emits when it forgets to escape a diff body.
    const raw =
      'Here is the change:\n' +
      '{"diff":"--- a/x.ts\n+++ b/x.ts\n@@\n-old\n+new","summary":"swap"}';
    const res = parseLastValidJson(raw, schema, "build");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.summary).toBe("swap");
      expect(res.value.diff).toContain("+new");
    }
  });

  it("still prefers the LAST valid object when several are present", () => {
    const raw =
      '{"diff":"d1\nx","summary":"first"} then ' +
      '{"diff":"d2\ny","summary":"second"}';
    const res = parseLastValidJson(raw, schema, "build");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.summary).toBe("second");
  });

  it("reports a schema failure when no candidate validates", () => {
    const res = parseLastValidJson('{"diff":"only"}', schema, "build");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("schema validation");
  });

  it("extractJsonCandidates still ignores prose braces", () => {
    expect(extractJsonCandidates("use {foo} carefully")).toEqual(["{foo}"]);
  });
});

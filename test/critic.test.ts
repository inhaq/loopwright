import { describe, it, expect } from "vitest";
import { parseCriticResponse } from "../src/engine/criticParser.js";
import { normalizeReview, type CriticReview } from "../src/schemas/critic.js";

describe("parseCriticResponse", () => {
  it("parses a bare JSON object", () => {
    const r = parseCriticResponse('{"verdict":"green","summary":"ok","findings":[]}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.review.verdict).toBe("green");
  });

  it("extracts JSON from a markdown fence with surrounding prose", () => {
    const raw = 'Sure!\n```json\n{"verdict":"changes_required","findings":[{"severity":"blocker","category":"correctness","detail":"bug","location":"a.ts"}]}\n```\ndone';
    const r = parseCriticResponse(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.review.findings).toHaveLength(1);
  });

  it("fills defaults for optional fields", () => {
    const r = parseCriticResponse('{"verdict":"green"}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.review.summary).toBe("");
      expect(r.review.findings).toEqual([]);
    }
  });

  it("fails when no JSON is present", () => {
    const r = parseCriticResponse("I can't do that right now.");
    expect(r.ok).toBe(false);
  });

  it("fails on invalid JSON syntax", () => {
    const r = parseCriticResponse('{"verdict": green}');
    expect(r.ok).toBe(false);
  });

  it("fails schema validation on a bad enum", () => {
    const r = parseCriticResponse('{"verdict":"maybe","findings":[]}');
    expect(r.ok).toBe(false);
  });
});

describe("normalizeReview (rubric enforcement)", () => {
  it("downgrades a blocker in a soft category to a nit", () => {
    const review: CriticReview = {
      verdict: "changes_required",
      summary: "",
      findings: [{ severity: "blocker", category: "style", detail: "naming", location: "" }],
    };
    const { review: out, adjustments } = normalizeReview(review);
    expect(out.findings[0]?.severity).toBe("nit");
    expect(out.verdict).toBe("green"); // no real blockers remain
    expect(adjustments.length).toBeGreaterThan(0);
  });

  it("corrects a green verdict that contradicts a real blocker", () => {
    const review: CriticReview = {
      verdict: "green",
      summary: "",
      findings: [{ severity: "blocker", category: "security", detail: "leak", location: "" }],
    };
    const { review: out } = normalizeReview(review);
    expect(out.verdict).toBe("changes_required");
  });

  it("keeps green when only nits are present", () => {
    const review: CriticReview = {
      verdict: "green",
      summary: "",
      findings: [{ severity: "nit", category: "style", detail: "spacing", location: "" }],
    };
    const { review: out } = normalizeReview(review);
    expect(out.verdict).toBe("green");
  });
});

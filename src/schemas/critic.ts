import { z } from "zod";

/**
 * Critic contract.
 *
 * The rubric is encoded here, not just in prompts: only the five "hard"
 * categories may ever be a `blocker`. Everything else is a `nit` and never
 * forces another actor cycle. `normalizeReview` enforces this regardless of
 * what the model claims, which is what prevents taste-based ping-pong.
 */

export const SeveritySchema = z.enum(["blocker", "nit"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingCategorySchema = z.enum([
  // hard categories -- allowed to block
  "correctness",
  "requirements",
  "test_integrity",
  "breakage",
  "security",
  // soft categories -- always nits
  "style",
  "other",
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

/** Categories that are permitted to carry a `blocker` severity. */
export const BLOCKER_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  "correctness",
  "requirements",
  "test_integrity",
  "breakage",
  "security",
]);

export const FindingSchema = z.object({
  severity: SeveritySchema,
  category: FindingCategorySchema,
  detail: z.string().min(1),
  location: z.string().default(""),
});
export type Finding = z.infer<typeof FindingSchema>;

export const VerdictSchema = z.enum(["green", "changes_required"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const CriticReviewSchema = z.object({
  verdict: VerdictSchema,
  summary: z.string().default(""),
  findings: z.array(FindingSchema).default([]),
});
export type CriticReview = z.infer<typeof CriticReviewSchema>;

/**
 * Enforces the rubric on a parsed review:
 *  - downgrades any `blocker` in a soft category to a `nit`
 *  - derives the verdict from the (post-downgrade) findings so the model
 *    cannot say "green" while listing real blockers, or vice versa.
 */
export function normalizeReview(review: CriticReview): {
  review: CriticReview;
  adjustments: string[];
} {
  const adjustments: string[] = [];

  const findings = review.findings.map((f) => {
    if (f.severity === "blocker" && !BLOCKER_CATEGORIES.has(f.category)) {
      adjustments.push(
        `Downgraded blocker -> nit for soft category "${f.category}": ${f.detail}`,
      );
      return { ...f, severity: "nit" as const };
    }
    return f;
  });

  const hasBlocker = findings.some((f) => f.severity === "blocker");
  const derivedVerdict: Verdict = hasBlocker ? "changes_required" : "green";

  if (derivedVerdict !== review.verdict) {
    adjustments.push(
      `Corrected verdict "${review.verdict}" -> "${derivedVerdict}" based on findings.`,
    );
  }

  return {
    review: { ...review, verdict: derivedVerdict, findings },
    adjustments,
  };
}

export function blockers(review: CriticReview): Finding[] {
  return review.findings.filter((f) => f.severity === "blocker");
}

export function nits(review: CriticReview): Finding[] {
  return review.findings.filter((f) => f.severity === "nit");
}

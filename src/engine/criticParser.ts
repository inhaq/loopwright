import { CriticReviewSchema, type CriticReview } from "../schemas/critic.js";
import { parseLastValidJson } from "./jsonExtract.js";

/**
 * Parses a critic model's raw text into a validated CriticReview.
 *
 * Models wrap JSON in prose or ```json fences and sometimes include an
 * illustrative brace snippet before the real answer, so we scan for ALL
 * balanced top-level {...} substrings, validate each, and prefer the last one
 * that satisfies the schema (the model's concluding answer). Returns a
 * discriminated result; the orchestrator owns the retry-then-NEEDS_HUMAN policy.
 *
 * The scanning/validation itself lives in engine/jsonExtract so the actor's
 * plan/build payloads parse through exactly the same code path.
 */

export type ParseResult =
  | { ok: true; review: CriticReview }
  | { ok: false; error: string };

export function parseCriticResponse(raw: string): ParseResult {
  const result = parseLastValidJson(raw, CriticReviewSchema, "critic response");
  if (result.ok) {
    return { ok: true, review: result.value };
  }
  return { ok: false, error: result.error };
}

/** A short corrective hint sent on the single retry after a malformed response. */
export const REPAIR_HINT =
  'Your previous response could not be parsed. Reply with ONLY a JSON object ' +
  'matching: {"verdict":"green"|"changes_required","summary":string,' +
  '"findings":[{"severity":"blocker"|"nit","category":' +
  '"correctness"|"requirements"|"test_integrity"|"breakage"|"security"|"style"|"other",' +
  '"detail":string,"location":string}]}. No prose, no markdown fences.';

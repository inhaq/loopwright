import { CriticReviewSchema, type CriticReview } from "../schemas/critic.js";

/**
 * Parses a critic model's raw text into a validated CriticReview.
 *
 * Models wrap JSON in prose or ```json fences and sometimes include an
 * illustrative brace snippet before the real answer, so we scan for ALL
 * balanced top-level {...} substrings, validate each, and prefer the last one
 * that satisfies the schema (the model's concluding answer). Returns a
 * discriminated result; the orchestrator owns the retry-then-NEEDS_HUMAN policy.
 */

export type ParseResult =
  | { ok: true; review: CriticReview }
  | { ok: false; error: string };

/** Returns every balanced top-level {...} substring, in order of appearance. */
function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return candidates;
}

export function parseCriticResponse(raw: string): ParseResult {
  const candidates = extractJsonCandidates(raw);
  if (candidates.length === 0) {
    return { ok: false, error: "No JSON object found in critic response." };
  }

  let schemaError: string | null = null;
  let lastValid: CriticReview | null = null;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue; // e.g. "{foo}" in prose -- not JSON, try the next candidate
    }
    const result = CriticReviewSchema.safeParse(parsed);
    if (result.success) {
      lastValid = result.data; // keep the latest valid object
    } else {
      schemaError = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
    }
  }

  if (lastValid !== null) {
    return { ok: true, review: lastValid };
  }

  return {
    ok: false,
    error:
      schemaError !== null
        ? `Critic JSON failed schema validation: ${schemaError}`
        : "No parseable JSON object found in critic response.",
  };
}

/** A short corrective hint sent on the single retry after a malformed response. */
export const REPAIR_HINT =
  'Your previous response could not be parsed. Reply with ONLY a JSON object ' +
  'matching: {"verdict":"green"|"changes_required","summary":string,' +
  '"findings":[{"severity":"blocker"|"nit","category":' +
  '"correctness"|"requirements"|"test_integrity"|"breakage"|"security"|"style"|"other",' +
  '"detail":string,"location":string}]}. No prose, no markdown fences.';

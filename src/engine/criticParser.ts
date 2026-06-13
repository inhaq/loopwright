import { CriticReviewSchema, type CriticReview } from "../schemas/critic.js";

/**
 * Parses a critic model's raw text into a validated CriticReview.
 *
 * Models wrap JSON in prose or ```json fences, so we extract the first
 * balanced JSON object before validating. Returns a discriminated result;
 * the orchestrator decides the retry-once-then-NEEDS_HUMAN policy.
 */

export type ParseResult =
  | { ok: true; review: CriticReview }
  | { ok: false; error: string };

/** Extracts the first balanced top-level {...} object from arbitrary text. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseCriticResponse(raw: string): ParseResult {
  const candidate = extractJsonObject(raw);
  if (candidate === null) {
    return { ok: false, error: "No JSON object found in critic response." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return {
      ok: false,
      error: `Critic response was not valid JSON: ${(e as Error).message}`,
    };
  }

  const result = CriticReviewSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `Critic JSON failed schema validation: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }

  return { ok: true, review: result.data };
}

/** A short corrective hint sent on the single retry after a malformed response. */
export const REPAIR_HINT =
  'Your previous response could not be parsed. Reply with ONLY a JSON object ' +
  'matching: {"verdict":"green"|"changes_required","summary":string,' +
  '"findings":[{"severity":"blocker"|"nit","category":' +
  '"correctness"|"requirements"|"test_integrity"|"breakage"|"security"|"style"|"other",' +
  '"detail":string,"location":string}]}. No prose, no markdown fences.';

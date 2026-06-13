import type { z } from "zod";

/**
 * Shared, robust JSON extraction for model output.
 *
 * Model responses routinely wrap JSON in prose or ```fences, and sometimes
 * include an illustrative `{...}` snippet before the real answer. Rather than
 * trust the model to emit clean JSON, we scan for ALL balanced top-level
 * `{...}` substrings, validate each against a schema, and prefer the LAST one
 * that satisfies it (a model's concluding answer comes last).
 *
 * Both role outputs (the critic review, and the actor's plan/build payloads)
 * go through this single code path so parsing behaves identically everywhere.
 */

/** Returns every balanced top-level `{...}` substring, in order of appearance. */
export function extractJsonCandidates(text: string): string[] {
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

export type JsonParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Scans `raw` for balanced JSON objects and returns the LAST one that both
 * parses as JSON and validates against `schema`. Returns a discriminated
 * result; callers own any retry/give-up policy.
 *
 * @param what short noun used in error messages, e.g. "critic response".
 */
export function parseLastValidJson<S extends z.ZodTypeAny>(
  raw: string,
  schema: S,
  what = "response",
): JsonParseResult<z.output<S>> {
  const candidates = extractJsonCandidates(raw);
  if (candidates.length === 0) {
    return { ok: false, error: `No JSON object found in ${what}.` };
  }

  let schemaError: string | null = null;
  let lastValid: z.output<S> | null = null;
  let found = false;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue; // e.g. "{foo}" in prose -- not JSON, try the next candidate
    }
    const result = schema.safeParse(parsed);
    if (result.success) {
      lastValid = result.data; // keep the latest valid object
      found = true;
    } else {
      schemaError = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
    }
  }

  if (found) {
    return { ok: true, value: lastValid as z.output<S> };
  }

  return {
    ok: false,
    error:
      schemaError !== null
        ? `${what} JSON failed schema validation: ${schemaError}`
        : `No parseable JSON object found in ${what}.`,
  };
}

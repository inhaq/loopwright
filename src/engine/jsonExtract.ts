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
 * Models also routinely emit JSON that is *almost* valid: raw control
 * characters (a literal newline/tab inside a string) or invalid backslash
 * escapes. Stock `JSON.parse` rejects these, which used to cost a whole
 * repair-retry round-trip (or a NEEDS_HUMAN give-up). Before failing a
 * candidate we therefore run a conservative {@link repairJson} pass and try
 * again, so a recoverable formatting slip no longer wastes a model call.
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

// ---------------------------------------------------------------------------
// JSON repair (ported from pi: packages/ai/src/utils/json-parse.ts, MIT).
// Trimmed to the non-streaming path loopwright needs (no partial-json dep).
// ---------------------------------------------------------------------------

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
  }
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings (e.g. a literal newline)
 * - doubling backslashes before invalid escape characters
 *
 * Conservative by construction: it only rewrites characters that stock JSON
 * would reject, so a string that already parses is returned byte-for-byte.
 */
export function repairJson(json: string): string {
  let repaired = "";
  let inString = false;

  for (let index = 0; index < json.length; index++) {
    const char = json[index] as string;

    if (!inString) {
      repaired += char;
      if (char === '"') inString = true;
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === "\\") {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += "\\\\";
        continue;
      }
      if (nextChar === "u") {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }
      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }
      // An invalid escape (e.g. a lone "\" before a normal char): keep the
      // backslash literally by doubling it.
      repaired += "\\\\";
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
  }

  return repaired;
}

/**
 * Parses JSON, falling back to a single {@link repairJson} pass when the raw
 * text won't parse. Throws the ORIGINAL parse error when repair doesn't change
 * anything (so the error message reflects the real input), matching pi.
 */
export function parseJsonWithRepair<T = unknown>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    const repaired = repairJson(json);
    if (repaired !== json) {
      return JSON.parse(repaired) as T;
    }
    throw error;
  }
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
      // Try strict parse first, then a conservative repair pass (raw control
      // chars / invalid escapes) before giving up on this candidate.
      parsed = parseJsonWithRepair(candidate);
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

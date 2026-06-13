/**
 * Secret/PII redaction.
 *
 * Diffs and especially test logs routinely leak env vars, tokens, and absolute
 * home paths. We redact BEFORE anything is placed in a critic artifact bundle
 * or persisted. This is intentionally conservative: false positives (over-
 * redaction) are acceptable; leaking a real secret to an external model is not.
 */

const REDACTED = "[REDACTED]";

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const RULES: RedactionRule[] = [
  // Specific token shapes run FIRST so a generic key=value rule can't redact
  // only the label and leave the real token exposed (e.g. "Bearer <token>").
  // OpenAI-style keys: sk-..., sk-proj-...
  {
    name: "openai-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
    replace: () => REDACTED,
  },
  // Bearer tokens in headers (any casing: "Bearer", "bearer", "BEARER")
  {
    name: "bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
    replace: () => `Bearer ${REDACTED}`,
  },
  // AWS access key ids
  {
    name: "aws-akid",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replace: () => REDACTED,
  },
  // GitHub tokens
  {
    name: "github-token",
    pattern: /\bgh[posru]_[A-Za-z0-9]{20,}\b/g,
    replace: () => REDACTED,
  },
  // JWTs
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => REDACTED,
  },
  // KEY=VALUE / KEY: VALUE for secret-looking keys (env files, logs). Runs
  // after the specific shapes above.
  {
    name: "secret-assignment",
    pattern:
      /\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|AUTH)[A-Z0-9_]*)\s*([:=])\s*("?)([^\s"']+)\3/gi,
    replace: (_m, key: string, sep: string, q: string) =>
      `${key}${sep}${q}${REDACTED}${q}`,
  },
  // Absolute home paths -> strip the username component
  {
    name: "home-path",
    pattern: /\/(Users|home)\/[^/\s:"']+/g,
    replace: (_m, root: string) => `/${root}/[user]`,
  },
  // Windows home paths, e.g. C:\Users\Alice\... -> C:\Users\[user]\...
  {
    name: "windows-home-path",
    pattern: /([A-Za-z]:\\Users\\)[^\\\s:"']+/g,
    replace: (_m, prefix: string) => `${prefix}[user]`,
  },
];

export function redact(input: string): string {
  let out = input;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace as (m: string) => string);
  }
  return out;
}

/** Redact and cap length so a runaway log can't blow up a critic call. */
export function redactAndTruncate(input: string, maxChars = 8_000): string {
  const redacted = redact(input);
  if (redacted.length <= maxChars) return redacted;
  const head = redacted.slice(0, Math.floor(maxChars * 0.7));
  const tail = redacted.slice(-Math.floor(maxChars * 0.2));
  const omitted = redacted.length - head.length - tail.length;
  return `${head}\n...[${omitted} chars truncated]...\n${tail}`;
}

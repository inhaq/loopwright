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

/**
 * Redact and cap length so a runaway log can't blow up a critic call.
 *
 * Structure-aware (inspired by pi's harness `truncate.ts`): when the content
 * has line structure — diffs, build/test output — the head is snapped back to
 * the last line boundary within budget and the tail forward to the next one, so
 * the critic never reasons over a line cut mid-token. The elision marker
 * reports how much (chars and lines) was dropped. A single very long line with
 * no boundaries falls back to a hard head/tail char slice.
 */
export function redactAndTruncate(input: string, maxChars = 8_000): string {
  const redacted = redact(input);
  if (redacted.length <= maxChars) return redacted;

  const headBudget = Math.floor(maxChars * 0.7);
  const tailBudget = Math.floor(maxChars * 0.2);

  // Head: take the budget, then trim back to the last complete line.
  let head = redacted.slice(0, headBudget);
  const headNl = head.lastIndexOf("\n");
  if (headNl > 0) head = head.slice(0, headNl);

  // Tail: take the budget from the end, then trim forward to start of a line.
  let tail = redacted.slice(redacted.length - tailBudget);
  const tailNl = tail.indexOf("\n");
  if (tailNl >= 0 && tailNl < tail.length - 1) tail = tail.slice(tailNl + 1);

  const omittedChars = redacted.length - head.length - tail.length;
  if (omittedChars <= 0) return redacted; // budgets overlapped; nothing to drop

  const omittedLines =
    redacted.slice(head.length, redacted.length - tail.length).split("\n").length - 1;
  const linesPart = omittedLines > 0 ? ` / ${omittedLines} lines` : "";

  return `${head}\n...[${omittedChars} chars${linesPart} truncated]...\n${tail}`;
}

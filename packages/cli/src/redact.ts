/**
 * Redaction and size-capping applied to everything before it is written to the event log.
 * The log must never become a second copy of the user's secrets.
 *
 * NOTE: the token patterns mirror .claude/hooks/block-dangerous.mjs (a dev-time script that
 * cannot import from this package). Keep the two lists in sync.
 */

export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|github_pat_[A-Za-z0-9_]{40,}/g },
  { name: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "stripe-live-key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    name: "private-key",
    re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g,
  },
  { name: "bearer-token", re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g },
];

/** `SOME_API_KEY=value` / `password: value` style assignments: keep the name, drop the value. */
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passwd|password|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi;

/** Object keys whose values are always dropped, whatever they contain. */
const SECRET_KEY = /(?:api[_-]?key|secret|token|passwd|password|credential|authorization|private[_-]?key)/i;

export const LIMITS = {
  /** Strings inside tool input/output. */
  string: 16 * 1024,
  /** File text and diffs. */
  text: 64 * 1024,
  /** Nesting depth / array length / object keys kept when sanitizing structured values. */
  depth: 6,
  items: 50,
  keys: 60,
} as const;

export function redactString(input: string): string {
  let out = input;
  for (const { name, re } of SECRET_PATTERNS) out = out.replace(re, `[REDACTED:${name}]`);
  out = out.replace(ASSIGNMENT, (match, key: string, sep: string, value: string) =>
    value.startsWith("[REDACTED") ? match : `${key}${sep}[REDACTED]`,
  );
  return out;
}

export interface Capped {
  text: string;
  truncated: boolean;
}

/** Cut a string to `max` UTF-16 units, appending a marker that says how much was dropped. */
export function capString(input: string, max: number): Capped {
  if (input.length <= max) return { text: input, truncated: false };
  const dropped = input.length - max;
  return { text: `${input.slice(0, max)}\n…[truncated ${dropped} chars]`, truncated: true };
}

/** Redact first, then cap, so a secret straddling the cut is never partially exposed. */
export function safeText(input: string, max: number): Capped {
  return capString(redactString(input), max);
}

/** Deep-sanitize an arbitrary JSON-like value: redact strings, drop secret-named keys, cap size. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return safeText(value, LIMITS.string).text;
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (depth >= LIMITS.depth) return "[max depth]";
  if (Array.isArray(value)) {
    const items = value.slice(0, LIMITS.items).map((v) => sanitize(v, depth + 1));
    if (value.length > LIMITS.items) items.push(`[${value.length - LIMITS.items} more items]`);
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, v] of entries.slice(0, LIMITS.keys)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitize(v, depth + 1);
    }
    if (entries.length > LIMITS.keys) out["…"] = `[${entries.length - LIMITS.keys} more keys]`;
    return out;
  }
  return String(value);
}

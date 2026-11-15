import { createHash } from "node:crypto";
import type { ArdEvent } from "@ard/schema";
import { diffFromTexts, parseUnifiedDiff, redactString, type DiffLine } from "@ard/core";

/**
 * The text a summary is made from, and the ONLY thing that leaves the machine. It is built from events that were already
 * redacted when recorded, redacted once more here, size-capped, and shown to the person before anything is sent.
 * Pictures are never included (only a note that one exists).
 */
export const DEFAULT_MAX_DIGEST_CHARS = 48_000;

const MAX_OUTPUT_CHARS = 600; // per command output stream
const MAX_DIFF_LINES = 30;
const MAX_LINE_CHARS = 160;
const MAX_ENTRY_CHARS = 3_000;

export interface DigestStats {
  /** Events in the session. */
  events: number;
  /** Events that appear in the digest (some, like successful tool completions, add nothing). */
  included: number;
  /** Events left out only because the digest would be too long. */
  omitted: number;
  screenshots: number;
  chars: number;
}

export interface Digest {
  text: string;
  /** SHA-256 of `text`: lets the server check that what is sent is exactly what the person saw. */
  sha256: string;
  stats: DigestStats;
}

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`);
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

function diffLines(event: Extract<ArdEvent, { type: "file_change" }>): DiffLine[] {
  if (event.patch) return parseUnifiedDiff(event.patch).filter((l) => l.kind === "add" || l.kind === "del");
  if (event.operation === "delete") return [];
  return diffFromTexts(event.oldText, event.newText).filter((l) => l.kind === "add" || l.kind === "del");
}

function describe(event: ArdEvent): string | null {
  switch (event.type) {
    case "session_start":
      return `Session started (${event.capture}${event.model ? `, model ${event.model}` : ""}${event.argv ? `, command: ${flat(event.argv.join(" "))}` : ""})`;
    case "session_end":
      return `Session ended${event.exitCode !== undefined && event.exitCode !== null ? ` (exit code ${event.exitCode})` : ""}${event.reason ? ` (${event.reason})` : ""}`;
    case "tool_use": {
      if (event.phase === "post" && event.ok !== false) return null;
      if (event.phase === "post") return `Tool ${event.toolName} FAILED${event.error ? `: ${cut(flat(event.error), 300)}` : ""}`;
      const input = event.input as Record<string, unknown> | undefined;
      const hint = input && typeof input === "object" ? input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.path : undefined;
      return `Tool ${event.toolName}${typeof hint === "string" ? `: ${cut(flat(hint), 200)}` : ""}`;
    }
    case "command": {
      const parts = [`$ ${cut(flat(event.command), 300)}`, event.exitCode !== undefined && event.exitCode !== null ? `exit ${event.exitCode}` : "exit unknown"];
      if (event.interrupted) parts.push("interrupted");
      const lines = [parts.join("  ")];
      if (event.stdout) lines.push(`  stdout: ${cut(event.stdout.trim(), MAX_OUTPUT_CHARS)}`);
      if (event.stderr) lines.push(`  stderr: ${cut(event.stderr.trim(), MAX_OUTPUT_CHARS)}`);
      return lines.join("\n");
    }
    case "file_change": {
      const lines = diffLines(event);
      const added = lines.filter((l) => l.kind === "add").length;
      const removed = lines.filter((l) => l.kind === "del").length;
      const shown = lines.slice(0, MAX_DIFF_LINES).map((l) => `  ${l.kind === "add" ? "+" : "-"} ${cut(l.text, MAX_LINE_CHARS)}`);
      if (lines.length > MAX_DIFF_LINES) shown.push(`  … ${lines.length - MAX_DIFF_LINES} more changed lines`);
      return [`File ${event.operation}: ${event.path} (+${added} -${removed})${event.tool ? ` via ${event.tool}` : ""}`, ...shown].join("\n");
    }
    case "approval": {
      const scope = event.targetSessionId ? "Session review" : "Action decision";
      return `${scope}: ${event.decision} by ${event.decidedBy ?? "unknown"}${event.note ? ` — "${cut(flat(event.note), 200)}"` : ""}${event.ruleIds?.length ? ` (rules: ${event.ruleIds.join(", ")})` : ""}`;
    }
    case "screenshot":
      return `[a screenshot was attached${event.caption ? `: "${cut(flat(event.caption), 120)}"` : ""}; the image is not included]`;
  }
}

/** Build the digest of a session's events (in order). Never throws on odd events. */
export function buildDigest(events: ArdEvent[], options: { maxChars?: number } = {}): Digest {
  const max = Math.max(2_000, options.maxChars ?? DEFAULT_MAX_DIGEST_CHARS);
  const entries: string[] = [];
  let screenshots = 0;
  for (const event of events) {
    if (event.type === "screenshot") screenshots++;
    let line: string | null = null;
    try {
      line = describe(event);
    } catch {
      line = null; // an event we cannot describe is skipped, not fatal
    }
    if (line) entries.push(cut(line, MAX_ENTRY_CHARS));
  }

  const total = entries.reduce((sum, e) => sum + e.length + 1, 0);
  let body: string;
  let omitted = 0;
  if (total <= max) {
    body = entries.join("\n");
  } else {
    // Keep the beginning (what was asked and started) and, more of, the end (how it finished).
    const headBudget = Math.floor(max * 0.4);
    const tailBudget = Math.floor(max * 0.6) - 120;
    const head: string[] = [];
    let used = 0;
    for (const e of entries) {
      if (used + e.length + 1 > headBudget) break;
      head.push(e);
      used += e.length + 1;
    }
    const tail: string[] = [];
    used = 0;
    for (let i = entries.length - 1; i >= head.length; i--) {
      const e = entries[i]!;
      if (used + e.length + 1 > tailBudget) break;
      tail.unshift(e);
      used += e.length + 1;
    }
    omitted = entries.length - head.length - tail.length;
    body = [...head, `[… ${omitted} event${omitted === 1 ? "" : "s"} omitted to keep this short …]`, ...tail].join("\n");
  }

  const first = events[0];
  const header = first ? `Agent: ${first.agent}\nStarted: ${first.ts}\nEvents: ${events.length}` : "Agent: unknown\nEvents: 0";
  // Redact once more; and make sure recorded text can never close the tag the prompt wraps this in.
  const text = redactString(`${header}\n\n${body}`).replace(/<\/session/gi, "<\\/session");
  return {
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    stats: { events: events.length, included: entries.length - omitted, omitted, screenshots, chars: text.length },
  };
}

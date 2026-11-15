/** Pure helpers that shape stored data for the review UI. No I/O, so they are easy to test. */

export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Split a unified diff (`git diff` output) into typed lines. The leading +/-/space marker is removed from add/del/ctx lines. */
export function parseUnifiedDiff(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let inHunk = false;
  for (const raw of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("@@")) {
      inHunk = true;
      lines.push({ kind: "hunk", text: raw });
    } else if (!inHunk) {
      if (raw !== "") lines.push({ kind: "meta", text: raw }); // diff --git, index, ---/+++ headers
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1) });
    } else if (raw.startsWith("\\")) {
      lines.push({ kind: "meta", text: raw }); // "\ No newline at end of file"
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "ctx", text: raw.slice(1) });
    } else if (raw !== "") {
      lines.push({ kind: "ctx", text: raw });
    }
  }
  return lines;
}

const LCS_LIMIT = 400;

/** A line diff of two texts (an Edit's old and new string). Falls back to "all removed, all added" for large inputs. */
export function diffFromTexts(oldText: string | undefined, newText: string | undefined): DiffLine[] {
  const a = oldText ? oldText.replace(/\r\n/g, "\n").split("\n") : [];
  const b = newText ? newText.replace(/\r\n/g, "\n").split("\n") : [];
  if (a.length === 0 || b.length === 0 || a.length > LCS_LIMIT || b.length > LCS_LIMIT) {
    return [...a.map((text): DiffLine => ({ kind: "del", text })), ...b.map((text): DiffLine => ({ kind: "add", text }))];
  }
  // Longest common subsequence table, then walk it to emit ctx/del/add in order.
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i++]! });
    } else {
      out.push({ kind: "add", text: b[j++]! });
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  return { added, removed };
}

/** "1m 05s", "12s", "340ms". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

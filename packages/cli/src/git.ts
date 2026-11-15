import { execFileSync } from "node:child_process";
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Run git and return stdout, or null on any failure (not a repo, no commits, ...). */
export function git(args: string[], cwd: string, input?: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      input,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function isGitRepo(cwd: string): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], cwd)?.trim() === "true";
}

export function gitHead(cwd: string): string | null {
  return git(["rev-parse", "--verify", "-q", "HEAD"], cwd)?.trim() || null;
}

function splitZ(out: string | null): string[] {
  return out ? out.split("\0").filter((s) => s !== "") : [];
}

/** Untracked, non-ignored files (paths relative to cwd). Ignored files are invisible to this. */
export function untrackedFiles(cwd: string): string[] {
  return splitZ(git(["ls-files", "--others", "--exclude-standard", "-z"], cwd));
}

export interface Snapshot {
  /** Commit-ish to diff against: working-tree state at snapshot time. Null when the repo has no commits yet. */
  base: string | null;
  untracked: Set<string>;
}

/**
 * Capture "what the tree looked like before the agent ran" without touching it:
 * `git stash create` writes a commit object for the current tracked changes and changes nothing
 * else (no ref, no working-tree edits). With a clean tree it prints nothing, so HEAD is the base.
 */
export function takeSnapshot(cwd: string): Snapshot | null {
  if (!isGitRepo(cwd)) return null;
  const head = gitHead(cwd);
  const stash = head ? git(["stash", "create"], cwd)?.trim() : null;
  return { base: stash || head, untracked: new Set(untrackedFiles(cwd)) };
}

export interface FileDelta {
  path: string;
  operation: "create" | "modify" | "delete";
  /** Unified diff for tracked files. */
  patch?: string;
  /** Full text of a newly created untracked file. */
  newText?: string;
}

function readTextFile(path: string, maxBytes: number): string | undefined {
  try {
    if (statSync(path).size > maxBytes) return undefined;
    const buf = readFileSync(path);
    return buf.includes(0) ? undefined : buf.toString("utf8"); // skip binaries
  } catch {
    return undefined;
  }
}

export interface ChangesOptions {
  /** Path prefixes (relative to cwd) to ignore, e.g. ard's own data folder, which must never record itself. */
  exclude?: string[];
  maxFiles?: number;
}

/** Everything that changed since `snapshot`. Capped at `maxFiles` files. */
export function changesSince(snapshot: Snapshot, cwd: string, options: ChangesOptions = {}): FileDelta[] {
  const maxFiles = options.maxFiles ?? 200;
  const excluded = (path: string) => (options.exclude ?? []).some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const deltas: FileDelta[] = [];

  if (snapshot.base) {
    // -z name-status output: STATUS\0path\0 (renames/copies: STATUS\0old\0new\0)
    // --relative keeps paths relative to cwd, matching `ls-files` output below, even when cwd is a subfolder.
    const parts = splitZ(git(["diff", "--name-status", "-z", "--no-renames", "--relative", snapshot.base], cwd));
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]!;
      const path = parts[i + 1]!;
      if (excluded(path)) continue;
      const operation = status.startsWith("A") ? "create" : status.startsWith("D") ? "delete" : "modify";
      const patch = git(["diff", "--no-color", "--no-ext-diff", "--relative", snapshot.base, "--", path], cwd) ?? undefined;
      deltas.push(patch === undefined ? { path, operation } : { path, operation, patch });
      if (deltas.length >= maxFiles) return deltas;
    }
  }

  for (const path of untrackedFiles(cwd)) {
    if (snapshot.untracked.has(path) || excluded(path)) continue;
    const text = readTextFile(join(cwd, path), 1024 * 1024);
    deltas.push(text === undefined ? { path, operation: "create" } : { path, operation: "create", newText: text });
    if (deltas.length >= maxFiles) break;
  }
  return deltas;
}

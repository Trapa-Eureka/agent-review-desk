import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ARD_DIR, EVENTS_FILE } from "@ard/schema";

/**
 * Nearest ancestor of `start` that contains `.ard` or `.git` (a directory, or a file for git
 * worktrees). Every worktree therefore gets its own `.ard`. Falls back to `start` itself.
 */
export function findProjectRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ARD_DIR)) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** Where ard stores its data for a project. `ARD_DIR` env var overrides it (used by tests and CI). */
export function ardDirFor(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ARD_DIR;
  return override && override !== "" ? resolve(override) : join(root, ARD_DIR);
}

export function eventsPathFor(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(ardDirFor(root, env), EVENTS_FILE);
}

/** Project-relative path with forward slashes when `p` is inside `root`; otherwise `p` unchanged. */
export function toProjectPath(p: string, root: string): string {
  if (!p) return p;
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return p;
  return rel.split(sep).join("/");
}

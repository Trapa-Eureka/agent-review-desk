import { openProject, type Repository } from "@ard/core";

export interface Project {
  root: string;
  repo: Repository;
  eventsPath: string;
}

export function projectRoot(): string {
  const root = process.env.ARD_PROJECT_DIR;
  if (!root) throw new Error("ARD_PROJECT_DIR is not set. Start the UI with `ard review`.");
  return root;
}

/**
 * Run `fn` against the project's database, after importing any events recorded since the last request.
 * A connection per request is cheap (WAL, local file) and means no stale singleton survives a reload.
 */
export function withProject<T>(fn: (project: Project) => T): T {
  const root = projectRoot();
  const { repo, eventsPath } = openProject(root);
  try {
    return fn({ root, repo, eventsPath });
  } finally {
    repo.close();
  }
}

/** Parse a small JSON request body, or return null if it is missing, too large or not an object. */
export async function readJsonBody(request: Request, maxBytes = 8 * 1024): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseDecision(body: Record<string, unknown>): { decision: "approved" | "rejected"; note: string | null } | null {
  const { decision, note } = body;
  if (decision !== "approved" && decision !== "rejected") return null;
  if (note !== undefined && note !== null && typeof note !== "string") return null;
  return { decision, note: typeof note === "string" && note.trim() !== "" ? note : null };
}

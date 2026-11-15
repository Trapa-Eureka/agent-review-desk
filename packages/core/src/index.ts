export * from "./paths.js";
export * from "./redact.js";
export * from "./jsonl.js";
export * from "./db.js";
export * from "./repository.js";
export * from "./policy.js";
export * from "./config.js";
export * from "./approvals.js";
export * from "./view.js";

import { join } from "node:path";
import { openDb } from "./db.js";
import { ardDirFor, eventsPathFor } from "./paths.js";
import { Repository } from "./repository.js";

/** File name of the SQLite database inside the ard data folder. */
export const DB_FILE = "data.db";

/** Where the SQLite database of a project lives (next to its events.jsonl). */
export function dbPathFor(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(ardDirFor(root, env), DB_FILE);
}

/** Open the project's database and import any events appended to its JSONL log since the last time. */
export function openProject(root: string, env: NodeJS.ProcessEnv = process.env): { repo: Repository; eventsPath: string } {
  const repo = new Repository(openDb(dbPathFor(root, env)));
  const eventsPath = eventsPathFor(root, env);
  repo.ingest(eventsPath);
  return { repo, eventsPath };
}
export * from "./screenshots.js";

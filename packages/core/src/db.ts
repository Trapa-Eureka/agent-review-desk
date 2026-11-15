import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const nodeRequire = createRequire(import.meta.url);
let DatabaseSyncCtor: typeof DatabaseSync | undefined;

/**
 * Load Node's built-in SQLite (no native dependency to compile on the user's machine).
 * It still prints an "ExperimentalWarning" on load; for a CLI that runs inside an agent's terminal
 * that is noise, so the one warning is filtered while the module loads. Needs Node >= 22.13.
 */
function loadSqlite(): typeof DatabaseSync {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning?.message ?? "";
    if (/sqlite/i.test(message)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    DatabaseSyncCtor = (nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSync }).DatabaseSync;
  } catch (error) {
    throw new Error(`This version of Node has no built-in SQLite (node:sqlite). Use Node 22.13 or newer. (${(error as Error).message})`);
  } finally {
    process.emitWarning = original;
  }
  return DatabaseSyncCtor;
}

/**
 * Schema migrations, applied in order. NEVER edit an entry that has shipped: append a new one.
 * The applied count is stored in `PRAGMA user_version`.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE events (
    seq                INTEGER PRIMARY KEY AUTOINCREMENT,
    id                 TEXT NOT NULL UNIQUE,
    ts                 TEXT NOT NULL,
    session_id         TEXT NOT NULL,
    wrapper_session_id TEXT,
    agent              TEXT NOT NULL,
    cwd                TEXT NOT NULL,
    type               TEXT NOT NULL,
    tool_name          TEXT,
    tool_use_id        TEXT,
    phase              TEXT,
    path               TEXT,
    command            TEXT,
    exit_code          INTEGER,
    decision           TEXT,
    target_event_id    TEXT,
    target_session_id  TEXT,
    data               TEXT NOT NULL
  );
  CREATE INDEX events_session ON events (session_id, seq);
  CREATE INDEX events_type ON events (type);
  CREATE INDEX events_target_event ON events (target_event_id);
  CREATE INDEX events_target_session ON events (target_session_id);

  -- How far into each JSONL file we have read, so ingesting is incremental.
  CREATE TABLE ingest_state (
    file   TEXT PRIMARY KEY,
    offset INTEGER NOT NULL
  );

  -- Pre-approval requests: a hook waits on a row until a human decides it in the review UI.
  CREATE TABLE approval_requests (
    id                 TEXT PRIMARY KEY,
    created_at         TEXT NOT NULL,
    expires_at         TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    session_id         TEXT NOT NULL,
    tool_use_event_id  TEXT NOT NULL,
    tool_use_id        TEXT,
    tool_name          TEXT NOT NULL,
    summary            TEXT NOT NULL,
    input_json         TEXT NOT NULL,
    rules_json         TEXT NOT NULL,
    decided_at         TEXT,
    decided_by         TEXT,
    note               TEXT
  );
  CREATE INDEX approval_requests_status ON approval_requests (status, created_at);
  CREATE INDEX approval_requests_session ON approval_requests (session_id);
  `,
];

/** Run `fn` inside an immediate (write-locking) transaction. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw error;
  }
}

function migrate(db: Db): void {
  const current = () => Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (current() >= MIGRATIONS.length) return;
  transaction(db, () => {
    // Re-check under the write lock: another process may have migrated while we waited.
    for (let v = current(); v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  });
}

/**
 * Open (creating if needed) the project database. WAL mode lets the review UI and any number of
 * hook processes read and write at the same time; `busy_timeout` makes writers wait instead of failing.
 * The file is created owner-only, because it holds code and command output.
 */
export function openDb(path: string): Db {
  const Ctor = loadSqlite();
  const isNew = path !== ":memory:" && !existsSync(path);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Ctor(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  if (isNew) chmodSync(path, 0o600);
  migrate(db);
  return db;
}

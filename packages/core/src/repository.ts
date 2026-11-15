import { closeSync, openSync, readSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { validateEvent, type ArdEvent } from "@ard/schema";
import { transaction, type Db } from "./db.js";

/**
 * The only module that knows SQL. Everything else talks to this class, so the cloud tier can swap
 * in a Postgres implementation of the same methods without touching callers.
 */

export interface SessionReview {
  decision: "approved" | "rejected";
  by: string | null;
  note: string | null;
  at: string;
}

export interface SessionSummary {
  id: string;
  agent: string;
  cwd: string;
  /** Set when the session ran inside an `ard run` wrapper. */
  wrapperSessionId: string | null;
  startedAt: string;
  lastEventAt: string;
  ended: boolean;
  counts: { events: number; toolCalls: number; commands: number; fileChanges: number };
  /** Approval requests currently waiting for a human. */
  pendingApprovals: number;
  /** Calls that were rejected by a reviewer, by policy, or by timeout. */
  blocked: number;
  /** The latest whole-session review decision, if any. */
  review: SessionReview | null;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRequest {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  sessionId: string;
  /** The `pre` tool_use event of the call that is waiting. */
  toolUseEventId: string;
  toolUseId: string | null;
  toolName: string;
  /** One-line, redacted description of what the agent wants to do. */
  summary: string;
  /** Redacted tool input. */
  input: unknown;
  rules: Array<{ id: string; description: string }>;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

export interface NewApprovalRequest {
  sessionId: string;
  toolUseEventId: string;
  toolUseId?: string;
  toolName: string;
  summary: string;
  input: unknown;
  rules: Array<{ id: string; description: string }>;
  /** How long the hook is willing to wait. */
  timeoutMs: number;
  now?: Date;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v ?? "");
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);

export interface IngestResult {
  /** New events stored. */
  added: number;
  /** Lines skipped because they were not valid events. */
  invalid: number;
}

export class Repository {
  constructor(readonly db: Db) {}

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- events

  /** Store one event. Returns false when an event with the same id already exists. */
  insertEvent(event: ArdEvent): boolean {
    const e = event as ArdEvent & Record<string, unknown>;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO events
          (id, ts, session_id, wrapper_session_id, agent, cwd, type, tool_name, tool_use_id, phase, path, command, exit_code, decision, target_event_id, target_session_id, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.ts,
        event.sessionId,
        event.wrapperSessionId ?? null,
        event.agent,
        event.cwd,
        event.type,
        event.type === "tool_use" ? event.toolName : null,
        (e.toolUseId as string | undefined) ?? null,
        event.type === "tool_use" ? event.phase : null,
        event.type === "file_change" ? event.path : null,
        event.type === "command" ? event.command : null,
        event.type === "command" || event.type === "session_end" ? (event.exitCode ?? null) : null,
        event.type === "approval" ? event.decision : null,
        event.type === "approval" ? (event.targetEventId ?? null) : null,
        event.type === "approval" ? (event.targetSessionId ?? null) : null,
        JSON.stringify(event),
      );
    return Number(result.changes) > 0;
  }

  /**
   * Import events appended to a JSONL file since the last call. Incremental (remembers the byte
   * offset), safe to call from many processes at once, and tolerant of a half-written last line
   * (it is left for the next call). Re-importing an event is harmless: ids are unique.
   */
  ingest(eventsPath: string): IngestResult {
    let size: number;
    try {
      size = statSync(eventsPath).size;
    } catch {
      return { added: 0, invalid: 0 };
    }
    const quickOffset = this.readOffset(eventsPath);
    if (size === quickOffset) return { added: 0, invalid: 0 };

    return transaction(this.db, () => {
      let offset = this.readOffset(eventsPath); // re-read under the write lock
      if (size < offset) offset = 0; // the file was replaced or truncated: start over (duplicates are ignored)
      if (size === offset) return { added: 0, invalid: 0 };

      const buffer = Buffer.alloc(size - offset);
      const fd = openSync(eventsPath, "r");
      try {
        let read = 0;
        while (read < buffer.length) {
          const n = readSync(fd, buffer, read, buffer.length - read, offset + read);
          if (n === 0) break;
          read += n;
        }
        const complete = buffer.subarray(0, read).lastIndexOf(0x0a) + 1; // bytes up to and including the last newline
        let added = 0;
        let invalid = 0;
        if (complete > 0) {
          for (const raw of buffer.subarray(0, complete).toString("utf8").split("\n")) {
            const line = raw.trim();
            if (line === "") continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              invalid++;
              continue;
            }
            const result = validateEvent(parsed);
            if (!result.ok) {
              invalid++;
              continue;
            }
            if (this.insertEvent(result.event)) added++;
          }
        }
        this.db.prepare("INSERT INTO ingest_state (file, offset) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset").run(eventsPath, offset + complete);
        return { added, invalid };
      } finally {
        closeSync(fd);
      }
    });
  }

  private readOffset(file: string): number {
    const row = this.db.prepare("SELECT offset FROM ingest_state WHERE file = ?").get(file) as Row | undefined;
    return row ? num(row.offset) : 0;
  }

  /** Every event of a session, oldest first (including approval decisions about it). */
  sessionEvents(sessionId: string): ArdEvent[] {
    return (this.db.prepare("SELECT data FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as Row[]).map((r) => JSON.parse(str(r.data)) as ArdEvent);
  }

  eventById(id: string): ArdEvent | null {
    const row = this.db.prepare("SELECT data FROM events WHERE id = ?").get(id) as Row | undefined;
    return row ? (JSON.parse(str(row.data)) as ArdEvent) : null;
  }

  // -------------------------------------------------------------- sessions

  /** Most recently active sessions first. */
  listSessions(limit = 200, now: Date = new Date()): SessionSummary[] {
    return this.summaries("", [], limit, now);
  }

  getSession(sessionId: string, now: Date = new Date()): SessionSummary | null {
    return this.summaries("AND session_id = ?", [sessionId], 1, now)[0] ?? null;
  }

  private summaries(where: string, params: string[], limit: number, now: Date): SessionSummary[] {
    // Approval events are *about* a session; they must not count as the session's own activity or set its agent.
    const rows = this.db
      .prepare(
        `SELECT session_id,
                MIN(ts) AS started_at, MAX(ts) AS last_at, MAX(seq) AS last_seq,
                MAX(agent) AS agent, MAX(cwd) AS cwd, MAX(wrapper_session_id) AS wrapper,
                COUNT(*) AS events,
                SUM(type = 'tool_use' AND phase = 'pre') AS tool_calls,
                SUM(type = 'command') AS commands,
                SUM(type = 'file_change') AS file_changes,
                MAX(type = 'session_end') AS ended
           FROM events WHERE type != 'approval' ${where}
          GROUP BY session_id ORDER BY last_seq DESC LIMIT ?`,
      )
      .all(...params, limit) as Row[];
    if (rows.length === 0) return [];

    const pending = new Map<string, number>();
    for (const r of this.db.prepare("SELECT session_id, COUNT(*) AS n FROM approval_requests WHERE status = 'pending' AND expires_at > ? GROUP BY session_id").all(now.toISOString()) as Row[]) {
      pending.set(str(r.session_id), num(r.n));
    }
    const blocked = new Map<string, number>();
    for (const r of this.db.prepare("SELECT session_id, COUNT(*) AS n FROM events WHERE type = 'approval' AND decision = 'rejected' AND target_event_id IS NOT NULL GROUP BY session_id").all() as Row[]) {
      blocked.set(str(r.session_id), num(r.n));
    }
    const reviews = new Map<string, SessionReview>();
    for (const r of this.db.prepare("SELECT target_session_id AS sid, decision, data, ts FROM events WHERE type = 'approval' AND target_session_id IS NOT NULL ORDER BY seq").all() as Row[]) {
      const data = JSON.parse(str(r.data)) as { decidedBy?: string; note?: string };
      reviews.set(str(r.sid), { decision: str(r.decision) as SessionReview["decision"], by: data.decidedBy ?? null, note: data.note ?? null, at: str(r.ts) });
    }

    return rows.map((r) => {
      const id = str(r.session_id);
      return {
        id,
        agent: str(r.agent),
        cwd: str(r.cwd),
        wrapperSessionId: strOrNull(r.wrapper),
        startedAt: str(r.started_at),
        lastEventAt: str(r.last_at),
        ended: num(r.ended) > 0,
        counts: { events: num(r.events), toolCalls: num(r.tool_calls), commands: num(r.commands), fileChanges: num(r.file_changes) },
        pendingApprovals: pending.get(id) ?? 0,
        blocked: blocked.get(id) ?? 0,
        review: reviews.get(id) ?? null,
      };
    });
  }

  // ------------------------------------------------------------- approvals

  createApprovalRequest(input: NewApprovalRequest): ApprovalRequest {
    const now = input.now ?? new Date();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO approval_requests
          (id, created_at, expires_at, status, session_id, tool_use_event_id, tool_use_id, tool_name, summary, input_json, rules_json)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, now.toISOString(), new Date(now.getTime() + input.timeoutMs).toISOString(), input.sessionId, input.toolUseEventId, input.toolUseId ?? null, input.toolName, input.summary, JSON.stringify(input.input ?? null), JSON.stringify(input.rules));
    return this.getApprovalRequest(id)!;
  }

  getApprovalRequest(id: string): ApprovalRequest | null {
    const row = this.db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as Row | undefined;
    return row ? toRequest(row) : null;
  }

  /** Requests whose deadline passed while nobody answered become `expired` first, so they never look actionable. */
  listApprovalRequests(options: { status?: ApprovalStatus; limit?: number; now?: Date } = {}): ApprovalRequest[] {
    const now = (options.now ?? new Date()).toISOString();
    this.db.prepare("UPDATE approval_requests SET status = 'expired', decided_at = ?, decided_by = 'timeout' WHERE status = 'pending' AND expires_at <= ?").run(now, now);
    const rows = options.status
      ? this.db.prepare("SELECT * FROM approval_requests WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(options.status, options.limit ?? 200)
      : this.db.prepare("SELECT * FROM approval_requests ORDER BY created_at DESC LIMIT ?").all(options.limit ?? 200);
    return (rows as Row[]).map(toRequest);
  }

  requestsForSession(sessionId: string): ApprovalRequest[] {
    return (this.db.prepare("SELECT * FROM approval_requests WHERE session_id = ? ORDER BY created_at").all(sessionId) as Row[]).map(toRequest);
  }

  /**
   * Record a human decision. Succeeds only while the request is still pending, so a late click on an
   * already-expired or already-decided request can never flip the outcome the hook already acted on.
   */
  decideApprovalRequest(id: string, decision: "approved" | "rejected", by: string, note: string | null, now: Date = new Date()): boolean {
    const result = this.db
      .prepare("UPDATE approval_requests SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND status = 'pending' AND expires_at > ?")
      .run(decision, now.toISOString(), by, note, id, now.toISOString());
    return Number(result.changes) > 0;
  }

  /** Mark a still-pending request expired (the hook gave up waiting). Returns false if it was already decided. */
  expireApprovalRequest(id: string, now: Date = new Date()): boolean {
    const result = this.db.prepare("UPDATE approval_requests SET status = 'expired', decided_at = ?, decided_by = 'timeout' WHERE id = ? AND status = 'pending'").run(now.toISOString(), id);
    return Number(result.changes) > 0;
  }
}

function toRequest(row: Row): ApprovalRequest {
  return {
    id: str(row.id),
    createdAt: str(row.created_at),
    expiresAt: str(row.expires_at),
    status: str(row.status) as ApprovalStatus,
    sessionId: str(row.session_id),
    toolUseEventId: str(row.tool_use_event_id),
    toolUseId: strOrNull(row.tool_use_id),
    toolName: str(row.tool_name),
    summary: str(row.summary),
    input: JSON.parse(str(row.input_json)) as unknown,
    rules: JSON.parse(str(row.rules_json)) as ApprovalRequest["rules"],
    decidedAt: strOrNull(row.decided_at),
    decidedBy: strOrNull(row.decided_by),
    note: strOrNull(row.note),
  };
}

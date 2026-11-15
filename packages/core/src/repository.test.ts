import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArdEvent } from "@ard/schema";
import { MIGRATIONS, openDb } from "./db.js";
import { appendEvent, baseFields } from "./jsonl.js";
import { Repository } from "./repository.js";
import { makeTmp } from "./testutil.js";

const ctx = (sessionId: string, agent = "claude-code") => ({ sessionId, agent, cwd: "/p" });
const start = (sid: string): ArdEvent => ({ ...baseFields(ctx(sid)), type: "session_start", capture: "hook" });
const end = (sid: string): ArdEvent => ({ ...baseFields(ctx(sid)), type: "session_end", capture: "hook" });
const pre = (sid: string, tool = "Bash"): ArdEvent => ({ ...baseFields(ctx(sid)), type: "tool_use", phase: "pre", toolName: tool });
const cmd = (sid: string, command: string, exitCode = 0): ArdEvent => ({ ...baseFields(ctx(sid)), type: "command", command, exitCode });
const change = (sid: string, path: string): ArdEvent => ({ ...baseFields(ctx(sid)), type: "file_change", path, operation: "modify", newText: "x" });
const approval = (sid: string, extra: { targetEventId?: string; targetSessionId?: string; decision: "approved" | "rejected"; decidedBy?: string; note?: string }): ArdEvent => ({ ...baseFields(ctx(sid, "ard-review")), type: "approval", ...extra });

function setup() {
  const tmp = makeTmp("ard-repo-test-");
  const eventsPath = join(tmp.dir, ".ard", "events.jsonl");
  const dbPath = join(tmp.dir, ".ard", "data.db");
  const repo = new Repository(openDb(dbPath));
  return { ...tmp, eventsPath, dbPath, repo, cleanup: () => { repo.close(); tmp.cleanup(); } };
}

test("openDb creates an owner-only database, applies migrations once and is reopenable", () => {
  const t = setup();
  try {
    assert.equal(statSync(t.dbPath).mode & 0o777, 0o600);
    const version = (t.repo.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    assert.equal(version, MIGRATIONS.length);
    const again = new Repository(openDb(t.dbPath));
    assert.equal((again.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
    assert.equal((again.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    again.close();
  } finally {
    t.cleanup();
  }
});

test("ingest is incremental: only new lines are read each time", () => {
  const t = setup();
  try {
    appendEvent(t.eventsPath, start("s1"));
    appendEvent(t.eventsPath, cmd("s1", "ls"));
    assert.deepEqual(t.repo.ingest(t.eventsPath), { added: 2, invalid: 0 });
    assert.deepEqual(t.repo.ingest(t.eventsPath), { added: 0, invalid: 0 });
    appendEvent(t.eventsPath, end("s1"));
    assert.deepEqual(t.repo.ingest(t.eventsPath), { added: 1, invalid: 0 });
    assert.equal(t.repo.sessionEvents("s1").length, 3);
  } finally {
    t.cleanup();
  }
});

test("ingest leaves a half-written last line for the next call", () => {
  const t = setup();
  try {
    appendEvent(t.eventsPath, start("s1"));
    const full = JSON.stringify(cmd("s1", "ls"));
    appendFileSync(t.eventsPath, full.slice(0, 20)); // a hook is mid-write
    assert.equal(t.repo.ingest(t.eventsPath).added, 1);
    appendFileSync(t.eventsPath, `${full.slice(20)}\n`);
    assert.equal(t.repo.ingest(t.eventsPath).added, 1);
    assert.equal(t.repo.sessionEvents("s1").length, 2);
  } finally {
    t.cleanup();
  }
});

test("ingest counts invalid lines and keeps going; duplicates and re-imports are harmless", () => {
  const t = setup();
  try {
    const e = start("s1");
    appendEvent(t.eventsPath, e);
    appendFileSync(t.eventsPath, "this is not json\n");
    appendFileSync(t.eventsPath, `${JSON.stringify({ v: 1, type: "nope" })}\n`);
    appendEvent(t.eventsPath, e); // same id again
    appendEvent(t.eventsPath, cmd("s1", "ls"));
    assert.deepEqual(t.repo.ingest(t.eventsPath), { added: 2, invalid: 2 });
    assert.equal(t.repo.sessionEvents("s1").length, 2);
  } finally {
    t.cleanup();
  }
});

test("a truncated or replaced log is re-read from the start without duplicating events", () => {
  const t = setup();
  try {
    const a = start("s1");
    appendEvent(t.eventsPath, a);
    appendEvent(t.eventsPath, cmd("s1", "ls"));
    t.repo.ingest(t.eventsPath);
    writeFileSync(t.eventsPath, ""); // user cleared the log
    appendEvent(t.eventsPath, a);
    const result = t.repo.ingest(t.eventsPath);
    assert.equal(result.added, 0);
    assert.equal(t.repo.sessionEvents("s1").length, 2);
  } finally {
    t.cleanup();
  }
});

test("two connections ingesting the same log never duplicate events", () => {
  const t = setup();
  try {
    for (let i = 0; i < 20; i++) appendEvent(t.eventsPath, cmd("s1", `cmd ${i}`));
    const other = new Repository(openDb(t.dbPath));
    const a = t.repo.ingest(t.eventsPath);
    const b = other.ingest(t.eventsPath);
    assert.equal(a.added + b.added, 20);
    assert.equal(t.repo.sessionEvents("s1").length, 20);
    other.close();
  } finally {
    t.cleanup();
  }
});

test("listSessions summarizes activity per session, newest first", () => {
  const t = setup();
  try {
    const s1 = [start("s1"), pre("s1"), cmd("s1", "ls"), pre("s1", "Write"), change("s1", "a.ts"), change("s1", "b.ts"), end("s1")];
    const s2 = [start("s2"), pre("s2"), cmd("s2", "pwd")];
    for (const e of [...s1, ...s2]) t.repo.insertEvent(e);

    const [newest, older] = t.repo.listSessions();
    assert.equal(newest!.id, "s2");
    assert.equal(older!.id, "s1");
    assert.deepEqual(older!.counts, { events: 7, toolCalls: 2, commands: 1, fileChanges: 2 });
    assert.equal(older!.ended, true);
    assert.equal(newest!.ended, false);
    assert.equal(older!.agent, "claude-code");
    assert.equal(older!.review, null);
  } finally {
    t.cleanup();
  }
});

test("approval events describe a session without becoming part of its activity", () => {
  const t = setup();
  try {
    const pre1 = pre("s1");
    for (const e of [start("s1"), pre1, cmd("s1", "ls")]) t.repo.insertEvent(e);
    t.repo.insertEvent(approval("s1", { targetEventId: pre1.id, decision: "rejected", decidedBy: "policy" }));
    t.repo.insertEvent(approval("s1", { targetSessionId: "s1", decision: "rejected", decidedBy: "reviewer", note: "no" }));
    t.repo.insertEvent(approval("s1", { targetSessionId: "s1", decision: "approved", decidedBy: "reviewer", note: "fine after all" }));

    const s = t.repo.getSession("s1")!;
    assert.equal(s.counts.events, 3, "approval events are not session activity");
    assert.equal(s.agent, "claude-code", "reviewer events must not change the agent");
    assert.equal(s.blocked, 1, "only call-level rejections count as blocked");
    assert.equal(s.review?.decision, "approved", "latest session review wins");
    assert.equal(s.review?.note, "fine after all");
    assert.equal(t.repo.sessionEvents("s1").length, 6, "the timeline still includes the decisions");
  } finally {
    t.cleanup();
  }
});

test("getSession returns null for an unknown session", () => {
  const t = setup();
  try {
    assert.equal(t.repo.getSession("nope"), null);
    assert.deepEqual(t.repo.listSessions(), []);
  } finally {
    t.cleanup();
  }
});

const newRequest = (over: Partial<Parameters<Repository["createApprovalRequest"]>[0]> = {}) => ({
  sessionId: "s1",
  toolUseEventId: "evt-1",
  toolName: "Bash",
  summary: "Bash: git push --force",
  input: { command: "git push --force" },
  rules: [{ id: "git-force-push", description: "force push" }],
  timeoutMs: 60_000,
  ...over,
});

test("approval requests are created pending and can be listed", () => {
  const t = setup();
  try {
    const now = new Date("2026-11-15T10:00:00Z");
    const r = t.repo.createApprovalRequest(newRequest({ now }));
    assert.equal(r.status, "pending");
    assert.equal(r.expiresAt, "2026-11-15T10:01:00.000Z");
    assert.deepEqual(r.input, { command: "git push --force" });
    assert.equal(t.repo.listApprovalRequests({ status: "pending", now }).length, 1);
    assert.equal(t.repo.getSession("s1"), null, "requests alone do not create a session");
  } finally {
    t.cleanup();
  }
});

test("a request can be decided exactly once", () => {
  const t = setup();
  try {
    const now = new Date("2026-11-15T10:00:00Z");
    const r = t.repo.createApprovalRequest(newRequest({ now }));
    assert.equal(t.repo.decideApprovalRequest(r.id, "approved", "me", "ok", now), true);
    assert.equal(t.repo.decideApprovalRequest(r.id, "rejected", "me", null, now), false, "a second decision must not flip the first");
    const after = t.repo.getApprovalRequest(r.id)!;
    assert.deepEqual([after.status, after.decidedBy, after.note], ["approved", "me", "ok"]);
  } finally {
    t.cleanup();
  }
});

test("an overdue request expires and can no longer be approved", () => {
  const t = setup();
  try {
    const created = new Date("2026-11-15T10:00:00Z");
    const later = new Date("2026-11-15T10:05:00Z");
    const r = t.repo.createApprovalRequest(newRequest({ now: created }));
    assert.equal(t.repo.decideApprovalRequest(r.id, "approved", "me", null, later), false, "late click must not approve");
    const listed = t.repo.listApprovalRequests({ status: "pending", now: later });
    assert.equal(listed.length, 0);
    const after = t.repo.getApprovalRequest(r.id)!;
    assert.deepEqual([after.status, after.decidedBy], ["expired", "timeout"]);
  } finally {
    t.cleanup();
  }
});

test("pending requests show up in the session summary until they expire", () => {
  const t = setup();
  try {
    const now = new Date("2026-11-15T10:00:00Z");
    t.repo.insertEvent(start("s1"));
    t.repo.createApprovalRequest(newRequest({ now }));
    assert.equal(t.repo.getSession("s1", now)!.pendingApprovals, 1);
    assert.equal(t.repo.getSession("s1", new Date("2026-11-15T11:00:00Z"))!.pendingApprovals, 0);
  } finally {
    t.cleanup();
  }
});

test("expireApprovalRequest only affects pending requests", () => {
  const t = setup();
  try {
    const r = t.repo.createApprovalRequest(newRequest());
    assert.equal(t.repo.decideApprovalRequest(r.id, "rejected", "me", null), true);
    assert.equal(t.repo.expireApprovalRequest(r.id), false);
    assert.equal(t.repo.getApprovalRequest(r.id)!.status, "rejected");
  } finally {
    t.cleanup();
  }
});

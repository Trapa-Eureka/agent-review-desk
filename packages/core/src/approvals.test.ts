import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openDb } from "./db.js";
import { decideRequest, recordApprovalEvent, reviewSession, waitForDecision } from "./approvals.js";
import { baseFields, appendEvent } from "./jsonl.js";
import { Repository } from "./repository.js";
import { fake, makeTmp, readEvents } from "./testutil.js";

function setup() {
  const tmp = makeTmp("ard-approvals-");
  const repo = new Repository(openDb(join(tmp.dir, ".ard", "data.db")));
  const eventsPath = join(tmp.dir, ".ard", "events.jsonl");
  return { ...tmp, repo, eventsPath, cleanup: () => { repo.close(); tmp.cleanup(); } };
}

const request = (over = {}) => ({
  sessionId: "s1",
  toolUseEventId: "evt-1",
  toolName: "Bash",
  summary: "Bash: git push --force",
  input: { command: "git push --force" },
  rules: [{ id: "git-force-push", description: "force push" }],
  timeoutMs: 60_000,
  ...over,
});

test("waitForDecision returns as soon as a human decides", async () => {
  const t = setup();
  try {
    const r = t.repo.createApprovalRequest(request());
    let polls = 0;
    const outcome = await waitForDecision(t.repo, r.id, {
      pollMs: 1,
      sleep: async () => {
        polls++;
        if (polls === 3) t.repo.decideApprovalRequest(r.id, "approved", "alice", "looks fine");
      },
    });
    assert.deepEqual(outcome, { status: "approved", decidedBy: "alice", note: "looks fine" });
    assert.equal(polls, 3);
  } finally {
    t.cleanup();
  }
});

test("waitForDecision reports a rejection with the reviewer's note", async () => {
  const t = setup();
  try {
    const r = t.repo.createApprovalRequest(request());
    t.repo.decideApprovalRequest(r.id, "rejected", "bob", "not on main");
    const outcome = await waitForDecision(t.repo, r.id, { sleep: async () => {} });
    assert.deepEqual(outcome, { status: "rejected", decidedBy: "bob", note: "not on main" });
  } finally {
    t.cleanup();
  }
});

test("waitForDecision gives up at the deadline and marks the request expired", async () => {
  const t = setup();
  try {
    let clock = new Date("2026-11-15T10:00:00Z");
    const r = t.repo.createApprovalRequest(request({ timeoutMs: 10_000, now: clock }));
    const outcome = await waitForDecision(t.repo, r.id, {
      now: () => clock,
      sleep: async () => {
        clock = new Date(clock.getTime() + 4_000);
      },
    });
    assert.equal(outcome.status, "expired");
    assert.equal(outcome.decidedBy, "timeout");
    assert.equal(t.repo.getApprovalRequest(r.id)!.status, "expired");
  } finally {
    t.cleanup();
  }
});

test("a decision that lands before the deadline check wins over expiry", async () => {
  const t = setup();
  try {
    let clock = new Date("2026-11-15T10:00:00Z");
    const r = t.repo.createApprovalRequest(request({ timeoutMs: 5_000, now: clock }));
    let first = true;
    const outcome = await waitForDecision(t.repo, r.id, {
      now: () => clock,
      sleep: async () => {
        if (first) {
          first = false;
          t.repo.decideApprovalRequest(r.id, "approved", "alice", null, clock); // decided just in time
          clock = new Date(clock.getTime() + 60_000);
        }
      },
    });
    assert.equal(outcome.status, "approved");
  } finally {
    t.cleanup();
  }
});

test("decideRequest records the decision in the database AND appends an approval event to the log", () => {
  const t = setup();
  try {
    const r = t.repo.createApprovalRequest(request());
    const result = decideRequest(t.repo, t.eventsPath, "/proj", r.id, "approved", { by: "alice", note: "ok to push" });
    assert.equal(result.ok, true);
    const logged = readEvents(t.dir).filter((e) => e.type === "approval");
    assert.equal(logged.length, 1);
    const event = logged[0]!;
    assert.equal(event.type === "approval" && event.decision, "approved");
    assert.equal(event.type === "approval" && event.targetEventId, "evt-1");
    assert.equal(event.type === "approval" && event.requestId, r.id);
    assert.deepEqual(event.type === "approval" && event.ruleIds, ["git-force-push"]);
    assert.equal(event.sessionId, "s1");
    assert.equal(t.repo.eventById(event.id)?.id, event.id, "indexed immediately for the UI");
  } finally {
    t.cleanup();
  }
});

test("decideRequest cannot overwrite an earlier decision or approve an expired request", () => {
  const t = setup();
  try {
    const r = t.repo.createApprovalRequest(request());
    assert.equal(decideRequest(t.repo, t.eventsPath, "/proj", r.id, "rejected", { by: "alice" }).ok, true);
    const second = decideRequest(t.repo, t.eventsPath, "/proj", r.id, "approved", { by: "mallory" });
    assert.deepEqual(second, { ok: false, reason: "already-decided", status: "rejected" });
    assert.equal(readEvents(t.dir).filter((e) => e.type === "approval").length, 1, "no event for the refused decision");

    const old = t.repo.createApprovalRequest(request({ now: new Date("2026-01-01T00:00:00Z"), timeoutMs: 1000 }));
    const late = decideRequest(t.repo, t.eventsPath, "/proj", old.id, "approved", { by: "alice" });
    assert.equal(late.ok, false);
    assert.equal(late.ok === false && late.reason, "expired");

    assert.deepEqual(decideRequest(t.repo, t.eventsPath, "/proj", "no-such-id", "approved"), { ok: false, reason: "not-found" });
  } finally {
    t.cleanup();
  }
});

test("notes are redacted and capped, and the reviewer name is bounded", () => {
  const t = setup();
  try {
    const r = t.repo.createApprovalRequest(request());
    const result = decideRequest(t.repo, t.eventsPath, "/proj", r.id, "approved", { by: "x".repeat(500), note: `use key ${fake.anthropic} ${"y".repeat(5000)}` });
    assert.equal(result.ok, true);
    const event = result.ok ? result.event : null;
    assert.equal(event!.note!.includes(fake.anthropic), false);
    assert.ok(event!.note!.length < 1100);
    assert.equal(event!.decidedBy!.length, 64);
    assert.equal(decideRequest(t.repo, t.eventsPath, "/proj", t.repo.createApprovalRequest(request()).id, "approved", { by: "   " }).ok, true);
  } finally {
    t.cleanup();
  }
});

test("reviewSession records a whole-session decision; the latest one wins; unknown sessions are refused", () => {
  const t = setup();
  try {
    t.repo.insertEvent({ ...baseFields({ sessionId: "s1", agent: "claude-code", cwd: "/p" }), type: "session_start", capture: "hook" });
    assert.equal(reviewSession(t.repo, t.eventsPath, "/proj", "nope", "approved"), null);

    const first = reviewSession(t.repo, t.eventsPath, "/proj", "s1", "rejected", { by: "alice", note: "needs rework" })!;
    assert.equal(first.targetSessionId, "s1");
    assert.equal(first.targetEventId, undefined);
    assert.equal(t.repo.getSession("s1")!.review?.decision, "rejected");

    reviewSession(t.repo, t.eventsPath, "/proj", "s1", "approved", { by: "alice", note: "fixed" });
    const review = t.repo.getSession("s1")!.review!;
    assert.deepEqual([review.decision, review.note, review.by], ["approved", "fixed", "alice"]);
  } finally {
    t.cleanup();
  }
});

test("recordApprovalEvent writes the log first (source of truth) and indexes it", () => {
  const t = setup();
  try {
    appendEvent(t.eventsPath, { ...baseFields({ sessionId: "s1", agent: "claude-code", cwd: "/p" }), type: "session_start", capture: "hook" });
    const event = recordApprovalEvent(t.repo, t.eventsPath, { sessionId: "s1", cwd: "/p", decision: "rejected", decidedBy: "policy", targetEventId: "evt-9", ruleIds: ["delete-ard-data"] });
    const log = readEvents(t.dir);
    assert.equal(log.length, 2);
    assert.equal(log[1]!.id, event.id);
    assert.equal(event.agent, "ard-review");
    assert.equal(t.repo.ingest(t.eventsPath).added, 1, "the session_start line was not indexed yet; the approval was, and is not duplicated");
  } finally {
    t.cleanup();
  }
});

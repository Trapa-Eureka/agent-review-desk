import { test } from "node:test";
import assert from "node:assert/strict";
import { filterByAgent, hasLinks, linkedSessions, summarizeByAgent } from "./agents.js";
import type { SessionSummary } from "./repository.js";

let n = 0;
function session(over: Partial<SessionSummary> & { agent: string }): SessionSummary {
  n++;
  return {
    id: `s${n}`,
    cwd: "/p",
    wrapperSessionId: null,
    startedAt: `2026-11-15T10:${String(n).padStart(2, "0")}:00.000Z`,
    lastEventAt: `2026-11-15T10:${String(n).padStart(2, "0")}:30.000Z`,
    ended: true,
    counts: { events: 5, toolCalls: 2, commands: 3, fileChanges: 1 },
    pendingApprovals: 0,
    blocked: 0,
    review: null,
    ...over,
  };
}
const review = (decision: "approved" | "rejected") => ({ decision, at: "2026-11-15T11:00:00Z", by: "reviewer", note: null });

test("the overview adds up each agent's sessions, work, reviews, blocked calls and waiting requests", () => {
  const rows = summarizeByAgent([
    session({ agent: "claude-code", review: review("approved") }),
    session({ agent: "claude-code", review: review("rejected"), blocked: 2 }),
    session({ agent: "claude-code", pendingApprovals: 1 }),
    session({ agent: "codex", counts: { events: 9, toolCalls: 4, commands: 7, fileChanges: 0 } }),
  ]);
  const claude = rows.find((r) => r.agent === "claude-code")!;
  assert.deepEqual({ ...claude, lastEventAt: undefined }, { agent: "claude-code", sessions: 3, toolCalls: 6, commands: 9, fileChanges: 3, approved: 1, rejected: 1, notReviewed: 1, blocked: 2, waiting: 1, lastEventAt: undefined });
  const codex = rows.find((r) => r.agent === "codex")!;
  assert.deepEqual([codex.sessions, codex.commands, codex.fileChanges, codex.notReviewed], [1, 7, 0, 1]);
});

test("the most recently active agent comes first, and ties are alphabetical", () => {
  const rows = summarizeByAgent([
    session({ agent: "old", lastEventAt: "2026-11-01T00:00:00Z" }),
    session({ agent: "recent", lastEventAt: "2026-11-15T00:00:00Z" }),
    session({ agent: "b-tie", lastEventAt: "2026-11-10T00:00:00Z" }),
    session({ agent: "a-tie", lastEventAt: "2026-11-10T00:00:00Z" }),
  ]);
  assert.deepEqual(rows.map((r) => r.agent), ["recent", "a-tie", "b-tie", "old"]);
  assert.equal(rows.find((r) => r.agent === "recent")!.lastEventAt, "2026-11-15T00:00:00Z");
  assert.deepEqual(summarizeByAgent([]), []);
});

test("an agent's last activity is its newest session's, not its first", () => {
  const rows = summarizeByAgent([session({ agent: "x", lastEventAt: "2026-11-01T00:00:00Z" }), session({ agent: "x", lastEventAt: "2026-11-09T00:00:00Z" }), session({ agent: "x", lastEventAt: "2026-11-05T00:00:00Z" })]);
  assert.equal(rows[0]!.lastEventAt, "2026-11-09T00:00:00Z");
});

test("filtering by agent keeps only that agent; an empty filter keeps everything; an unknown agent gives an empty list", () => {
  const all = [session({ agent: "codex" }), session({ agent: "claude-code" }), session({ agent: "codex" })];
  assert.equal(filterByAgent(all, "codex").length, 2);
  assert.equal(filterByAgent(all, "claude-code").length, 1);
  assert.equal(filterByAgent(all, "").length, 3);
  assert.equal(filterByAgent(all, null).length, 3);
  assert.equal(filterByAgent(all, undefined).length, 3);
  assert.deepEqual(filterByAgent(all, "no-such-agent"), []);
  assert.deepEqual(filterByAgent(all, "CODEX"), [], "agent names are matched exactly");
});

test("a wrapper session and the hook sessions that ran inside it are linked from both sides", () => {
  const wrapper = session({ agent: "codex" });
  const hookA = session({ agent: "codex", wrapperSessionId: wrapper.id });
  const hookB = session({ agent: "codex", wrapperSessionId: wrapper.id });
  const other = session({ agent: "claude-code" });
  const all = [other, hookB, wrapper, hookA];

  const fromWrapper = linkedSessions(all, wrapper);
  assert.equal(fromWrapper.wrapper, null);
  assert.deepEqual(fromWrapper.hooks.map((s) => s.id), [hookA.id, hookB.id], "oldest first");
  assert.equal(hasLinks(fromWrapper), true);

  const fromHook = linkedSessions(all, hookA);
  assert.equal(fromHook.wrapper?.id, wrapper.id);
  assert.deepEqual(fromHook.hooks, []);
  assert.equal(hasLinks(fromHook), true);

  assert.equal(hasLinks(linkedSessions(all, other)), false);
});

test("a link to a wrapper that is not in the list, or to itself, is not a link", () => {
  const orphan = session({ agent: "codex", wrapperSessionId: "gone" });
  assert.equal(linkedSessions([orphan], orphan).wrapper, null);
  assert.equal(hasLinks(linkedSessions([orphan], orphan)), false);
  const self = session({ agent: "codex" });
  self.wrapperSessionId = self.id;
  const links = linkedSessions([self], self);
  assert.deepEqual([links.wrapper, links.hooks], [null, []]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentNameFor, runWrapped } from "./run.js";
import { cleanEnv, fake, git, makeGitRepo, makeTmp, readEvents } from "./testutil.js";
import type { FileChangeEvent } from "@ard/schema";

/** Run `script` (JavaScript) as the "agent" inside `dir`. */
async function runAgent(dir: string, script: string, extraEnv: Record<string, string> = {}) {
  const lines: string[] = [];
  const code = await runWrapped({ argv: [process.execPath, "-e", script], cwd: dir, env: cleanEnv(extraEnv), log: (l) => lines.push(l) });
  return { code, lines, events: readEvents(dir) };
}
const changes = (events: ReturnType<typeof readEvents>) => events.filter((e): e is FileChangeEvent => e.type === "file_change");

test("records session_start, file changes and session_end, and returns the agent's exit code", async () => {
  const repo = makeGitRepo();
  try {
    const { code, events, lines } = await runAgent(
      repo.dir,
      "const fs=require('fs');fs.appendFileSync('tracked.txt','added line\\n');fs.writeFileSync('new.txt','hello');process.exit(3)",
    );
    assert.equal(code, 3);
    assert.deepEqual(events.map((e) => e.type), ["session_start", "file_change", "file_change", "session_end"]);

    const start = events[0]!;
    assert.equal(start.type === "session_start" && start.capture, "wrapper");
    assert.equal(start.agent, "node");
    assert.equal(new Set(events.map((e) => e.sessionId)).size, 1, "one session id for the whole run");

    const byPath = Object.fromEntries(changes(events).map((c) => [c.path, c]));
    assert.equal(byPath["tracked.txt"]!.operation, "modify");
    assert.match(byPath["tracked.txt"]!.patch ?? "", /\+added line/);
    assert.equal(byPath["new.txt"]!.operation, "create");
    assert.equal(byPath["new.txt"]!.newText, "hello");

    const end = events[events.length - 1]!;
    assert.equal(end.type === "session_end" && end.exitCode, 3);
    assert.ok(lines.some((l) => /recorded \(2 file changes\)/.test(l)), lines.join("|"));
  } finally {
    repo.cleanup();
  }
});

test("never records its own .ard folder as the agent's work, even when .ard is not git-ignored", async () => {
  const repo = makeGitRepo(); // note: no .gitignore, so .ard/ is visible to git
  try {
    const first = await runAgent(repo.dir, "require('fs').writeFileSync('work.txt','x')");
    assert.deepEqual(changes(first.events).map((c) => c.path), ["work.txt"]);
    // A second run sees .ard/events.jsonl from the first run already on disk and growing.
    const second = await runAgent(repo.dir, "require('fs').writeFileSync('work2.txt','y')");
    const secondSession = second.events.filter((e) => e.sessionId === second.events[second.events.length - 1]!.sessionId);
    assert.deepEqual(changes(secondSession).map((c) => c.path), ["work2.txt"]);
    assert.equal(JSON.stringify(second.events).includes(".ard/"), false);
  } finally {
    repo.cleanup();
  }
});

test("records deleted files", async () => {
  const repo = makeGitRepo();
  try {
    const { events } = await runAgent(repo.dir, "require('fs').unlinkSync('tracked.txt')");
    const [change] = changes(events);
    assert.equal(change!.operation, "delete");
    assert.equal(change!.path, "tracked.txt");
  } finally {
    repo.cleanup();
  }
});

test("only reports what the agent changed, not changes that were already in the working tree", async () => {
  const repo = makeGitRepo();
  try {
    writeFileSync(join(repo.dir, "dirty.txt"), "base\n");
    git(repo.dir, "add", "dirty.txt");
    git(repo.dir, "commit", "-q", "-m", "add dirty");
    appendFileSync(join(repo.dir, "dirty.txt"), "first (before the run)\n"); // uncommitted edit made by the human
    appendFileSync(join(repo.dir, "tracked.txt"), "human edit\n"); // another uncommitted edit
    writeFileSync(join(repo.dir, "human-untracked.txt"), "mine"); // untracked file that already existed

    const { events } = await runAgent(repo.dir, "require('fs').appendFileSync('dirty.txt','second (by the agent)\\n')");
    const list = changes(events);
    assert.deepEqual(list.map((c) => c.path), ["dirty.txt"]);
    assert.match(list[0]!.patch ?? "", /\+second \(by the agent\)/);
    // The earlier line may appear as unchanged context, but it must not be shown as an addition by the agent.
    assert.doesNotMatch(list[0]!.patch ?? "", /^\+first/m, "pre-existing edit must not be attributed to the agent");
    assert.doesNotMatch(list[0]!.patch ?? "", /human edit/);
  } finally {
    repo.cleanup();
  }
});

test("a run that changes nothing records no file_change events", async () => {
  const repo = makeGitRepo();
  try {
    const { events, code } = await runAgent(repo.dir, "0");
    assert.equal(code, 0);
    assert.deepEqual(events.map((e) => e.type), ["session_start", "session_end"]);
  } finally {
    repo.cleanup();
  }
});

test("diffs and new files are redacted", async () => {
  const repo = makeGitRepo();
  try {
    const { events } = await runAgent(repo.dir, `const fs=require('fs');fs.writeFileSync('config.txt','key=${fake.anthropic}');fs.appendFileSync('tracked.txt','token ${fake.github}\\n')`);
    const text = JSON.stringify(events);
    assert.equal(text.includes(fake.anthropic), false);
    assert.equal(text.includes(fake.github), false);
  } finally {
    repo.cleanup();
  }
});

test("works from a subfolder; paths are relative to the project root so they are stable across sessions", async () => {
  const repo = makeGitRepo();
  try {
    const sub = join(repo.dir, "pkg");
    mkdirSync(sub);
    writeFileSync(join(sub, "inner.txt"), "a\n");
    git(repo.dir, "add", "pkg/inner.txt");
    git(repo.dir, "commit", "-q", "-m", "inner");
    const lines: string[] = [];
    await runWrapped({ argv: [process.execPath, "-e", "require('fs').appendFileSync('inner.txt','b\\n')"], cwd: sub, env: cleanEnv(), log: (l) => lines.push(l) });
    const list = changes(readEvents(repo.dir));
    assert.deepEqual(list.map((c) => c.path), ["pkg/inner.txt"]);
  } finally {
    repo.cleanup();
  }
});

test("outside a git repository the run is still recorded, without file changes", async () => {
  const plain = makeTmp("ard-nogit-");
  try {
    const { events, lines, code } = await runAgent(plain.dir, "require('fs').writeFileSync('x.txt','1')");
    assert.equal(code, 0);
    assert.deepEqual(events.map((e) => e.type), ["session_start", "session_end"]);
    assert.ok(lines.some((l) => /not a git repository/.test(l)));
  } finally {
    plain.cleanup();
  }
});

test("a command that cannot be started returns 127 and still closes the session", async () => {
  const repo = makeGitRepo();
  try {
    const lines: string[] = [];
    const code = await runWrapped({ argv: ["definitely-not-a-real-program-xyz"], cwd: repo.dir, env: cleanEnv(), log: (l) => lines.push(l) });
    assert.equal(code, 127);
    const events = readEvents(repo.dir);
    assert.deepEqual(events.map((e) => e.type), ["session_start", "session_end"]);
    assert.equal(events[1]!.type === "session_end" && events[1]!.exitCode, 127);
    assert.ok(lines.some((l) => /could not start/.test(l)));
  } finally {
    repo.cleanup();
  }
});

test("a signal-killed agent is recorded with its signal and a 128+n exit code", async () => {
  const repo = makeGitRepo();
  try {
    const { code, events } = await runAgent(repo.dir, "process.kill(process.pid,'SIGTERM'); setTimeout(()=>{},5000)");
    assert.equal(code, 128 + 15);
    const end = events[events.length - 1]!;
    assert.equal(end.type === "session_end" && end.signal, "SIGTERM");
    assert.equal(end.type === "session_end" && end.exitCode, null);
  } finally {
    repo.cleanup();
  }
});

test("the child receives ARD_SESSION_ID matching the recorded session", async () => {
  const repo = makeGitRepo();
  try {
    const { events } = await runAgent(repo.dir, "require('fs').writeFileSync('sid.txt', process.env.ARD_SESSION_ID || 'missing')");
    const created = changes(events).find((c) => c.path === "sid.txt");
    assert.equal(created!.newText, events[0]!.sessionId);
    assert.equal(readFileSync(join(repo.dir, "sid.txt"), "utf8"), events[0]!.sessionId);
  } finally {
    repo.cleanup();
  }
});

test("rejects an empty command line", async () => {
  await assert.rejects(() => runWrapped({ argv: [], cwd: process.cwd(), env: cleanEnv() }), /no command given/);
});

test("agentNameFor maps known programs", () => {
  assert.equal(agentNameFor("claude"), "claude-code");
  assert.equal(agentNameFor("/usr/local/bin/claude"), "claude-code");
  assert.equal(agentNameFor("codex"), "codex");
  assert.equal(agentNameFor("/opt/my-agent"), "my-agent");
});

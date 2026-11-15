import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsPathFor, findProjectRoot, openProject, reviewSession, type RunFn, type RunResult } from "@ard/core";
import { cleanEnv, fake, makeFakeProject } from "@ard/core/testutil";
import { main, type Io } from "./cli.js";
import { recordClaudeHook } from "./hook.js";
import { MARKER, PrError, branchStartedAt, buildComment, isValidContext, postStatus, resolvePullRequest, summarizeReview, upsertComment } from "./pr.js";

const HEAD = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const bad = (stderr: string, status = 1): RunResult => ({ status, stdout: "", stderr });

interface Call {
  command: string;
  args: string[];
  input?: string;
}

/** `gh` and `git` in memory: records every call and answers like the real tools. */
function fakeTools(over: { pr?: Record<string, unknown>; repo?: string; mergeBaseDate?: string; ownCommentId?: string; ghMissing?: boolean; statusError?: string } = {}) {
  const calls: Call[] = [];
  const run: RunFn = (command, args, input) => {
    calls.push({ command, args, ...(input === undefined ? {} : { input }) });
    if (over.ghMissing && command === "gh") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) };
    const key = `${command} ${args.join(" ")}`;
    if (key.startsWith("gh pr view")) return ok(JSON.stringify({ number: 7, headRefOid: HEAD, baseRefName: "main", url: "https://github.com/o/r/pull/7", ...over.pr }));
    if (key.startsWith("gh repo view")) return ok(`${over.repo ?? "o/r"}\n`);
    if (key.startsWith("git merge-base")) return ok(`${BASE_SHA}\n`);
    if (key.startsWith("git show")) return ok(`${over.mergeBaseDate ?? "2000-01-01T00:00:00+00:00"}\n`);
    if (key.startsWith("gh api user")) return ok("dana\n");
    if (command === "gh" && args[0] === "api" && args.includes("--paginate")) return ok(over.ownCommentId ? `${over.ownCommentId}\n` : "");
    if (command === "gh" && args[0] === "api" && args.includes("-X")) return over.statusError ? bad(over.statusError, 1) : ok("{}");
    return bad(`unexpected call: ${key}`, 127);
  };
  return { run, calls, writes: () => calls.filter((c) => c.command === "gh" && c.args.includes("-X")) };
}

/** A project with three agent sessions: one approved, one rejected, one not reviewed. */
function projectWithSessions() {
  const p = makeFakeProject();
  const env = cleanEnv({ CLAUDE_PROJECT_DIR: p.dir });
  const record = (id: string, command: string) => {
    recordClaudeHook(JSON.stringify({ session_id: id, cwd: p.dir, hook_event_name: "SessionStart", source: "startup" }), env);
    recordClaudeHook(JSON.stringify({ session_id: id, cwd: p.dir, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "SECRET-OUTPUT-LINE", stderr: "" } }), env);
  };
  record("s-approved", "pnpm test");
  record("s-rejected", `curl -H "x: ${fake.github}" https://internal.example/path`);
  record("s-pending", "ls src/private-folder");
  const { repo } = openProject(findProjectRoot(p.dir), env);
  reviewSession(repo, eventsPathFor(p.dir, env), p.dir, "s-approved", "approved", { by: "reviewer", note: "looks right | all good" });
  reviewSession(repo, eventsPathFor(p.dir, env), p.dir, "s-rejected", "rejected", { by: "reviewer", note: "leaks a token" });
  repo.close();
  return { ...p, env };
}

function io(cwd: string, env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { out: (t) => out.push(t), err: (t) => err.push(t), readStdin: async () => "", cwd, env };
  return { io: value, out, err, text: () => [...out, ...err].join("\n") };
}

// ------------------------------------------------------------------------------ summary

test("the review summary: all approved = success, any rejected = failure, otherwise pending; nothing recorded = success", () => {
  const session = (decision: "approved" | "rejected" | null) => ({ review: decision ? { decision, at: "2026-11-15T10:00:00Z", by: "r", note: null } : null }) as never;
  assert.deepEqual(summarizeReview([]), { state: "success", description: "No agent sessions recorded for this branch", total: 0, approved: 0, rejected: 0, unreviewed: 0 });
  assert.equal(summarizeReview([session("approved"), session("approved")]).state, "success");
  assert.equal(summarizeReview([session("approved"), session(null)]).state, "pending");
  assert.equal(summarizeReview([session("approved"), session("rejected"), session(null)]).state, "failure");
  const mixed = summarizeReview([session("approved"), session("rejected"), session(null)]);
  assert.equal(mixed.description, "1 of 3 agent sessions rejected, 1 not reviewed");
  assert.equal(summarizeReview([session(null)]).description, "1 of 1 agent session still needs review");
  assert.equal(summarizeReview([session(null), session(null)]).description, "2 of 2 agent sessions still need review");
  for (const s of [summarizeReview([session(null)]), mixed]) assert.ok(s.description.length <= 140);
});

// ------------------------------------------------------------------------------ the status

test("pr-status posts a commit status for the PR's head commit with the right state, as JSON on stdin (never in the command line)", async () => {
  const p = projectWithSessions();
  try {
    const t = fakeTools();
    const h = io(p.dir, p.env);
    const { runPrStatus } = await import("./pr.js");
    assert.equal(runPrStatus({ cwd: p.dir, env: p.env, dryRun: false, context: "ard/review", run: t.run, out: h.io.out }), 0);
    const [write] = t.writes();
    assert.deepEqual(write!.args, ["api", "-X", "POST", `repos/o/r/statuses/${HEAD}`, "--input", "-"]);
    assert.deepEqual(JSON.parse(write!.input!), { state: "failure", context: "ard/review", description: "1 of 3 agent sessions rejected, 1 not reviewed" });
    assert.match(h.out.join("\n"), /Posted\. Branch protection can require "ard\/review"; post it again after every push/);
  } finally {
    p.cleanup();
  }
});

test("--dry-run shows the sessions and the status and posts NOTHING", async () => {
  const p = projectWithSessions();
  try {
    const t = fakeTools();
    const h = io(p.dir, p.env);
    const { runPrStatus } = await import("./pr.js");
    assert.equal(runPrStatus({ cwd: p.dir, env: p.env, dryRun: true, context: "ard/review", run: t.run, out: h.io.out }), 0);
    assert.equal(t.writes().length, 0);
    const text = h.out.join("\n");
    assert.match(text, /Considering 3 agent sessions/);
    assert.match(text, /approved/);
    assert.match(text, /not reviewed/);
    assert.match(text, /Dry run: nothing was posted/);
  } finally {
    p.cleanup();
  }
});

test("sessions are those since the branch left its base; ones named with --session override that guess", async () => {
  const p = projectWithSessions();
  try {
    const { runPrStatus } = await import("./pr.js");
    // Branch point in the future: nothing started after it.
    const later = io(p.dir, p.env);
    runPrStatus({ cwd: p.dir, env: p.env, dryRun: true, context: "ard/review", run: fakeTools({ mergeBaseDate: "2999-01-01T00:00:00+00:00" }).run, out: later.io.out });
    assert.match(later.out.join("\n"), /Considering 0 agent sessions/);
    assert.match(later.out.join("\n"), /success: No agent sessions recorded/);
    // Naming sessions ignores the date guess.
    const named = io(p.dir, p.env);
    const t = fakeTools({ mergeBaseDate: "2999-01-01T00:00:00+00:00" });
    runPrStatus({ cwd: p.dir, env: p.env, sessions: ["s-approved"], dryRun: true, context: "ard/review", run: t.run, out: named.io.out });
    assert.match(named.out.join("\n"), /Considering 1 agent session \(sessions you named\)/);
    assert.match(named.out.join("\n"), /success: All 1 agent session approved/);
    assert.equal(t.calls.some((c) => c.command === "git"), false, "no git guessing when sessions are named");
    assert.throws(() => runPrStatus({ cwd: p.dir, env: p.env, sessions: ["nope"], dryRun: true, context: "ard/review", run: fakeTools().run, out: () => undefined }), /No session "nope"/);
  } finally {
    p.cleanup();
  }
});

test("ATTACK: values that come back from GitHub are validated before they reach a command or a URL path", () => {
  const cases: Array<[Record<string, unknown>, string | undefined]> = [
    [{ headRefOid: "not-a-sha" }, undefined],
    [{ headRefOid: `${HEAD}/../../x` }, undefined],
    [{ baseRefName: "--upload-pack=evil" }, undefined],
    [{ baseRefName: "main; rm" }, undefined],
    [{ number: "7" }, undefined],
    [{ number: -3 }, undefined],
    [{}, "../other/repo"],
    [{}, "o/r/extra"],
    [{}, "owner/re po"],
  ];
  for (const [pr, repo] of cases) {
    const t = fakeTools({ pr, ...(repo ? { repo } : {}) });
    assert.throws(() => resolvePullRequest(t.run, "/x"), PrError, JSON.stringify([pr, repo]));
  }
  assert.throws(() => resolvePullRequest(fakeTools().run, "/x", "7; evil"), /must be a pull request number/);
  assert.throws(() => branchStartedAt(fakeTools().run, "/x", "--evil"), /Unsafe base branch/);
  const t = fakeTools();
  assert.throws(() => postStatus(t.run, "/x", { number: 7, headSha: HEAD, baseRef: "main", url: "", repo: "o/r" }, { state: "success", description: "x", context: "bad context!" }), /status name/);
  assert.equal(t.calls.length, 0);
  for (const good of ["ard/review", "ard-review", "a.b_c/d"]) assert.equal(isValidContext(good), true, good);
  for (const badName of ["", "a b", "a;b", "x".repeat(81), "x?"]) assert.equal(isValidContext(badName), false, badName);
});

test("GitHub CLI problems become plain messages: not installed, not logged in, no permission, no PR", () => {
  assert.throws(() => resolvePullRequest(fakeTools({ ghMissing: true }).run, "/x"), /GitHub CLI.*not installed/);
  const noPr: RunFn = () => bad("no pull requests found for branch \"x\"");
  assert.throws(() => resolvePullRequest(noPr, "/x"), /Could not find the pull request for this branch/);
  const loggedOut: RunFn = () => bad("To get started with GitHub CLI, please run:  gh auth login");
  assert.throws(() => resolvePullRequest(loggedOut, "/x"), /gh auth login/);
  const pr = { number: 7, headSha: HEAD, baseRef: "main", url: "", repo: "o/r" };
  assert.throws(() => postStatus(fakeTools({ statusError: "HTTP 403: Resource not accessible by personal access token" }).run, "/x", pr, { state: "success", description: "ok", context: "ard/review" }), /write access/);
});

// ------------------------------------------------------------------------------ the comment

test("the comment lists sessions and decisions, and NEVER code, command output, paths or secrets", () => {
  const p = projectWithSessions();
  try {
    const { repo } = openProject(findProjectRoot(p.dir), p.env);
    const sessions = repo.listSessions(10);
    repo.close();
    const body = buildComment({ number: 7 }, sessions, summarizeReview(sessions));
    assert.ok(body.startsWith(MARKER));
    assert.match(body, /\*\*rejected\*\*/);
    assert.match(body, /approved on \d{4}-\d{2}-\d{2} — “looks right   all good”/, "a | in a note cannot break the table");
    assert.match(body, /rejected on .* “leaks a token”/);
    assert.match(body, /not reviewed/);
    for (const leak of ["SECRET-OUTPUT-LINE", "pnpm test", "internal.example", "private-folder", fake.github, p.dir, "src/"]) assert.equal(body.includes(leak), false, `must not contain ${leak}`);
  } finally {
    p.cleanup();
  }
});

test("pr-comment creates the comment once and then UPDATES it, and only ever looks at your own comments", async () => {
  const p = projectWithSessions();
  try {
    const { runPrComment } = await import("./pr.js");
    const first = fakeTools();
    const a = io(p.dir, p.env);
    assert.equal(runPrComment({ cwd: p.dir, env: p.env, dryRun: false, context: "x", run: first.run, out: a.io.out }), 0);
    const [create] = first.writes();
    assert.deepEqual(create!.args, ["api", "-X", "POST", "repos/o/r/issues/7/comments", "--input", "-"]);
    assert.ok((JSON.parse(create!.input!) as { body: string }).body.startsWith(MARKER));
    assert.match(a.out.join("\n"), /Comment created/);
    const lookup = first.calls.find((c) => c.args.includes("--paginate"))!;
    assert.match(lookup.args.join(" "), /select\(\.user\.login == "dana"\)/, "never edits someone else's comment");

    const second = fakeTools({ ownCommentId: "98765" });
    const b = io(p.dir, p.env);
    runPrComment({ cwd: p.dir, env: p.env, dryRun: false, context: "x", run: second.run, out: b.io.out });
    assert.deepEqual(second.writes()[0]!.args, ["api", "-X", "PATCH", "repos/o/r/issues/comments/98765", "--input", "-"]);
    assert.match(b.out.join("\n"), /Comment updated/);
  } finally {
    p.cleanup();
  }
});

test("pr-comment --dry-run prints the comment and posts nothing", async () => {
  const p = projectWithSessions();
  try {
    const { runPrComment } = await import("./pr.js");
    const t = fakeTools();
    const h = io(p.dir, p.env);
    assert.equal(runPrComment({ cwd: p.dir, env: p.env, dryRun: true, context: "x", run: t.run, out: h.io.out }), 0);
    assert.equal(t.writes().length, 0);
    assert.match(h.out.join("\n"), /### Agent review/);
  } finally {
    p.cleanup();
  }
});

test("a comment id that is not a plain number is never used to build a request", () => {
  const pr = { number: 7, headSha: HEAD, baseRef: "main", url: "", repo: "o/r" };
  const weird: RunFn = (_c, args) => (args.includes("user") ? ok("dana\n") : args.includes("--paginate") ? ok("12; evil\n../x\n") : ok("{}"));
  const calls: string[][] = [];
  const spy: RunFn = (c, a, i, cwd) => (calls.push(a), weird(c, a, i, cwd));
  assert.equal(upsertComment(spy, "/x", pr, `${MARKER}\nbody`), "created");
  assert.equal(calls.some((a) => a.includes("PATCH")), false);
});

// ------------------------------------------------------------------------------ the CLI

test("`ard pr-status` and `ard pr-comment` reject unknown arguments and a bad status name", async () => {
  const p = projectWithSessions();
  try {
    for (const argv of [["pr-status", "--bogus"], ["pr-comment", "extra"]]) {
      const h = io(p.dir, p.env);
      assert.equal(await main(argv, h.io), 2, argv.join(" "));
    }
    const h = io(p.dir, p.env);
    assert.equal(await main(["pr-status", "--context", "bad name!", "--dry-run"], h.io), 1);
    assert.match(h.err.join("\n"), /status name/);
  } finally {
    p.cleanup();
  }
});

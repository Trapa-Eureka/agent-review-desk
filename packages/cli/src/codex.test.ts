import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Repository, dbPathFor, decideRequest, eventsPathFor, openDb, parseUnifiedDiff } from "@ard/core";
import { cleanEnv, fake, makeFakeProject, readEvents } from "@ard/core/testutil";
import { validateEvent, type ArdEvent } from "@ard/schema";
import { eventsFromCodexPayload, parseApplyPatch, type CodexHookPayload } from "./codex.js";
import { handleClaudeHook, handleHook, recordPayload } from "./hook.js";
import { CODEX_MAX_WAIT_SECONDS } from "./codex.js";

// The fixtures are payloads captured from a real Codex 0.169.0 session (paths and prompts cleaned).
const FIXTURES = fileURLToPath(new URL("../src/fixtures/codex/", import.meta.url));
const fixture = (name: string): CodexHookPayload => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as CodexHookPayload;
const INDEX = fileURLToPath(new URL("./index.js", import.meta.url));
const ROOT = "/proj";
const map = (payload: CodexHookPayload, env: NodeJS.ProcessEnv = cleanEnv()) => eventsFromCodexPayload(payload, ROOT, env);
const ofType = <T extends ArdEvent["type"]>(events: ArdEvent[], type: T) => events.filter((e): e is Extract<ArdEvent, { type: T }> => e.type === type);

test("every real captured payload maps to events that pass schema validation", () => {
  for (const name of ["session-start", "session-end", "pre-bash-echo", "post-bash-echo", "pre-bash-false", "post-bash-false", "post-bash-curl", "post-bash-write-file", "permission-request", "stop"]) {
    for (const event of map(fixture(name))) {
      const result = validateEvent(event);
      assert.equal(result.ok, true, `${name}: ${result.ok ? "" : result.error}`);
      assert.equal(event.agent, "codex");
    }
  }
});

test("SessionStart and SessionEnd", () => {
  const [start] = map(fixture("session-start"));
  assert.deepEqual({ type: start!.type, agent: start!.agent, session: start!.sessionId, startSource: (start as { startSource?: string }).startSource, model: (start as { model?: string }).model }, { type: "session_start", agent: "codex", session: "01a1dfe6-8864-7cb1-b356-1a8f825a6140", startSource: "startup", model: "gpt-6-luna" });
  const [end] = map(fixture("session-end"));
  assert.equal(end!.type, "session_end");
  assert.equal((end as { reason?: string }).reason, "other");
});

test("PreToolUse records the Bash call with its id and input", () => {
  const [pre] = ofType(map(fixture("pre-bash-echo")), "tool_use");
  assert.deepEqual({ phase: pre!.phase, tool: pre!.toolName, input: pre!.input, id: pre!.toolUseId }, { phase: "pre", tool: "Bash", input: { command: "echo hello" }, id: fixture("pre-bash-echo").tool_use_id });
});

test("PostToolUse: the output string becomes stdout; the exit code is UNKNOWN because Codex does not report it", () => {
  const events = map(fixture("post-bash-echo"));
  const [post] = ofType(events, "tool_use");
  const [command] = ofType(events, "command");
  assert.deepEqual({ phase: post!.phase, ok: post!.ok, id: post!.toolUseId }, { phase: "post", ok: true, id: fixture("post-bash-echo").tool_use_id });
  assert.deepEqual({ command: command!.command, stdout: command!.stdout, exitCode: command!.exitCode, id: command!.toolUseId }, { command: "echo hello", stdout: "hello\n", exitCode: null, id: fixture("post-bash-echo").tool_use_id });
  assert.equal(post!.output, undefined, "the output is recorded once, on the command event");
});

test("a FAILING command (`false`) arrives like a quiet success: empty output and no exit code, and the recorder says exactly that", () => {
  const [command] = ofType(map(fixture("post-bash-false")), "command");
  assert.deepEqual({ command: command!.command, stdout: command!.stdout, exitCode: command!.exitCode }, { command: "false", stdout: undefined, exitCode: null });
});

test("real output keeps its CRLF header lines", () => {
  const [command] = ofType(map(fixture("post-bash-curl")), "command");
  assert.match(command!.stdout!, /^HTTP\/2 200 \r\n/);
});

test("a file written through a shell command is just a command: there is no file_change data to derive", () => {
  const events = map(fixture("post-bash-write-file"));
  assert.equal(ofType(events, "file_change").length, 0);
  assert.equal(ofType(events, "command")[0]!.command, "printf 'hello\\n' > notes.txt");
});

test("Stop and PermissionRequest are not recorded (and the hook must not answer a permission request)", () => {
  assert.deepEqual(map(fixture("stop")), []);
  assert.deepEqual(map(fixture("permission-request")), []);
});

test("ARD_SESSION_ID links the hook events to the `ard run` wrapper session", () => {
  const events = map(fixture("pre-bash-echo"), cleanEnv({ ARD_SESSION_ID: "wrap-1" }));
  assert.equal(events[0]!.wrapperSessionId, "wrap-1");
});

test("an object-shaped response (in case a future Codex sends one) is understood too", () => {
  const [command] = ofType(map({ ...fixture("post-bash-echo"), tool_response: { stdout: "out", stderr: "err", exit_code: 3 } }), "command");
  assert.deepEqual({ stdout: command!.stdout, stderr: command!.stderr, exitCode: command!.exitCode }, { stdout: "out", stderr: "err", exitCode: 3 });
});

test("secrets in the command or its output are redacted, and huge output is cut", () => {
  const events = map({ ...fixture("post-bash-echo"), tool_input: { command: `curl -H "x: ${fake.github}" example.com` }, tool_response: `TOKEN=${fake.aws}\n${"y".repeat(200_000)}` });
  const text = JSON.stringify(events);
  assert.equal(text.includes(fake.github), false);
  assert.equal(text.includes(fake.aws), false);
  assert.ok(text.length < 100_000, String(text.length));
  assert.equal(ofType(events, "command")[0]!.truncated, true);
});

test("a tool other than Bash keeps a sanitized output, and pictures never land in the log as text", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 9)]).toString("base64");
  const [post] = ofType(map({ ...fixture("post-bash-echo"), tool_name: "mcp__x__shot", tool_input: {}, tool_response: { content: [{ type: "image", data: png, mimeType: "image/png" }] } }), "tool_use");
  assert.equal(JSON.stringify(post).includes(png), false);
  assert.match(JSON.stringify(post), /omitted/);
});

test("malformed or unknown payloads are handled without throwing", () => {
  for (const payload of [{}, { hook_event_name: "Nope" }, { hook_event_name: "PostToolUse" }, { hook_event_name: "PreToolUse", tool_input: "text" }, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: null, tool_response: 5 }] as CodexHookPayload[]) {
    assert.doesNotThrow(() => map(payload));
  }
});

// ------------------------------------------------------------------- apply_patch (documented format, NOT seen in a capture)

const PATCH = ["*** Begin Patch", "*** Add File: docs/new.md", "+# Title", "+body", "*** Update File: src/a.ts", "@@ function f", " keep", "-old line", "+new line", "*** Delete File: old.txt", "*** End Patch"].join("\n");

test("apply_patch text is parsed into create / modify / delete (synthetic: the captured session never used this tool)", () => {
  const files = parseApplyPatch(PATCH);
  assert.deepEqual(files.map((f) => [f.operation, f.path]), [["create", "docs/new.md"], ["modify", "src/a.ts"], ["delete", "old.txt"]]);
  assert.equal(files[0]!.newText, "# Title\nbody");
  const lines = parseUnifiedDiff(files[1]!.patch!);
  assert.deepEqual(lines.filter((l) => l.kind === "add" || l.kind === "del").map((l) => [l.kind, l.text]), [["del", "old line"], ["add", "new line"]]);
});

test("apply_patch: a first hunk without @@, a rename, and unparsable text", () => {
  const [bare] = parseApplyPatch("*** Begin Patch\n*** Update File: a.txt\n-x\n+y\n*** End Patch");
  assert.deepEqual(parseUnifiedDiff(bare!.patch!).filter((l) => l.kind === "add" || l.kind === "del").map((l) => l.kind), ["del", "add"]);
  const [moved] = parseApplyPatch("*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-x\n+y\n*** End Patch");
  assert.equal(moved!.path, "b.txt");
  for (const junk of ["", "not a patch", "*** Begin Patch\n*** End Patch", "*** Add File: \n+x"]) assert.deepEqual(parseApplyPatch(junk), [], JSON.stringify(junk));
});

test("an apply_patch PostToolUse yields file_change events, and the patch text is not stored twice", () => {
  const post = { ...fixture("post-bash-echo"), tool_name: "apply_patch", tool_input: { command: PATCH }, tool_response: "Success" };
  const events = map(post);
  assert.deepEqual(ofType(events, "file_change").map((e) => [e.operation, e.path, e.tool]), [["create", "docs/new.md", "apply_patch"], ["modify", "src/a.ts", "apply_patch"], ["delete", "old.txt", "apply_patch"]]);
  const pre = ofType(map({ ...fixture("pre-bash-echo"), tool_name: "apply_patch", tool_input: { command: PATCH } }), "tool_use")[0]!;
  assert.equal(JSON.stringify(pre).includes("old line"), false);
  assert.equal((pre.input as { command_chars?: number }).command_chars, PATCH.length);
  for (const e of events) assert.equal(validateEvent(e).ok, true);
});

// ---------------------------------------------------------------------- recording and the pre-approval flow

const stdinOf = (dir: string, name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ...fixture(name), cwd: dir, ...extra });
const RISKY = "git push --force origin main";

test("recordPayload for Codex finds the project from the payload's working directory", () => {
  const project = makeFakeProject();
  try {
    const env = cleanEnv(); // no CLAUDE_PROJECT_DIR: Codex does not set one
    assert.equal(recordPayload(stdinOf(project.dir, "post-bash-echo"), env, "/somewhere/else", "codex")!.events.length, 2);
    assert.deepEqual(readEvents(project.dir).map((e) => e.agent), ["codex", "codex"]);
  } finally {
    project.cleanup();
  }
});

test("`ard hook --agent codex` records and exits 0; a wrong agent still exits 0", () => {
  const project = makeFakeProject();
  try {
    execFileSync(process.execPath, [INDEX, "hook", "--agent", "codex"], { input: stdinOf(project.dir, "pre-bash-echo"), cwd: project.dir, env: cleanEnv() });
    assert.equal(readEvents(project.dir).length, 1);
    const wrong = spawnSync(process.execPath, [INDEX, "hook", "--agent", "other"], { input: "{}", cwd: project.dir, env: cleanEnv(), encoding: "utf8" });
    assert.equal(wrong.status, 0);
    assert.match(wrong.stderr, /claude-code" or "codex"/);
  } finally {
    project.cleanup();
  }
});

test("approvals OFF: a risky Codex command passes (and is recorded)", async () => {
  const project = makeFakeProject();
  try {
    const result = await handleHook("codex", stdinOf(project.dir, "pre-bash-echo", { tool_input: { command: RISKY } }), cleanEnv(), project.dir);
    assert.equal(result.exitCode, 0);
    assert.equal(readEvents(project.dir).length, 1);
  } finally {
    project.cleanup();
  }
});

test("approvals ON + a deny rule: a risky Codex command is blocked with exit 2 and a reason (the documented Codex blocking protocol)", async () => {
  const project = makeFakeProject();
  try {
    writeFileSync(join(project.dir, "ard.config.json"), JSON.stringify({ approvals: true, rules: { "git-force-push": "deny" } }));
    const result = await handleHook("codex", stdinOf(project.dir, "pre-bash-echo", { tool_input: { command: RISKY } }), cleanEnv(), project.dir);
    assert.equal(result.exitCode, 2);
    assert.match(result.message!, /^\[ard\] Blocked by policy \(git-force-push\)/);
    const approval = readEvents(project.dir).find((e) => e.type === "approval");
    assert.equal(approval?.type === "approval" && approval.decidedBy, "policy");
  } finally {
    project.cleanup();
  }
});

test("approvals ON: a risky Codex command waits for a human, and runs after approval", async () => {
  const project = makeFakeProject();
  try {
    writeFileSync(join(project.dir, "ard.config.json"), JSON.stringify({ approvals: true, timeoutSeconds: 30 }));
    const env = cleanEnv();
    const hook = handleHook("codex", stdinOf(project.dir, "pre-bash-echo", { tool_input: { command: RISKY } }), env, project.dir, { pollMs: 5 });
    const repo = new Repository(openDb(dbPathFor(project.dir, env)));
    const request = await (async () => {
      for (let i = 0; i < 500; i++) {
        const found = repo.listApprovalRequests({ status: "pending" })[0];
        if (found) return found;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("no pending request");
    })();
    assert.equal(request.toolName, "Bash");
    assert.equal(request.summary, `Bash: ${RISKY}`);
    assert.equal(decideRequest(repo, eventsPathFor(project.dir, env), project.dir, request.id, "approved", { by: "alice" }).ok, true);
    assert.equal((await hook).exitCode, 0);
  } finally {
    project.cleanup();
  }
});

// Verified on Codex 0.169.0: a hook that outlives its timeout makes Codex RUN the command. ard must give up first.
async function requestLifetimeSeconds(agent: "codex" | "claude-code", configured: number): Promise<number> {
  const project = makeFakeProject();
  try {
    writeFileSync(join(project.dir, "ard.config.json"), JSON.stringify({ approvals: true, timeoutSeconds: configured }));
    const env = cleanEnv({ CLAUDE_PROJECT_DIR: project.dir });
    const stdin = agent === "codex" ? stdinOf(project.dir, "pre-bash-echo", { tool_input: { command: RISKY } }) : JSON.stringify({ session_id: "c1", cwd: project.dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: RISKY }, tool_use_id: "t1" });
    const hook = agent === "codex" ? handleHook("codex", stdin, env, project.dir, { pollMs: 5 }) : handleClaudeHook(stdin, env, project.dir, { pollMs: 5 });
    const repo = new Repository(openDb(dbPathFor(project.dir, env)));
    let request;
    for (let i = 0; i < 500 && !request; i++) {
      request = repo.listApprovalRequests({ status: "pending" })[0];
      if (!request) await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(request, "no pending request");
    const seconds = Math.round((Date.parse(request.expiresAt) - Date.parse(request.createdAt)) / 1000);
    decideRequest(repo, eventsPathFor(project.dir, env), project.dir, request.id, "rejected", { by: "t" });
    await hook;
    return seconds;
  } finally {
    project.cleanup();
  }
}

test("on Codex the wait for a human is capped below Codex's hook timeout, because Codex runs the command when the hook times out", async () => {
  assert.equal(await requestLifetimeSeconds("codex", 3000), CODEX_MAX_WAIT_SECONDS);
  assert.equal(await requestLifetimeSeconds("codex", 60), 60, "a shorter configured wait is kept");
});

test("the cap is Codex-only: Claude Code keeps the configured wait", async () => {
  assert.equal(await requestLifetimeSeconds("claude-code", 3000), 3000);
});

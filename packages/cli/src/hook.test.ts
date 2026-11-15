import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvent, type ArdEvent } from "@ard/schema";
import { eventsFromClaudePayload, recordClaudeHook, type ClaudeHookPayload } from "./hook.js";
import { cleanEnv, fake, makeFakeProject, readEvents } from "./testutil.js";

const ROOT = "/proj";
const base = { session_id: "sess-1", cwd: ROOT };
const map = (payload: ClaudeHookPayload, env: NodeJS.ProcessEnv = cleanEnv()) => eventsFromClaudePayload({ ...base, ...payload }, ROOT, env);
const ofType = <T extends ArdEvent["type"]>(events: ArdEvent[], type: T) => events.filter((e): e is Extract<ArdEvent, { type: T }> => e.type === type);

test("every mapped event passes schema validation", () => {
  const payloads: ClaudeHookPayload[] = [
    { hook_event_name: "SessionStart", source: "startup", model: "m" },
    { hook_event_name: "SessionEnd", reason: "other" },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "a", stderr: "", interrupted: false }, tool_use_id: "t1" },
    { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "false" }, error: "Exit code 1" },
    { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/proj/a.ts", content: "x" }, tool_response: { filePath: "/proj/a.ts", type: "create" } },
    { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/proj/a.ts" }, tool_response: { content: "x" } },
  ];
  for (const payload of payloads) {
    for (const event of map(payload)) {
      const result = validateEvent(event);
      assert.equal(result.ok, true, `${payload.hook_event_name}/${payload.tool_name}: ${result.ok ? "" : result.error}`);
    }
  }
});

test("SessionStart and SessionEnd", () => {
  const [start] = map({ hook_event_name: "SessionStart", source: "resume", model: "claude-x" });
  assert.deepEqual({ type: start!.type, session: start!.sessionId, agent: start!.agent }, { type: "session_start", session: "sess-1", agent: "claude-code" });
  assert.equal((start as { startSource?: string }).startSource, "resume");
  assert.equal((start as { model?: string }).model, "claude-x");
  const [end] = map({ hook_event_name: "SessionEnd", reason: "logout" });
  assert.equal(end!.type, "session_end");
  assert.equal((end as { reason?: string }).reason, "logout");
});

test("PreToolUse records the tool call with its id and redacts secrets in the input", () => {
  const [event] = ofType(map({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `curl -H "x: ${fake.github}" example.com` }, tool_use_id: "toolu_1" }), "tool_use");
  assert.equal(event!.phase, "pre");
  assert.equal(event!.toolUseId, "toolu_1");
  assert.equal(JSON.stringify(event!.input).includes(fake.github), false);
});

test("PreToolUse for file tools keeps only the size of bulky text (the text is recorded once, as file_change)", () => {
  const [event] = ofType(map({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/proj/a.ts", content: "x".repeat(5000) } }), "tool_use");
  const input = event!.input as Record<string, unknown>;
  assert.equal(input.content, undefined);
  assert.equal(input.content_chars, 5000);
  assert.equal(input.file_path, "/proj/a.ts");
});

test("PostToolUse for Bash yields a post tool_use plus a command event with exit code 0", () => {
  const events = map({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: { stdout: "hi\n", stderr: "", interrupted: false }, tool_use_id: "t9" });
  const [post] = ofType(events, "tool_use");
  const [cmd] = ofType(events, "command");
  assert.equal(post!.phase, "post");
  assert.equal(post!.ok, true);
  assert.equal(post!.output, undefined, "output lives on the command event, not duplicated");
  assert.equal(cmd!.command, "echo hi");
  assert.equal(cmd!.exitCode, 0);
  assert.equal(cmd!.stdout, "hi\n");
  assert.equal(cmd!.toolUseId, "t9");
});

test("PostToolUseFailure for Bash parses the exit code from the error text", () => {
  const events = map({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "exit 3" }, error: "Exit code 3\nsomething broke", is_interrupt: false });
  const [post] = ofType(events, "tool_use");
  const [cmd] = ofType(events, "command");
  assert.equal(post!.ok, false);
  assert.match(post!.error ?? "", /Exit code 3/);
  assert.equal(cmd!.exitCode, 3);
  assert.match(cmd!.stderr ?? "", /something broke/);
});

test("PostToolUseFailure without a parsable exit code, or for another tool", () => {
  const [, cmd] = map({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "x" }, error: "User rejected", is_interrupt: true });
  assert.equal((cmd as { exitCode: number | null }).exitCode, null);
  assert.equal((cmd as { interrupted?: boolean }).interrupted, true);
  const other = map({ hook_event_name: "PostToolUseFailure", tool_name: "Read", tool_input: { file_path: "/nope" }, error: "ENOENT" });
  assert.equal(other.length, 1);
  assert.equal(ofType(other, "tool_use")[0]!.ok, false);
});

test("Write maps to file_change using the response type, with a project-relative path", () => {
  const input = { file_path: "/proj/src/a.ts", content: "export {};\n" };
  const created = ofType(map({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: input, tool_response: { filePath: "/proj/src/a.ts", type: "create" } }), "file_change")[0]!;
  assert.deepEqual({ path: created.path, op: created.operation, text: created.newText, tool: created.tool }, { path: "src/a.ts", op: "create", text: "export {};\n", tool: "Write" });
  const updated = ofType(map({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: input, tool_response: { type: "update" } }), "file_change")[0]!;
  assert.equal(updated.operation, "modify");
  const unknown = ofType(map({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: input, tool_response: {} }), "file_change")[0]!;
  assert.equal(unknown.operation, "write");
});

test("Edit, MultiEdit and NotebookEdit map to file_change events", () => {
  const edit = ofType(map({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/proj/a.ts", old_string: "a", new_string: "b" }, tool_response: {} }), "file_change");
  assert.deepEqual(edit.map((e) => [e.operation, e.oldText, e.newText]), [["modify", "a", "b"]]);
  const multi = ofType(map({ hook_event_name: "PostToolUse", tool_name: "MultiEdit", tool_input: { file_path: "/proj/a.ts", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] }, tool_response: {} }), "file_change");
  assert.equal(multi.length, 2);
  const nb = ofType(map({ hook_event_name: "PostToolUse", tool_name: "NotebookEdit", tool_input: { notebook_path: "/proj/n.ipynb", new_source: "print(1)" }, tool_response: {} }), "file_change");
  assert.deepEqual(nb.map((e) => [e.path, e.newText]), [["n.ipynb", "print(1)"]]);
});

test("file text and command output are redacted and size-capped", () => {
  const [fc] = ofType(map({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/proj/c.ts", content: `const k = "${fake.anthropic}";\n${"z".repeat(100_000)}` }, tool_response: { type: "create" } }), "file_change");
  assert.equal(fc!.newText!.includes(fake.anthropic), false);
  assert.equal(fc!.truncated, true);
  assert.ok(fc!.newText!.length < 70_000);
  const [cmd] = ofType(map({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "env" }, tool_response: { stdout: `TOKEN_X=${fake.github}`, stderr: "" } }), "command");
  assert.equal(cmd!.stdout!.includes(fake.github), false);
});

test("other tools keep a sanitized output on the post event", () => {
  const [post] = ofType(map({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/proj/a.ts" }, tool_response: { content: `k=${fake.aws}` } }), "tool_use");
  assert.equal(JSON.stringify(post!.output).includes(fake.aws), false);
});

test("unrecorded events and malformed payloads are handled without throwing", () => {
  assert.deepEqual(map({ hook_event_name: "Stop" }), []);
  assert.deepEqual(map({ hook_event_name: "UserPromptSubmit" }), []);
  assert.deepEqual(map({}), []);
  assert.deepEqual(map({ hook_event_name: 42 as unknown as string }), []);
  const [event] = eventsFromClaudePayload({ hook_event_name: "SessionStart" }, ROOT, cleanEnv());
  assert.equal(event!.sessionId, "unknown-session");
  assert.equal(event!.cwd, ROOT);
});

test("ARD_SESSION_ID links hook events to the wrapper session", () => {
  const [event] = map({ hook_event_name: "SessionStart" }, cleanEnv({ ARD_SESSION_ID: "wrap-1" }));
  assert.equal(event!.wrapperSessionId, "wrap-1");
  const [plain] = map({ hook_event_name: "SessionStart" });
  assert.equal(plain!.wrapperSessionId, undefined);
});

test("recordClaudeHook appends to .ard/events.jsonl with owner-only permissions", () => {
  const project = makeFakeProject();
  try {
    const env = cleanEnv({ CLAUDE_PROJECT_DIR: project.dir });
    const stdin = JSON.stringify({ session_id: "s", cwd: project.dir, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "x", stderr: "" } });
    assert.equal(recordClaudeHook(stdin, env), 2);
    assert.equal(recordClaudeHook(stdin, env), 2);
    assert.equal(readEvents(project.dir).length, 4);
    assert.equal(statSync(join(project.dir, ".ard", "events.jsonl")).mode & 0o777, 0o600);
    assert.equal(statSync(join(project.dir, ".ard")).mode & 0o777, 0o700);
  } finally {
    project.cleanup();
  }
});

test("recordClaudeHook: empty input and non-object JSON write nothing; bad JSON throws", () => {
  const project = makeFakeProject();
  try {
    const env = cleanEnv({ CLAUDE_PROJECT_DIR: project.dir });
    assert.equal(recordClaudeHook("", env), 0);
    assert.equal(recordClaudeHook("  \n", env), 0);
    assert.equal(recordClaudeHook("[1,2]", env), 0);
    assert.equal(recordClaudeHook("null", env), 0);
    assert.throws(() => recordClaudeHook("{not json", env));
    assert.equal(readEvents(project.dir).length, 0);
  } finally {
    project.cleanup();
  }
});

test("ARD_DIR redirects where events are written", () => {
  const project = makeFakeProject();
  const elsewhere = makeFakeProject();
  try {
    const env = cleanEnv({ CLAUDE_PROJECT_DIR: project.dir, ARD_DIR: join(elsewhere.dir, "data") });
    recordClaudeHook(JSON.stringify({ session_id: "s", hook_event_name: "SessionStart" }), env);
    assert.equal(readEvents(project.dir).length, 0);
    assert.equal(statSync(join(elsewhere.dir, "data", "events.jsonl")).isFile(), true);
  } finally {
    project.cleanup();
    elsewhere.cleanup();
  }
});

// ---- the real binary, as Claude Code would call it ----
const INDEX = fileURLToPath(new URL("./index.js", import.meta.url));

test("`ard hook` binary records an event and exits 0", () => {
  const project = makeFakeProject();
  try {
    const stdin = JSON.stringify({ session_id: "bin", cwd: project.dir, hook_event_name: "SessionStart", source: "startup" });
    execFileSync(process.execPath, [INDEX, "hook", "--agent", "claude-code"], { input: stdin, cwd: project.dir, env: cleanEnv({ CLAUDE_PROJECT_DIR: project.dir }) });
    const events = readEvents(project.dir);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.sessionId, "bin");
  } finally {
    project.cleanup();
  }
});

test("`ard hook` NEVER exits non-zero, even on garbage, a wrong agent or a missing agent (exit 2 would block the tool call)", () => {
  const project = makeFakeProject();
  try {
    const env = cleanEnv({ CLAUDE_PROJECT_DIR: project.dir });
    for (const [args, input] of [
      [["hook", "--agent", "claude-code"], "garbage {{{"],
      [["hook", "--agent", "claude-code"], ""],
      [["hook", "--agent", "other"], "{}"],
      [["hook"], "{}"],
    ] as const) {
      const result = spawnSync(process.execPath, [INDEX, ...args], { input, cwd: project.dir, env, encoding: "utf8" });
      assert.equal(result.status, 0, `args=${args.join(" ")} input=${JSON.stringify(input)} -> ${result.status}: ${result.stderr}`);
    }
  } finally {
    project.cleanup();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_HOOK_EVENTS } from "./hook.js";
import { MAX_TIMEOUT_SECONDS, loadConfig } from "@ard/core";
import { PRE_TOOL_TIMEOUT_SECONDS, RECORD_TIMEOUT_SECONDS, defaultHookCommand, isArdHookCommand, runInit } from "./init.js";
import { cleanEnv, makeFakeProject, makeTmp } from "@ard/core/testutil";

const CMD = "ard hook --agent claude-code";
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const init = (dir: string, extra: Partial<Parameters<typeof runInit>[0]> = {}) => runInit({ dir, shared: false, remove: false, command: CMD, env: cleanEnv(), ...extra });

test("installs hooks for every recorded event into the personal settings.local.json", () => {
  const project = makeFakeProject();
  try {
    const result = init(project.dir);
    assert.equal(result.action, "installed");
    assert.equal(result.settingsPath, join(project.dir, ".claude", "settings.local.json"));
    const hooks = read(result.settingsPath).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), [...CLAUDE_HOOK_EVENTS].sort());
    for (const event of CLAUDE_HOOK_EVENTS) {
      assert.equal(hooks[event].length, 1);
      const group = hooks[event][0];
      const timeout = event === "PreToolUse" ? PRE_TOOL_TIMEOUT_SECONDS : RECORD_TIMEOUT_SECONDS;
      assert.deepEqual(group.hooks, [{ type: "command", command: CMD, timeout }]);
      const isToolEvent = event.includes("Tool");
      assert.equal(group.matcher, isToolEvent ? "*" : undefined, event);
    }
    assert.equal(existsSync(join(project.dir, ".claude", "settings.json")), false, "must not touch the committed file");
  } finally {
    project.cleanup();
  }
});

test("the PreToolUse hook outlives the longest approval wait, or Claude Code would kill it and let the call through", () => {
  assert.ok(PRE_TOOL_TIMEOUT_SECONDS > MAX_TIMEOUT_SECONDS);
  assert.ok(RECORD_TIMEOUT_SECONDS < 60);
});

test("--approvals / --no-approvals write ard.config.json; omitting both leaves it alone", () => {
  const project = makeFakeProject();
  try {
    assert.equal(loadConfig(project.dir).approvals, false);
    const untouched = init(project.dir);
    assert.equal(untouched.approvals, undefined);
    assert.equal(existsSync(join(project.dir, "ard.config.json")), false, "plain init must not switch blocking on");

    const on = init(project.dir, { approvals: true });
    assert.deepEqual(on.approvals, { path: join(project.dir, "ard.config.json"), enabled: true, changed: true });
    assert.equal(loadConfig(project.dir).approvals, true);

    init(project.dir); // a later plain init must not reset it
    assert.equal(loadConfig(project.dir).approvals, true);

    const again = init(project.dir, { approvals: true });
    assert.equal(again.approvals?.changed, false);

    init(project.dir, { approvals: false });
    assert.equal(loadConfig(project.dir).approvals, false);
  } finally {
    project.cleanup();
  }
});

test("an unparsable ard.config.json aborts init BEFORE any hook is written (no half-finished setup)", () => {
  const project = makeFakeProject();
  try {
    writeFileSync(join(project.dir, "ard.config.json"), "{ nope");
    assert.throws(() => init(project.dir, { approvals: true }), /not valid JSON/);
    assert.equal(existsSync(join(project.dir, ".claude", "settings.local.json")), false);
    assert.equal(readFileSync(join(project.dir, "ard.config.json"), "utf8"), "{ nope");
  } finally {
    project.cleanup();
  }
});

test("--remove leaves ard.config.json alone", () => {
  const project = makeFakeProject();
  try {
    init(project.dir, { approvals: true });
    init(project.dir, { remove: true, approvals: false });
    assert.equal(loadConfig(project.dir).approvals, true);
  } finally {
    project.cleanup();
  }
});

test("creates .ard/ with owner-only permissions", () => {
  const project = makeFakeProject();
  try {
    init(project.dir);
    assert.equal(statSync(join(project.dir, ".ard")).mode & 0o777, 0o700);
  } finally {
    project.cleanup();
  }
});

test("--shared writes the committed settings.json", () => {
  const project = makeFakeProject();
  try {
    const result = init(project.dir, { shared: true });
    assert.equal(result.settingsPath, join(project.dir, ".claude", "settings.json"));
    assert.equal(existsSync(result.settingsPath), true);
  } finally {
    project.cleanup();
  }
});

test("is idempotent: a second run changes nothing and adds no duplicates", () => {
  const project = makeFakeProject();
  try {
    const first = init(project.dir);
    const text1 = readFileSync(first.settingsPath, "utf8");
    const second = init(project.dir);
    assert.equal(second.action, "unchanged");
    assert.equal(readFileSync(second.settingsPath, "utf8"), text1);
    assert.equal(read(second.settingsPath).hooks.PreToolUse.length, 1);
  } finally {
    project.cleanup();
  }
});

test("re-running with a different command updates ard's entries instead of adding more", () => {
  const project = makeFakeProject();
  try {
    init(project.dir, { command: "ard hook --agent claude-code" });
    const result = init(project.dir, { command: "/new/node /new/ard.js hook --agent claude-code" });
    assert.equal(result.action, "updated");
    const group = read(result.settingsPath).hooks.PostToolUse;
    assert.equal(group.length, 1);
    assert.equal(group[0].hooks[0].command, "/new/node /new/ard.js hook --agent claude-code");
  } finally {
    project.cleanup();
  }
});

test("preserves the user's other settings and own hooks, and --remove restores them exactly", () => {
  const project = makeFakeProject();
  try {
    const original = {
      permissions: { allow: ["Bash(ls)"] },
      env: { FOO: "bar" },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./my-hook.sh" }] }], Stop: [{ hooks: [{ type: "command", command: "./done.sh" }] }] },
    };
    mkdirSync(join(project.dir, ".claude"));
    const path = join(project.dir, ".claude", "settings.local.json");
    writeFileSync(path, JSON.stringify(original));

    init(project.dir);
    const installed = read(path);
    assert.deepEqual(installed.permissions, original.permissions);
    assert.deepEqual(installed.env, original.env);
    assert.deepEqual(installed.hooks.Stop, original.hooks.Stop);
    assert.equal(installed.hooks.PreToolUse.length, 2);
    assert.deepEqual(installed.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);

    const removed = init(project.dir, { remove: true });
    assert.equal(removed.action, "removed");
    assert.deepEqual(read(path), original);
  } finally {
    project.cleanup();
  }
});

test("--remove on a project without ard hooks does nothing and creates no file", () => {
  const project = makeFakeProject();
  try {
    const result = init(project.dir, { remove: true });
    assert.equal(result.action, "nothing-to-remove");
    assert.equal(existsSync(result.settingsPath), false);
  } finally {
    project.cleanup();
  }
});

test("removing ard hooks keeps the .ard recordings", () => {
  const project = makeFakeProject();
  try {
    init(project.dir);
    writeFileSync(join(project.dir, ".ard", "events.jsonl"), "x\n");
    init(project.dir, { remove: true });
    assert.equal(readFileSync(join(project.dir, ".ard", "events.jsonl"), "utf8"), "x\n");
  } finally {
    project.cleanup();
  }
});

test("refuses to overwrite a settings file it cannot parse", () => {
  const project = makeFakeProject();
  try {
    mkdirSync(join(project.dir, ".claude"));
    const path = join(project.dir, ".claude", "settings.local.json");
    writeFileSync(path, "{ not json");
    assert.throws(() => init(project.dir), /not valid JSON/);
    assert.equal(readFileSync(path, "utf8"), "{ not json");
    writeFileSync(path, "[1]");
    assert.throws(() => init(project.dir), /must contain a JSON object/);
  } finally {
    project.cleanup();
  }
});

test("warns when ard hooks are registered in both settings files (they would run twice)", () => {
  const project = makeFakeProject();
  try {
    init(project.dir, { shared: true });
    const result = init(project.dir);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /recorded twice/);
    assert.match(result.warnings[0]!, /ard init --remove --shared/);
  } finally {
    project.cleanup();
  }
});

test("adds .ard/ to .gitignore exactly once, keeping existing content", () => {
  const project = makeFakeProject();
  try {
    writeFileSync(join(project.dir, ".gitignore"), "node_modules/");
    assert.equal(init(project.dir).gitignore, "added");
    const text = readFileSync(join(project.dir, ".gitignore"), "utf8");
    assert.match(text, /^node_modules\/\n/);
    assert.equal((text.match(/^\.ard\/$/gm) ?? []).length, 1);
    assert.equal(init(project.dir).gitignore, "already-present");
    assert.equal((readFileSync(join(project.dir, ".gitignore"), "utf8").match(/^\.ard\/$/gm) ?? []).length, 1);
  } finally {
    project.cleanup();
  }
});

test("creates .gitignore when missing; skips it outside a git repository", () => {
  const project = makeFakeProject();
  const plain = makeTmp("ard-plain-");
  try {
    assert.equal(init(project.dir).gitignore, "added");
    assert.match(readFileSync(join(project.dir, ".gitignore"), "utf8"), /^\.ard\/$/m);
    const result = init(plain.dir);
    assert.equal(result.gitignore, "skipped");
    assert.equal(existsSync(join(plain.dir, ".gitignore")), false);
    assert.match(result.warnings.join(" "), /not a git repository/);
  } finally {
    project.cleanup();
    plain.cleanup();
  }
});

test("finds the project root from a subfolder", () => {
  const project = makeFakeProject();
  try {
    const sub = join(project.dir, "packages", "app");
    mkdirSync(sub, { recursive: true });
    const result = init(sub);
    assert.equal(result.root, project.dir);
    assert.equal(existsSync(join(project.dir, ".claude", "settings.local.json")), true);
    assert.equal(existsSync(join(sub, ".claude")), false);
  } finally {
    project.cleanup();
  }
});

test("isArdHookCommand recognizes only ard's own commands", () => {
  assert.equal(isArdHookCommand("ard hook --agent claude-code"), true);
  assert.equal(isArdHookCommand("/usr/bin/node '/x/ard/dist/index.js' hook --agent claude-code"), true);
  assert.equal(isArdHookCommand("./my-hook.sh"), false);
  assert.equal(isArdHookCommand("node block-dangerous.mjs"), false);
  assert.equal(isArdHookCommand(undefined), false);
});

test("defaultHookCommand: shared is portable, personal pins absolute paths", () => {
  assert.equal(defaultHookCommand(true), CMD);
  const personal = defaultHookCommand(false);
  assert.ok(personal.includes(process.execPath));
  assert.ok(personal.endsWith(" hook --agent claude-code"));
  assert.equal(isArdHookCommand(personal), true);
});

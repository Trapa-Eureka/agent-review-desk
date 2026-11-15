import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@ard/core";
import { cleanEnv, makeFakeProject } from "@ard/core/testutil";
import { main, type Io } from "./cli.js";
import { CODEX_HOOK_EVENTS, CODEX_MAX_WAIT_SECONDS, CODEX_PRE_TOOL_TIMEOUT_SECONDS } from "./codex.js";
import { runInit } from "./init.js";
import { isArdCodexHookCommand, runInitCodex } from "./init-codex.js";

const CMD = "ard hook --agent codex";
const hooksFile = (dir: string) => join(dir, ".codex", "hooks.json");
const read = (dir: string) => JSON.parse(readFileSync(hooksFile(dir), "utf8")) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>> };
const ours = (file: ReturnType<typeof read>) => Object.values(file.hooks).flat().flatMap((g) => g.hooks).filter((h) => isArdCodexHookCommand(h.command));

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = { out: (t) => out.push(t), err: (t) => err.push(t), readStdin: async () => "", cwd, env: cleanEnv() };
  return { io: value, out, err };
}

test("init for Codex writes this project's .codex/hooks.json with the four hooks, without a matcher, and a long enough PreToolUse timeout", () => {
  const p = makeFakeProject();
  try {
    const result = runInitCodex({ dir: p.dir, shared: true, remove: false, command: CMD, env: cleanEnv() });
    assert.equal(result.action, "installed");
    assert.equal(result.hooksPath, hooksFile(p.dir));
    const file = read(p.dir);
    assert.deepEqual(Object.keys(file.hooks).sort(), [...CODEX_HOOK_EVENTS].sort());
    for (const event of CODEX_HOOK_EVENTS) {
      const [group] = file.hooks[event]!;
      assert.equal("matcher" in group!, false, "every tool");
      assert.equal(group!.hooks[0]!.command, CMD);
    }
    // Verified on Codex 0.169.0: when a hook outlives its timeout, Codex RUNS the command. So the timeout must exceed the longest wait.
    assert.equal(file.hooks.PreToolUse![0]!.hooks[0]!.timeout, CODEX_PRE_TOOL_TIMEOUT_SECONDS);
    assert.ok(CODEX_PRE_TOOL_TIMEOUT_SECONDS > CODEX_MAX_WAIT_SECONDS, "ard must give up before Codex does");
    assert.equal(CODEX_PRE_TOOL_TIMEOUT_SECONDS, 600, "the documented default: the one long value known to be accepted");
    assert.equal(file.hooks.PostToolUse![0]!.hooks[0]!.timeout, 10);
    assert.equal(existsSync(join(p.dir, ".ard")), true);
    assert.match(readFileSync(join(p.dir, ".gitignore"), "utf8"), /^\.ard\/$/m);
  } finally {
    p.cleanup();
  }
});

test("a personal install keeps the hooks file out of git status through .git/info/exclude (never the committed .gitignore); shared does not", () => {
  const personal = makeFakeProject();
  const shared = makeFakeProject();
  try {
    const r = runInitCodex({ dir: personal.dir, shared: false, remove: false, command: CMD, env: cleanEnv() });
    assert.equal(r.exclude, "added");
    assert.match(readFileSync(join(personal.dir, ".git", "info", "exclude"), "utf8"), /^\.codex\/hooks\.json$/m);
    assert.doesNotMatch(readFileSync(join(personal.dir, ".gitignore"), "utf8"), /codex/);
    assert.equal(runInitCodex({ dir: personal.dir, shared: false, remove: false, command: CMD, env: cleanEnv() }).exclude, "already-present");
    assert.equal(runInitCodex({ dir: shared.dir, shared: true, remove: false, command: CMD, env: cleanEnv() }).exclude, "skipped");
    assert.equal(existsSync(join(shared.dir, ".git", "info", "exclude")), false);
  } finally {
    personal.cleanup();
    shared.cleanup();
  }
});

test("the user's own hooks are never touched, and removing ard's hooks restores them exactly", () => {
  const p = makeFakeProject();
  try {
    mkdirSync(join(p.dir, ".codex"));
    const mine = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-audit-script", timeout: 5 }] }], Stop: [{ hooks: [{ type: "command", command: ":", timeout: 10 }] }] }, other: { keep: true } };
    writeFileSync(hooksFile(p.dir), `${JSON.stringify(mine, null, 2)}\n`);
    runInitCodex({ dir: p.dir, shared: true, remove: false, command: CMD, env: cleanEnv() });
    const after = read(p.dir);
    assert.equal(after.hooks.PreToolUse![0]!.hooks[0]!.command, "my-audit-script");
    assert.deepEqual(after.hooks.Stop, mine.hooks.Stop);
    assert.deepEqual((after as unknown as { other: unknown }).other, { keep: true });
    assert.equal(ours(after).length, 4);
    assert.equal(runInitCodex({ dir: p.dir, shared: true, remove: true, command: CMD, env: cleanEnv() }).action, "removed");
    assert.deepEqual(JSON.parse(readFileSync(hooksFile(p.dir), "utf8")), mine);
  } finally {
    p.cleanup();
  }
});

test("running init again changes nothing; a different command replaces ours instead of adding a second", () => {
  const p = makeFakeProject();
  try {
    runInitCodex({ dir: p.dir, shared: true, remove: false, command: CMD, env: cleanEnv() });
    const first = readFileSync(hooksFile(p.dir), "utf8");
    assert.equal(runInitCodex({ dir: p.dir, shared: true, remove: false, command: CMD, env: cleanEnv() }).action, "unchanged");
    assert.equal(readFileSync(hooksFile(p.dir), "utf8"), first);
    const result = runInitCodex({ dir: p.dir, shared: true, remove: false, command: "node /elsewhere/ard.js hook --agent codex", env: cleanEnv() });
    assert.equal(result.action, "updated");
    assert.equal(ours(read(p.dir)).length, 4, "exactly one per event");
  } finally {
    p.cleanup();
  }
});

test("a hooks file ard cannot parse is never overwritten, and nothing else is written either", () => {
  const p = makeFakeProject();
  try {
    mkdirSync(join(p.dir, ".codex"));
    writeFileSync(hooksFile(p.dir), "{ not json");
    assert.throws(() => runInitCodex({ dir: p.dir, shared: true, remove: false, approvals: true, command: CMD, env: cleanEnv() }), /will not overwrite a file it cannot parse/);
    assert.equal(readFileSync(hooksFile(p.dir), "utf8"), "{ not json");
    assert.equal(existsSync(join(p.dir, "ard.config.json")), false, "the config was not changed either");
    assert.equal(existsSync(join(p.dir, ".ard")), false);
  } finally {
    p.cleanup();
  }
});

test("removing when ard was never installed says so and changes nothing", () => {
  const p = makeFakeProject();
  try {
    assert.equal(runInitCodex({ dir: p.dir, shared: true, remove: true, command: CMD, env: cleanEnv() }).action, "nothing-to-remove");
    assert.equal(existsSync(hooksFile(p.dir)), false);
  } finally {
    p.cleanup();
  }
});

test("Claude and Codex installs live side by side without touching each other's hooks", () => {
  const p = makeFakeProject();
  try {
    runInit({ dir: p.dir, shared: true, remove: false, command: "ard hook --agent claude-code", env: cleanEnv() });
    runInitCodex({ dir: p.dir, shared: true, remove: false, command: CMD, env: cleanEnv() });
    const claude = readFileSync(join(p.dir, ".claude", "settings.json"), "utf8");
    assert.equal(claude.includes("codex"), false);
    assert.equal(readFileSync(hooksFile(p.dir), "utf8").includes("claude-code"), false);
    runInit({ dir: p.dir, shared: true, remove: true, env: cleanEnv() });
    assert.equal(ours(read(p.dir)).length, 4, "removing Claude's hooks left Codex's");
    runInitCodex({ dir: p.dir, shared: true, remove: true, command: CMD, env: cleanEnv() });
    assert.equal(readFileSync(join(p.dir, ".claude", "settings.json"), "utf8").includes("claude-code"), false);
  } finally {
    p.cleanup();
  }
});

test("`ard init --agent codex` tells the person to trust the hooks in Codex, and --approvals carries an honest note", async () => {
  const p = makeFakeProject();
  try {
    const h = io(p.dir);
    assert.equal(await main(["init", "--agent", "codex", "--shared", "--approvals"], h.io), 0, h.err.join("\n"));
    const text = h.out.join("\n");
    assert.match(text, /ard hooks for Codex installed in .*\.codex\/hooks\.json/);
    assert.match(text, /run \/hooks to review and trust/);
    assert.match(text, /approvals:\s+ON/);
    assert.match(text, /verified on Codex 0\.169\.0/);
    assert.match(text, /waits at most 9 minutes/);
    assert.equal(loadConfig(p.dir).approvals, true);
    const again = io(p.dir);
    assert.equal(await main(["init", "--agent", "codex", "--shared", "--remove"], again.io), 0);
    assert.match(again.out.join("\n"), /Removed ard hooks/);
  } finally {
    p.cleanup();
  }
});

test("`ard init` rejects an unknown agent, and --screenshots with Codex (not verified there)", async () => {
  const p = makeFakeProject();
  try {
    for (const argv of [["init", "--agent", "gemini"], ["init", "--agent", "codex", "--screenshots"]]) {
      const h = io(p.dir);
      assert.equal(await main(argv, h.io), 2, argv.join(" "));
    }
    assert.equal(existsSync(hooksFile(p.dir)), false);
  } finally {
    p.cleanup();
  }
});

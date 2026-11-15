import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HELP, main, type Io } from "./cli.js";
import { cleanEnv, makeFakeProject } from "@ard/core/testutil";

function fakeIo(cwd: string, stdin = "", env: NodeJS.ProcessEnv = cleanEnv()) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => out.push(t), err: (t) => err.push(t), readStdin: async () => stdin, cwd, env };
  return { io, out, err };
}

test("help, version and no-arguments", async () => {
  for (const argv of [[], ["--help"], ["-h"], ["help"]]) {
    const { io, out } = fakeIo(process.cwd());
    assert.equal(await main(argv, io), 0);
    assert.equal(out[0], HELP);
  }
  const { io, out } = fakeIo(process.cwd());
  assert.equal(await main(["--version"], io), 0);
  assert.match(out[0]!, /^ard \d+\.\d+\.\d+ \(event schema v1\)$/);
});

test("help documents every command", () => {
  for (const word of ["ard init", "ard run", "ard hook", "--shared", "--remove", "ARD_DIR"]) assert.ok(HELP.includes(word), word);
});

test("unknown command exits 2", async () => {
  const { io, err } = fakeIo(process.cwd());
  assert.equal(await main(["frobnicate"], io), 2);
  assert.match(err[0]!, /unknown command/);
});

test("init installs hooks and prints where they went; second run says unchanged", async () => {
  const project = makeFakeProject();
  try {
    const first = fakeIo(project.dir);
    assert.equal(await main(["init"], first.io), 0);
    assert.match(first.out.join("\n"), /ard hooks installed in .*settings\.local\.json/);
    assert.match(first.out.join("\n"), /\.gitignore:\s+added \.ard\//);
    assert.match(first.out.join("\n"), /Restart Claude Code/);
    const second = fakeIo(project.dir);
    assert.equal(await main(["init"], second.io), 0);
    assert.match(second.out.join("\n"), /unchanged/);
    const settings = JSON.parse(readFileSync(join(project.dir, ".claude", "settings.local.json"), "utf8"));
    assert.equal(settings.hooks.SessionStart.length, 1);
  } finally {
    project.cleanup();
  }
});

test("init --dir, --shared and --remove", async () => {
  const project = makeFakeProject();
  try {
    const other = fakeIo(process.cwd());
    assert.equal(await main(["init", "--dir", project.dir, "--shared"], other.io), 0);
    assert.equal(existsSync(join(project.dir, ".claude", "settings.json")), true);
    const hooks = JSON.parse(readFileSync(join(project.dir, ".claude", "settings.json"), "utf8")).hooks;
    assert.equal(hooks.PreToolUse[0].hooks[0].command, "ard hook --agent claude-code");

    const removed = fakeIo(project.dir);
    assert.equal(await main(["init", "--shared", "--remove"], removed.io), 0);
    assert.match(removed.out.join("\n"), /Removed ard hooks/);
  } finally {
    project.cleanup();
  }
});

test("init reports bad arguments and unparsable settings with a non-zero exit", async () => {
  const project = makeFakeProject();
  try {
    const bad = fakeIo(project.dir);
    assert.equal(await main(["init", "--wat"], bad.io), 2);
    assert.match(bad.err[0]!, /unknown argument/);
  } finally {
    project.cleanup();
  }
});

test("run without a command exits 2", async () => {
  const { io, err } = fakeIo(process.cwd());
  assert.equal(await main(["run"], io), 2);
  assert.equal(await main(["run", "--"], io), 2);
  assert.match(err[0]!, /no command given/);
});

test("`ard run -- <program>` through the real binary propagates the exit code", () => {
  const project = makeFakeProject();
  try {
    const index = fileURLToPath(new URL("./index.js", import.meta.url));
    const result = spawnSync(process.execPath, [index, "run", "--", process.execPath, "-e", "process.exit(7)"], { cwd: project.dir, env: cleanEnv(), encoding: "utf8" });
    assert.equal(result.status, 7, result.stderr);
    assert.match(result.stderr, /ard: session .* recorded/);
  } finally {
    project.cleanup();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_SCREENSHOT_BYTES, loadConfig } from "@ard/core";
import { cleanEnv, fake, makeFakeProject, readEvents } from "@ard/core/testutil";
import { validateEvent } from "@ard/schema";
import { main, type Io } from "./cli.js";
import { recordClaudeHook } from "./hook.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 5)]);

function fakeIo(cwd: string, env: NodeJS.ProcessEnv = cleanEnv()) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => out.push(t), err: (t) => err.push(t), readStdin: async () => "", cwd, env };
  return { io, out, err };
}

/** A project with one recorded session, as the hook would leave it. */
function projectWithSession(sessionId = "s-1") {
  const project = makeFakeProject();
  recordClaudeHook(JSON.stringify({ session_id: sessionId, cwd: project.dir, hook_event_name: "SessionStart", source: "startup" }), cleanEnv({ CLAUDE_PROJECT_DIR: project.dir }));
  return project;
}

test("`ard screenshot` attaches a picture to the most recent session, with a caption, and keeps it under its hash", async () => {
  const project = projectWithSession("s-1");
  try {
    writeFileSync(join(project.dir, "login.png"), PNG);
    const { io, out, err } = fakeIo(project.dir);
    assert.equal(await main(["screenshot", "login.png", "--caption", "login page after the fix"], io), 0, err.join("\n"));
    assert.match(out.join("\n"), /Attached image\/png \(\d+ bytes\) to session s-1/);
    const [shot] = readEvents(project.dir).filter((e) => e.type === "screenshot");
    assert.ok(shot && shot.type === "screenshot");
    assert.deepEqual({ session: shot.sessionId, source: shot.source, media: shot.mediaType, bytes: shot.bytes, caption: shot.caption, agent: shot.agent }, { session: "s-1", source: "manual", media: "image/png", bytes: PNG.length, caption: "login page after the fix", agent: "claude-code" });
    assert.equal(validateEvent(shot).ok, true);
    assert.deepEqual(readdirSync(join(project.dir, ".ard", "screenshots")), [shot.imageId]);
  } finally {
    project.cleanup();
  }
});

test("`ard screenshot --session` targets that session, and an unknown session is refused without storing anything", async () => {
  const project = projectWithSession("s-1");
  try {
    recordClaudeHook(JSON.stringify({ session_id: "s-2", cwd: project.dir, hook_event_name: "SessionStart" }), cleanEnv({ CLAUDE_PROJECT_DIR: project.dir }));
    writeFileSync(join(project.dir, "a.png"), PNG);
    const ok = fakeIo(project.dir);
    assert.equal(await main(["screenshot", "a.png", "--session", "s-1"], ok.io), 0);
    assert.equal(readEvents(project.dir).filter((e) => e.type === "screenshot")[0]!.sessionId, "s-1");
    const before = readdirSync(join(project.dir, ".ard", "screenshots")).length;
    const bad = fakeIo(project.dir);
    assert.equal(await main(["screenshot", "a.png", "--session", "nope"], bad.io), 1);
    assert.match(bad.err.join("\n"), /no session "nope"/);
    assert.equal(readdirSync(join(project.dir, ".ard", "screenshots")).length, before);
  } finally {
    project.cleanup();
  }
});

test("`ard screenshot` with no recorded session says what to do", async () => {
  const project = makeFakeProject();
  try {
    writeFileSync(join(project.dir, "a.png"), PNG);
    const { io, err } = fakeIo(project.dir);
    assert.equal(await main(["screenshot", "a.png"], io), 1);
    assert.match(err.join("\n"), /no recorded session yet/);
    assert.equal(existsSync(join(project.dir, ".ard", "screenshots")), false);
  } finally {
    project.cleanup();
  }
});

test("`ard screenshot` refuses a file that is not a PNG/JPEG/GIF/WebP (SVG, HTML, text), a directory, a missing file and an oversized file", async () => {
  const project = projectWithSession();
  try {
    writeFileSync(join(project.dir, "evil.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    writeFileSync(join(project.dir, "fake.png"), "<html>claims to be a png</html>");
    writeFileSync(join(project.dir, "big.png"), Buffer.concat([PNG, Buffer.alloc(MAX_SCREENSHOT_BYTES)]));
    for (const file of ["evil.svg", "fake.png", "big.png", ".", "missing.png"]) {
      const { io, err } = fakeIo(project.dir);
      assert.equal(await main(["screenshot", file], io), 1, file);
      assert.ok(err.join("\n").length > 0, file);
    }
    assert.equal(readEvents(project.dir).filter((e) => e.type === "screenshot").length, 0, "no event for any of them");
    assert.equal(existsSync(join(project.dir, ".ard", "screenshots")), false, "nothing stored for any of them");
  } finally {
    project.cleanup();
  }
});

test("a caption is redacted like any other text, and bad usage exits 2", async () => {
  const project = projectWithSession();
  try {
    writeFileSync(join(project.dir, "a.png"), PNG);
    const { io } = fakeIo(project.dir);
    assert.equal(await main(["screenshot", "a.png", "--caption", `token ${fake.github} visible`], io), 0);
    const caption = (readEvents(project.dir).find((e) => e.type === "screenshot") as { caption?: string }).caption ?? "";
    assert.equal(caption.includes(fake.github), false);
    for (const argv of [["screenshot"], ["screenshot", "a.png", "b.png"], ["screenshot", "--bogus"]]) {
      const bad = fakeIo(project.dir);
      assert.equal(await main(argv, bad.io), 2, argv.join(" "));
    }
  } finally {
    project.cleanup();
  }
});

test("`ard init --screenshots` turns the setting on (and says it is not redacted), --no-screenshots turns it off, both together is an error", async () => {
  const project = makeFakeProject();
  try {
    const on = fakeIo(project.dir);
    assert.equal(await main(["init", "--screenshots"], on.io), 0, on.err.join("\n"));
    assert.match(on.out.join("\n"), /screenshots:\s+ON/);
    assert.match(on.out.join("\n"), /NOT redacted/);
    assert.equal(loadConfig(project.dir).screenshots, true);
    const off = fakeIo(project.dir);
    assert.equal(await main(["init", "--no-screenshots"], off.io), 0);
    assert.equal(loadConfig(project.dir).screenshots, false);
    assert.equal(JSON.parse(readFileSync(join(project.dir, "ard.config.json"), "utf8")).screenshots, false);
    const both = fakeIo(project.dir);
    assert.equal(await main(["init", "--screenshots", "--no-screenshots"], both.io), 2);
  } finally {
    project.cleanup();
  }
});

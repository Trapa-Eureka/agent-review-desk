import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { cleanEnv, makeFakeProject, makeTmp } from "@ard/core/testutil";
import { main, type Io } from "./cli.js";
import { portIsFree, resolveWebDir, runReview, webProblem } from "./review.js";

function fakeIo(cwd: string, env: NodeJS.ProcessEnv = cleanEnv()) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => out.push(t), err: (t) => err.push(t), readStdin: async () => "", cwd, env };
  return { io, out, err };
}

test("resolveWebDir honours ARD_WEB_DIR, otherwise points at apps/web of the checkout", () => {
  assert.equal(resolveWebDir(cleanEnv({ ARD_WEB_DIR: "/somewhere/web" })), resolve("/somewhere/web"));
  assert.match(resolveWebDir(cleanEnv()), /apps\/web$/);
});

test("webProblem explains what is missing, in the order a user would fix it", () => {
  const tmp = makeTmp("ard-web-");
  try {
    assert.match(webProblem(tmp.dir)!, /was not found/);
    writeFileSync(join(tmp.dir, "package.json"), "{}");
    assert.match(webProblem(tmp.dir)!, /pnpm build/);
    mkdirSync(join(tmp.dir, ".next"));
    writeFileSync(join(tmp.dir, ".next", "BUILD_ID"), "x");
    assert.match(webProblem(tmp.dir)!, /pnpm install/);
    const bin = join(tmp.dir, "node_modules", "next", "dist", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "next"), "");
    assert.equal(webProblem(tmp.dir), null);
  } finally {
    tmp.cleanup();
  }
});

test("portIsFree sees a port that is taken", async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    assert.equal(await portIsFree(port), false);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(await portIsFree(port), true);
});

test("runReview refuses to start (exit 1, clear message) when the UI is not built or the port is busy", async () => {
  const project = makeFakeProject();
  const web = makeTmp("ard-web-");
  const lines: string[] = [];
  try {
    const env = cleanEnv({ ARD_WEB_DIR: web.dir });
    assert.equal(await runReview({ cwd: project.dir, env, port: 47771, log: (l) => lines.push(l) }), 1);
    assert.match(lines.join("\n"), /ard review: .*not found/);
  } finally {
    project.cleanup();
    web.cleanup();
  }
});

test("`ard review` validates --port and unknown arguments", async () => {
  for (const args of [["review", "--port", "abc"], ["review", "--port", "80"], ["review", "--port", "70000"], ["review", "--bogus"]]) {
    const { io, err } = fakeIo(process.cwd());
    assert.equal(await main(args, io), 2, args.join(" "));
    assert.match(err[0]!, /ard review:/);
  }
});

test("`ard init --approvals` reports that risky actions will now wait; --approvals with --no-approvals is rejected", async () => {
  const project = makeFakeProject();
  try {
    const { io, out, err } = fakeIo(project.dir);
    assert.equal(await main(["init", "--approvals"], io), 0);
    assert.match(out.join("\n"), /approvals:\s+ON/);
    assert.match(out.join("\n"), /ard review/);
    assert.deepEqual(err, []);

    const off = fakeIo(project.dir);
    assert.equal(await main(["init", "--no-approvals"], off.io), 0);
    assert.match(off.out.join("\n"), /approvals:\s+off/);

    const both = fakeIo(project.dir);
    assert.equal(await main(["init", "--approvals", "--no-approvals"], both.io), 2);
    assert.match(both.err[0]!, /cannot be used together/);
  } finally {
    project.cleanup();
  }
});

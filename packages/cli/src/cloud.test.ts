import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, baseFields, eventsPathFor } from "@ard/core";
import { cleanEnv, makeFakeProject, makeTmp } from "@ard/core/testutil";
import type { ArdEvent } from "@ard/schema";
import { runLogin, runLogout, runWhoami, type AccountIo } from "./cloud/account.js";
import { CloudHttpError, cloudRequest, resolveServer, type CloudFetch } from "./cloud/client.js";
import { configDir, credentialsPath, getCredential, removeCredential, saveCredential } from "./cloud/credentials.js";
import { BATCH_MAX_EVENTS, batches, readPending, runSync } from "./cloud/sync.js";
import { HELP, main, type Io } from "./cli.js";

const SERVER = "https://cloud.example.com";

// ------------------------------------------------------------ a fake cloud

type Reply = { status?: number; json?: unknown };
type Handler = (body: Record<string, unknown> | undefined, call: { auth: string | undefined }) => Reply | Promise<Reply>;

function fakeCloud(routes: Record<string, Handler>) {
  const calls: Array<{ method: string; path: string; auth: string | undefined; body: Record<string, unknown> | undefined }> = [];
  const fetch: CloudFetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method: init.method, path: u.pathname, auth: init.headers.authorization, body });
    const handler = routes[`${init.method} ${u.pathname}`];
    const reply = handler ? await handler(body, { auth: init.headers.authorization }) : { status: 404, json: { error: "not found" } };
    const status = reply.status ?? 200;
    return { status, text: async () => (reply.json === undefined ? "" : JSON.stringify(reply.json)) };
  };
  return { fetch, calls };
}

function ioFor(env: NodeJS.ProcessEnv, fetch: CloudFetch) {
  const out: string[] = [];
  const err: string[] = [];
  const waits: number[] = [];
  let clock = new Date("2026-11-15T10:00:00Z").getTime();
  const io: AccountIo = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    env,
    fetch,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return { io, out, err, waits };
}

function sandbox() {
  const config = makeTmp("ard-config-");
  const project = makeFakeProject();
  const env = cleanEnv({ ARD_CONFIG_DIR: config.dir });
  return { env, project, config, cleanup: () => (config.cleanup(), project.cleanup()) };
}

const ctx = (sid: string) => ({ sessionId: sid, agent: "claude-code", cwd: "/p" });
const cmd = (sid: string, command: string): ArdEvent => ({ ...baseFields(ctx(sid)), type: "command", command, exitCode: 0 });
const start = (sid: string): ArdEvent => ({ ...baseFields(ctx(sid)), type: "session_start", capture: "hook" });
const record = (dir: string, env: NodeJS.ProcessEnv, ...events: ArdEvent[]) => events.forEach((e) => appendEvent(eventsPathFor(dir, env), e));

const signedIn = (env: NodeJS.ProcessEnv) => saveCredential(env, SERVER, { token: "ard_" + "a".repeat(64), email: "dana@example.com", savedAt: "2026-11-01T00:00:00Z" });
const ME = { user: { email: "dana@example.com" }, organizations: [{ slug: "acme", name: "Acme", role: "member", plan: { active: true, reason: "active", until: null } }] };
const accepting: Handler = (body) => ({ json: { accepted: (body!.events as unknown[]).length, duplicates: 0, droppedReviews: 0, rejected: [] } });

// ------------------------------------------------------------ server address

test("the server comes from --server or ARD_CLOUD_URL, and is reduced to its origin", () => {
  assert.equal(resolveServer({ ARD_CLOUD_URL: "https://cloud.example.com/some/path?x=1" }), SERVER);
  assert.equal(resolveServer({ ARD_CLOUD_URL: "https://a.example.com" }, "https://b.example.com"), "https://b.example.com", "the flag wins");
  assert.throws(() => resolveServer({}), /No cloud server given/);
  assert.throws(() => resolveServer({ ARD_CLOUD_URL: "" }), /No cloud server given/);
});

test("the login token is never sent over plain http, except to localhost", () => {
  assert.throws(() => resolveServer({}, "http://cloud.example.com"), /must use https/);
  assert.throws(() => resolveServer({}, "ftp://cloud.example.com"), /must use https/);
  assert.throws(() => resolveServer({}, "not a url"), /not a valid URL/);
  assert.throws(() => resolveServer({}, "https://user:pw@cloud.example.com"), /user name or password/);
  assert.equal(resolveServer({}, "http://127.0.0.1:4780"), "http://127.0.0.1:4780");
  assert.equal(resolveServer({}, "http://localhost:4780"), "http://localhost:4780");
});

test("cloudRequest sends the token and JSON, refuses redirects, and explains failures without leaking the token", async () => {
  const seen: Array<{ redirect: string; auth?: string; ctype?: string }> = [];
  const fetch: CloudFetch = async (_u, init) => {
    seen.push({ redirect: init.redirect, auth: init.headers.authorization, ctype: init.headers["content-type"] });
    return { status: 402, text: async () => JSON.stringify({ error: "This organization is on the free plan.", code: "payment_required" }) };
  };
  await assert.rejects(
    cloudRequest(fetch, SERVER, "/x", { method: "POST", token: "ard_SECRET", body: { a: 1 } }),
    (e: unknown) => e instanceof CloudHttpError && e.status === 402 && e.code === "payment_required" && /free plan/.test(e.message) && !e.message.includes("ard_SECRET"),
  );
  assert.deepEqual(seen[0], { redirect: "error", auth: "Bearer ard_SECRET", ctype: "application/json" });
});

test("cloudRequest turns network failures, timeouts and non-JSON answers into plain messages", async () => {
  const down: CloudFetch = async () => Promise.reject(new Error("ECONNREFUSED"));
  await assert.rejects(cloudRequest(down, SERVER, "/x"), /Could not reach/);
  const slow: CloudFetch = async () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }));
  await assert.rejects(cloudRequest(slow, SERVER, "/x"), /did not answer in time/);
  const html: CloudFetch = async () => ({ status: 200, text: async () => "<html>login</html>" });
  await assert.rejects(cloudRequest(html, SERVER, "/x"), /not JSON/);
  const oauthStyle: CloudFetch = async () => ({ status: 400, text: async () => JSON.stringify({ error: "authorization_pending" }) });
  await assert.rejects(cloudRequest(oauthStyle, SERVER, "/x"), (e: unknown) => e instanceof CloudHttpError && e.code === "authorization_pending");
});

// ------------------------------------------------------------- credentials

test("credentials are stored owner-only, per server, and can be removed", () => {
  const s = sandbox();
  try {
    assert.equal(getCredential(s.env, SERVER), null);
    saveCredential(s.env, SERVER, { token: "t1", email: "a@x.com", savedAt: "now" });
    saveCredential(s.env, "https://other.example.com", { token: "t2", email: "b@x.com", savedAt: "now" });
    assert.equal(getCredential(s.env, SERVER)?.token, "t1");
    assert.equal(getCredential(s.env, "https://other.example.com")?.token, "t2");
    assert.equal(statSync(credentialsPath(s.env)).mode & 0o777, 0o600, "the file is readable by its owner only");
    assert.equal(statSync(configDir(s.env)).mode & 0o777, 0o700);
    assert.equal(removeCredential(s.env, SERVER), true);
    assert.equal(removeCredential(s.env, SERVER), false);
    assert.equal(getCredential(s.env, "https://other.example.com")?.token, "t2", "the other server is untouched");
  } finally {
    s.cleanup();
  }
});

test("a credentials file ard cannot read is never overwritten", () => {
  const s = sandbox();
  try {
    mkdirSync(configDir(s.env), { recursive: true });
    writeFileSync(credentialsPath(s.env), "{ not json");
    assert.throws(() => saveCredential(s.env, SERVER, { token: "t", email: "a", savedAt: "n" }), /not valid JSON/);
    assert.equal(readFileSync(credentialsPath(s.env), "utf8"), "{ not json");
    writeFileSync(credentialsPath(s.env), JSON.stringify({ servers: [] }));
    assert.throws(() => getCredential(s.env, SERVER), /unexpected shape/);
  } finally {
    s.cleanup();
  }
});

test("the config folder honours ARD_CONFIG_DIR, then XDG_CONFIG_HOME", () => {
  assert.equal(configDir({ ARD_CONFIG_DIR: "/custom" }), "/custom");
  assert.equal(configDir({ XDG_CONFIG_HOME: "/xdg" }), "/xdg/ard");
  assert.match(configDir({}), /\.config\/ard$/);
});

// -------------------------------------------------------------------- login

const codeReply: Reply = { json: { device_code: "d".repeat(64), user_code: "ABCD-EFGH", verification_uri: `${SERVER}/device`, verification_uri_complete: `${SERVER}/device?code=ABCD-EFGH`, expires_in: 600, interval: 5 } };

test("login shows the link and code, waits for approval, saves the token and lists organizations", async () => {
  const s = sandbox();
  try {
    let polls = 0;
    const cloud = fakeCloud({
      "POST /api/v1/device/code": () => codeReply,
      "POST /api/v1/device/token": () => (++polls < 3 ? { status: 400, json: { error: "authorization_pending" } } : { json: { access_token: "ard_" + "b".repeat(64), token_type: "Bearer", email: "dana@example.com" } }),
      "GET /api/v1/me": (_b, call) => (call.auth === `Bearer ard_${"b".repeat(64)}` ? { json: ME } : { status: 401, json: { error: "no" } }),
    });
    const t = ioFor(s.env, cloud.fetch);
    assert.equal(await runLogin(t.io, SERVER), 0);
    const text = t.out.join("\n");
    assert.match(text, /\/device\?code=ABCD-EFGH/);
    assert.match(text, /confirm the code\s+ABCD-EFGH/);
    assert.match(text, /Signed in as dana@example.com/);
    assert.match(text, /acme\s+member\s+Team \(active\)/);
    assert.equal(getCredential(s.env, SERVER)?.token, "ard_" + "b".repeat(64));
    assert.deepEqual(t.waits, [5000, 5000, 5000], "polls at the server's interval");
    assert.equal(cloud.calls.find((c) => c.path === "/api/v1/device/token")!.body!.device_code, "d".repeat(64));
  } finally {
    s.cleanup();
  }
});

test("login obeys slow_down by waiting longer", async () => {
  const s = sandbox();
  try {
    const replies = [{ status: 400, json: { error: "slow_down" } }, { status: 400, json: { error: "authorization_pending" } }, { json: { access_token: "ard_x", email: "d@x.com" } }];
    const cloud = fakeCloud({ "POST /api/v1/device/code": () => codeReply, "POST /api/v1/device/token": () => replies.shift()!, "GET /api/v1/me": () => ({ json: ME }) });
    const t = ioFor(s.env, cloud.fetch);
    assert.equal(await runLogin(t.io, SERVER), 0);
    assert.deepEqual(t.waits, [5000, 10000, 10000]);
  } finally {
    s.cleanup();
  }
});

test("login that is refused or expired saves nothing and says so", async () => {
  for (const [error, pattern] of [["access_denied", /refused/], ["expired_token", /expired/], ["invalid_grant", /expired/]] as const) {
    const s = sandbox();
    try {
      const cloud = fakeCloud({ "POST /api/v1/device/code": () => codeReply, "POST /api/v1/device/token": () => ({ status: 400, json: { error } }) });
      const t = ioFor(s.env, cloud.fetch);
      assert.equal(await runLogin(t.io, SERVER), 1, error);
      assert.match(t.err.join("\n"), pattern);
      assert.equal(getCredential(s.env, SERVER), null);
    } finally {
      s.cleanup();
    }
  }
});

test("login gives up when the code's lifetime passes", async () => {
  const s = sandbox();
  try {
    const cloud = fakeCloud({ "POST /api/v1/device/code": () => ({ json: { ...(codeReply.json as object), expires_in: 12 } }), "POST /api/v1/device/token": () => ({ status: 400, json: { error: "authorization_pending" } }) });
    const t = ioFor(s.env, cloud.fetch);
    assert.equal(await runLogin(t.io, SERVER), 1);
    assert.match(t.err.join("\n"), /Timed out/);
    assert.ok(t.waits.length <= 3);
  } finally {
    s.cleanup();
  }
});

test("login against something that is not an Agent Review Desk Cloud fails clearly", async () => {
  const s = sandbox();
  try {
    const cloud = fakeCloud({ "POST /api/v1/device/code": () => ({ json: { hello: "world" } }) });
    await assert.rejects(runLogin(ioFor(s.env, cloud.fetch).io, SERVER), /Is this really an Agent Review Desk Cloud/);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------- logout / whoami

test("logout revokes the token on the server and removes it here", async () => {
  const s = sandbox();
  try {
    signedIn(s.env);
    const cloud = fakeCloud({ "POST /api/v1/logout": () => ({ json: { ok: true } }) });
    const t = ioFor(s.env, cloud.fetch);
    assert.equal(await runLogout(t.io, SERVER), 0);
    assert.equal(getCredential(s.env, SERVER), null);
    assert.equal(cloud.calls[0]!.auth, `Bearer ard_${"a".repeat(64)}`);
    assert.match(t.out.join("\n"), /no longer works/);
  } finally {
    s.cleanup();
  }
});

test("logout while offline still removes the token locally and warns that it may need revoking", async () => {
  const s = sandbox();
  try {
    signedIn(s.env);
    const t = ioFor(s.env, async () => Promise.reject(new Error("offline")));
    assert.equal(await runLogout(t.io, SERVER), 0);
    assert.equal(getCredential(s.env, SERVER), null);
    assert.match(t.out.join("\n"), /could not be reached/);
    assert.match(await (async () => { const u = ioFor(s.env, async () => Promise.reject(new Error("x"))); await runLogout(u.io, SERVER); return u.out.join(""); })(), /Not signed in/);
  } finally {
    s.cleanup();
  }
});

test("whoami reports the account and each organization's plan; without a login it says how to sign in", async () => {
  const s = sandbox();
  try {
    const cloud = fakeCloud({ "GET /api/v1/me": () => ({ json: { ...ME, organizations: [...ME.organizations, { slug: "free-co", name: "Free Co", role: "owner", plan: { active: false, reason: "no_subscription", until: null } }] } }) });
    const none = ioFor(s.env, cloud.fetch);
    assert.equal(await runWhoami(none.io, SERVER), 1);
    assert.match(none.err.join(""), /ard login/);
    signedIn(s.env);
    const t = ioFor(s.env, cloud.fetch);
    assert.equal(await runWhoami(t.io, SERVER), 0);
    assert.match(t.out.join("\n"), /dana@example.com on https:\/\/cloud\.example\.com/);
    assert.match(t.out.join("\n"), /free-co\s+owner\s+Free \(sync is off\)/);
  } finally {
    s.cleanup();
  }
});

// --------------------------------------------------------------------- sync

test("readPending reads only complete lines, counts unreadable ones, and tracks BYTE offsets (multi-byte text)", () => {
  const s = sandbox();
  try {
    const path = eventsPathFor(s.project.dir, s.env);
    const korean = cmd("s1", "echo 한국어 텍스트 ✓");
    record(s.project.dir, s.env, start("s1"), korean);
    appendFileSync(path, "this is not json\n");
    const half = JSON.stringify(cmd("s1", "pwd"));
    appendFileSync(path, half.slice(0, 15)); // a hook is mid-write
    const first = readPending(path, 0);
    assert.equal(first.events.length, 2);
    assert.equal(first.invalid, 1);
    assert.equal(first.endOffset, statSync(path).size - 15, "stops before the incomplete last line");
    assert.equal(first.events[1]!.endOffset, readFileSync(path).indexOf("this is not json"), "offset after the Korean line is a byte offset");
    appendFileSync(path, `${half.slice(15)}\n`);
    const second = readPending(path, first.endOffset);
    assert.deepEqual(second.events.map((e) => e.event.type), ["command"]);
    assert.equal(second.endOffset, statSync(path).size);
    assert.equal(readPending(path, second.endOffset).events.length, 0);
  } finally {
    s.cleanup();
  }
});

test("a log that shrank (cleared or replaced) is read again from the start", () => {
  const s = sandbox();
  try {
    record(s.project.dir, s.env, start("s1"), cmd("s1", "ls"));
    const path = eventsPathFor(s.project.dir, s.env);
    const size = statSync(path).size;
    writeFileSync(path, "");
    record(s.project.dir, s.env, start("s2"));
    assert.equal(readPending(path, size).events.length, 1);
    assert.equal(readPending(join(s.project.dir, "nope.jsonl"), 5).endOffset, 5);
  } finally {
    s.cleanup();
  }
});

test("batches respect the per-request event limit and the byte limit", () => {
  const item = (bytes: number) => ({ event: start("s"), endOffset: 0, bytes });
  assert.equal(batches(Array.from({ length: BATCH_MAX_EVENTS * 2 + 1 }, () => item(10))).length, 3);
  assert.deepEqual(batches([item(2 * 1024 * 1024), item(2 * 1024 * 1024)]).map((b) => b.length), [1, 1], "two 2 MB events do not share a 3 MB request");
  assert.deepEqual(batches([]), []);
});

test("sync needs a login first", async () => {
  const s = sandbox();
  try {
    record(s.project.dir, s.env, start("s1"));
    const cloud = fakeCloud({});
    await assert.rejects(runSync(ioFor(s.env, cloud.fetch).io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false }), /ard login/);
    assert.equal(cloud.calls.length, 0);
  } finally {
    s.cleanup();
  }
});

test("the first upload to an organization needs explicit consent, and shows what would be sent; nothing is sent without it", async () => {
  const s = sandbox();
  try {
    signedIn(s.env);
    record(s.project.dir, s.env, start("s1"), cmd("s1", "ls"));
    const cloud = fakeCloud({ "POST /api/v1/orgs/acme/events": accepting });
    const t = ioFor(s.env, cloud.fetch);
    assert.equal(await runSync(t.io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: false, dryRun: false }), 1);
    assert.match(t.err.join("\n"), /--yes/);
    assert.match(t.err.join("\n"), /command output and file diffs/);
    assert.match(t.out.join("\n"), /2 events from 1 session/);
    assert.equal(cloud.calls.length, 0, "no request was made");
  } finally {
    s.cleanup();
  }
});

test("--dry-run shows the summary, sends nothing, and works even when not logged in", async () => {
  const s = sandbox();
  try {
    record(s.project.dir, s.env, start("s1"), cmd("s1", "ls"), cmd("s2", "pwd"));
    const cloud = fakeCloud({});
    const t = ioFor(s.env, cloud.fetch);
    assert.equal(await runSync(t.io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: false, dryRun: true }), 0);
    assert.match(t.out.join("\n"), /3 events from 2 sessions \(1 session_start, 2 command\)/);
    assert.match(t.out.join("\n"), /Dry run: nothing was sent/);
    assert.equal(cloud.calls.length, 0);
    assert.equal(existsSync(join(s.project.dir, ".ard", "cloud-sync.json")), false, "a dry run records no consent and no progress");
  } finally {
    s.cleanup();
  }
});

test("with consent it uploads, remembers how far it got, then sends only what is new", async () => {
  const s = sandbox();
  try {
    signedIn(s.env);
    record(s.project.dir, s.env, start("s1"), cmd("s1", "ls"));
    const cloud = fakeCloud({ "POST /api/v1/orgs/acme/events": accepting });
    const t1 = ioFor(s.env, cloud.fetch);
    assert.equal(await runSync(t1.io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false }), 0);
    assert.match(t1.out.join("\n"), /Uploaded 2 new events/);
    assert.equal(cloud.calls[0]!.auth, `Bearer ard_${"a".repeat(64)}`);
    assert.equal((cloud.calls[0]!.body!.events as unknown[]).length, 2);

    const t2 = ioFor(s.env, cloud.fetch);
    assert.equal(await runSync(t2.io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: false, dryRun: false }), 0, "no --yes needed again for the same organization");
    assert.match(t2.out.join("\n"), /Nothing new to upload/);
    assert.equal(cloud.calls.length, 1);

    record(s.project.dir, s.env, cmd("s1", "pwd"));
    const t3 = ioFor(s.env, cloud.fetch);
    await runSync(t3.io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: false, dryRun: false });
    assert.equal((cloud.calls[1]!.body!.events as unknown[]).length, 1, "only the new event");
  } finally {
    s.cleanup();
  }
});

test("consent is per organization: a different organization asks again", async () => {
  const s = sandbox();
  try {
    signedIn(s.env);
    record(s.project.dir, s.env, start("s1"));
    const cloud = fakeCloud({ "POST /api/v1/orgs/acme/events": accepting, "POST /api/v1/orgs/other/events": accepting });
    await runSync(ioFor(s.env, cloud.fetch).io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false });
    const t = ioFor(s.env, cloud.fetch);
    assert.equal(await runSync(t.io, { cwd: s.project.dir, server: SERVER, org: "other", yes: false, dryRun: false }), 1);
    assert.match(t.err.join("\n"), /--yes/);
  } finally {
    s.cleanup();
  }
});

test("large logs are sent in several requests", async () => {
  const s = sandbox();
  try {
    signedIn(s.env);
    for (let i = 0; i < BATCH_MAX_EVENTS + 20; i++) record(s.project.dir, s.env, cmd("s1", `cmd ${i}`));
    const cloud = fakeCloud({ "POST /api/v1/orgs/acme/events": accepting });
    assert.equal(await runSync(ioFor(s.env, cloud.fetch).io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false }), 0);
    assert.deepEqual(cloud.calls.map((c) => (c.body!.events as unknown[]).length), [BATCH_MAX_EVENTS, 20]);
  } finally {
    s.cleanup();
  }
});

test("an interrupted sync loses nothing and repeats nothing: it resumes after the last batch that went through", async () => {
  const s = sandbox();
  try {
    signedIn(s.env);
    for (let i = 0; i < BATCH_MAX_EVENTS + 20; i++) record(s.project.dir, s.env, cmd("s1", `cmd ${i}`));
    let n = 0;
    const flaky = fakeCloud({ "POST /api/v1/orgs/acme/events": (body, call) => (++n === 2 ? { status: 503, json: { error: "try later" } } : accepting(body, call)) });
    await assert.rejects(runSync(ioFor(s.env, flaky.fetch).io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false }), /try later.*will go next time/s);
    const steady = fakeCloud({ "POST /api/v1/orgs/acme/events": accepting });
    assert.equal(await runSync(ioFor(s.env, steady.fetch).io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: false, dryRun: false }), 0);
    assert.equal((steady.calls[0]!.body!.events as unknown[]).length, 20, "only the part that had not gone through");
  } finally {
    s.cleanup();
  }
});

test("a free-plan organization is refused with the server's explanation, and progress is NOT recorded", async () => {
  const s = sandbox();
  try {
    signedIn(s.env);
    record(s.project.dir, s.env, start("s1"));
    const paywall = fakeCloud({ "POST /api/v1/orgs/acme/events": () => ({ status: 402, json: { error: "This organization is on the free plan. Cloud sync needs an active Team subscription.", code: "payment_required" } }) });
    await assert.rejects(runSync(ioFor(s.env, paywall.fetch).io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false }), /free plan/);
    const ok = fakeCloud({ "POST /api/v1/orgs/acme/events": accepting });
    await runSync(ioFor(s.env, ok.fetch).io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false });
    assert.equal((ok.calls[0]!.body!.events as unknown[]).length, 1, "after subscribing, everything is still there to upload");
  } finally {
    s.cleanup();
  }
});

test("expired logins and rate limits give actionable messages", async () => {
  const s = sandbox();
  try {
    signedIn(s.env);
    record(s.project.dir, s.env, start("s1"));
    const expired = fakeCloud({ "POST /api/v1/orgs/acme/events": () => ({ status: 401, json: { error: "Not signed in.", code: "unauthenticated" } }) });
    await assert.rejects(runSync(ioFor(s.env, expired.fetch).io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false }), /Run: ard login/);
    const limited = fakeCloud({ "POST /api/v1/orgs/acme/events": () => ({ status: 429, json: { error: "Uploading too fast.", code: "rate_limited", retry_after: 30 } }) });
    await assert.rejects(runSync(ioFor(s.env, limited.fetch).io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false }), /Try again in 30s/);
  } finally {
    s.cleanup();
  }
});

test("events the server refuses for good are reported and not retried forever; review decisions are explained", async () => {
  const s = sandbox();
  try {
    signedIn(s.env);
    record(s.project.dir, s.env, start("s1"), cmd("s1", "ls"));
    const refusing = fakeCloud({ "POST /api/v1/orgs/acme/events": () => ({ json: { accepted: 1, duplicates: 0, droppedReviews: 2, rejected: [{ index: 1, reason: "this session was uploaded by another member" }] } }) });
    const t = ioFor(s.env, refusing.fetch);
    assert.equal(await runSync(t.io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false }), 1);
    assert.match(t.err.join("\n"), /another member/);
    assert.match(t.out.join("\n"), /2 review decision\(s\) were not uploaded/);
    const again = ioFor(s.env, refusing.fetch);
    await runSync(again.io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: false, dryRun: false });
    assert.match(again.out.join("\n"), /Nothing new/);
  } finally {
    s.cleanup();
  }
});

test("without --org, the only organization is used; none or several are explained", async () => {
  const s = sandbox();
  try {
    signedIn(s.env);
    record(s.project.dir, s.env, start("s1"));
    const org = (slug: string) => ({ slug, name: slug, role: "member", plan: { active: true, reason: "active", until: null } });
    const one = fakeCloud({ "GET /api/v1/me": () => ({ json: { user: { email: "d@x.com" }, organizations: [org("acme")] } }), "POST /api/v1/orgs/acme/events": accepting });
    assert.equal(await runSync(ioFor(s.env, one.fetch).io, { cwd: s.project.dir, server: SERVER, yes: true, dryRun: false }), 0);
    const none = fakeCloud({ "GET /api/v1/me": () => ({ json: { user: { email: "d@x.com" }, organizations: [] } }) });
    await assert.rejects(runSync(ioFor(s.env, none.fetch).io, { cwd: s.project.dir, server: SERVER, yes: true, dryRun: false }), /do not belong to an organization/);
    const many = fakeCloud({ "GET /api/v1/me": () => ({ json: { user: { email: "d@x.com" }, organizations: [org("a"), org("b")] } }) });
    await assert.rejects(runSync(ioFor(s.env, many.fetch).io, { cwd: s.project.dir, server: SERVER, yes: true, dryRun: false }), /several organizations \(a, b\).*--org/);
  } finally {
    s.cleanup();
  }
});

test("a damaged progress file stops the sync instead of silently re-uploading or skipping", async () => {
  const s = sandbox();
  try {
    signedIn(s.env);
    record(s.project.dir, s.env, start("s1"));
    writeFileSync(join(s.project.dir, ".ard", "cloud-sync.json"), "{ nope");
    await assert.rejects(runSync(ioFor(s.env, fakeCloud({}).fetch).io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false }), /is damaged/);
  } finally {
    s.cleanup();
  }
});

// -------------------------------------------------------- through the CLI

function cliIo(env: NodeJS.ProcessEnv, cwd: string, fetch: CloudFetch): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => out.push(t), err: (t) => err.push(t), readStdin: async () => "", cwd, env, fetch, sleep: async () => {}, now: () => new Date("2026-11-15T10:00:00Z") }, out, err };
}

test("`ard sync` and friends through main(): flags are parsed, errors become messages and exit code 1", async () => {
  const s = sandbox();
  try {
    const unlocked = { ...s.env, ARD_UNRELEASED_CLOUD: "1" }; // the team commands are blocked without this developer switch
    const env = { ...unlocked, ARD_CLOUD_URL: SERVER };
    signedIn(env);
    record(s.project.dir, env, start("s1"));
    const cloud = fakeCloud({ "POST /api/v1/orgs/acme/events": accepting, "GET /api/v1/me": () => ({ json: ME }) });
    const sync = cliIo(env, s.project.dir, cloud.fetch);
    assert.equal(await main(["sync", "--org", "acme", "--yes"], sync.io), 0);
    assert.match(sync.out.join("\n"), /Uploaded 1 new event/);
    const who = cliIo(env, s.project.dir, cloud.fetch);
    assert.equal(await main(["whoami"], who.io), 0);

    const noServer = cliIo(unlocked, s.project.dir, cloud.fetch);
    assert.equal(await main(["sync"], noServer.io), 1);
    assert.match(noServer.err.join(""), /No cloud server given/);

    const insecure = cliIo(unlocked, s.project.dir, cloud.fetch);
    assert.equal(await main(["login", "--server", "http://evil.example.com"], insecure.io), 1);
    assert.match(insecure.err.join(""), /must use https/);

    const bad = cliIo(env, s.project.dir, cloud.fetch);
    assert.equal(await main(["sync", "--bogus"], bad.io), 2);
    assert.equal(cloud.calls.length, 2, "only the upload and whoami went out: nothing was sent for the rejected invocations");
  } finally {
    s.cleanup();
  }
});

test("screenshots are never uploaded: they are counted, skipped, and the user is told they stay on this machine", async () => {
  const s = sandbox();
  try {
    const shot: ArdEvent = { ...baseFields(ctx("s1")), type: "screenshot", imageId: "a".repeat(64), mediaType: "image/png", bytes: 1234, source: "hook" };
    record(s.project.dir, s.env, start("s1"), shot, cmd("s1", "ls"), { ...shot, id: "22222222-2222-4222-8222-222222222222" });
    const dry = ioFor(s.env, fakeCloud({}).fetch);
    assert.equal(await runSync(dry.io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: false, dryRun: true }), 0);
    assert.match(dry.out.join("\n"), /2 events from 1 session \(1 session_start, 1 command\)/, "the summary counts only what would be sent");
    assert.match(dry.out.join("\n"), /2 screenshots stay on this machine/);

    signedIn(s.env);
    const sent: unknown[] = [];
    const cloud = fakeCloud({ "GET /api/v1/me": () => ({ json: ME }), "POST /api/v1/orgs/acme/events": (body) => (sent.push(...(body!.events as unknown[])), { json: { accepted: (body!.events as unknown[]).length, duplicates: 0, droppedReviews: 0, rejected: [] } }) });
    const t = ioFor(s.env, cloud.fetch);
    assert.equal(await runSync(t.io, { cwd: s.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false }), 0, t.err.join("\n"));
    assert.equal(sent.length, 2);
    assert.equal(JSON.stringify(sent).includes("screenshot"), false, "no screenshot event, and no image id, leaves the machine");
    // A log that holds only screenshots has nothing to upload, and says why.
    const only = sandbox();
    try {
      record(only.project.dir, only.env, shot);
      signedIn(only.env);
      const t2 = ioFor(only.env, fakeCloud({ "GET /api/v1/me": () => ({ json: ME }) }).fetch);
      assert.equal(await runSync(t2.io, { cwd: only.project.dir, server: SERVER, org: "acme", yes: true, dryRun: false }), 0);
      assert.match(t2.out.join("\n"), /Nothing new to upload.*1 screenshot stays on this machine/);
    } finally {
      only.cleanup();
    }
  } finally {
    s.cleanup();
  }
});

test("the team commands are BLOCKED without the developer switch: they refuse, send nothing, and touch no files", async () => {
  const s = sandbox();
  try {
    const env = { ...s.env, ARD_CLOUD_URL: SERVER }; // a server is configured and a login is saved: still blocked
    signedIn(env);
    record(s.project.dir, env, start("s1"));
    const cloud = fakeCloud({ "POST /api/v1/orgs/acme/events": accepting, "GET /api/v1/me": () => ({ json: ME }) });
    const before = JSON.stringify(existsSync(join(s.project.dir, ".ard", "cloud-sync.json")));
    for (const argv of [["login"], ["logout"], ["whoami"], ["sync", "--org", "acme", "--yes"], ["sync", "--dry-run"]]) {
      for (const value of [undefined, "", "0", "true", "yes"]) {
        const h = cliIo({ ...env, ...(value === undefined ? {} : { ARD_UNRELEASED_CLOUD: value }) }, s.project.dir, cloud.fetch);
        assert.equal(await main(argv, h.io), 1, `${argv.join(" ")} with switch=${JSON.stringify(value)}`);
        assert.match(h.err.join(""), /not available yet\. Paid plans are still in planning/);
        assert.equal(h.out.length, 0);
      }
    }
    assert.equal(cloud.calls.length, 0, "nothing went out");
    assert.equal(JSON.stringify(existsSync(join(s.project.dir, ".ard", "cloud-sync.json"))), before, "no sync state was written");
  } finally {
    s.cleanup();
  }
});

test("the help text does not advertise the team commands", () => {
  for (const word of ["ard login", "ard logout", "ard whoami", "ard sync", "Team workspace", "paid", "credentials.json", "ARD_CLOUD_URL"]) {
    assert.equal(HELP.includes(word), false, word);
  }
});

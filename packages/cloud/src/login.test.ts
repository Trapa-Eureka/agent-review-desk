import { test } from "node:test";
import assert from "node:assert/strict";
import { principalFromSession } from "./auth.js";
import { CloudError } from "./errors.js";
import { LOGIN_STATE_TTL_MS, SSO_SECRET_PURPOSE, beginPlatformLogin, beginSsoLogin, callbackUrl, completeLogin, safeReturnTo, saveSsoSettings, type LoginDeps, type PlatformLoginConfig } from "./login.js";
import { unseal } from "./crypto.js";
import { TEST_SECRET, makeHarness, mockIdp } from "./testkit.js";

const BASE = "https://cloud.example.com";
const PLATFORM: PlatformLoginConfig = { issuer: "https://accounts.example.com", clientId: "platform-client", clientSecret: "platform-secret", label: "Example" };

const throwsCloud = (promise: Promise<unknown>, code: string, pattern?: RegExp) =>
  assert.rejects(promise, (e: unknown) => e instanceof CloudError && e.code === code && (!pattern || pattern.test(e.message)), `expected ${code}${pattern ? ` /${pattern.source}/` : ""}`);

function setup() {
  const h = makeHarness();
  const platformIdp = mockIdp({ issuer: PLATFORM.issuer, clientSecret: PLATFORM.clientSecret, now: h.clock.now });
  const companyIdp = mockIdp({ issuer: "https://login.acme.com", clientSecret: "acme-secret", now: h.clock.now });
  const idps = new Map([[PLATFORM.issuer, platformIdp], [companyIdp.issuer, companyIdp]]);
  const deps: LoginDeps = {
    control: h.control,
    secret: TEST_SECRET,
    baseUrl: BASE,
    oidc: {
      fetch: (url, init) => idps.get(new URL(url).origin)!.fetch(url, init),
      resolve: async () => ["93.184.216.34"],
      now: h.clock.now,
    },
  };
  const owner = h.user("owner@acme.com");
  const org = h.org(owner, "acme");
  return { h, deps, platformIdp, companyIdp, owner, org, ownerP: h.principal(owner) };
}

type Setup = ReturnType<typeof setup>;
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

async function signInPlatform(s: Setup, claims: Parameters<ReturnType<typeof mockIdp>["issueCode"]>[2] = {}, returnTo = "/") {
  const url = await beginPlatformLogin(s.deps, PLATFORM, returnTo);
  const code = s.platformIdp.issueCode(url, PLATFORM.clientId, claims);
  return completeLogin(s.deps, PLATFORM, { state: stateOf(url), code, error: null });
}

async function configureSso(s: Setup, over: Partial<{ emailDomain: string; defaultRole: string }> = {}) {
  await saveSsoSettings(s.deps, s.ownerP, s.org.id, { issuer: s.companyIdp.issuer, clientId: "acme-client", clientSecret: "acme-secret", emailDomain: "acme.com", defaultRole: "member", ...over });
}

async function signInSso(s: Setup, claims: Parameters<ReturnType<typeof mockIdp>["issueCode"]>[2] = {}) {
  const url = await beginSsoLogin(s.deps, "acme", "/o/acme");
  const code = s.companyIdp.issueCode(url, "acme-client", claims);
  return completeLogin(s.deps, null, { state: stateOf(url), code, error: null });
}

// -------------------------------------------------------------- return_to

test("only same-site relative paths may be returned to after login (no open redirect)", () => {
  for (const ok of ["/", "/o/acme", "/o/acme/billing?x=1", "/device?code=ABCD-EFGH"]) assert.equal(safeReturnTo(ok), ok);
  for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "evil.com", "", null, undefined, "/ok\r\nSet-Cookie: x=1", "/ok\nx"]) assert.equal(safeReturnTo(bad), "/", String(bad));
  assert.equal(callbackUrl("https://cloud.example.com/"), "https://cloud.example.com/api/auth/callback");
});

// --------------------------------------------------------- platform login

test("platform login: the browser is sent to the provider with PKCE, state and nonce, and comes back signed in", async () => {
  const s = setup();
  try {
    const url = await beginPlatformLogin(s.deps, PLATFORM, "/o/acme");
    const p = new URL(url).searchParams;
    assert.equal(new URL(url).origin, PLATFORM.issuer);
    assert.deepEqual([p.get("client_id"), p.get("redirect_uri"), p.get("code_challenge_method")], ["platform-client", `${BASE}/api/auth/callback`, "S256"]);
    assert.ok(p.get("state")!.length >= 32 && p.get("nonce")!.length >= 32);
    const result = await signInPlatform(s, { email: "dana@example.com", subject: "g-1", name: "Dana" }, "/o/acme");
    assert.deepEqual([result.user.email, result.user.name, result.returnTo, result.orgSlug], ["dana@example.com", "Dana", "/o/acme", null]);
    assert.equal(principalFromSession(s.h.control, result.sessionToken)?.user.id, result.user.id);
  } finally {
    s.h.cleanup();
  }
});

test("platform login: signing in again with the same identity is the same user, not a new one", async () => {
  const s = setup();
  try {
    const first = await signInPlatform(s, { email: "dana@example.com", subject: "g-1" });
    const second = await signInPlatform(s, { email: "dana@example.com", subject: "g-1" });
    assert.equal(second.user.id, first.user.id);
    assert.notEqual(second.sessionToken, first.sessionToken);
  } finally {
    s.h.cleanup();
  }
});

test("platform login requires a VERIFIED e-mail: unverified, unknown and missing are all refused", async () => {
  const s = setup();
  try {
    await throwsCloud(signInPlatform(s, { email: "dana@example.com", emailVerified: false }), "unauthenticated", /not verified/);
    await throwsCloud(signInPlatform(s, { email: "dana@example.com", emailVerified: null }), "unauthenticated", /not verified/);
    await throwsCloud(signInPlatform(s, { email: null }), "unauthenticated", /did not share an e-mail/);
    assert.equal(s.h.control.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'dana@example.com'").get()!.n, 0, "no account was created");
  } finally {
    s.h.cleanup();
  }
});

test("a login attempt can complete only once, and only before it expires", async () => {
  const s = setup();
  try {
    const url = await beginPlatformLogin(s.deps, PLATFORM, "/");
    const code1 = s.platformIdp.issueCode(url, PLATFORM.clientId, {});
    await completeLogin(s.deps, PLATFORM, { state: stateOf(url), code: code1, error: null });
    const code2 = s.platformIdp.issueCode(url, PLATFORM.clientId, {});
    await throwsCloud(completeLogin(s.deps, PLATFORM, { state: stateOf(url), code: code2, error: null }), "unauthenticated", /expired or was already used/);

    const stale = await beginPlatformLogin(s.deps, PLATFORM, "/");
    s.h.clock.advance(LOGIN_STATE_TTL_MS + 1);
    await throwsCloud(completeLogin(s.deps, PLATFORM, { state: stateOf(stale), code: s.platformIdp.issueCode(stale, PLATFORM.clientId, {}), error: null }), "unauthenticated", /expired/);
  } finally {
    s.h.cleanup();
  }
});

test("ATTACK: a callback with a state we never issued (login CSRF) is refused", async () => {
  const s = setup();
  try {
    const url = await beginPlatformLogin(s.deps, PLATFORM, "/");
    const code = s.platformIdp.issueCode(url, PLATFORM.clientId, {});
    await throwsCloud(completeLogin(s.deps, PLATFORM, { state: "attacker-state", code, error: null }), "unauthenticated");
    await throwsCloud(completeLogin(s.deps, PLATFORM, { state: null, code, error: null }), "bad_request");
    await throwsCloud(completeLogin(s.deps, PLATFORM, { state: stateOf(url), code: null, error: null }), "bad_request");
    await throwsCloud(completeLogin(s.deps, PLATFORM, { state: stateOf(url), code, error: "access_denied" }), "unauthenticated");
  } finally {
    s.h.cleanup();
  }
});

test("ATTACK: an ID token minted for a different login attempt (wrong nonce) is refused", async () => {
  const s = setup();
  try {
    const mine = await beginPlatformLogin(s.deps, PLATFORM, "/");
    const theirs = await beginPlatformLogin(s.deps, PLATFORM, "/");
    const codeForTheirs = s.platformIdp.issueCode(theirs, PLATFORM.clientId, { email: "victim@example.com" });
    await throwsCloud(completeLogin(s.deps, PLATFORM, { state: stateOf(mine), code: codeForTheirs, error: null }), "unauthenticated");
  } finally {
    s.h.cleanup();
  }
});

test("platform login when the server has no provider configured is unavailable, not a crash", async () => {
  const s = setup();
  try {
    const url = await beginPlatformLogin(s.deps, PLATFORM, "/");
    await throwsCloud(completeLogin(s.deps, null, { state: stateOf(url), code: s.platformIdp.issueCode(url, PLATFORM.clientId, {}), error: null }), "unavailable");
  } finally {
    s.h.cleanup();
  }
});

// ------------------------------------------------------------ SSO settings

test("saving SSO settings validates input, proves the issuer is reachable, and stores the secret ENCRYPTED", async () => {
  const s = setup();
  try {
    await configureSso(s);
    const stored = s.h.control.getSsoConfig(s.org.id)!;
    assert.deepEqual([stored.issuer, stored.clientId, stored.emailDomain, stored.defaultRole], ["https://login.acme.com", "acme-client", "acme.com", "member"]);
    assert.equal(stored.clientSecretSealed.includes("acme-secret"), false);
    assert.equal(unseal(TEST_SECRET, SSO_SECRET_PURPOSE, stored.clientSecretSealed), "acme-secret");
    assert.ok(s.h.control.listAudit(s.org.id).some((a) => a.action === "sso.configured"));
  } finally {
    s.h.cleanup();
  }
});

test("SSO settings reject bad domains, roles, empty fields, and an issuer that is internal or not an OpenID provider", async () => {
  const s = setup();
  try {
    const input = { issuer: s.companyIdp.issuer, clientId: "c", clientSecret: "s", emailDomain: "acme.com", defaultRole: "member" };
    for (const emailDomain of ["", "acme", "acme.", "ac me.com", "-acme.com", "acme.com/evil", "@@acme.com", "a".repeat(300) + ".com"]) await throwsCloud(saveSsoSettings(s.deps, s.ownerP, s.org.id, { ...input, emailDomain }), "bad_request");
    await throwsCloud(saveSsoSettings(s.deps, s.ownerP, s.org.id, { ...input, defaultRole: "owner" }), "bad_request", /default role/);
    await throwsCloud(saveSsoSettings(s.deps, s.ownerP, s.org.id, { ...input, clientId: "  " }), "bad_request");
    await throwsCloud(saveSsoSettings(s.deps, s.ownerP, s.org.id, { ...input, clientSecret: "" }), "bad_request");
    await throwsCloud(saveSsoSettings(s.deps, s.ownerP, s.org.id, { ...input, issuer: "https://169.254.169.254" }), "bad_request");
    await throwsCloud(saveSsoSettings(s.deps, s.ownerP, s.org.id, { ...input, issuer: "http://login.acme.com" }), "bad_request");
    assert.equal(s.h.control.getSsoConfig(s.org.id), null, "nothing was saved");
    await saveSsoSettings(s.deps, s.ownerP, s.org.id, { ...input, emailDomain: "@Acme.COM" });
    assert.equal(s.h.control.getSsoConfig(s.org.id)!.emailDomain, "acme.com", "normalized");
  } finally {
    s.h.cleanup();
  }
});

test("SSO login is unavailable until an owner configures it", async () => {
  const s = setup();
  try {
    await throwsCloud(beginSsoLogin(s.deps, "acme", "/"), "not_found", /not set up/);
    await throwsCloud(beginSsoLogin(s.deps, "no-such-org", "/"), "not_found");
  } finally {
    s.h.cleanup();
  }
});

// ---------------------------------------------------------------- SSO login

test("SSO: a company employee is created as a user scoped to that organization, with the default role", async () => {
  const s = setup();
  try {
    await configureSso(s, { defaultRole: "reviewer" });
    const result = await signInSso(s, { email: "Erin@Acme.com", subject: "okta-7", name: "Erin" });
    assert.equal(result.user.email, "erin@acme.com");
    assert.equal(result.user.homeOrgId, s.org.id);
    assert.equal(result.orgSlug, "acme");
    assert.equal(s.h.control.getRole(s.org.id, result.user.id), "reviewer");
    assert.equal(s.h.control.getWebSession(result.sessionToken)?.ssoOrgId, s.org.id);
    assert.ok(s.h.control.listAudit(s.org.id).some((a) => a.action === "member.provisioned"));
  } finally {
    s.h.cleanup();
  }
});

test("SSO: signing in again is the same person (no duplicate), and the role an admin set is kept", async () => {
  const s = setup();
  try {
    await configureSso(s);
    const first = await signInSso(s, { email: "erin@acme.com", subject: "okta-7" });
    s.h.control.setRole(s.org.id, first.user.id, "admin");
    const second = await signInSso(s, { email: "erin@acme.com", subject: "okta-7" });
    assert.equal(second.user.id, first.user.id);
    assert.equal(s.h.control.getRole(s.org.id, first.user.id), "admin");
  } finally {
    s.h.cleanup();
  }
});

test("SSO: someone an admin removed is re-provisioned only because the company's IdP still vouches for them", async () => {
  const s = setup();
  try {
    await configureSso(s);
    const first = await signInSso(s, { email: "erin@acme.com", subject: "okta-7" });
    s.h.control.removeMember(s.org.id, first.user.id);
    await signInSso(s, { email: "erin@acme.com", subject: "okta-7" });
    assert.equal(s.h.control.getRole(s.org.id, first.user.id), "member");
  } finally {
    s.h.cleanup();
  }
});

test("ATTACK: a malicious company IdP claiming an existing platform user's e-mail does NOT take over that account", async () => {
  const s = setup();
  try {
    const victim = await signInPlatform(s, { email: "victim@acme.com", subject: "g-victim" });
    await configureSso(s); // the "company" (attacker-controlled IdP) is allowed to speak for @acme.com
    const attacker = await signInSso(s, { email: "victim@acme.com", subject: "attacker-controlled-subject" });
    assert.notEqual(attacker.user.id, victim.user.id, "a separate, organization-scoped account");
    assert.equal(attacker.user.homeOrgId, s.org.id);
    assert.equal(s.h.control.getRole(s.org.id, victim.user.id), null, "the victim's real account gained nothing in this organization");
    // The attacker's account cannot reach anything the victim has elsewhere.
    const elsewhere = s.h.org(victim.user, "victims-own");
    assert.equal(s.h.control.getRole(elsewhere.id, attacker.user.id), null);
    assert.equal(s.h.control.listOrgsForUser(attacker.user.id).length, 1);
  } finally {
    s.h.cleanup();
  }
});

test("SSO: only the configured e-mail domain may sign in, whatever the IdP says", async () => {
  const s = setup();
  try {
    await configureSso(s);
    await throwsCloud(signInSso(s, { email: "mallory@evil.com" }), "forbidden", /Only @acme\.com/);
    await throwsCloud(signInSso(s, { email: "mallory@acme.com.evil.com" }), "forbidden");
    await throwsCloud(signInSso(s, { email: "mallory@sub.acme.com" }), "forbidden");
    await throwsCloud(signInSso(s, { email: null }), "unauthenticated", /did not share an e-mail/);
  } finally {
    s.h.cleanup();
  }
});

test("SSO: an explicit email_verified=false is refused, while providers that never send the field are accepted", async () => {
  const s = setup();
  try {
    await configureSso(s);
    await throwsCloud(signInSso(s, { email: "erin@acme.com", emailVerified: false }), "unauthenticated", /not verified/);
    assert.ok(await signInSso(s, { email: "erin@acme.com", emailVerified: null }));
  } finally {
    s.h.cleanup();
  }
});

test("SSO: a changed client secret at the IdP, or removed settings, fail cleanly", async () => {
  const s = setup();
  try {
    await configureSso(s);
    const url = await beginSsoLogin(s.deps, "acme", "/");
    const code = s.companyIdp.issueCode(url, "acme-client", { email: "erin@acme.com" });
    s.h.control.removeSsoConfig(s.org.id);
    await throwsCloud(completeLogin(s.deps, null, { state: stateOf(url), code, error: null }), "unavailable", /no longer configured/);
    await saveSsoSettings(s.deps, s.ownerP, s.org.id, { issuer: s.companyIdp.issuer, clientId: "acme-client", clientSecret: "WRONG-secret", emailDomain: "acme.com", defaultRole: "member" });
    const url2 = await beginSsoLogin(s.deps, "acme", "/");
    await throwsCloud(completeLogin(s.deps, null, { state: stateOf(url2), code: s.companyIdp.issueCode(url2, "acme-client", { email: "erin@acme.com" }), error: null }), "unauthenticated", /invalid_client/);
  } finally {
    s.h.cleanup();
  }
});

test("removing SSO also switches enforcement off, so nobody is locked out by a configuration that no longer exists", async () => {
  const s = setup();
  try {
    await configureSso(s);
    s.h.control.setSsoEnforced(s.org.id, true);
    s.h.control.removeSsoConfig(s.org.id);
    assert.equal(s.h.control.getOrg(s.org.id)!.ssoEnforced, false);
  } finally {
    s.h.cleanup();
  }
});

test("the stored SSO secret cannot be read with a different server secret (rotating ARD_CLOUD_SECRET forces re-entry)", async () => {
  const s = setup();
  try {
    await configureSso(s);
    const rotated = { ...s.deps, secret: "a-completely-different-server-secret-value" };
    await throwsCloud(beginSsoLogin(rotated, "acme", "/"), "unavailable", /save the SSO settings again/);
  } finally {
    s.h.cleanup();
  }
});

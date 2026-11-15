import { test } from "node:test";
import assert from "node:assert/strict";
import type { SubscriptionSnapshot } from "@ard/billing";
import { DEVICE_INTERVAL_S, DEVICE_TTL_MS, decideDeviceLogin, orgEntitlement, pollDeviceLogin, principalFromBearer, principalFromSession, requireEntitled, requireOrgAccess, startDeviceLogin } from "./auth.js";
import { CloudError } from "./errors.js";
import { RateLimiter } from "./limits.js";
import { makeHarness } from "./testkit.js";

const throwsCloud = (fn: () => unknown, code: string, pattern?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof CloudError && e.code === code && (!pattern || pattern.test(e.message)), `expected ${code}`);

const BASE = "https://cloud.example.com/";

// ------------------------------------------------------------ device login

test("starting a device login returns a secret device code, a short user code and where to confirm", () => {
  const h = makeHarness();
  try {
    const start = startDeviceLogin(h.control, BASE);
    assert.match(start.deviceCode, /^[0-9a-f]{64}$/);
    assert.match(start.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(start.verificationUri, "https://cloud.example.com/device");
    assert.equal(start.verificationUriComplete, `https://cloud.example.com/device?code=${start.userCode}`);
    assert.equal(start.expiresIn, DEVICE_TTL_MS / 1000);
    assert.equal(start.interval, DEVICE_INTERVAL_S);
  } finally {
    h.cleanup();
  }
});

test("the device code is stored only as a hash", () => {
  const h = makeHarness();
  try {
    const start = startDeviceLogin(h.control, BASE);
    const rows = h.control.db.prepare("SELECT * FROM device_codes").all();
    assert.equal(JSON.stringify(rows).includes(start.deviceCode), false);
  } finally {
    h.cleanup();
  }
});

test("the full flow: pending, approved by a person, one token, and never a second one", () => {
  const h = makeHarness();
  try {
    const alice = h.user("alice@example.com");
    const limiter = new RateLimiter(10, 600_000, () => h.clock.now().getTime());
    const start = startDeviceLogin(h.control, BASE);

    assert.deepEqual(pollDeviceLogin(h.control, start.deviceCode, h.clock.now()), { status: "pending" });
    decideDeviceLogin(h.control, limiter, alice, start.userCode.toLowerCase().replace("-", " "), "approved"); // typed sloppily
    h.clock.advance(6_000);
    const approved = pollDeviceLogin(h.control, start.deviceCode, h.clock.now());
    assert.equal(approved.status, "approved");
    if (approved.status !== "approved") return;
    assert.match(approved.token, /^ard_[0-9a-f]{64}$/);
    assert.equal(approved.user.id, alice.id);

    h.clock.advance(6_000);
    assert.deepEqual(pollDeviceLogin(h.control, start.deviceCode, h.clock.now()), { status: "invalid" }, "the code is single use");
    assert.equal(h.control.db.prepare("SELECT COUNT(*) AS n FROM api_tokens").get()!.n, 1);
  } finally {
    h.cleanup();
  }
});

test("polling faster than the interval is told to slow down", () => {
  const h = makeHarness();
  try {
    const start = startDeviceLogin(h.control, BASE);
    assert.equal(pollDeviceLogin(h.control, start.deviceCode, h.clock.now()).status, "pending");
    h.clock.advance(1_000);
    assert.equal(pollDeviceLogin(h.control, start.deviceCode, h.clock.now()).status, "slow_down");
    h.clock.advance(1_000);
    assert.equal(pollDeviceLogin(h.control, start.deviceCode, h.clock.now()).status, "slow_down", "hammering keeps being refused");
    h.clock.advance(DEVICE_INTERVAL_S * 1000);
    assert.equal(pollDeviceLogin(h.control, start.deviceCode, h.clock.now()).status, "pending");
  } finally {
    h.cleanup();
  }
});

test("a refused login reports denied, and an expired one reports expired", () => {
  const h = makeHarness();
  try {
    const alice = h.user("alice@example.com");
    const limiter = new RateLimiter(10, 600_000);
    const denied = startDeviceLogin(h.control, BASE);
    decideDeviceLogin(h.control, limiter, alice, denied.userCode, "denied");
    h.clock.advance(6_000);
    assert.equal(pollDeviceLogin(h.control, denied.deviceCode, h.clock.now()).status, "denied");

    const late = startDeviceLogin(h.control, BASE);
    h.clock.advance(DEVICE_TTL_MS + 1);
    assert.equal(pollDeviceLogin(h.control, late.deviceCode, h.clock.now()).status, "expired");
    throwsCloud(() => decideDeviceLogin(h.control, limiter, alice, late.userCode, "approved"), "conflict", /expired|already used/);
  } finally {
    h.cleanup();
  }
});

test("unknown device codes are invalid, and an already-decided code cannot be decided again", () => {
  const h = makeHarness();
  try {
    const alice = h.user("alice@example.com");
    const limiter = new RateLimiter(10, 600_000);
    assert.equal(pollDeviceLogin(h.control, "0".repeat(64), h.clock.now()).status, "invalid");
    assert.equal(pollDeviceLogin(h.control, "", h.clock.now()).status, "invalid");
    const start = startDeviceLogin(h.control, BASE);
    decideDeviceLogin(h.control, limiter, alice, start.userCode, "approved");
    throwsCloud(() => decideDeviceLogin(h.control, limiter, h.user("mallory@example.com"), start.userCode, "denied"), "conflict");
  } finally {
    h.cleanup();
  }
});

test("guessing codes is rate limited per user: this is what stops an attacker approving a victim's pending login into their own account", () => {
  const h = makeHarness();
  try {
    const mallory = h.user("mallory@example.com");
    const limiter = new RateLimiter(10, 600_000, () => h.clock.now().getTime());
    for (let i = 0; i < 10; i++) throwsCloud(() => decideDeviceLogin(h.control, limiter, mallory, `BCDF-GH${i}K`, "approved"), "not_found");
    throwsCloud(() => decideDeviceLogin(h.control, limiter, mallory, "BCDF-GHJK", "approved"), "rate_limited");
    // Another person is not affected by Mallory's attempts.
    throwsCloud(() => decideDeviceLogin(h.control, limiter, h.user("alice@example.com"), "BCDF-GHJK", "approved"), "not_found");
    // ...and the limit lifts after the window.
    h.clock.advance(600_001);
    throwsCloud(() => decideDeviceLogin(h.control, limiter, mallory, "BCDF-GHJK", "approved"), "not_found");
  } finally {
    h.cleanup();
  }
});

test("a malformed code counts as a guess too", () => {
  const h = makeHarness();
  try {
    const mallory = h.user("mallory@example.com");
    const limiter = new RateLimiter(2, 600_000);
    throwsCloud(() => decideDeviceLogin(h.control, limiter, mallory, "", "approved"), "not_found");
    throwsCloud(() => decideDeviceLogin(h.control, limiter, mallory, "!!!", "approved"), "not_found");
    throwsCloud(() => decideDeviceLogin(h.control, limiter, mallory, "AAAA-AAAA", "approved"), "rate_limited");
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------------ credentials

test("a bearer token authenticates its user; it is stored only as a hash", () => {
  const h = makeHarness();
  try {
    const alice = h.user("alice@example.com");
    const { token, id } = h.control.createApiToken(alice.id, "laptop");
    assert.equal(principalFromBearer(h.control, `Bearer ${token}`)?.user.id, alice.id);
    assert.equal(principalFromBearer(h.control, `Bearer ${token}`)?.via, "token");
    assert.equal(JSON.stringify(h.control.db.prepare("SELECT * FROM api_tokens").all()).includes(token), false);
    assert.equal(h.control.revokeApiToken(id, alice.id), true);
    assert.equal(principalFromBearer(h.control, `Bearer ${token}`), null, "revoked");
  } finally {
    h.cleanup();
  }
});

test("only the owner of a token can revoke it; tokens can expire", () => {
  const h = makeHarness();
  try {
    const alice = h.user("alice@example.com");
    const mallory = h.user("mallory@example.com");
    const { token, id } = h.control.createApiToken(alice.id, "laptop");
    assert.equal(h.control.revokeApiToken(id, mallory.id), false);
    assert.ok(principalFromBearer(h.control, `Bearer ${token}`));
    const short = h.control.createApiToken(alice.id, "short", 1000);
    h.clock.advance(1001);
    assert.equal(principalFromBearer(h.control, `Bearer ${short.token}`), null);
  } finally {
    h.cleanup();
  }
});

test("malformed or wrong authorization headers never authenticate", () => {
  const h = makeHarness();
  try {
    const alice = h.user("alice@example.com");
    const { token } = h.control.createApiToken(alice.id, "t");
    for (const header of [null, undefined, "", "Bearer", "Bearer ", `bearer ${token}`, token, `Basic ${token}`, `Bearer ${token}x`, `Bearer ${token.slice(0, -1)}`, `Bearer ard_${"0".repeat(64)}`, "Bearer ard_<script>"]) {
      assert.equal(principalFromBearer(h.control, header), null, String(header));
    }
  } finally {
    h.cleanup();
  }
});

test("web sessions: valid until they expire, and gone after logout", () => {
  const h = makeHarness();
  try {
    const alice = h.user("alice@example.com");
    const cookie = h.control.createWebSession(alice.id, 60_000);
    assert.equal(principalFromSession(h.control, cookie)?.user.id, alice.id);
    assert.equal(principalFromSession(h.control, "nonsense"), null);
    assert.equal(principalFromSession(h.control, null), null);
    assert.equal(JSON.stringify(h.control.db.prepare("SELECT * FROM web_sessions").all()).includes(cookie), false, "stored hashed");
    h.clock.advance(60_001);
    assert.equal(principalFromSession(h.control, cookie), null, "expired");
    const again = h.control.createWebSession(alice.id, 60_000);
    h.control.deleteWebSession(again);
    assert.equal(principalFromSession(h.control, again), null);
  } finally {
    h.cleanup();
  }
});

// --------------------------------------------------------- organization gate

function team() {
  const h = makeHarness();
  const owner = h.user("owner@example.com");
  const org = h.org(owner, "acme");
  const users = { owner, admin: h.user("admin@x.com"), reviewer: h.user("reviewer@x.com"), member: h.user("member@x.com"), outsider: h.user("outsider@x.com") };
  h.control.addMember(org.id, users.admin.id, "admin");
  h.control.addMember(org.id, users.reviewer.id, "reviewer");
  h.control.addMember(org.id, users.member.id, "member");
  return { h, org, ...users };
}

test("members get through with the right role; the wrong role is forbidden", () => {
  const t = team();
  try {
    assert.equal(requireOrgAccess(t.h.control, t.h.principal(t.member), "acme", "view").role, "member");
    assert.equal(requireOrgAccess(t.h.control, t.h.principal(t.reviewer), "acme", "review").role, "reviewer");
    throwsCloud(() => requireOrgAccess(t.h.control, t.h.principal(t.member), "acme", "review"), "forbidden");
    throwsCloud(() => requireOrgAccess(t.h.control, t.h.principal(t.admin), "acme", "billing.manage"), "forbidden");
    assert.equal(requireOrgAccess(t.h.control, t.h.principal(t.owner), "acme", "billing.manage").role, "owner");
  } finally {
    t.h.cleanup();
  }
});

test("a non-member and a missing organization look exactly the same, so existence is not revealed", () => {
  const t = team();
  try {
    let a = "";
    let b = "";
    try {
      requireOrgAccess(t.h.control, t.h.principal(t.outsider), "acme", "view");
    } catch (e) {
      a = `${(e as CloudError).code}|${(e as CloudError).message}`;
    }
    try {
      requireOrgAccess(t.h.control, t.h.principal(t.outsider), "no-such-org", "view");
    } catch (e) {
      b = `${(e as CloudError).code}|${(e as CloudError).message}`;
    }
    assert.equal(a, "not_found|No such organization.");
    assert.equal(a, b);
  } finally {
    t.h.cleanup();
  }
});

test("a company-SSO account cannot reach any other organization, even one it was somehow added to", () => {
  const t = team();
  try {
    const other = t.h.org(t.h.user("boss@other.com"), "other");
    const sso = t.h.control.createSsoUser(other.id, "emp@other.com");
    t.h.control.addMember(other.id, sso.id, "member");
    t.h.control.addMember(t.org.id, sso.id, "member"); // a data error or attack: still must not work
    assert.equal(requireOrgAccess(t.h.control, t.h.principal(sso), "other", "view").role, "member");
    throwsCloud(() => requireOrgAccess(t.h.control, t.h.principal(sso), "acme", "view"), "not_found");
  } finally {
    t.h.cleanup();
  }
});

test("when SSO is enforced, password-style members are locked out but owners keep a break-glass way in", () => {
  const t = team();
  try {
    const sso = t.h.control.createSsoUser(t.org.id, "emp@acme.com");
    t.h.control.addMember(t.org.id, sso.id, "member");
    t.h.control.setSsoEnforced(t.org.id, true);
    throwsCloud(() => requireOrgAccess(t.h.control, t.h.principal(t.member), "acme", "view"), "forbidden", /single sign-on/);
    throwsCloud(() => requireOrgAccess(t.h.control, t.h.principal(t.admin), "acme", "view"), "forbidden", /single sign-on/);
    assert.equal(requireOrgAccess(t.h.control, t.h.principal(sso), "acme", "view").role, "member");
    assert.equal(requireOrgAccess(t.h.control, t.h.principal(t.owner), "acme", "view").role, "owner");
    t.h.control.setSsoEnforced(t.org.id, false);
    assert.equal(requireOrgAccess(t.h.control, t.h.principal(t.member), "acme", "view").role, "member");
  } finally {
    t.h.cleanup();
  }
});

// -------------------------------------------------------------- entitlement

const snapshot = (over: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  provider: "paddle",
  subscriptionId: "sub_1",
  customerId: "ctm_1",
  status: "active",
  currentPeriodEnd: "2026-12-15T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  checkoutNonce: null,
  transactionId: null,
  planRef: "pri_1",
  ...over,
});

test("a new organization is on the free plan: paid features are refused with payment_required", () => {
  const t = team();
  try {
    assert.deepEqual(orgEntitlement(t.org, t.h.clock.now()), { active: false, reason: "no_subscription", until: null });
    throwsCloud(() => requireEntitled(t.org, t.h.clock.now()), "payment_required", /Team subscription/);
  } finally {
    t.h.cleanup();
  }
});

test("an active subscription unlocks paid features; a lapsed one locks them again", () => {
  const t = team();
  try {
    t.h.control.applySubscription(t.org.id, snapshot(), "2026-11-15T10:00:00.000Z");
    const org = t.h.control.getOrg(t.org.id)!;
    assert.equal(orgEntitlement(org, t.h.clock.now()).active, true);
    assert.doesNotThrow(() => requireEntitled(org, t.h.clock.now()));

    t.h.control.applySubscription(t.org.id, snapshot({ status: "canceled", currentPeriodEnd: null }), "2026-11-16T10:00:00.000Z");
    throwsCloud(() => requireEntitled(t.h.control.getOrg(t.org.id)!, t.h.clock.now()), "payment_required");
  } finally {
    t.h.cleanup();
  }
});

test("a failed payment keeps access for the grace period, counted from the FIRST failure", () => {
  const t = team();
  try {
    t.h.control.applySubscription(t.org.id, snapshot({ status: "past_due" }), "2026-11-10T10:00:00.000Z");
    t.h.control.applySubscription(t.org.id, snapshot({ status: "past_due" }), "2026-11-14T10:00:00.000Z"); // a later retry failing must not restart the clock
    const org = t.h.control.getOrg(t.org.id)!;
    assert.equal(org.subPastDueSince, "2026-11-10T10:00:00.000Z");
    assert.equal(orgEntitlement(org, new Date("2026-11-15T10:00:00Z")).active, true);
    assert.equal(orgEntitlement(org, new Date("2026-11-18T10:00:00Z")).active, false, "7 days after the first failure");
  } finally {
    t.h.cleanup();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { INVITABLE_ROLES, ROLES, can, canChangeRole, canRemoveMember, isInvitableRole, isRole, type Action, type Role } from "./access.js";
import { newPkce, newUserCode, normalizeUserCode, randomToken, safeEqual, seal, sha256, unseal } from "./crypto.js";
import { RateLimiter } from "./limits.js";

const SECRET = "s".repeat(40);

// ------------------------------------------------------------------ crypto

test("seal/unseal round-trips, and the ciphertext does not contain the plaintext", () => {
  const sealed = seal(SECRET, "purpose", "client-secret-value");
  assert.equal(sealed.includes("client-secret-value"), false);
  assert.equal(unseal(SECRET, "purpose", sealed), "client-secret-value");
});

test("unseal refuses another secret, another purpose, tampering, truncation and junk", () => {
  const sealed = seal(SECRET, "purpose", "hello");
  assert.equal(unseal("t".repeat(40), "purpose", sealed), null);
  assert.equal(unseal(SECRET, "other-purpose", sealed), null);
  const parts = sealed.split(".");
  const flipped = [parts[0], parts[1], parts[2], Buffer.from("tampered").toString("base64url")].join(".");
  assert.equal(unseal(SECRET, "purpose", flipped), null);
  assert.equal(unseal(SECRET, "purpose", sealed.slice(0, -4)), null);
  for (const junk of ["", "v1", "v2.a.b.c", "not sealed at all", "v1...."]) assert.equal(unseal(SECRET, "purpose", junk), null, junk);
});

test("every seal is different (fresh IV) even for the same input", () => {
  assert.notEqual(seal(SECRET, "p", "same"), seal(SECRET, "p", "same"));
});

test("randomToken is hex of the requested size and never repeats", () => {
  assert.match(randomToken(), /^[0-9a-f]{64}$/);
  assert.match(randomToken(8), /^[0-9a-f]{16}$/);
  assert.equal(new Set(Array.from({ length: 200 }, () => randomToken())).size, 200);
});

test("sha256 is the standard digest and safeEqual compares in constant time without throwing on length mismatch", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});

test("user codes look like ABCD-EFGH, use only the unambiguous alphabet, and are accepted however typed", () => {
  for (let i = 0; i < 200; i++) {
    const code = newUserCode();
    assert.match(code, /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
    assert.equal(normalizeUserCode(code), code);
    assert.equal(normalizeUserCode(code.toLowerCase().replace("-", " ")), code);
    assert.equal(normalizeUserCode(code.replace("-", "")), code);
  }
  assert.equal(new Set(Array.from({ length: 500 }, newUserCode)).size, 500);
});

test("normalizeUserCode refuses wrong lengths and look-alike or vowel characters", () => {
  for (const bad of ["", "ABCD", "ABCD-EFGHI", "AEIO-UXYZ", "0123-4567", "ABCD-EFG!", "ABCD EFG"]) assert.equal(normalizeUserCode(bad), null, bad);
});

test("PKCE: the challenge is the S256 of the verifier, and fresh each time", async () => {
  const { createHash } = await import("node:crypto");
  const pkce = newPkce();
  assert.equal(pkce.challenge, createHash("sha256").update(pkce.verifier).digest("base64url"));
  assert.ok(pkce.verifier.length >= 43, "RFC 7636 minimum length");
  assert.notEqual(newPkce().verifier, pkce.verifier);
});

// ------------------------------------------------------------------ access

const ACTIONS: Action[] = ["view", "upload", "review", "members.manage", "audit.view", "billing.manage", "sso.manage"];
const EXPECTED: Record<Role, Action[]> = {
  owner: ["view", "upload", "review", "members.manage", "audit.view", "billing.manage", "sso.manage"],
  admin: ["view", "upload", "review", "members.manage", "audit.view"],
  reviewer: ["view", "upload", "review"],
  member: ["view", "upload"],
};

test("the permission matrix is exactly this, role by role", () => {
  for (const role of ROLES) {
    for (const action of ACTIONS) assert.equal(can(role, action), EXPECTED[role].includes(action), `${role} / ${action}`);
  }
});

test("no role means no permission", () => {
  for (const action of ACTIONS) {
    assert.equal(can(null, action), false);
    assert.equal(can(undefined, action), false);
  }
});

test("only owners handle billing and SSO; reviewers review but cannot manage people", () => {
  assert.deepEqual(ROLES.filter((r) => can(r, "billing.manage")), ["owner"]);
  assert.deepEqual(ROLES.filter((r) => can(r, "sso.manage")), ["owner"]);
  assert.deepEqual(ROLES.filter((r) => can(r, "review")), ["owner", "admin", "reviewer"]);
  assert.deepEqual(ROLES.filter((r) => can(r, "members.manage")), ["owner", "admin"]);
});

test("ownership is never granted by invitation; role guards", () => {
  assert.deepEqual([...INVITABLE_ROLES], ["admin", "reviewer", "member"]);
  assert.equal(isInvitableRole("owner"), false);
  assert.equal(isInvitableRole("admin"), true);
  assert.equal(isRole("owner"), true);
  assert.equal(isRole("root"), false);
  assert.equal(isRole(undefined), false);
});

test("role changes: owners can do anything, admins cannot touch or create owners, others cannot change roles", () => {
  assert.equal(canChangeRole("owner", "member", "owner"), true);
  assert.equal(canChangeRole("owner", "owner", "member"), true);
  assert.equal(canChangeRole("admin", "member", "reviewer"), true);
  assert.equal(canChangeRole("admin", "reviewer", "admin"), true);
  assert.equal(canChangeRole("admin", "member", "owner"), false, "admin must not mint owners");
  assert.equal(canChangeRole("admin", "owner", "member"), false, "admin must not demote owners");
  for (const actor of ["reviewer", "member", null] as const) assert.equal(canChangeRole(actor, "member", "reviewer"), false, String(actor));
});

test("removal: owners remove anyone, admins everyone but owners, others no one", () => {
  assert.equal(canRemoveMember("owner", "owner"), true);
  assert.equal(canRemoveMember("owner", "member"), true);
  assert.equal(canRemoveMember("admin", "member"), true);
  assert.equal(canRemoveMember("admin", "admin"), true);
  assert.equal(canRemoveMember("admin", "owner"), false);
  for (const actor of ["reviewer", "member", null] as const) assert.equal(canRemoveMember(actor, "member"), false, String(actor));
});

// ------------------------------------------------------------ rate limiter

test("RateLimiter allows up to max per window, then reports how long to wait, then recovers", () => {
  let now = 1_000;
  const limiter = new RateLimiter(3, 10_000, () => now);
  for (let i = 0; i < 3; i++) assert.equal(limiter.hit("k").allowed, true);
  const blocked = limiter.hit("k");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 10_000);
  now += 4_000;
  assert.equal(limiter.hit("k").retryAfterMs, 6_000);
  now += 6_000;
  assert.deepEqual(limiter.hit("k"), { allowed: true, retryAfterMs: 0 });
});

test("RateLimiter keeps keys independent, and reset forgives one", () => {
  const limiter = new RateLimiter(1, 10_000, () => 0);
  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, false);
  assert.equal(limiter.hit("b").allowed, true);
  limiter.reset("a");
  assert.equal(limiter.hit("a").allowed, true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudError } from "./errors.js";
import { INVITATION_TTL_MS, acceptInvitation, changeMemberRole, createOrg, inviteMember, normalizeSlug, removeMember, validateSlug } from "./orgs.js";
import { makeHarness } from "./testkit.js";

const throwsCloud = (fn: () => unknown, code: string, pattern?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof CloudError && e.code === code && (!pattern || pattern.test(e.message)), `expected ${code}`);

// ------------------------------------------------------------------ orgs

test("creating an organization makes the creator its owner and records it in the audit log", () => {
  const h = makeHarness();
  try {
    const alice = h.user("alice@example.com");
    const org = createOrg(h.control, alice, { name: "  Acme Inc  ", slug: "Acme" });
    assert.deepEqual([org.slug, org.name], ["acme", "Acme Inc"]);
    assert.equal(h.control.getRole(org.id, alice.id), "owner");
    assert.equal(h.control.listAudit(org.id)[0]!.action, "org.created");
  } finally {
    h.cleanup();
  }
});

test("slugs: valid shapes pass; bad shapes and reserved words are refused; duplicates conflict", () => {
  for (const ok of ["a", "acme", "acme-corp", "a1", "x".repeat(38)]) assert.doesNotThrow(() => validateSlug(ok), ok);
  for (const bad of ["", "-acme", "acme-", "Acme", "ac me", "ac_me", "x".repeat(39), "한글", "../etc", "a/b"]) throwsCloud(() => validateSlug(bad), "bad_request");
  for (const reserved of ["api", "device", "invite", "login", "sso", "pay", "billing", "webhooks", "o"]) throwsCloud(() => validateSlug(reserved), "bad_request", /reserved/);
  assert.equal(normalizeSlug("  AcMe "), "acme");
  const h = makeHarness();
  try {
    const alice = h.user("alice@example.com");
    h.org(alice, "acme");
    throwsCloud(() => createOrg(h.control, alice, { name: "Other", slug: "ACME" }), "conflict");
    throwsCloud(() => createOrg(h.control, alice, { name: "   ", slug: "fine" }), "bad_request");
    throwsCloud(() => createOrg(h.control, alice, { name: "x".repeat(81), slug: "fine" }), "bad_request");
  } finally {
    h.cleanup();
  }
});

test("an account created by an organization's SSO cannot create organizations", () => {
  const h = makeHarness();
  try {
    const owner = h.user("owner@example.com");
    const org = h.org(owner, "acme");
    const sso = h.control.createSsoUser(org.id, "emp@acme.com");
    throwsCloud(() => createOrg(h.control, sso, { name: "Mine", slug: "mine" }), "forbidden");
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------------ invitations

function setup() {
  const h = makeHarness();
  const owner = h.user("owner@example.com");
  const org = h.org(owner, "acme");
  return { h, owner, org, ownerP: h.principal(owner) };
}

test("an invitation is accepted by the invited e-mail, once, and grants exactly the invited role", () => {
  const { h, org, ownerP } = setup();
  try {
    const { token, invitation } = inviteMember(h.control, ownerP, org, "owner", { email: "Bob@Example.com", role: "reviewer" });
    assert.equal(invitation.email, "bob@example.com");
    assert.equal(h.control.listPendingInvitations(org.id).length, 1);
    const bob = h.user("bob@example.com");
    assert.deepEqual(acceptInvitation(h.control, bob, token).role, "reviewer");
    assert.equal(h.control.getRole(org.id, bob.id), "reviewer");
    assert.equal(h.control.listPendingInvitations(org.id).length, 0);
    throwsCloud(() => acceptInvitation(h.control, bob, token), "not_found"); // single use
  } finally {
    h.cleanup();
  }
});

test("a forwarded invitation is useless to anyone with a different e-mail address", () => {
  const { h, org, ownerP } = setup();
  try {
    const { token } = inviteMember(h.control, ownerP, org, "owner", { email: "bob@example.com", role: "member" });
    const mallory = h.user("mallory@example.com");
    throwsCloud(() => acceptInvitation(h.control, mallory, token), "forbidden", /different e-mail/);
    assert.equal(h.control.getRole(org.id, mallory.id), null);
  } finally {
    h.cleanup();
  }
});

test("an SSO-provisioned account (scoped to one company) cannot join another organization, even with the right e-mail", () => {
  const { h, org, ownerP } = setup();
  try {
    const other = h.org(h.user("boss@other.com"), "other");
    const sso = h.control.createSsoUser(other.id, "bob@example.com");
    const { token } = inviteMember(h.control, ownerP, org, "owner", { email: "bob@example.com", role: "member" });
    throwsCloud(() => acceptInvitation(h.control, sso, token), "forbidden", /single sign-on/);
  } finally {
    h.cleanup();
  }
});

test("expired, unknown and already-used invitations are refused", () => {
  const { h, org, owner } = setup();
  try {
    const bob = h.user("bob@example.com");
    const expired = h.control.createInvitation({ orgId: org.id, email: "bob@example.com", role: "member", createdBy: owner.id, ttlMs: -1000 });
    throwsCloud(() => acceptInvitation(h.control, bob, expired.token), "not_found", /expired/);
    throwsCloud(() => acceptInvitation(h.control, bob, "f".repeat(48)), "not_found");
    throwsCloud(() => acceptInvitation(h.control, bob, ""), "not_found");
  } finally {
    h.cleanup();
  }
});

test("inviting: only people who may manage members; valid e-mail; invitable role; not an existing member", () => {
  const { h, org, ownerP } = setup();
  try {
    throwsCloud(() => inviteMember(h.control, ownerP, org, "owner", { email: "not-an-email", role: "member" }), "bad_request");
    throwsCloud(() => inviteMember(h.control, ownerP, org, "owner", { email: "a@b.co", role: "owner" }), "bad_request", /role must be/);
    throwsCloud(() => inviteMember(h.control, ownerP, org, "owner", { email: "a@b.co", role: "root" }), "bad_request");
    for (const role of ["reviewer", "member"] as const) throwsCloud(() => inviteMember(h.control, ownerP, org, role, { email: "a@b.co", role: "member" }), "forbidden");
    throwsCloud(() => inviteMember(h.control, ownerP, org, "owner", { email: "OWNER@example.com", role: "member" }), "conflict", /already a member/);
    assert.ok(inviteMember(h.control, ownerP, org, "admin", { email: "new@b.co", role: "admin" }), "an admin may invite admins");
    assert.equal(INVITATION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  } finally {
    h.cleanup();
  }
});

test("a pending invitation can be revoked, and then cannot be used", () => {
  const { h, org, ownerP } = setup();
  try {
    const { token, invitation } = inviteMember(h.control, ownerP, org, "owner", { email: "bob@example.com", role: "member" });
    assert.equal(h.control.revokeInvitation(org.id, invitation.id), true);
    throwsCloud(() => acceptInvitation(h.control, h.user("bob@example.com"), token), "not_found");
    assert.equal(h.control.revokeInvitation("other-org", invitation.id), false);
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------------ role changes

function team() {
  const s = setup();
  const admin = s.h.user("admin@example.com");
  const reviewer = s.h.user("reviewer@example.com");
  const member = s.h.user("member@example.com");
  s.h.control.addMember(s.org.id, admin.id, "admin");
  s.h.control.addMember(s.org.id, reviewer.id, "reviewer");
  s.h.control.addMember(s.org.id, member.id, "member");
  return { ...s, admin, reviewer, member, adminP: s.h.principal(admin), memberP: s.h.principal(member) };
}

test("an owner can promote, demote and appoint other owners", () => {
  const t = team();
  try {
    changeMemberRole(t.h.control, t.ownerP, t.org, "owner", t.member.id, "reviewer");
    assert.equal(t.h.control.getRole(t.org.id, t.member.id), "reviewer");
    changeMemberRole(t.h.control, t.ownerP, t.org, "owner", t.admin.id, "owner");
    assert.equal(t.h.control.countOwners(t.org.id), 2);
    assert.ok(t.h.control.listAudit(t.org.id).some((a) => a.action === "member.role_changed"));
  } finally {
    t.h.cleanup();
  }
});

test("an admin cannot make an owner, demote an owner, or act without the right; members cannot change roles at all", () => {
  const t = team();
  try {
    throwsCloud(() => changeMemberRole(t.h.control, t.adminP, t.org, "admin", t.member.id, "owner"), "forbidden");
    throwsCloud(() => changeMemberRole(t.h.control, t.adminP, t.org, "admin", t.owner.id, "member"), "forbidden");
    assert.doesNotThrow(() => changeMemberRole(t.h.control, t.adminP, t.org, "admin", t.member.id, "reviewer"));
    throwsCloud(() => changeMemberRole(t.h.control, t.memberP, t.org, "member", t.reviewer.id, "admin"), "forbidden");
    throwsCloud(() => changeMemberRole(t.h.control, t.ownerP, t.org, "owner", t.member.id, "superuser"), "bad_request");
    throwsCloud(() => changeMemberRole(t.h.control, t.ownerP, t.org, "owner", "nobody", "member"), "not_found");
  } finally {
    t.h.cleanup();
  }
});

test("the last owner can neither be demoted nor removed, nor leave", () => {
  const t = team();
  try {
    throwsCloud(() => changeMemberRole(t.h.control, t.ownerP, t.org, "owner", t.owner.id, "admin"), "conflict", /at least one owner/);
    throwsCloud(() => removeMember(t.h.control, t.ownerP, t.org, "owner", t.owner.id), "conflict", /at least one owner/);
    changeMemberRole(t.h.control, t.ownerP, t.org, "owner", t.admin.id, "owner");
    assert.doesNotThrow(() => changeMemberRole(t.h.control, t.ownerP, t.org, "owner", t.owner.id, "admin"), "fine once someone else owns it");
    assert.equal(t.h.control.countOwners(t.org.id), 1);
  } finally {
    t.h.cleanup();
  }
});

// ----------------------------------------------------------------- removal

test("removal: an owner removes anyone, an admin cannot remove an owner, a member cannot remove others but can leave", () => {
  const t = team();
  try {
    throwsCloud(() => removeMember(t.h.control, t.adminP, t.org, "admin", t.owner.id), "forbidden");
    throwsCloud(() => removeMember(t.h.control, t.memberP, t.org, "member", t.reviewer.id), "forbidden");
    removeMember(t.h.control, t.memberP, t.org, "member", t.member.id); // leaving
    assert.equal(t.h.control.getRole(t.org.id, t.member.id), null);
    removeMember(t.h.control, t.adminP, t.org, "admin", t.reviewer.id);
    assert.equal(t.h.control.getRole(t.org.id, t.reviewer.id), null);
    throwsCloud(() => removeMember(t.h.control, t.ownerP, t.org, "owner", "ghost"), "not_found");
    const actions = t.h.control.listAudit(t.org.id).map((a) => a.action);
    assert.ok(actions.includes("member.left") && actions.includes("member.removed"));
  } finally {
    t.h.cleanup();
  }
});

test("the audit log is newest first and names who acted", () => {
  const t = team();
  try {
    changeMemberRole(t.h.control, t.ownerP, t.org, "owner", t.member.id, "reviewer");
    const [latest] = t.h.control.listAudit(t.org.id);
    assert.equal(latest!.action, "member.role_changed");
    assert.equal(latest!.actorEmail, "owner@example.com");
  } finally {
    t.h.cleanup();
  }
});

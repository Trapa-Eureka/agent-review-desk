import { INVITABLE_ROLES, canChangeRole, canRemoveMember, can, isInvitableRole, type InvitableRole, type Role } from "./access.js";
import type { Principal } from "./auth.js";
import type { ControlStore, Invitation, Org, User } from "./control.js";
import { CloudError } from "./errors.js";

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,36}[a-z0-9])?$/;
/** Paths the app itself uses at the top level, so an organization can never shadow them. */
const RESERVED_SLUGS = new Set(["api", "device", "invite", "login", "logout", "sso", "pay", "o", "new", "settings", "admin", "static", "_next", "health", "billing", "webhooks", "www"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeSlug = (input: string): string => input.trim().toLowerCase();

export function validateSlug(slug: string): void {
  if (!SLUG.test(slug)) throw new CloudError("bad_request", "The address must be 1-38 characters: lowercase letters, digits and dashes, not starting or ending with a dash.");
  if (RESERVED_SLUGS.has(slug)) throw new CloudError("bad_request", "That address is reserved. Pick another.");
}

export function validateName(name: string): string {
  const clean = name.trim();
  if (clean.length < 1 || clean.length > 80) throw new CloudError("bad_request", "The name must be 1-80 characters.");
  return clean;
}

export const isEmail = (value: string): boolean => value.length <= 254 && EMAIL.test(value);

/** Create an organization; the creator becomes its owner. SSO-provisioned users belong to one organization and cannot create more. */
export function createOrg(control: ControlStore, user: User, input: { name: string; slug: string }): Org {
  if (user.homeOrgId !== null) throw new CloudError("forbidden", "Accounts created through a company's single sign-on cannot create organizations.");
  const slug = normalizeSlug(input.slug);
  validateSlug(slug);
  const name = validateName(input.name);
  if (control.getOrgBySlug(slug)) throw new CloudError("conflict", "That address is already taken.");
  const org = control.createOrg({ slug, name, ownerUserId: user.id });
  control.audit(org.id, user.id, "org.created", slug);
  return org;
}

export function inviteMember(control: ControlStore, actor: Principal, org: Org, role: Role, input: { email: string; role: string }): { invitation: Invitation; token: string } {
  if (!can(role, "members.manage")) throw new CloudError("forbidden", "Your role does not allow inviting people.");
  const email = input.email.trim().toLowerCase();
  if (!isEmail(email)) throw new CloudError("bad_request", "That does not look like an e-mail address.");
  if (!isInvitableRole(input.role)) throw new CloudError("bad_request", `The role must be one of: ${INVITABLE_ROLES.join(", ")}.`);
  const existing = control.listMembers(org.id).find((m) => m.email === email && m.homeOrgId === null);
  if (existing) throw new CloudError("conflict", "That person is already a member.");
  const created = control.createInvitation({ orgId: org.id, email, role: input.role, createdBy: actor.user.id, ttlMs: INVITATION_TTL_MS });
  control.audit(org.id, actor.user.id, "member.invited", `${email} as ${input.role}`);
  return created;
}

/**
 * The invited person joins. The signed-in account's verified e-mail must match the invitation: a forwarded link is
 * useless to anyone else. SSO-provisioned accounts are tied to their own company and cannot join other organizations.
 */
export function acceptInvitation(control: ControlStore, user: User, token: string): { org: Org; role: InvitableRole } {
  const invitation = control.findInvitationByToken(token);
  const gone = new CloudError("not_found", "This invitation is not valid. Ask for a new one.");
  if (!invitation || invitation.acceptedAt) throw gone;
  if (Date.parse(invitation.expiresAt) <= control.time().getTime()) throw new CloudError("not_found", "This invitation has expired. Ask for a new one.");
  if (user.homeOrgId !== null) throw new CloudError("forbidden", "Accounts created through a company's single sign-on cannot join other organizations.");
  if (user.email !== invitation.email) throw new CloudError("forbidden", `This invitation was sent to a different e-mail address. Sign in as ${invitation.email}.`);
  const org = control.getOrg(invitation.orgId);
  if (!org) throw gone;
  return control.tx(() => {
    if (control.getRole(org.id, user.id)) throw new CloudError("conflict", "You are already a member of this organization.");
    if (!control.markInvitationAccepted(invitation.id)) throw gone;
    control.addMember(org.id, user.id, invitation.role);
    control.audit(org.id, user.id, "member.joined", invitation.role);
    return { org, role: invitation.role };
  });
}

export function changeMemberRole(control: ControlStore, actor: Principal, org: Org, actorRole: Role, targetUserId: string, nextRole: string): void {
  const next = [...INVITABLE_ROLES, "owner"].find((r) => r === nextRole) as Role | undefined;
  if (!next) throw new CloudError("bad_request", "Unknown role.");
  const current = control.getRole(org.id, targetUserId);
  if (!current) throw new CloudError("not_found", "That person is not a member.");
  if (!canChangeRole(actorRole, current, next)) throw new CloudError("forbidden", "Your role does not allow that change.");
  if (current === "owner" && next !== "owner" && control.countOwners(org.id) <= 1) throw new CloudError("conflict", "An organization needs at least one owner. Make someone else an owner first.");
  control.tx(() => {
    control.setRole(org.id, targetUserId, next);
    control.audit(org.id, actor.user.id, "member.role_changed", `${targetUserId}: ${current} -> ${next}`);
  });
}

export function removeMember(control: ControlStore, actor: Principal, org: Org, actorRole: Role, targetUserId: string): void {
  const target = control.getRole(org.id, targetUserId);
  if (!target) throw new CloudError("not_found", "That person is not a member.");
  const leaving = targetUserId === actor.user.id;
  if (!leaving && !canRemoveMember(actorRole, target)) throw new CloudError("forbidden", "Your role does not allow removing that person.");
  if (target === "owner" && control.countOwners(org.id) <= 1) throw new CloudError("conflict", "An organization needs at least one owner. Make someone else an owner first.");
  control.tx(() => {
    control.removeMember(org.id, targetUserId);
    control.audit(org.id, actor.user.id, leaving ? "member.left" : "member.removed", targetUserId);
  });
}

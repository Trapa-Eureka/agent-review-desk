/**
 * Roles and what each may do. One table, one function, so "who can do what" is readable in one place and
 * tested as a matrix. Paid-feature gating (is the organization's plan active?) is separate: see entitlement.
 */

export const ROLES = ["owner", "admin", "reviewer", "member"] as const;
export type Role = (typeof ROLES)[number];

export type Action =
  | "view" //            read the organization's synced sessions
  | "upload" //          sync sessions from the CLI
  | "review" //          approve / reject a synced session
  | "members.manage" //  invite, remove, change roles
  | "audit.view" //      read the audit log
  | "billing.manage" //  start a subscription, open the billing portal
  | "sso.manage"; //     configure single sign-on

const MATRIX: Record<Role, readonly Action[]> = {
  owner: ["view", "upload", "review", "members.manage", "audit.view", "billing.manage", "sso.manage"],
  admin: ["view", "upload", "review", "members.manage", "audit.view"],
  reviewer: ["view", "upload", "review"],
  member: ["view", "upload"],
};

export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);

export function can(role: Role | null | undefined, action: Action): boolean {
  return role ? MATRIX[role].includes(action) : false;
}

/** Roles an invitation may carry. Ownership is never handed out by invitation. */
export const INVITABLE_ROLES = ["admin", "reviewer", "member"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];
export const isInvitableRole = (value: unknown): value is InvitableRole => typeof value === "string" && (INVITABLE_ROLES as readonly string[]).includes(value);

/**
 * May `actor` change a member whose role is `current` to `next`?
 * Owners can do anything; admins manage everyone except owners and cannot create owners.
 */
export function canChangeRole(actor: Role | null, current: Role, next: Role): boolean {
  if (!can(actor, "members.manage")) return false;
  if (actor === "owner") return true;
  return current !== "owner" && next !== "owner";
}

/** May `actor` remove a member whose role is `target`? */
export function canRemoveMember(actor: Role | null, target: Role): boolean {
  if (!can(actor, "members.manage")) return false;
  return actor === "owner" || target !== "owner";
}

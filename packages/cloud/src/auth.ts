import { entitlementFor, type Entitlement } from "@ard/billing";
import { can, type Action, type Role } from "./access.js";
import type { ControlStore, Org, User } from "./control.js";
import { newUserCode, normalizeUserCode, randomToken, sha256 } from "./crypto.js";
import { CloudError } from "./errors.js";
import type { RateLimiter } from "./limits.js";

/** Who is making a request, and how they proved it. */
export interface Principal {
  user: User;
  via: "session" | "token";
  /** The SSO organization the session was created for, if any. */
  ssoOrgId: string | null;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "ard_session";

export function principalFromSession(control: ControlStore, cookieValue: string | null | undefined): Principal | null {
  if (!cookieValue) return null;
  const session = control.getWebSession(cookieValue);
  return session ? { user: session.user, via: "session", ssoOrgId: session.ssoOrgId } : null;
}

/** `Authorization: Bearer ard_…` */
export function principalFromBearer(control: ControlStore, header: string | null | undefined): Principal | null {
  const match = /^Bearer (ard_[0-9a-f]{64})$/.exec(header ?? "");
  if (!match) return null;
  const verified = control.verifyApiToken(match[1]!);
  return verified ? { user: verified.user, via: "token", ssoOrgId: null } : null;
}

// ------------------------------------------------------------- org access

export interface OrgAccess {
  org: Org;
  role: Role;
}

/**
 * The single gate for touching an organization. Order matters:
 *  1. not a member (or an SSO user of a different organization) -> "not found", so existence is not revealed;
 *  2. the organization enforces SSO and this is a non-SSO, non-owner member -> refused (owners keep a break-glass way in);
 *  3. the role does not allow the action -> forbidden.
 */
export function requireOrgAccess(control: ControlStore, principal: Principal, slug: string, action: Action): OrgAccess {
  const org = control.getOrgBySlug(slug);
  const notFound = new CloudError("not_found", "No such organization.");
  if (!org) throw notFound;
  const { user } = principal;
  if (user.homeOrgId !== null && user.homeOrgId !== org.id) throw notFound;
  const role = control.getRole(org.id, user.id);
  if (!role) throw notFound;
  if (org.ssoEnforced && user.homeOrgId !== org.id && role !== "owner") throw new CloudError("forbidden", "This organization requires single sign-on. Sign in through your company's login.");
  if (!can(role, action)) throw new CloudError("forbidden", "Your role in this organization does not allow that.");
  return { org, role };
}

/** What the organization's subscription currently allows. */
export function orgEntitlement(org: Org, now: Date = new Date()): Entitlement {
  if (!org.subStatus) return entitlementFor(null, now);
  return entitlementFor({ status: org.subStatus, currentPeriodEnd: org.subPeriodEnd, cancelAtPeriodEnd: org.subCancelAtPeriodEnd, pastDueSince: org.subPastDueSince }, now);
}

/** Paid features (sync, review) need an active plan; reading existing data never does, so lapsing never holds data hostage. */
export function requireEntitled(org: Org, now: Date = new Date()): void {
  if (!orgEntitlement(org, now).active) throw new CloudError("payment_required", "This organization is on the free plan. Cloud sync and review need an active Team subscription (see Billing).");
}

// ---------------------------------------------------------- device login

export const DEVICE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_INTERVAL_S = 5;
/** Wrong-code guesses allowed per signed-in user per window. */
export const DEVICE_GUESS_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 } as const;

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

/** `ard login` begins: it gets a secret device code to poll with, and a short code for the person to confirm. */
export function startDeviceLogin(control: ControlStore, baseUrl: string): DeviceStart {
  const deviceCode = randomToken(32);
  let userCode = newUserCode();
  for (let attempt = 0; control.getDeviceCodeByUserCode(userCode) && attempt < 5; attempt++) userCode = newUserCode();
  control.createDeviceCode({ deviceCodeHash: sha256(deviceCode), userCode, ttlMs: DEVICE_TTL_MS, intervalSeconds: DEVICE_INTERVAL_S });
  const base = baseUrl.replace(/\/$/, "");
  return { deviceCode, userCode, verificationUri: `${base}/device`, verificationUriComplete: `${base}/device?code=${encodeURIComponent(userCode)}`, expiresIn: DEVICE_TTL_MS / 1000, interval: DEVICE_INTERVAL_S };
}

/**
 * A signed-in person confirms (or refuses) the code shown in their terminal.
 *
 * Why the guess limit matters: whoever approves a code decides WHICH ACCOUNT the waiting CLI is logged into.
 * If codes could be guessed, an attacker could approve a victim's pending login into the attacker's account and
 * receive the victim's synced code. Codes are single use, expire in 10 minutes, and guesses are rate limited per user.
 */
export function decideDeviceLogin(control: ControlStore, limiter: RateLimiter, user: User, rawCode: string, decision: "approved" | "denied"): void {
  const code = normalizeUserCode(rawCode);
  const row = code ? control.getDeviceCodeByUserCode(code) : null;
  if (!code || !row) {
    const hit = limiter.hit(`device-guess:${user.id}`);
    if (!hit.allowed) throw new CloudError("rate_limited", "Too many wrong codes. Wait a few minutes and try again.", Math.ceil(hit.retryAfterMs / 1000));
    throw new CloudError("not_found", "That code was not found. Check the code shown in your terminal.");
  }
  if (!control.decideDeviceCode(code, decision, user.id)) throw new CloudError("conflict", "That code has expired or was already used. Run `ard login` again.");
  control.audit(null, user.id, `device_login.${decision}`);
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "invalid" }
  | { status: "approved"; token: string; user: User };

/** The CLI asks "has the person approved yet?". Approval turns into an API token exactly once. */
export function pollDeviceLogin(control: ControlStore, deviceCode: string, now: Date = new Date()): DevicePoll {
  const row = control.getDeviceCodeByHash(sha256(deviceCode));
  if (!row) return { status: "invalid" };
  if (Date.parse(row.expiresAt) <= now.getTime()) return { status: "expired" };
  if (row.lastPollAt && now.getTime() - Date.parse(row.lastPollAt) < row.intervalSeconds * 1000 - 500) {
    control.touchDevicePoll(row.deviceHash);
    return { status: "slow_down" };
  }
  control.touchDevicePoll(row.deviceHash);
  if (row.status === "pending") return { status: "pending" };
  if (row.status === "denied") return { status: "denied" };
  if (row.status === "consumed" || !row.userId) return { status: "invalid" };
  const user = control.getUser(row.userId);
  if (!user) return { status: "invalid" };
  return control.tx(() => {
    if (!control.consumeDeviceCode(row.deviceHash)) return { status: "invalid" } as const; // someone else got there first
    const { token } = control.createApiToken(user.id, `ard CLI ${now.toISOString().slice(0, 10)}`);
    control.audit(null, user.id, "token.created", "device login");
    return { status: "approved", token, user } as const;
  });
}

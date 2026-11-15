import { randomUUID } from "node:crypto";
import { transaction, type Db } from "@ard/core";
import type { ProviderId, SubscriptionSnapshot, SubscriptionStatus } from "@ard/billing";
import type { InvitableRole, Role } from "./access.js";
import { randomToken, sha256 } from "./crypto.js";

/**
 * The only module that knows the control-plane SQL. Methods are synchronous (node:sqlite is) and small;
 * the rules that combine them (who may do what, what a webhook means) live in the modules that call them.
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v ?? "");
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);

export interface User {
  id: string;
  email: string;
  name: string | null;
  /** Set for users created by one organization's SSO: they belong to that organization only. */
  homeOrgId: string | null;
  createdAt: string;
}

export interface Org {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  billingProvider: ProviderId | null;
  billingCustomerId: string | null;
  billingSubscriptionId: string | null;
  subStatus: SubscriptionStatus | null;
  subPeriodEnd: string | null;
  subCancelAtPeriodEnd: boolean;
  subPastDueSince: string | null;
  subPlanRef: string | null;
  subEventAt: string | null;
  ssoEnforced: boolean;
  storedBytes: number;
}

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  homeOrgId: string | null;
  since: string;
}

export interface Invitation {
  id: string;
  orgId: string;
  email: string;
  role: InvitableRole;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  acceptedAt: string | null;
}

export interface SsoConfig {
  orgId: string;
  issuer: string;
  clientId: string;
  clientSecretSealed: string;
  emailDomain: string;
  defaultRole: InvitableRole;
}

export interface DeviceCode {
  deviceHash: string;
  userCode: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "consumed";
  userId: string | null;
  attempts: number;
  lastPollAt: string | null;
  intervalSeconds: number;
}

export interface LoginState {
  nonce: string;
  codeVerifier: string;
  orgId: string | null;
  returnTo: string;
}

export interface AuditEntry {
  id: number;
  orgId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  detail: string | null;
  at: string;
}

const toUser = (r: Row): User => ({ id: str(r.id), email: str(r.email), name: strOrNull(r.name), homeOrgId: strOrNull(r.home_org_id), createdAt: str(r.created_at) });

const toOrg = (r: Row): Org => ({
  id: str(r.id),
  slug: str(r.slug),
  name: str(r.name),
  createdAt: str(r.created_at),
  billingProvider: strOrNull(r.billing_provider) as ProviderId | null,
  billingCustomerId: strOrNull(r.billing_customer_id),
  billingSubscriptionId: strOrNull(r.billing_subscription_id),
  subStatus: strOrNull(r.sub_status) as SubscriptionStatus | null,
  subPeriodEnd: strOrNull(r.sub_period_end),
  subCancelAtPeriodEnd: num(r.sub_cancel_at_period_end) === 1,
  subPastDueSince: strOrNull(r.sub_past_due_since),
  subPlanRef: strOrNull(r.sub_plan_ref),
  subEventAt: strOrNull(r.sub_event_at),
  ssoEnforced: num(r.sso_enforced) === 1,
  storedBytes: num(r.stored_bytes),
});

export class ControlStore {
  constructor(
    readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private now(): string {
    return this.clock().toISOString();
  }

  /** The current time as this store sees it. Use this instead of `Date.now()` so everything shares one clock. */
  time(): Date {
    return this.clock();
  }

  /** Run several steps atomically. */
  tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------ users

  /** The platform user with this e-mail, created on first sign-in. */
  upsertPlatformUser(email: string, name?: string | null): User {
    const clean = email.trim().toLowerCase();
    const existing = this.db.prepare("SELECT * FROM users WHERE email = ? AND home_org_id IS NULL").get(clean) as Row | undefined;
    if (existing) {
      if (name && !existing.name) this.db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, str(existing.id));
      return toUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(str(existing.id)) as Row);
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO users (id, email, name, home_org_id, created_at) VALUES (?, ?, ?, NULL, ?)").run(id, clean, name ?? null, this.now());
    return this.getUser(id)!;
  }

  /** A user created by one organization's SSO. Scoped to that organization; never merged with a platform user. */
  createSsoUser(orgId: string, email: string, name?: string | null): User {
    const clean = email.trim().toLowerCase();
    const existing = this.db.prepare("SELECT * FROM users WHERE email = ? AND home_org_id = ?").get(clean, orgId) as Row | undefined;
    if (existing) return toUser(existing);
    const id = randomUUID();
    this.db.prepare("INSERT INTO users (id, email, name, home_org_id, created_at) VALUES (?, ?, ?, ?, ?)").run(id, clean, name ?? null, orgId, this.now());
    return this.getUser(id)!;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return row ? toUser(row) : null;
  }

  linkIdentity(provider: string, subject: string, userId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO identities (provider, subject, user_id) VALUES (?, ?, ?)").run(provider, subject, userId);
  }

  findUserByIdentity(provider: string, subject: string): User | null {
    const row = this.db.prepare("SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?").get(provider, subject) as Row | undefined;
    return row ? toUser(row) : null;
  }

  // ------------------------------------------------------------------- orgs

  createOrg(input: { slug: string; name: string; ownerUserId: string }): Org {
    return this.tx(() => {
      const id = randomUUID();
      const at = this.now();
      this.db.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run(id, input.slug, input.name, at);
      this.db.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(id, input.ownerUserId, at);
      return this.getOrg(id)!;
    });
  }

  getOrg(id: string): Org | null {
    const row = this.db.prepare("SELECT * FROM orgs WHERE id = ?").get(id) as Row | undefined;
    return row ? toOrg(row) : null;
  }

  getOrgBySlug(slug: string): Org | null {
    const row = this.db.prepare("SELECT * FROM orgs WHERE slug = ?").get(slug) as Row | undefined;
    return row ? toOrg(row) : null;
  }

  listOrgsForUser(userId: string): Array<{ org: Org; role: Role }> {
    return (this.db.prepare("SELECT o.*, m.role AS member_role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name").all(userId) as Row[]).map((r) => ({ org: toOrg(r), role: str(r.member_role) as Role }));
  }

  setSsoEnforced(orgId: string, enforced: boolean): void {
    this.db.prepare("UPDATE orgs SET sso_enforced = ? WHERE id = ?").run(enforced ? 1 : 0, orgId);
  }

  // ------------------------------------------------------------ memberships

  getRole(orgId: string, userId: string): Role | null {
    const row = this.db.prepare("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?").get(orgId, userId) as Row | undefined;
    return row ? (str(row.role) as Role) : null;
  }

  addMember(orgId: string, userId: string, role: Role): void {
    this.db.prepare("INSERT OR IGNORE INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(orgId, userId, role, this.now());
  }

  setRole(orgId: string, userId: string, role: Role): void {
    this.db.prepare("UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?").run(role, orgId, userId);
  }

  removeMember(orgId: string, userId: string): void {
    this.db.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?").run(orgId, userId);
  }

  countOwners(orgId: string): number {
    return num((this.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'").get(orgId) as Row).n);
  }

  listMembers(orgId: string): Member[] {
    return (this.db.prepare("SELECT u.id, u.email, u.name, u.home_org_id, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'reviewer' THEN 2 ELSE 3 END, u.email").all(orgId) as Row[]).map((r) => ({
      userId: str(r.id),
      email: str(r.email),
      name: strOrNull(r.name),
      role: str(r.role) as Role,
      homeOrgId: strOrNull(r.home_org_id),
      since: str(r.created_at),
    }));
  }

  // ------------------------------------------------------------ invitations

  /** Returns the invitation and its secret token. The token is shown once; only its hash is stored. */
  createInvitation(input: { orgId: string; email: string; role: InvitableRole; createdBy: string; ttlMs: number }): { invitation: Invitation; token: string } {
    const token = randomToken(24);
    const id = randomUUID();
    const at = this.now();
    this.db
      .prepare("INSERT INTO invitations (id, org_id, email, role, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.orgId, input.email.trim().toLowerCase(), input.role, sha256(token), new Date(this.clock().getTime() + input.ttlMs).toISOString(), input.createdBy, at);
    return { invitation: this.getInvitation(id)!, token };
  }

  private getInvitation(id: string): Invitation | null {
    const row = this.db.prepare("SELECT * FROM invitations WHERE id = ?").get(id) as Row | undefined;
    return row ? toInvitation(row) : null;
  }

  findInvitationByToken(token: string): Invitation | null {
    const row = this.db.prepare("SELECT * FROM invitations WHERE token_hash = ?").get(sha256(token)) as Row | undefined;
    return row ? toInvitation(row) : null;
  }

  listPendingInvitations(orgId: string): Invitation[] {
    return (this.db.prepare("SELECT * FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(orgId, this.now()) as Row[]).map(toInvitation);
  }

  markInvitationAccepted(id: string): boolean {
    return Number(this.db.prepare("UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL").run(this.now(), id).changes) > 0;
  }

  revokeInvitation(orgId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM invitations WHERE id = ? AND org_id = ? AND accepted_at IS NULL").run(id, orgId).changes) > 0;
  }

  // ----------------------------------------------------------------- tokens

  /** A new API token for the CLI. Returns the plaintext once. */
  createApiToken(userId: string, name: string, ttlMs: number | null = null): { id: string; token: string } {
    const id = randomUUID();
    const token = `ard_${randomToken(32)}`;
    this.db
      .prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, userId, name.slice(0, 80), sha256(token), this.now(), ttlMs === null ? null : new Date(this.clock().getTime() + ttlMs).toISOString());
    return { id, token };
  }

  /** The user a valid, unrevoked, unexpired token belongs to. */
  verifyApiToken(token: string): { user: User; tokenId: string } | null {
    const row = this.db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(sha256(token)) as Row | undefined;
    if (!row || row.revoked_at !== null) return null;
    if (row.expires_at !== null && Date.parse(str(row.expires_at)) <= this.clock().getTime()) return null;
    const user = this.getUser(str(row.user_id));
    if (!user) return null;
    // Record use at most once a minute, so reading is not a write on every request.
    const last = row.last_used_at === null ? 0 : Date.parse(str(row.last_used_at));
    if (this.clock().getTime() - last > 60_000) this.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(this.now(), str(row.id));
    return { user, tokenId: str(row.id) };
  }

  revokeApiToken(tokenId: string, userId: string): boolean {
    return Number(this.db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(this.now(), tokenId, userId).changes) > 0;
  }

  revokeApiTokenByPlaintext(token: string): boolean {
    return Number(this.db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(this.now(), sha256(token)).changes) > 0;
  }

  // ---------------------------------------------------------- device codes

  createDeviceCode(input: { deviceCodeHash: string; userCode: string; ttlMs: number; intervalSeconds: number }): void {
    this.db
      .prepare("INSERT INTO device_codes (device_hash, user_code, created_at, expires_at, status, interval_s) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(input.deviceCodeHash, input.userCode, this.now(), new Date(this.clock().getTime() + input.ttlMs).toISOString(), input.intervalSeconds);
  }

  getDeviceCodeByUserCode(userCode: string): DeviceCode | null {
    const row = this.db.prepare("SELECT * FROM device_codes WHERE user_code = ?").get(userCode) as Row | undefined;
    return row ? toDeviceCode(row) : null;
  }

  getDeviceCodeByHash(hash: string): DeviceCode | null {
    const row = this.db.prepare("SELECT * FROM device_codes WHERE device_hash = ?").get(hash) as Row | undefined;
    return row ? toDeviceCode(row) : null;
  }

  bumpDeviceAttempts(userCode: string): number {
    this.db.prepare("UPDATE device_codes SET attempts = attempts + 1 WHERE user_code = ?").run(userCode);
    return this.getDeviceCodeByUserCode(userCode)?.attempts ?? 0;
  }

  decideDeviceCode(userCode: string, status: "approved" | "denied", userId: string): boolean {
    return Number(this.db.prepare("UPDATE device_codes SET status = ?, user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?").run(status, userId, userCode, this.now()).changes) > 0;
  }

  touchDevicePoll(hash: string): void {
    this.db.prepare("UPDATE device_codes SET last_poll_at = ? WHERE device_hash = ?").run(this.now(), hash);
  }

  /** Mark an approved code as used. Succeeds exactly once, so a code can never mint two tokens. */
  consumeDeviceCode(hash: string): boolean {
    return Number(this.db.prepare("UPDATE device_codes SET status = 'consumed' WHERE device_hash = ? AND status = 'approved'").run(hash).changes) > 0;
  }

  // -------------------------------------------------------------- sessions

  createWebSession(userId: string, ttlMs: number, ssoOrgId: string | null = null): string {
    const token = randomToken(32);
    this.db
      .prepare("INSERT INTO web_sessions (id_hash, user_id, created_at, expires_at, sso_org_id) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), userId, this.now(), new Date(this.clock().getTime() + ttlMs).toISOString(), ssoOrgId);
    return token;
  }

  getWebSession(token: string): { user: User; ssoOrgId: string | null } | null {
    const row = this.db.prepare("SELECT * FROM web_sessions WHERE id_hash = ?").get(sha256(token)) as Row | undefined;
    if (!row || Date.parse(str(row.expires_at)) <= this.clock().getTime()) return null;
    const user = this.getUser(str(row.user_id));
    return user ? { user, ssoOrgId: strOrNull(row.sso_org_id) } : null;
  }

  deleteWebSession(token: string): void {
    this.db.prepare("DELETE FROM web_sessions WHERE id_hash = ?").run(sha256(token));
  }

  purgeExpired(): void {
    const at = this.now();
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(at);
    this.db.prepare("DELETE FROM login_states WHERE expires_at <= ?").run(at);
    this.db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").run(at);
  }

  // ------------------------------------------------------------------- sso

  setSsoConfig(config: SsoConfig): void {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO sso_configs (org_id, issuer, client_id, client_secret_sealed, email_domain, default_role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET issuer = excluded.issuer, client_id = excluded.client_id, client_secret_sealed = excluded.client_secret_sealed,
           email_domain = excluded.email_domain, default_role = excluded.default_role, updated_at = excluded.updated_at`,
      )
      .run(config.orgId, config.issuer, config.clientId, config.clientSecretSealed, config.emailDomain.toLowerCase(), config.defaultRole, at, at);
  }

  getSsoConfig(orgId: string): SsoConfig | null {
    const row = this.db.prepare("SELECT * FROM sso_configs WHERE org_id = ?").get(orgId) as Row | undefined;
    return row
      ? { orgId: str(row.org_id), issuer: str(row.issuer), clientId: str(row.client_id), clientSecretSealed: str(row.client_secret_sealed), emailDomain: str(row.email_domain), defaultRole: str(row.default_role) as InvitableRole }
      : null;
  }

  removeSsoConfig(orgId: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM sso_configs WHERE org_id = ?").run(orgId);
      this.setSsoEnforced(orgId, false); // enforcement without an IdP would lock everyone out
    });
  }

  putLoginState(stateToken: string, state: LoginState, ttlMs: number): void {
    this.db
      .prepare("INSERT INTO login_states (state_hash, nonce, code_verifier, org_id, return_to, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha256(stateToken), state.nonce, state.codeVerifier, state.orgId, state.returnTo, new Date(this.clock().getTime() + ttlMs).toISOString());
  }

  /** Fetch and delete in one step: a state can complete a login only once. */
  takeLoginState(stateToken: string): LoginState | null {
    const hash = sha256(stateToken);
    const row = this.db.prepare("SELECT * FROM login_states WHERE state_hash = ?").get(hash) as Row | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM login_states WHERE state_hash = ?").run(hash);
    if (Date.parse(str(row.expires_at)) <= this.clock().getTime()) return null;
    return { nonce: str(row.nonce), codeVerifier: str(row.code_verifier), orgId: strOrNull(row.org_id), returnTo: str(row.return_to) };
  }

  // --------------------------------------------------------------- billing

  createCheckout(input: { orgId: string; userId: string; provider: ProviderId; nonce: string }): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO checkouts (id, nonce_hash, org_id, user_id, provider, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, sha256(input.nonce), input.orgId, input.userId, input.provider, this.now());
    return id;
  }

  setCheckoutReference(id: string, reference: string): void {
    this.db.prepare("UPDATE checkouts SET reference = ? WHERE id = ?").run(reference, id);
  }

  findOrgIdByCheckoutNonce(provider: ProviderId, nonce: string): string | null {
    const row = this.db.prepare("SELECT org_id FROM checkouts WHERE nonce_hash = ? AND provider = ?").get(sha256(nonce), provider) as Row | undefined;
    return row ? str(row.org_id) : null;
  }

  findOrgIdByCheckoutReference(provider: ProviderId, reference: string): string | null {
    const row = this.db.prepare("SELECT org_id FROM checkouts WHERE provider = ? AND reference = ?").get(provider, reference) as Row | undefined;
    return row ? str(row.org_id) : null;
  }

  findOrgIdBySubscription(provider: ProviderId, subscriptionId: string): string | null {
    const row = this.db.prepare("SELECT id FROM orgs WHERE billing_provider = ? AND billing_subscription_id = ?").get(provider, subscriptionId) as Row | undefined;
    return row ? str(row.id) : null;
  }

  /** Record a webhook id. Returns false when it was already seen (a redelivery). */
  recordBillingEvent(provider: ProviderId, eventId: string): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO billing_events (provider, event_id, received_at) VALUES (?, ?, ?)").run(provider, eventId, this.now()).changes) > 0;
  }

  /**
   * Apply a subscription snapshot to an organization, unless a newer one was already applied (providers may
   * deliver out of order). Returns false for a stale snapshot.
   */
  applySubscription(orgId: string, snapshot: SubscriptionSnapshot, occurredAt: string): boolean {
    const org = this.getOrg(orgId);
    if (!org) return false;
    if (org.subEventAt !== null && Date.parse(occurredAt) < Date.parse(org.subEventAt)) return false;
    const wasPastDue = org.subStatus === "past_due";
    const pastDueSince = snapshot.status === "past_due" ? (wasPastDue && org.subPastDueSince ? org.subPastDueSince : occurredAt) : null;
    this.db
      .prepare(
        `UPDATE orgs SET billing_provider = ?, billing_customer_id = COALESCE(?, billing_customer_id), billing_subscription_id = ?,
           sub_status = ?, sub_period_end = ?, sub_cancel_at_period_end = ?, sub_past_due_since = ?, sub_plan_ref = ?, sub_event_at = ? WHERE id = ?`,
      )
      .run(snapshot.provider, snapshot.customerId, snapshot.subscriptionId, snapshot.status, snapshot.currentPeriodEnd, snapshot.cancelAtPeriodEnd ? 1 : 0, pastDueSince, snapshot.planRef, occurredAt, orgId);
    return true;
  }

  // --------------------------------------------------------------- uploads

  /** Bind a session to the first member who uploads it. False when another member already owns it. */
  claimSession(orgId: string, sessionId: string, userId: string): boolean {
    this.db.prepare("INSERT OR IGNORE INTO uploads (org_id, session_id, user_id, first_at) VALUES (?, ?, ?, ?)").run(orgId, sessionId, userId, this.now());
    const row = this.db.prepare("SELECT user_id FROM uploads WHERE org_id = ? AND session_id = ?").get(orgId, sessionId) as Row;
    return str(row.user_id) === userId;
  }

  /** Who uploaded this session first, or null when nobody has (yet). */
  sessionOwner(orgId: string, sessionId: string): string | null {
    const row = this.db.prepare("SELECT user_id FROM uploads WHERE org_id = ? AND session_id = ?").get(orgId, sessionId) as Row | undefined;
    return row ? str(row.user_id) : null;
  }

  sessionUploaders(orgId: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const r of this.db.prepare("SELECT u.session_id, us.email FROM uploads u JOIN users us ON us.id = u.user_id WHERE u.org_id = ?").all(orgId) as Row[]) map.set(str(r.session_id), str(r.email));
    return map;
  }

  addStoredBytes(orgId: string, bytes: number): void {
    this.db.prepare("UPDATE orgs SET stored_bytes = stored_bytes + ? WHERE id = ?").run(bytes, orgId);
  }

  // ----------------------------------------------------------------- audit

  audit(orgId: string | null, actorUserId: string | null, action: string, detail?: string): void {
    this.db.prepare("INSERT INTO audit_log (org_id, actor_user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)").run(orgId, actorUserId, action, detail ?? null, this.now());
  }

  listAudit(orgId: string, limit = 100): AuditEntry[] {
    return (this.db.prepare("SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.org_id = ? ORDER BY a.id DESC LIMIT ?").all(orgId, limit) as Row[]).map((r) => ({
      id: num(r.id),
      orgId: strOrNull(r.org_id),
      actorUserId: strOrNull(r.actor_user_id),
      actorEmail: strOrNull(r.actor_email),
      action: str(r.action),
      detail: strOrNull(r.detail),
      at: str(r.at),
    }));
  }
}

function toInvitation(r: Row): Invitation {
  return { id: str(r.id), orgId: str(r.org_id), email: str(r.email), role: str(r.role) as InvitableRole, expiresAt: str(r.expires_at), createdBy: str(r.created_by), createdAt: str(r.created_at), acceptedAt: strOrNull(r.accepted_at) };
}

function toDeviceCode(r: Row): DeviceCode {
  return { deviceHash: str(r.device_hash), userCode: str(r.user_code), expiresAt: str(r.expires_at), status: str(r.status) as DeviceCode["status"], userId: strOrNull(r.user_id), attempts: num(r.attempts), lastPollAt: strOrNull(r.last_poll_at), intervalSeconds: num(r.interval_s) };
}

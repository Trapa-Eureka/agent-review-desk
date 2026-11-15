import type { Principal } from "./auth.js";
import { SESSION_TTL_MS } from "./auth.js";
import type { ControlStore, LoginState, SsoConfig, User } from "./control.js";
import { newPkce, randomToken, safeEqual, seal, unseal } from "./crypto.js";
import { CloudError } from "./errors.js";
import { buildAuthorizationUrl, discover, exchangeCode, verifyIdToken, type IdentityClaims, type OidcClient, type OidcOptions } from "./oidc.js";

/**
 * Sign-in flows built on OIDC.
 *
 *  - Platform login: the operator configures ONE provider (Google, GitHub-via-OIDC bridge, Auth0...). Users are
 *    keyed by (issuer, subject); the provider must say the e-mail is verified.
 *  - Organization SSO: an organization owner configures THEIR identity provider. People who sign in through it are
 *    created as users scoped to that organization (`homeOrgId`) and are never merged with a platform account
 *    that happens to share the e-mail: otherwise a malicious IdP could claim "victim@gmail.com" and take over
 *    the victim's account in every organization they belong to.
 */

export const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
export const SSO_SECRET_PURPOSE = "sso-client-secret";

export interface PlatformLoginConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
}

export interface LoginDeps {
  control: ControlStore;
  /** The server secret, used to encrypt SSO client secrets at rest. */
  secret: string;
  /** Public URL of this server, e.g. https://cloud.example.com */
  baseUrl: string;
  oidc: OidcOptions;
}

export const callbackUrl = (baseUrl: string): string => `${baseUrl.replace(/\/$/, "")}/api/auth/callback`;

/** Only same-site relative paths may be returned to after login (no open redirect). */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || /[\r\n]/.test(value)) return "/";
  return value;
}

async function begin(deps: LoginDeps, client: OidcClient, orgId: string | null, returnTo: string, loginHint?: string): Promise<string> {
  const discovery = await discover(client.issuer, deps.oidc);
  const pkce = newPkce();
  const state = randomToken(24);
  const nonce = randomToken(24);
  deps.control.putLoginState(state, { nonce, codeVerifier: pkce.verifier, orgId, returnTo: safeReturnTo(returnTo) }, LOGIN_STATE_TTL_MS);
  return buildAuthorizationUrl(discovery, { clientId: client.clientId, redirectUri: callbackUrl(deps.baseUrl), state, nonce, challenge: pkce.challenge, ...(loginHint ? { loginHint } : {}) });
}

export function beginPlatformLogin(deps: LoginDeps, config: PlatformLoginConfig, returnTo: string): Promise<string> {
  return begin(deps, config, null, returnTo);
}

export async function beginSsoLogin(deps: LoginDeps, orgSlug: string, returnTo: string): Promise<string> {
  const org = deps.control.getOrgBySlug(orgSlug);
  const sso = org ? deps.control.getSsoConfig(org.id) : null;
  if (!org || !sso) throw new CloudError("not_found", "Single sign-on is not set up for that organization.");
  const clientSecret = unseal(deps.secret, SSO_SECRET_PURPOSE, sso.clientSecretSealed);
  if (!clientSecret) throw new CloudError("unavailable", "The stored single sign-on secret could not be read. An owner must save the SSO settings again.");
  return begin(deps, { issuer: sso.issuer, clientId: sso.clientId, clientSecret }, org.id, returnTo);
}

export interface LoginResult {
  user: User;
  sessionToken: string;
  returnTo: string;
  orgSlug: string | null;
}

/** The `state` value inside an authorization URL we built: the web layer stores it in a cookie so only THIS browser can finish the login. */
export function stateOfAuthorizationUrl(url: string): string {
  return new URL(url).searchParams.get("state") ?? "";
}

/**
 * The identity provider sent the browser back. Complete (or refuse) the login.
 *
 * `browserState` is what the browser's login cookie held. It must equal `state`: otherwise anyone could finish THEIR OWN
 * sign-in at the identity provider, stop before the last step, and send the callback link to a victim; the victim's
 * browser would then be signed in as the attacker (login CSRF), and could be led to link their CLI to the attacker's account.
 */
export async function completeLogin(deps: LoginDeps, platform: PlatformLoginConfig | null, params: { state: string | null; code: string | null; error: string | null; browserState: string | null }): Promise<LoginResult> {
  if (params.error) throw new CloudError("unauthenticated", "The identity provider reported a problem. Try signing in again.");
  if (!params.state || !params.code) throw new CloudError("bad_request", "The login response was incomplete.");
  if (!params.browserState || !safeEqual(params.browserState, params.state)) throw new CloudError("unauthenticated", "This sign-in was not started in this browser. Start again from the sign-in page.");
  const saved: LoginState | null = deps.control.takeLoginState(params.state);
  if (!saved) throw new CloudError("unauthenticated", "This login attempt expired or was already used. Start again.");

  let client: OidcClient;
  let sso: SsoConfig | null = null;
  let orgSlug: string | null = null;
  if (saved.orgId) {
    sso = deps.control.getSsoConfig(saved.orgId);
    const org = deps.control.getOrg(saved.orgId);
    const clientSecret = sso ? unseal(deps.secret, SSO_SECRET_PURPOSE, sso.clientSecretSealed) : null;
    if (!sso || !org || !clientSecret) throw new CloudError("unavailable", "Single sign-on is no longer configured for that organization.");
    client = { issuer: sso.issuer, clientId: sso.clientId, clientSecret };
    orgSlug = org.slug;
  } else {
    if (!platform) throw new CloudError("unavailable", "Sign-in is not configured on this server.");
    client = platform;
  }

  const discovery = await discover(client.issuer, deps.oidc);
  const idToken = await exchangeCode(discovery, client, { code: params.code, redirectUri: callbackUrl(deps.baseUrl), codeVerifier: saved.codeVerifier }, deps.oidc);
  const claims = await verifyIdToken(idToken, discovery, client, { nonce: saved.nonce }, deps.oidc);
  const user = sso ? resolveSsoUser(deps.control, sso, discovery.issuer, claims) : resolvePlatformUser(deps.control, discovery.issuer, claims);
  const sessionToken = deps.control.createWebSession(user.id, SESSION_TTL_MS, sso ? sso.orgId : null);
  deps.control.audit(sso ? sso.orgId : null, user.id, sso ? "login.sso" : "login.platform");
  return { user, sessionToken, returnTo: saved.returnTo, orgSlug };
}

function resolvePlatformUser(control: ControlStore, issuer: string, claims: IdentityClaims): User {
  if (!claims.email) throw new CloudError("unauthenticated", "The identity provider did not share an e-mail address.");
  if (claims.emailVerified !== true) throw new CloudError("unauthenticated", "Your e-mail address is not verified with the identity provider.");
  const known = control.findUserByIdentity(issuer, claims.subject);
  if (known) return known;
  return control.tx(() => {
    const user = control.upsertPlatformUser(claims.email!, claims.name);
    control.linkIdentity(issuer, claims.subject, user.id);
    return user;
  });
}

function resolveSsoUser(control: ControlStore, sso: SsoConfig, issuer: string, claims: IdentityClaims): User {
  if (!claims.email) throw new CloudError("unauthenticated", "Your company's identity provider did not share an e-mail address.");
  // Enterprise providers often omit email_verified; an explicit `false` is still a refusal.
  if (claims.emailVerified === false) throw new CloudError("unauthenticated", "Your e-mail address is not verified with your company's identity provider.");
  const domain = claims.email.split("@")[1] ?? "";
  if (domain !== sso.emailDomain) throw new CloudError("forbidden", `Only @${sso.emailDomain} accounts may sign in through this organization's single sign-on.`);
  const provider = `${issuer}#${sso.orgId}`;
  const known = control.findUserByIdentity(provider, claims.subject);
  if (known) {
    if (!control.getRole(sso.orgId, known.id)) control.addMember(sso.orgId, known.id, sso.defaultRole); // re-provision someone an admin removed
    return known;
  }
  return control.tx(() => {
    const user = control.createSsoUser(sso.orgId, claims.email!, claims.name);
    control.linkIdentity(provider, claims.subject, user.id);
    control.addMember(sso.orgId, user.id, sso.defaultRole);
    control.audit(sso.orgId, user.id, "member.provisioned", `sso ${sso.defaultRole}`);
    return user;
  });
}

// --------------------------------------------------------- SSO settings

export interface SsoSettingsInput {
  issuer: string;
  clientId: string;
  clientSecret: string;
  emailDomain: string;
  defaultRole: string;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Owner saves the company's identity provider. The issuer is checked by reading its discovery document right now. */
export async function saveSsoSettings(deps: LoginDeps, actor: Principal, orgId: string, input: SsoSettingsInput): Promise<void> {
  const domain = input.emailDomain.trim().toLowerCase().replace(/^@/, "");
  if (!DOMAIN.test(domain)) throw new CloudError("bad_request", "Enter the company e-mail domain, e.g. example.com.");
  if (!["admin", "reviewer", "member"].includes(input.defaultRole)) throw new CloudError("bad_request", "The default role must be admin, reviewer or member.");
  if (!input.clientId.trim() || input.clientId.length > 300) throw new CloudError("bad_request", "Enter the client id.");
  if (!input.clientSecret || input.clientSecret.length > 2000) throw new CloudError("bad_request", "Enter the client secret.");
  const issuer = input.issuer.trim().replace(/\/$/, "");
  await discover(issuer, deps.oidc); // proves it is reachable, public, and really an OpenID provider
  deps.control.setSsoConfig({
    orgId,
    issuer,
    clientId: input.clientId.trim(),
    clientSecretSealed: seal(deps.secret, SSO_SECRET_PURPOSE, input.clientSecret),
    emailDomain: domain,
    defaultRole: input.defaultRole as SsoConfig["defaultRole"],
  });
  deps.control.audit(orgId, actor.user.id, "sso.configured", `${issuer} @${domain}`);
}

import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { CloudError } from "./errors.js";
import { safeEqual } from "./crypto.js";

/**
 * OpenID Connect, authorization-code flow with PKCE, for two uses: the operator's own login provider (e.g. Google)
 * and per-organization single sign-on. No dependencies: discovery, code exchange and ID-token verification.
 *
 * Two things here are security-critical and tested hard:
 *  - the server fetches URLs that a customer typed in (an SSO issuer), so it must refuse to be pointed at internal
 *    addresses (SSRF);
 *  - the ID token's signature algorithm must come from OUR allow-list, never from the token (the classic
 *    `alg: none` / HS256-with-the-public-key attacks).
 */

export interface OidcClient {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

export type FetchResponse = { status: number; text(): Promise<string> };
export type OidcFetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; redirect: "manual"; signal: AbortSignal }) => Promise<FetchResponse>;

export interface OidcOptions {
  fetch?: OidcFetch;
  /** Resolve a host name to addresses (tests replace it). */
  resolve?: (host: string) => Promise<string[]>;
  /** Development only: allow loopback / private addresses and plain http. */
  allowPrivateNetwork?: boolean;
  now?: () => Date;
}

const FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const CLOCK_SKEW_S = 60;
const ALLOWED_ALGS = ["RS256", "ES256"] as const;

// ------------------------------------------------------------- SSRF guard

/** Is this literal IP address one that must never be reached on a customer's say-so? */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
  }
  return true; // not an IP at all: treat as unsafe
}

async function assertSafeUrl(raw: string, opts: OidcOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CloudError("bad_request", "That is not a valid URL.");
  }
  if (url.username || url.password) throw new CloudError("bad_request", "URLs with credentials are not allowed.");
  const dev = opts.allowPrivateNetwork === true;
  if (url.protocol !== "https:" && !(dev && url.protocol === "http:")) throw new CloudError("bad_request", "The identity provider URL must use https.");
  if (dev) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new CloudError("bad_request", "That address is not allowed.");
  const addresses = isIP(host) ? [host] : await (opts.resolve ?? defaultResolve)(host).catch(() => []);
  if (addresses.length === 0) throw new CloudError("bad_request", "That address could not be resolved.");
  if (addresses.some(isPrivateAddress)) throw new CloudError("bad_request", "That address is not allowed.");
  return url;
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((r) => r.address);
}

/** GET/POST with a timeout, no redirects (a redirect could point back inside), and a response size cap. */
async function guardedFetch(rawUrl: string, init: { method: string; headers?: Record<string, string>; body?: string }, opts: OidcOptions): Promise<{ status: number; body: string }> {
  const url = await assertSafeUrl(rawUrl, opts);
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as OidcFetch);
  let response: FetchResponse;
  try {
    response = await doFetch(url.toString(), { ...init, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new CloudError("unavailable", "The identity provider could not be reached.");
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new CloudError("bad_request", "The identity provider sent an unreasonably large response.");
  return { status: response.status, body };
}

function parseJson(body: string, what: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new CloudError("bad_request", `The identity provider's ${what} was not valid JSON.`);
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

// ---------------------------------------------------------------- discovery

/** Read `<issuer>/.well-known/openid-configuration` and check it describes the issuer we asked about. */
export async function discover(issuer: string, opts: OidcOptions = {}): Promise<Discovery> {
  const base = (await assertSafeUrl(issuer, opts)).toString().replace(/\/$/, "");
  const { status, body } = await guardedFetch(`${base}/.well-known/openid-configuration`, { method: "GET", headers: { accept: "application/json" } }, opts);
  if (status !== 200) throw new CloudError("bad_request", `The identity provider's discovery document could not be read (HTTP ${status}).`);
  const doc = parseJson(body, "discovery document");
  const docIssuer = text(doc.issuer);
  // The spec requires an exact match; trailing slashes differ between providers, so compare without them.
  if (!docIssuer || docIssuer.replace(/\/$/, "") !== base) throw new CloudError("bad_request", "The discovery document belongs to a different issuer.");
  const authorizationEndpoint = text(doc.authorization_endpoint);
  const tokenEndpoint = text(doc.token_endpoint);
  const jwksUri = text(doc.jwks_uri);
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) throw new CloudError("bad_request", "The discovery document is missing endpoints.");
  for (const endpoint of [authorizationEndpoint, tokenEndpoint, jwksUri]) await assertSafeUrl(endpoint, opts);
  return { issuer: docIssuer, authorizationEndpoint, tokenEndpoint, jwksUri };
}

export function buildAuthorizationUrl(d: Discovery, p: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string; loginHint?: string }): string {
  const url = new URL(d.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", p.state);
  url.searchParams.set("nonce", p.nonce);
  url.searchParams.set("code_challenge", p.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (p.loginHint) url.searchParams.set("login_hint", p.loginHint);
  return url.toString();
}

/** Trade the one-time code for an ID token (client_secret_post). */
export async function exchangeCode(d: Discovery, client: OidcClient, p: { code: string; redirectUri: string; codeVerifier: string }, opts: OidcOptions = {}): Promise<string> {
  const form = new URLSearchParams({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, client_id: client.clientId, client_secret: client.clientSecret, code_verifier: p.codeVerifier });
  const { status, body } = await guardedFetch(d.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() }, opts);
  const json = parseJson(body, "token response");
  if (status !== 200) throw new CloudError("unauthenticated", `The identity provider refused the login${text(json.error) ? ` (${text(json.error)})` : ""}.`);
  const idToken = text(json.id_token);
  if (!idToken) throw new CloudError("unauthenticated", "The identity provider did not return an ID token.");
  return idToken;
}

// ------------------------------------------------------------ ID token

export interface IdentityClaims {
  subject: string;
  email: string | null;
  /** `true`/`false` when the provider says, `null` when it does not say (some enterprise providers never do). */
  emailVerified: boolean | null;
  name: string | null;
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new CloudError("unauthenticated", "The ID token is malformed.");
}

/**
 * Verify an ID token: signature (against the provider's published keys), issuer, audience, expiry, nonce.
 * The algorithm is checked against our allow-list BEFORE anything else.
 */
export async function verifyIdToken(idToken: string, d: Discovery, client: OidcClient, expected: { nonce: string }, opts: OidcOptions = {}): Promise<IdentityClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((p) => p === "")) throw new CloudError("unauthenticated", "The ID token is malformed.");
  const [h, p, s] = parts as [string, string, string];
  const header = decodeSegment(h);
  const alg = text(header.alg);
  if (!alg || !(ALLOWED_ALGS as readonly string[]).includes(alg)) throw new CloudError("unauthenticated", "The ID token uses an unsupported signature algorithm.");

  const { status, body } = await guardedFetch(d.jwksUri, { method: "GET", headers: { accept: "application/json" } }, opts);
  if (status !== 200) throw new CloudError("unavailable", "The identity provider's signing keys could not be read.");
  const keys = Array.isArray(parseJson(body, "key set").keys) ? (parseJson(body, "key set").keys as Array<Record<string, unknown>>) : [];
  const kid = text(header.kid);
  const wantedType = alg === "RS256" ? "RSA" : "EC";
  const candidates = keys.filter((k) => k.kty === wantedType && (k.use === undefined || k.use === "sig") && (kid ? k.kid === kid : true));
  if (candidates.length === 0 || (!kid && candidates.length > 1)) throw new CloudError("unauthenticated", "No matching signing key was found for the ID token.");

  let valid = false;
  try {
    const key = createPublicKey({ key: candidates[0] as JsonWebKey, format: "jwk" });
    const data = Buffer.from(`${h}.${p}`);
    const signature = Buffer.from(s, "base64url");
    valid = alg === "RS256" ? cryptoVerify("RSA-SHA256", data, key, signature) : cryptoVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new CloudError("unauthenticated", "The ID token's signature is not valid.");

  const claims = decodeSegment(p);
  const nowS = Math.floor((opts.now ?? (() => new Date()))().getTime() / 1000);
  if (text(claims.iss)?.replace(/\/$/, "") !== d.issuer.replace(/\/$/, "")) throw new CloudError("unauthenticated", "The ID token was issued by someone else.");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(client.clientId)) throw new CloudError("unauthenticated", "The ID token was issued for a different application.");
  if (aud.length > 1 && claims.azp !== client.clientId) throw new CloudError("unauthenticated", "The ID token's authorized party does not match.");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < nowS) throw new CloudError("unauthenticated", "The ID token has expired.");
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > nowS) throw new CloudError("unauthenticated", "The ID token is not valid yet.");
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > nowS) throw new CloudError("unauthenticated", "The ID token was issued in the future.");
  if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, expected.nonce)) throw new CloudError("unauthenticated", "The login response did not match the request (nonce).");
  const subject = text(claims.sub);
  if (!subject) throw new CloudError("unauthenticated", "The ID token has no subject.");
  return { subject, email: text(claims.email)?.toLowerCase() ?? null, emailVerified: typeof claims.email_verified === "boolean" ? claims.email_verified : null, name: text(claims.name) };
}

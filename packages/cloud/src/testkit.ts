// Test helpers for the cloud package. Not part of the server's runtime.
import { createHash, createSign, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@ard/core";
import { ControlStore, type Org, type User } from "./control.js";
import { Workspaces } from "./workspace.js";
import type { Principal } from "./auth.js";
import type { OidcFetch } from "./oidc.js";
import { CLOUD_MIGRATIONS } from "./schema.js";
import { createOrg } from "./orgs.js";

export const TEST_SECRET = "test-secret-".padEnd(48, "x");

/** A mutable clock so tests can move time. */
export function makeClock(start = "2026-11-15T10:00:00.000Z") {
  let now = new Date(start).getTime();
  return { now: () => new Date(now), advance: (ms: number) => void (now += ms), set: (iso: string) => void (now = new Date(iso).getTime()) };
}

export interface Harness {
  dir: string;
  control: ControlStore;
  workspaces: Workspaces;
  clock: ReturnType<typeof makeClock>;
  cleanup: () => void;
  user(email: string, name?: string): User;
  principal(user: User, via?: "session" | "token"): Principal;
  org(owner: User, slug: string): Org;
}

export function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "ard-cloud-test-"));
  const clock = makeClock();
  const control = new ControlStore(openDb(join(dir, "control.db"), CLOUD_MIGRATIONS), clock.now);
  const workspaces = new Workspaces(dir);
  return {
    dir,
    control,
    workspaces,
    clock,
    cleanup: () => {
      control.close();
      rmSync(dir, { recursive: true, force: true });
    },
    user: (email, name) => control.upsertPlatformUser(email, name ?? null),
    principal: (user, via = "session") => ({ user, via, ssoOrgId: null }),
    org: (owner, slug) => createOrg(control, owner, { name: slug.toUpperCase(), slug }),
  };
}

// -------------------------------------------------------------- mock IdP

export interface MockIdpOptions {
  issuer?: string;
  alg?: "RS256" | "ES256";
  kid?: string;
  /** When set, the token endpoint refuses any other client secret. */
  clientSecret?: string;
  /** The clock used for iat/exp in issued tokens (defaults to real time). */
  now?: () => Date;
}

export interface IssueOptions {
  nonce: string;
  subject?: string;
  email?: string | null;
  emailVerified?: boolean | null;
  name?: string;
  audience?: string | string[];
  issuer?: string;
  expiresInS?: number;
  issuedAtOffsetS?: number;
  azp?: string;
  /** Tamper with the signed token after the fact. */
  mutate?: (token: string) => string;
}

const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/**
 * An in-process OpenID provider: discovery, JWKS, token endpoint (with PKCE verification), and a way to sign ID
 * tokens. `fetch` plugs straight into the OIDC code, so no network or ports are involved.
 */
export function mockIdp(options: MockIdpOptions = {}) {
  const issuer = options.issuer ?? "https://idp.example.com";
  const alg = options.alg ?? "RS256";
  const kid = options.kid ?? "key-1";
  const pair = alg === "RS256" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...(pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid, use: "sig", alg };
  const codes = new Map<string, { id: string; challenge: string }>();
  const log: Array<{ url: string; method: string; body?: string }> = [];
  let tokens = 0;

  function signToken(claims: Record<string, unknown>, headerOverride: Record<string, unknown> = {}, key: KeyObject = pair.privateKey): string {
    const header = { alg, typ: "JWT", kid, ...headerOverride };
    const input = `${b64(header)}.${b64(claims)}`;
    const data = Buffer.from(input);
    const signature = header.alg === "RS256" ? createSign("RSA-SHA256").update(data).sign(key) : header.alg === "ES256" ? cryptoSign("sha256", data, { key, dsaEncoding: "ieee-p1363" }) : Buffer.alloc(32);
    return `${input}.${signature.toString("base64url")}`;
  }

  function claimsFor(o: IssueOptions, clientId: string): Record<string, unknown> {
    const now = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
    const claims: Record<string, unknown> = {
      iss: o.issuer ?? issuer,
      sub: o.subject ?? "subject-1",
      aud: o.audience ?? clientId,
      iat: now + (o.issuedAtOffsetS ?? 0),
      exp: now + (o.expiresInS ?? 300),
      nonce: o.nonce,
    };
    if (o.email !== null) claims.email = o.email ?? "alice@example.com";
    if (o.emailVerified !== null) claims.email_verified = o.emailVerified ?? true;
    if (o.name) claims.name = o.name;
    if (o.azp) claims.azp = o.azp;
    return claims;
  }

  const fetch: OidcFetch = async (url, init) => {
    log.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}) });
    const path = new URL(url).pathname;
    const respond = (status: number, json: unknown) => ({ status, text: async () => JSON.stringify(json) });
    if (path === "/.well-known/openid-configuration") {
      return respond(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (path === "/jwks") return respond(200, { keys: [jwk] });
    if (path === "/token" && init.method === "POST") {
      const form = new URLSearchParams(init.body);
      if (options.clientSecret && form.get("client_secret") !== options.clientSecret) return respond(401, { error: "invalid_client" });
      const issued = codes.get(form.get("code") ?? "");
      if (!issued) return respond(400, { error: "invalid_grant" });
      codes.delete(form.get("code")!); // single use
      const verifier = form.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== issued.challenge) return respond(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      return respond(200, { id_token: issued.id, token_type: "Bearer" });
    }
    return respond(404, { error: "not_found" });
  };

  return {
    issuer,
    fetch,
    log,
    jwk,
    signToken,
    /** Register a one-time authorization code that exchanges for an ID token with these claims. */
    issueCode(authorizeUrl: string, clientId: string, o: Omit<IssueOptions, "nonce"> = {}): string {
      const params = new URL(authorizeUrl).searchParams;
      const nonce = params.get("nonce") ?? "";
      const challenge = params.get("code_challenge") ?? "";
      let id = signToken(claimsFor({ ...o, nonce }, clientId));
      if (o.mutate) id = o.mutate(id);
      const code = `code-${++tokens}`;
      codes.set(code, { id, challenge });
      return code;
    },
    claimsFor,
  };
}

export { b64 };

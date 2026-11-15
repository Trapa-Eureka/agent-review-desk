import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CloudError } from "./errors.js";
import { newPkce } from "./crypto.js";
import { buildAuthorizationUrl, discover, exchangeCode, isPrivateAddress, pinnedFetch, verifyIdToken, type Discovery, type OidcClient, type OidcFetch, type OidcOptions } from "./oidc.js";
import { b64, makeClock, mockIdp } from "./testkit.js";

const CLIENT: OidcClient = { issuer: "https://idp.example.com", clientId: "client-1", clientSecret: "shh" };
const PUBLIC_IP = async () => ["93.184.216.34"];
const clock = makeClock();

const throwsCloud = (promise: Promise<unknown>, code: string, pattern?: RegExp) =>
  assert.rejects(promise, (e: unknown) => e instanceof CloudError && e.code === code && (!pattern || pattern.test(e.message)), `expected ${code}${pattern ? ` /${pattern.source}/` : ""}`);

const opts = (idp: ReturnType<typeof mockIdp>, extra: OidcOptions = {}): OidcOptions => ({ fetch: idp.fetch, resolve: PUBLIC_IP, now: clock.now, ...extra });
const discovery = (idp: ReturnType<typeof mockIdp>): Discovery => ({ issuer: idp.issuer, authorizationEndpoint: `${idp.issuer}/authorize`, tokenEndpoint: `${idp.issuer}/token`, jwksUri: `${idp.issuer}/jwks` });

// ------------------------------------------------------------------ SSRF

test("private, loopback, link-local and malformed addresses are recognized", () => {
  for (const bad of ["127.0.0.1", "127.9.9.9", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:8.8.8.8", "::ffff:808:808", "0:0:0:0:0:ffff:7f00:1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "fec0::1", "100::1", "not-an-ip", ""]) {
    assert.equal(isPrivateAddress(bad), true, bad);
  }
  for (const good of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e"]) {
    assert.equal(isPrivateAddress(good), false, good);
  }
});

test("discovery refuses http, credentials in the URL, localhost names and internal addresses", async () => {
  const idp = mockIdp();
  for (const issuer of ["http://idp.example.com", "https://user:pass@idp.example.com", "https://localhost", "https://app.localhost", "https://metadata.internal", "https://printer.local", "https://127.0.0.1", "https://[::1]", "https://169.254.169.254", "https://10.0.0.5", "ftp://idp.example.com", "not a url", ""]) {
    await throwsCloud(discover(issuer, opts(idp)), "bad_request");
  }
  assert.equal(idp.log.length, 0, "nothing was requested for any of them");
});

test("a host name that RESOLVES to an internal address is refused (DNS pointing inward)", async () => {
  const idp = mockIdp();
  await throwsCloud(discover("https://innocent.example.com", opts(idp, { resolve: async () => ["10.1.2.3"] })), "bad_request");
  await throwsCloud(discover("https://innocent.example.com", opts(idp, { resolve: async () => ["93.184.216.34", "127.0.0.1"] })), "bad_request", /not allowed/);
  await throwsCloud(discover("https://innocent.example.com", opts(idp, { resolve: async () => [] })), "bad_request", /resolved/);
  await throwsCloud(discover("https://innocent.example.com", opts(idp, { resolve: async () => Promise.reject(new Error("NXDOMAIN")) })), "bad_request", /resolved/);
  assert.equal(idp.log.length, 0);
});

test("endpoints advertised inside a discovery document are held to the same rules", async () => {
  const doc = (over: Record<string, string>) => ({ issuer: "https://idp.example.com", authorization_endpoint: "https://idp.example.com/a", token_endpoint: "https://idp.example.com/t", jwks_uri: "https://idp.example.com/j", ...over });
  const cases: Array<Record<string, string>> = [{ token_endpoint: "http://idp.example.com/t" }, { jwks_uri: "https://169.254.169.254/latest/meta-data" }, { authorization_endpoint: "https://127.0.0.1/a" }];
  for (const bad of cases) {
    const fetch: OidcFetch = async () => ({ status: 200, text: async () => JSON.stringify(doc(bad)) });
    await throwsCloud(discover("https://idp.example.com", { fetch, resolve: PUBLIC_IP }), "bad_request");
  }
});

test("redirects are not followed, so an IdP URL cannot bounce the server to an internal one", async () => {
  const seen: string[] = [];
  const fetch: OidcFetch = async (url, init) => {
    seen.push(`${url} redirect=${init.redirect}`);
    return { status: 302, text: async () => "" };
  };
  await throwsCloud(discover("https://idp.example.com", { fetch, resolve: PUBLIC_IP }), "bad_request", /HTTP 302/);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /redirect=manual/);
});

test("an oversized, unreadable or unreachable identity provider is a clear error", async () => {
  const huge: OidcFetch = async () => ({ status: 200, text: async () => "x".repeat(300 * 1024) });
  await throwsCloud(discover("https://idp.example.com", { fetch: huge, resolve: PUBLIC_IP }), "bad_request", /large/);
  const junk: OidcFetch = async () => ({ status: 200, text: async () => "<html>" });
  await throwsCloud(discover("https://idp.example.com", { fetch: junk, resolve: PUBLIC_IP }), "bad_request", /JSON/);
  const down: OidcFetch = async () => Promise.reject(new Error("ECONNREFUSED 10.0.0.1"));
  await assert.rejects(discover("https://idp.example.com", { fetch: down, resolve: PUBLIC_IP }), (e: unknown) => e instanceof CloudError && e.code === "unavailable" && !e.message.includes("10.0.0.1"));
});

test("development mode allows http and loopback, nothing else changes", async () => {
  const idp = mockIdp({ issuer: "http://127.0.0.1:9999" });
  const found = await discover("http://127.0.0.1:9999", { fetch: idp.fetch, allowPrivateNetwork: true });
  assert.equal(found.tokenEndpoint, "http://127.0.0.1:9999/token");
  await throwsCloud(discover("http://127.0.0.1:9999", { fetch: idp.fetch }), "bad_request");
  await throwsCloud(discover("ftp://127.0.0.1", { fetch: idp.fetch, allowPrivateNetwork: true }), "bad_request");
});

// ---------------------------------------------------------------- discovery

test("discovery returns the endpoints of the issuer we asked about", async () => {
  const idp = mockIdp();
  assert.deepEqual(await discover("https://idp.example.com", opts(idp)), discovery(idp));
  assert.deepEqual(await discover("https://idp.example.com/", opts(idp)), discovery(idp), "a trailing slash is tolerated");
});

test("discovery refuses a document that describes a different issuer, lacks endpoints, or fails", async () => {
  const answer = (status: number, json: unknown): OidcFetch => async () => ({ status, text: async () => JSON.stringify(json) });
  const good = { issuer: "https://idp.example.com", authorization_endpoint: "https://idp.example.com/a", token_endpoint: "https://idp.example.com/t", jwks_uri: "https://idp.example.com/j" };
  await throwsCloud(discover("https://idp.example.com", { fetch: answer(200, { ...good, issuer: "https://evil.example.com" }), resolve: PUBLIC_IP }), "bad_request", /different issuer/);
  for (const missing of ["authorization_endpoint", "token_endpoint", "jwks_uri", "issuer"]) {
    const broken: Record<string, string> = { ...good };
    delete broken[missing];
    await throwsCloud(discover("https://idp.example.com", { fetch: answer(200, broken), resolve: PUBLIC_IP }), "bad_request");
  }
  await throwsCloud(discover("https://idp.example.com", { fetch: answer(404, {}), resolve: PUBLIC_IP }), "bad_request", /HTTP 404/);
});

test("the authorization URL carries PKCE (S256), state, nonce, scope and the exact redirect", () => {
  const idp = mockIdp();
  const pkce = newPkce();
  const url = new URL(buildAuthorizationUrl(discovery(idp), { clientId: "client-1", redirectUri: "https://cloud.example.com/api/auth/callback", state: "st", nonce: "no", challenge: pkce.challenge, loginHint: "a@b.co" }));
  assert.equal(url.origin + url.pathname, "https://idp.example.com/authorize");
  const p = url.searchParams;
  assert.deepEqual([p.get("response_type"), p.get("client_id"), p.get("redirect_uri"), p.get("scope"), p.get("state"), p.get("nonce"), p.get("code_challenge"), p.get("code_challenge_method"), p.get("login_hint")], ["code", "client-1", "https://cloud.example.com/api/auth/callback", "openid email profile", "st", "no", pkce.challenge, "S256", "a@b.co"]);
});

// ------------------------------------------------------------ code exchange

test("the code is exchanged with the PKCE verifier and the client secret, and yields the ID token", async () => {
  const idp = mockIdp({ clientSecret: "shh", now: clock.now });
  const pkce = newPkce();
  const authorize = buildAuthorizationUrl(discovery(idp), { clientId: "client-1", redirectUri: "https://cloud.example.com/cb", state: "s", nonce: "n1", challenge: pkce.challenge });
  const code = idp.issueCode(authorize, "client-1");
  const token = await exchangeCode(discovery(idp), CLIENT, { code, redirectUri: "https://cloud.example.com/cb", codeVerifier: pkce.verifier }, opts(idp));
  assert.equal(token.split(".").length, 3);
  const body = new URLSearchParams(idp.log.find((l) => l.url.endsWith("/token"))!.body);
  assert.deepEqual([body.get("grant_type"), body.get("client_id"), body.get("client_secret"), body.get("code_verifier")], ["authorization_code", "client-1", "shh", pkce.verifier]);
});

test("a wrong PKCE verifier, a wrong client secret and a reused code are all refused by the exchange", async () => {
  const idp = mockIdp({ clientSecret: "shh", now: clock.now });
  const pkce = newPkce();
  const authorize = buildAuthorizationUrl(discovery(idp), { clientId: "client-1", redirectUri: "https://x/cb", state: "s", nonce: "n", challenge: pkce.challenge });
  await throwsCloud(exchangeCode(discovery(idp), CLIENT, { code: idp.issueCode(authorize, "client-1"), redirectUri: "https://x/cb", codeVerifier: newPkce().verifier }, opts(idp)), "unauthenticated", /refused/);
  await throwsCloud(exchangeCode(discovery(idp), { ...CLIENT, clientSecret: "wrong" }, { code: idp.issueCode(authorize, "client-1"), redirectUri: "https://x/cb", codeVerifier: pkce.verifier }, opts(idp)), "unauthenticated", /invalid_client/);
  const code = idp.issueCode(authorize, "client-1");
  await exchangeCode(discovery(idp), CLIENT, { code, redirectUri: "https://x/cb", codeVerifier: pkce.verifier }, opts(idp));
  await throwsCloud(exchangeCode(discovery(idp), CLIENT, { code, redirectUri: "https://x/cb", codeVerifier: pkce.verifier }, opts(idp)), "unauthenticated");
});

test("an exchange that returns no ID token is refused", async () => {
  const noToken: OidcFetch = async () => ({ status: 200, text: async () => JSON.stringify({ access_token: "a" }) });
  await throwsCloud(exchangeCode(discovery(mockIdp()), CLIENT, { code: "c", redirectUri: "https://x", codeVerifier: "v" }, { fetch: noToken, resolve: PUBLIC_IP }), "unauthenticated", /did not return an ID token/);
});

// ------------------------------------------------------------ verification

async function verifyWith(idp: ReturnType<typeof mockIdp>, issue: Parameters<ReturnType<typeof mockIdp>["issueCode"]>[2] = {}, expectedNonce = "nonce-1", client = CLIENT) {
  const pkce = newPkce();
  const authorize = buildAuthorizationUrl(discovery(idp), { clientId: client.clientId, redirectUri: "https://x/cb", state: "s", nonce: "nonce-1", challenge: pkce.challenge });
  const code = idp.issueCode(authorize, client.clientId, issue);
  const token = await exchangeCode(discovery(idp), client, { code, redirectUri: "https://x/cb", codeVerifier: pkce.verifier }, opts(idp));
  return verifyIdToken(token, discovery(idp), client, { nonce: expectedNonce }, opts(idp));
}

test("a properly signed RS256 token yields the identity", async () => {
  const idp = mockIdp({ now: clock.now });
  assert.deepEqual(await verifyWith(idp, { subject: "sub-42", email: "Alice@Example.com", name: "Alice A" }), { subject: "sub-42", email: "alice@example.com", emailVerified: true, name: "Alice A" });
});

test("ES256 tokens are supported too", async () => {
  const idp = mockIdp({ alg: "ES256", now: clock.now });
  assert.equal((await verifyWith(idp, { subject: "ec-user" })).subject, "ec-user");
});

test("email_verified is reported as true, false, or unknown (null) exactly as the provider says", async () => {
  const idp = mockIdp({ now: clock.now });
  assert.equal((await verifyWith(idp, { emailVerified: true })).emailVerified, true);
  assert.equal((await verifyWith(idp, { emailVerified: false })).emailVerified, false);
  assert.equal((await verifyWith(idp, { emailVerified: null })).emailVerified, null);
  assert.equal((await verifyWith(idp, { email: null })).email, null);
});

test("ATTACK: a token with alg 'none' (no signature at all) is refused before anything else", async () => {
  const idp = mockIdp({ now: clock.now });
  const claims = idp.claimsFor({ nonce: "nonce-1" }, "client-1");
  const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
  await throwsCloud(verifyIdToken(unsigned, discovery(idp), CLIENT, { nonce: "nonce-1" }, opts(idp)), "unauthenticated");
  const noSigPart = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.AAAA`;
  await throwsCloud(verifyIdToken(noSigPart, discovery(idp), CLIENT, { nonce: "nonce-1" }, opts(idp)), "unauthenticated", /unsupported signature algorithm/);
  assert.equal(idp.log.some((l) => l.url.endsWith("/jwks")), false, "refused without even fetching keys");
});

test("ATTACK: an HS256 token signed with the provider's PUBLIC key as the HMAC secret is refused (algorithm confusion)", async () => {
  const idp = mockIdp({ now: clock.now });
  const claims = idp.claimsFor({ nonce: "nonce-1" }, "client-1");
  const input = `${b64({ alg: "HS256", typ: "JWT", kid: "key-1" })}.${b64(claims)}`;
  const hmac = createHmac("sha256", JSON.stringify(idp.jwk)).update(input).digest("base64url");
  await throwsCloud(verifyIdToken(`${input}.${hmac}`, discovery(idp), CLIENT, { nonce: "nonce-1" }, opts(idp)), "unauthenticated", /unsupported signature algorithm/);
  for (const alg of ["HS384", "HS512", "RS512", "PS256", "ES512", "EdDSA", "", 5, null]) {
    const t = `${b64({ alg, typ: "JWT" })}.${b64(claims)}.${hmac}`;
    await throwsCloud(verifyIdToken(t, discovery(idp), CLIENT, { nonce: "nonce-1" }, opts(idp)), "unauthenticated");
  }
});

test("ATTACK: a token signed with a different key (or tampered after signing) is refused", async () => {
  const idp = mockIdp({ now: clock.now });
  const attacker = mockIdp({ now: clock.now });
  const forged = attacker.signToken(idp.claimsFor({ nonce: "nonce-1", email: "ceo@example.com" }, "client-1"));
  await throwsCloud(verifyIdToken(forged, discovery(idp), CLIENT, { nonce: "nonce-1" }, opts(idp)), "unauthenticated", /signature is not valid/);

  await throwsCloud(
    verifyWith(idp, { email: "alice@example.com", mutate: (t) => { const [h, , s] = t.split("."); return `${h}.${b64({ ...idp.claimsFor({ nonce: "nonce-1" }, "client-1"), email: "ceo@example.com" })}.${s}`; } }),
    "unauthenticated",
    /signature is not valid/,
  );
  await throwsCloud(verifyWith(idp, { mutate: (t) => t.slice(0, -4) + "AAAA" }), "unauthenticated", /signature is not valid/);
});

test("the key is chosen by kid; an unknown kid, a wrong key type, or a wrong 'use' finds no key", async () => {
  const idp = mockIdp({ now: clock.now });
  const claims = idp.claimsFor({ nonce: "nonce-1" }, "client-1");
  await throwsCloud(verifyIdToken(idp.signToken(claims, { kid: "other-key" }), discovery(idp), CLIENT, { nonce: "nonce-1" }, opts(idp)), "unauthenticated", /No matching signing key/);
  const wrongType: OidcFetch = async (url, init) => (url.endsWith("/jwks") ? { status: 200, text: async () => JSON.stringify({ keys: [{ ...idp.jwk, kty: "EC" }] }) } : idp.fetch(url, init));
  await throwsCloud(verifyIdToken(idp.signToken(claims), discovery(idp), CLIENT, { nonce: "nonce-1" }, { fetch: wrongType, resolve: PUBLIC_IP, now: clock.now }), "unauthenticated", /No matching signing key/);
  const encKey: OidcFetch = async (url, init) => (url.endsWith("/jwks") ? { status: 200, text: async () => JSON.stringify({ keys: [{ ...idp.jwk, use: "enc" }] }) } : idp.fetch(url, init));
  await throwsCloud(verifyIdToken(idp.signToken(claims), discovery(idp), CLIENT, { nonce: "nonce-1" }, { fetch: encKey, resolve: PUBLIC_IP, now: clock.now }), "unauthenticated", /No matching signing key/);
});

test("a token without kid is accepted only when the provider has exactly one candidate key", async () => {
  const idp = mockIdp({ now: clock.now });
  const claims = idp.claimsFor({ nonce: "nonce-1" }, "client-1");
  const noKid = idp.signToken(claims, { kid: undefined });
  assert.ok(await verifyIdToken(noKid, discovery(idp), CLIENT, { nonce: "nonce-1" }, opts(idp)));
  const two: OidcFetch = async (url, init) => (url.endsWith("/jwks") ? { status: 200, text: async () => JSON.stringify({ keys: [idp.jwk, { ...idp.jwk, kid: "key-2" }] }) } : idp.fetch(url, init));
  await throwsCloud(verifyIdToken(noKid, discovery(idp), CLIENT, { nonce: "nonce-1" }, { fetch: two, resolve: PUBLIC_IP, now: clock.now }), "unauthenticated", /No matching signing key/);
});

test("issuer, audience, authorized party, expiry, not-before, issued-at and nonce are all enforced", async () => {
  const idp = mockIdp({ now: clock.now });
  await throwsCloud(verifyWith(idp, { issuer: "https://evil.example.com" }), "unauthenticated", /issued by someone else/);
  await throwsCloud(verifyWith(idp, { audience: "another-client" }), "unauthenticated", /different application/);
  await throwsCloud(verifyWith(idp, { audience: ["client-1", "second"] }), "unauthenticated", /authorized party/);
  assert.ok(await verifyWith(idp, { audience: ["client-1", "second"], azp: "client-1" }));
  await throwsCloud(verifyWith(idp, { expiresInS: -120 }), "unauthenticated", /expired/);
  await throwsCloud(verifyWith(idp, { issuedAtOffsetS: 600 }), "unauthenticated", /future/);
  await throwsCloud(verifyWith(idp, {}, "a-different-nonce"), "unauthenticated", /nonce/);
});

test("a little clock drift between servers is tolerated, a lot is not", async () => {
  const idp = mockIdp({ now: clock.now });
  assert.ok(await verifyWith(idp, { expiresInS: -30 }), "expired 30 s ago is within the 60 s allowance");
  await throwsCloud(verifyWith(idp, { expiresInS: -90 }), "unauthenticated", /expired/);
});

test("the nbf (not before) claim is honoured", async () => {
  const idp = mockIdp({ now: clock.now });
  const future = idp.signToken({ ...idp.claimsFor({ nonce: "nonce-1" }, "client-1"), nbf: Math.floor(clock.now().getTime() / 1000) + 600 });
  await throwsCloud(verifyIdToken(future, discovery(idp), CLIENT, { nonce: "nonce-1" }, opts(idp)), "unauthenticated", /not valid yet/);
});

test("a token with no subject, or that is simply malformed, is refused", async () => {
  const idp = mockIdp({ now: clock.now });
  const noSub = idp.signToken({ ...idp.claimsFor({ nonce: "nonce-1" }, "client-1"), sub: "" });
  await throwsCloud(verifyIdToken(noSub, discovery(idp), CLIENT, { nonce: "nonce-1" }, opts(idp)), "unauthenticated", /no subject/);
  for (const junk of ["", "a.b", "a.b.c.d", "...", "not.a.jwt", `${b64("x")}.${b64("y")}.zz`]) {
    await throwsCloud(verifyIdToken(junk, discovery(idp), CLIENT, { nonce: "nonce-1" }, opts(idp)), "unauthenticated");
  }
});

test("if the provider's key set cannot be read, nothing is accepted", async () => {
  const idp = mockIdp({ now: clock.now });
  const token = idp.signToken(idp.claimsFor({ nonce: "nonce-1" }, "client-1"));
  const broken: OidcFetch = async (url, init) => (url.endsWith("/jwks") ? { status: 500, text: async () => "boom" } : idp.fetch(url, init));
  await throwsCloud(verifyIdToken(token, discovery(idp), CLIENT, { nonce: "nonce-1" }, { fetch: broken, resolve: PUBLIC_IP, now: clock.now }), "unavailable");
});

// --------------------------------------------------- connecting to the address we checked

async function withLocalServer<T>(handler: Parameters<typeof createServer>[1], fn: (port: number, seen: { host: string | undefined; body: string }) => Promise<T>): Promise<T> {
  const seen = { host: undefined as string | undefined, body: "" };
  const server = createServer(async (req, res) => {
    seen.host = req.headers.host;
    for await (const chunk of req) seen.body += chunk;
    handler!(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn((server.address() as AddressInfo).port, seen);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("pinnedFetch connects to the validated address, not to the name (a name that would resolve elsewhere never gets looked up)", async () => {
  await withLocalServer((_req, res) => void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'), async (port, seen) => {
    // The host name below does not resolve anywhere. A client that resolved it again would fail; ours uses 127.0.0.1.
    const url = new URL(`http://idp-that-does-not-exist.example:${port}/.well-known/openid-configuration?x=1`);
    const response = await pinnedFetch(url, { method: "GET", headers: { accept: "application/json" } }, "127.0.0.1", AbortSignal.timeout(3000));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"ok":true}');
    assert.equal(seen.host, `idp-that-does-not-exist.example:${port}`, "the Host header still names the real host");
  });
});

test("pinnedFetch sends a POST body with the right length", async () => {
  await withLocalServer((_req, res) => void res.writeHead(200).end("done"), async (port, seen) => {
    const body = "grant_type=authorization_code&code=ü";
    const response = await pinnedFetch(new URL(`http://x.example:${port}/token`), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, "127.0.0.1", AbortSignal.timeout(3000));
    assert.equal(response.status, 200);
    assert.equal(seen.body, body);
  });
});

test("pinnedFetch stops reading an oversized response instead of buffering all of it", async () => {
  await withLocalServer((_req, res) => {
    res.writeHead(200);
    const chunk = Buffer.alloc(64 * 1024, 97);
    let sent = 0;
    const pump = () => {
      while (sent < 50 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return void res.once("drain", pump);
        if (res.destroyed) return;
      }
      res.end();
    };
    pump();
  }, async (port) => {
    await throwsCloud(pinnedFetch(new URL(`http://x.example:${port}/`), { method: "GET" }, "127.0.0.1", AbortSignal.timeout(5000)), "bad_request", /unreasonably large/);
  });
});

test("pinnedFetch honours the timeout signal", async () => {
  await withLocalServer(() => undefined, async (port) => {
    await assert.rejects(pinnedFetch(new URL(`http://x.example:${port}/`), { method: "GET" }, "127.0.0.1", AbortSignal.timeout(200)));
  });
});

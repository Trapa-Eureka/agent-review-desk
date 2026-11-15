import { CloudError, INGEST_LIMITS, forwardedClient, isCloudError, isSameOriginRequest, principalFromBearer, principalFromSession, safeReturnTo, type Cloud, type Principal } from "@ard/cloud";
import { absolute } from "./cloud";

/** `__Host-` pins the cookie to this exact host, over https, for the whole site (no Domain attribute possible). */
export const sessionCookieName = (cloud: Cloud): string => (cloud.config.baseUrl.startsWith("https:") ? "__Host-ard_session" : "ard_session");

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

/** Turn any failure into a response. Known failures speak plainly; unknown ones are logged and answered with a bland 500. */
export function fail(error: unknown): Response {
  if (isCloudError(error)) {
    return json({ error: error.message, code: error.code, ...(error.retryAfter ? { retry_after: error.retryAfter } : {}) }, error.status, error.retryAfter ? { "retry-after": String(error.retryAfter) } : {});
  }
  console.error("[ard-cloud] unexpected error:", error instanceof Error ? error.stack ?? error.message : error);
  return json({ error: "Something went wrong on the server.", code: "internal" }, 500);
}

/** Wrap a route handler so a thrown CloudError becomes a proper JSON response. */
export async function api(handler: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return fail(error);
  }
}

/** A 303 redirect to a path on THIS site. The host always comes from configuration, never from the request. */
export function redirectTo(cloud: Cloud, path: string, extraHeaders: Record<string, string> = {}, cookies: string[] = []): Response {
  const headers = new Headers({ location: absolute(cloud, safeReturnTo(path)), ...extraHeaders });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export function withMessage(path: string, kind: "notice" | "error", message: string): string {
  const url = new URL(path, "http://x");
  url.searchParams.set(kind, message.slice(0, 200));
  return `${url.pathname}${url.search}`;
}

/**
 * Cookie-authenticated requests that change something must come from our own pages (CSRF defence, on top of
 * SameSite=Lax). The rule itself is `isSameOriginRequest`; see it for why Sec-Fetch-Site, not Origin, leads.
 */
export function assertSameOrigin(request: Request, cloud: Cloud): void {
  if (!isSameOriginRequest(request.headers, cloud.config.baseUrl)) throw new CloudError("forbidden", "This request did not come from this site.");
}

/** One cookie's value, or null. A malformed value (bad %-escape) is "no cookie", never an exception. */
export function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The signed-in person behind a request from our own pages. */
export function sessionPrincipal(request: Request, cloud: Cloud): Principal {
  const principal = principalFromSession(cloud.control, cookieValue(request, sessionCookieName(cloud)));
  if (!principal) throw new CloudError("unauthenticated", "Please sign in.");
  return principal;
}

/** The person behind an `ard` CLI request (Bearer token). */
export function bearerPrincipal(request: Request, cloud: Cloud): Principal {
  const principal = principalFromBearer(cloud.control, request.headers.get("authorization"));
  if (!principal) throw new CloudError("unauthenticated", "Not signed in. Run `ard login`.");
  return principal;
}

export function sessionCookie(cloud: Cloud, token: string, maxAgeSeconds: number): string {
  const secure = cloud.config.baseUrl.startsWith("https:") ? "; Secure" : "";
  return `${sessionCookieName(cloud)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearedSessionCookie(cloud: Cloud): string {
  const secure = cloud.config.baseUrl.startsWith("https:") ? "; Secure" : "";
  return `${sessionCookieName(cloud)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/**
 * Who is calling, for rate limiting. Behind a reverse proxy set ARD_CLOUD_TRUST_PROXY=1 (one proxy hop; a larger
 * number means that many hops): the address is read from the RIGHT of X-Forwarded-For, where our own proxy appended it,
 * because anything to its left was written by the client. Without the setting the header is ignored and everyone
 * shares one bucket ("direct"): safe against spoofing, but one noisy client can use up everyone's allowance.
 */
export function clientKey(request: Request): string {
  const hops = Number(process.env.ARD_CLOUD_TRUST_PROXY ?? 0);
  if (!Number.isInteger(hops) || hops < 1) return "direct";
  return forwardedClient(request.headers.get("x-forwarded-for"), hops);
}

/** Cookie that binds a sign-in attempt to the browser that started it (login CSRF defence). */
export const loginCookieName = (cloud: Cloud): string => (cloud.config.baseUrl.startsWith("https:") ? "__Host-ard_login" : "ard_login");

export function loginCookie(cloud: Cloud, state: string, maxAgeSeconds: number): string {
  const secure = cloud.config.baseUrl.startsWith("https:") ? "; Secure" : "";
  return `${loginCookieName(cloud)}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearedLoginCookie(cloud: Cloud): string {
  return loginCookie(cloud, "", 0);
}

/** Read a request body as text with a hard size cap, refusing early on a declared length that is too big. */
export async function readText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new CloudError("too_large", "That request is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) throw new CloudError("too_large", "That request is too large.");
  return text;
}

export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const text = await readText(request, maxBytes);
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new CloudError("bad_request", "The request body must be a JSON object.");
}

/** Read a small HTML form post into a plain string map. */
export async function readForm(request: Request): Promise<Map<string, string>> {
  const text = await readText(request, 32 * 1024);
  const map = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(text)) map.set(key, value);
  return map;
}

export { INGEST_LIMITS };

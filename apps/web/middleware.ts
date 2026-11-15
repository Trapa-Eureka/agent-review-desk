import { NextResponse, type NextRequest } from "next/server";

/**
 * Access control for the review UI. It can approve actions an agent is waiting on, and it shows code
 * and command output, so a web page you merely visit must never be able to talk to it.
 *
 *  1. Host must be a loopback name (blocks DNS-rebinding: an attacker's domain pointing at 127.0.0.1).
 *  2. Every request needs the per-launch token, as a cookie. `ard review` prints a link carrying it once;
 *     it is swapped for an HttpOnly, SameSite=Strict cookie and removed from the address bar.
 *  3. Anything that changes state must come from this origin (CSRF).
 */

const COOKIE = "ard_token";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hostnameOf(host: string): string {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
}

function deny(request: NextRequest, status: number, message: string): NextResponse {
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: message }, { status });
  return new NextResponse(`<!doctype html><meta charset="utf-8"><title>ard review</title><body style="font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>${status === 503 ? "Not configured" : "Access denied"}</h1><p>${message}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function middleware(request: NextRequest) {
  const token = process.env.ARD_UI_TOKEN;
  if (!token) return deny(request, 503, "This UI must be started with <code>ard review</code>, which sets up its access token.");

  const host = request.headers.get("host") ?? "";
  if (!LOOPBACK.has(hostnameOf(host))) return deny(request, 403, "This UI only answers on 127.0.0.1 / localhost.");

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    // Two independent signals must agree. Sec-Fetch-Site is set by the browser and cannot be forged by a web page;
    // Origin must name this host. `Origin: null` is only accepted when Sec-Fetch-Site vouches for it, because with
    // `Referrer-Policy: no-referrer` browsers send exactly that on the site's own form posts.
    const site = request.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") return deny(request, 403, "Cross-site requests are not allowed.");
    const origin = request.headers.get("origin");
    if (origin !== null && !(origin === "null" && site !== null)) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        // malformed Origin: treated as a mismatch below
      }
      if (originHost !== host) return deny(request, 403, "Cross-origin requests are not allowed.");
    }
  }

  const given = request.nextUrl.searchParams.get("token");
  if (given !== null) {
    if (!safeEqual(given, token)) return deny(request, 401, "That link is not valid any more. Run <code>ard review</code> again and use the new link.");
    // Serve the page and set the cookie in the same response; do NOT redirect. Next rewrites 127.0.0.1 to
    // "localhost" in redirects (and rejects relative ones), and a cookie set for one host is invisible on the
    // other, which would lock the user out. The token is wiped from the address bar by <StripToken /> instead.
    const response = NextResponse.next();
    response.cookies.set(COOKIE, token, { httpOnly: true, sameSite: "strict", path: "/" });
    return response;
  }

  const cookie = request.cookies.get(COOKIE)?.value ?? "";
  if (!safeEqual(cookie, token)) return deny(request, 401, "Open the link that <code>ard review</code> printed in your terminal.");
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

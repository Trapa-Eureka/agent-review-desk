import { NextResponse, type NextRequest } from "next/server";

/**
 * The team workspace server is unreleased and BLOCKED: every request, webhooks and health check included, gets a 503
 * unless ARD_UNRELEASED_CLOUD=1 (development and the end-to-end test only; not documented, not set by any normal install).
 */
export function middleware(_request: NextRequest) {
  if (process.env.ARD_UNRELEASED_CLOUD === "1") return NextResponse.next();
  return new NextResponse("Not available. The paid team features of Agent Review Desk are still in planning.\n", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

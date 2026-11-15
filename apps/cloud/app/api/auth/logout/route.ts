import { getCloud } from "../../../../lib/cloud";
import { assertSameOrigin, clearedSessionCookie, redirectTo, sessionCookieName } from "../../../../lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const cloud = getCloud();
  try {
    assertSameOrigin(request, cloud);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  const name = sessionCookieName(cloud);
  const match = (request.headers.get("cookie") ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  if (match) cloud.control.deleteWebSession(decodeURIComponent(match.slice(name.length + 1)));
  return redirectTo(cloud, "/", { "set-cookie": clearedSessionCookie(cloud) });
}

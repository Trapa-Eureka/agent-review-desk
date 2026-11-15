import { getCloud } from "../../../../lib/cloud";
import { assertSameOrigin, clearedSessionCookie, cookieValue, redirectTo, sessionCookieName } from "../../../../lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const cloud = getCloud();
  try {
    assertSameOrigin(request, cloud);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  const token = cookieValue(request, sessionCookieName(cloud));
  if (token) cloud.control.deleteWebSession(token);
  return redirectTo(cloud, "/", { "set-cookie": clearedSessionCookie(cloud) });
}

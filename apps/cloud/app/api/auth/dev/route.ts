import { SESSION_TTL_MS, isEmail, safeReturnTo } from "@ard/cloud";
import { getCloud } from "../../../../lib/cloud";
import { assertSameOrigin, readForm, redirectTo, sessionCookie, withMessage } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/**
 * LOCAL DEVELOPMENT ONLY. Sign in as any e-mail address, no password. The server refuses to start with
 * ARD_CLOUD_DEV_LOGIN=1 unless its public URL is localhost; this route also disappears (404) when it is off.
 */
export async function POST(request: Request) {
  const cloud = getCloud();
  if (!cloud.config.devLogin) return new Response("Not found", { status: 404 });
  try {
    assertSameOrigin(request, cloud);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  const form = await readForm(request);
  const email = (form.get("email") ?? "").trim().toLowerCase();
  if (!isEmail(email)) return redirectTo(cloud, withMessage("/", "error", "Enter an e-mail address."));
  const user = cloud.control.upsertPlatformUser(email, form.get("name") || null);
  const token = cloud.control.createWebSession(user.id, SESSION_TTL_MS);
  return redirectTo(cloud, safeReturnTo(form.get("next")), { "set-cookie": sessionCookie(cloud, token, SESSION_TTL_MS / 1000) });
}

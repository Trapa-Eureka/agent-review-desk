import { CloudError, beginSsoLogin, normalizeSlug } from "@ard/cloud";
import { loginDeps } from "../../../../lib/auth";
import { getCloud } from "../../../../lib/cloud";
import { assertSameOrigin, clientKey, readForm, redirectTo, withMessage } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** "Sign in with your company" : the person types their organization's address, we send them to that company's IdP. */
export async function POST(request: Request) {
  const cloud = getCloud();
  try {
    assertSameOrigin(request, cloud);
    const hit = cloud.logins.hit(`login:${clientKey(request)}`);
    if (!hit.allowed) throw new CloudError("rate_limited", "Too many sign-in attempts. Wait a few minutes.", Math.ceil(hit.retryAfterMs / 1000));
    const slug = normalizeSlug((await readForm(request)).get("org") ?? "");
    const url = await beginSsoLogin(loginDeps(cloud), slug, `/o/${slug}`);
    return new Response(null, { status: 303, headers: { location: url } });
  } catch (error) {
    return redirectTo(cloud, withMessage("/", "error", error instanceof CloudError ? error.message : "Single sign-on could not be started."));
  }
}

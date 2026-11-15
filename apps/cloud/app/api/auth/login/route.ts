import { CloudError, beginPlatformLogin, safeReturnTo } from "@ard/cloud";
import { loginDeps } from "../../../../lib/auth";
import { getCloud } from "../../../../lib/cloud";
import { assertSameOrigin, clientKey, readForm, redirectTo, withMessage } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** "Sign in" button: send the browser to the operator's OpenID Connect provider. */
export async function POST(request: Request) {
  const cloud = getCloud();
  try {
    assertSameOrigin(request, cloud);
    const hit = cloud.logins.hit(`login:${clientKey(request)}`);
    if (!hit.allowed) throw new CloudError("rate_limited", "Too many sign-in attempts. Wait a few minutes.", Math.ceil(hit.retryAfterMs / 1000));
    if (!cloud.config.login) throw new CloudError("unavailable", "Sign-in with an account is not configured on this server.");
    const form = await readForm(request);
    const url = await beginPlatformLogin(loginDeps(cloud), cloud.config.login, safeReturnTo(form.get("next")));
    return new Response(null, { status: 303, headers: { location: url } });
  } catch (error) {
    return redirectTo(cloud, withMessage("/", "error", error instanceof CloudError ? error.message : "Sign-in could not be started."));
  }
}

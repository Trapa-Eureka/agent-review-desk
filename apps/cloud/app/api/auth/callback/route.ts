import { CloudError, SESSION_TTL_MS, completeLogin } from "@ard/cloud";
import { loginDeps } from "../../../../lib/auth";
import { getCloud } from "../../../../lib/cloud";
import { clearedLoginCookie, cookieValue, loginCookieName, redirectTo, sessionCookie, withMessage } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** The identity provider sends the browser back here with a one-time code. */
export async function GET(request: Request) {
  const cloud = getCloud();
  const url = new URL(request.url);
  try {
    const result = await completeLogin(loginDeps(cloud), cloud.config.login, {
      state: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      browserState: cookieValue(request, loginCookieName(cloud)),
    });
    cloud.control.purgeExpired();
    const destination = result.returnTo === "/" && result.orgSlug ? `/o/${result.orgSlug}` : result.returnTo;
    return redirectTo(cloud, destination, {}, [sessionCookie(cloud, result.sessionToken, SESSION_TTL_MS / 1000), clearedLoginCookie(cloud)]);
  } catch (error) {
    return redirectTo(cloud, withMessage("/", "error", error instanceof CloudError ? error.message : "Sign-in failed. Please try again."), {}, [clearedLoginCookie(cloud)]);
  }
}

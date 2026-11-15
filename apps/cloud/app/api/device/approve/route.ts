import { CloudError, decideDeviceLogin } from "@ard/cloud";
import { getCloud } from "../../../../lib/cloud";
import { assertSameOrigin, readForm, redirectTo, sessionPrincipal, withMessage } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** A signed-in person confirms (or refuses) the code that `ard login` is showing in their terminal. */
export async function POST(request: Request) {
  const cloud = getCloud();
  try {
    assertSameOrigin(request, cloud);
    const principal = sessionPrincipal(request, cloud);
    const form = await readForm(request);
    const decision = form.get("decision") === "deny" ? "denied" : "approved";
    decideDeviceLogin(cloud.control, cloud.deviceGuesses, principal.user, form.get("code") ?? "", decision);
    return redirectTo(cloud, withMessage("/device", "notice", decision === "approved" ? "Approved. Go back to your terminal: `ard` is now signed in." : "Refused. Nothing was signed in."));
  } catch (error) {
    if (error instanceof CloudError && error.code === "unauthenticated") return redirectTo(cloud, "/?next=/device");
    return redirectTo(cloud, withMessage("/device", "error", error instanceof CloudError ? error.message : "That did not work."));
  }
}

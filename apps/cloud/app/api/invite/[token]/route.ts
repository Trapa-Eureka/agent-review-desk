import { CloudError, acceptInvitation } from "@ard/cloud";
import { getCloud } from "../../../../lib/cloud";
import { assertSameOrigin, redirectTo, sessionPrincipal, withMessage } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** The invited person joins. The signed-in account's e-mail must be the invited one (checked in acceptInvitation). */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const cloud = getCloud();
  const { token } = await context.params;
  try {
    assertSameOrigin(request, cloud);
    const principal = sessionPrincipal(request, cloud);
    const { org } = acceptInvitation(cloud.control, principal.user, token);
    return redirectTo(cloud, withMessage(`/o/${org.slug}`, "notice", `Welcome to ${org.name}.`));
  } catch (error) {
    if (error instanceof CloudError && error.code === "unauthenticated") return redirectTo(cloud, `/?next=${encodeURIComponent(`/invite/${token}`)}`);
    return redirectTo(cloud, withMessage(`/invite/${token}`, "error", error instanceof CloudError ? error.message : "Could not accept the invitation."));
  }
}

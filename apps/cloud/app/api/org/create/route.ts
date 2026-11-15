import { CloudError, createOrg } from "@ard/cloud";
import { getCloud } from "../../../../lib/cloud";
import { assertSameOrigin, readForm, redirectTo, sessionPrincipal, withMessage } from "../../../../lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const cloud = getCloud();
  try {
    assertSameOrigin(request, cloud);
    const principal = sessionPrincipal(request, cloud);
    const form = await readForm(request);
    const org = createOrg(cloud.control, principal.user, { name: form.get("name") ?? "", slug: form.get("slug") ?? "" });
    return redirectTo(cloud, withMessage(`/o/${org.slug}`, "notice", "Organization created. You are its owner."));
  } catch (error) {
    if (error instanceof CloudError && error.code === "unauthenticated") return redirectTo(cloud, "/");
    return redirectTo(cloud, withMessage("/", "error", error instanceof CloudError ? error.message : "Could not create the organization."));
  }
}

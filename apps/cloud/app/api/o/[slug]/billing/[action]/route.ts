import { CloudError, openBillingPortal, startCheckout } from "@ard/cloud";
import { orgAction } from "../../../../../../lib/org-route";

export const dynamic = "force-dynamic";

/** checkout | portal : the Billing page. Only owners ("billing.manage") get this far. */
export async function POST(request: Request, context: { params: Promise<{ slug: string; action: string }> }) {
  const { action } = await context.params;
  return orgAction(request, context, { action: "billing.manage", section: "billing" }, async ({ cloud, principal, access, form, slug }) => {
    const returnUrl = `${cloud.config.baseUrl}/o/${slug}/billing?checkout=return`;
    if (action === "checkout") {
      const { url } = await startCheckout(cloud.control, cloud.providers, { org: access.org, user: principal.user, providerId: form.get("provider") ?? "", returnUrl, now: cloud.control.time() });
      return new Response(null, { status: 303, headers: { location: url } });
    }
    if (action === "portal") {
      const { url } = await openBillingPortal(cloud.providers, { org: access.org, returnUrl });
      return new Response(null, { status: 303, headers: { location: url } });
    }
    throw new CloudError("not_found", "Unknown action.");
  });
}

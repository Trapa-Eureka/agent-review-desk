import { CloudError, saveSsoSettings } from "@ard/cloud";
import { loginDeps } from "../../../../../../lib/auth";
import { orgAction } from "../../../../../../lib/org-route";

export const dynamic = "force-dynamic";

/** save | enforce | remove : the SSO settings page. Owners only. */
export async function POST(request: Request, context: { params: Promise<{ slug: string; action: string }> }) {
  const { action } = await context.params;
  return orgAction(request, context, { action: "sso.manage", section: "sso" }, async ({ cloud, principal, access, form }) => {
    const { org } = access;
    switch (action) {
      case "save":
        await saveSsoSettings(loginDeps(cloud), principal, org.id, {
          issuer: form.get("issuer") ?? "",
          clientId: form.get("clientId") ?? "",
          clientSecret: form.get("clientSecret") ?? "",
          emailDomain: form.get("emailDomain") ?? "",
          defaultRole: form.get("defaultRole") ?? "",
        });
        return "Single sign-on saved. Test it in a private window before you enforce it.";
      case "enforce": {
        const on = form.get("enforce") === "on";
        if (on && !cloud.control.getSsoConfig(org.id)) throw new CloudError("bad_request", "Configure single sign-on before enforcing it.");
        cloud.control.setSsoEnforced(org.id, on);
        cloud.control.audit(org.id, principal.user.id, on ? "sso.enforced" : "sso.enforcement_removed");
        return on ? "Single sign-on is now required (owners can still sign in directly)." : "Single sign-on is no longer required.";
      }
      case "remove":
        cloud.control.removeSsoConfig(org.id);
        cloud.control.audit(org.id, principal.user.id, "sso.removed");
        return "Single sign-on removed.";
      default:
        throw new CloudError("not_found", "Unknown action.");
    }
  });
}

import { CloudError, changeMemberRole, inviteMember, removeMember } from "@ard/cloud";
import { orgAction } from "../../../../../../lib/org-route";
import { redirectTo, withMessage } from "../../../../../../lib/http";

export const dynamic = "force-dynamic";

/** invite | role | remove | leave : the buttons on the Members page. */
export async function POST(request: Request, context: { params: Promise<{ slug: string; action: string }> }) {
  const { action } = await context.params;
  const permission = action === "leave" ? "view" : "members.manage";
  return orgAction(request, context, { action: permission, section: "members" }, ({ cloud, principal, access, form, slug }) => {
    const { org, role } = access;
    switch (action) {
      case "invite": {
        const { token } = inviteMember(cloud.control, principal, org, role, { email: form.get("email") ?? "", role: form.get("role") ?? "" });
        // The one-time link is shown to the inviter on the next page (the invitee must also sign in with the invited e-mail).
        return redirectTo(cloud, withMessage(`/o/${slug}/members`, "notice", "Invitation created. Send the link below to that person.") + `&invite=${encodeURIComponent(token)}`);
      }
      case "role":
        changeMemberRole(cloud.control, principal, org, role, form.get("user") ?? "", form.get("role") ?? "");
        return "Role updated.";
      case "remove":
        removeMember(cloud.control, principal, org, role, form.get("user") ?? "");
        return "Member removed.";
      case "leave":
        removeMember(cloud.control, principal, org, role, principal.user.id);
        return redirectTo(cloud, withMessage("/", "notice", `You left ${org.name}.`));
      default:
        throw new CloudError("not_found", "Unknown action.");
    }
  });
}

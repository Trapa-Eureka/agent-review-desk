import { CloudError, requireEntitled, requireOrgAccess } from "@ard/cloud";
import { reviewSession } from "@ard/core";
import { getCloud } from "../../../../../../../lib/cloud";
import { api, assertSameOrigin, json, readJson, sessionPrincipal } from "../../../../../../../lib/http";

export const dynamic = "force-dynamic";

/** A reviewer approves or rejects a synced session. Needs the "review" role AND an active plan. */
export function POST(request: Request, context: { params: Promise<{ slug: string; id: string }> }) {
  return api(async () => {
    const cloud = getCloud();
    const { slug, id } = await context.params;
    assertSameOrigin(request, cloud);
    const principal = sessionPrincipal(request, cloud);
    const { org } = requireOrgAccess(cloud.control, principal, slug, "review");
    requireEntitled(org, cloud.control.time());
    const body = await readJson(request, 8 * 1024);
    const decision = body.decision;
    if (decision !== "approved" && decision !== "rejected") throw new CloudError("bad_request", 'decision must be "approved" or "rejected".');
    const note = typeof body.note === "string" ? body.note : null;
    // Recorded as the reviewer's e-mail so the audit trail says who, not just "reviewer".
    const event = cloud.workspaces.with(org.id, (repo) => reviewSession(repo, null, "/cloud", id, decision, { by: principal.user.email, note }));
    if (!event) throw new CloudError("not_found", "No such session.");
    cloud.control.audit(org.id, principal.user.id, `session.${decision}`, id);
    return json({ ok: true, decision });
  });
}

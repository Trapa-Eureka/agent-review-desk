import { CloudError, INGEST_LIMITS, ingestEvents, requireEntitled, requireOrgAccess } from "@ard/cloud";
import { getCloud } from "../../../../../../lib/cloud";
import { api, bearerPrincipal, json, readJson } from "../../../../../../lib/http";

export const dynamic = "force-dynamic";

/**
 * `ard sync` uploads recorded events here. Checked in this order: who you are, whether you belong to the organization
 * with a role that may upload, whether the organization's plan is active, then the contents of the upload.
 */
export function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  return api(async () => {
    const cloud = getCloud();
    const { slug } = await context.params;
    const principal = bearerPrincipal(request, cloud);
    const hit = cloud.uploads.hit(`upload:${principal.user.id}`);
    if (!hit.allowed) throw new CloudError("rate_limited", "Uploading too fast. Try again in a moment.", Math.ceil(hit.retryAfterMs / 1000));
    const { org } = requireOrgAccess(cloud.control, principal, slug, "upload");
    requireEntitled(org, cloud.control.time());
    const body = await readJson(request, INGEST_LIMITS.maxBodyBytes);
    if (!Array.isArray(body.events)) throw new CloudError("bad_request", "Send {\"events\": [...]}.");
    const result = ingestEvents(cloud.control, cloud.workspaces, { orgId: org.id, userId: principal.user.id, events: body.events, quotaBytes: cloud.config.maxOrgBytes });
    return json(result);
  });
}

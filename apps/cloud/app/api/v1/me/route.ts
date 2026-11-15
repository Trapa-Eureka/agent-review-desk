import { orgEntitlement } from "@ard/cloud";
import { getCloud } from "../../../../lib/cloud";
import { api, bearerPrincipal, json } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** Who am I, and what can each of my organizations do (plan included)? Used by `ard whoami` and before `ard sync`. */
export function GET(request: Request) {
  return api(() => {
    const cloud = getCloud();
    const { user } = bearerPrincipal(request, cloud);
    const now = cloud.control.time();
    return json({
      user: { email: user.email, name: user.name },
      organizations: cloud.control.listOrgsForUser(user.id).map(({ org, role }) => {
        const plan = orgEntitlement(org, now);
        return { slug: org.slug, name: org.name, role, plan: { active: plan.active, reason: plan.reason, until: plan.until } };
      }),
      billing_url: `${cloud.config.baseUrl}/`,
    });
  });
}

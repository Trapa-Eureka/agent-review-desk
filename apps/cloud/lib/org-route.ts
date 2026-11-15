import { CloudError, isCloudError, requireOrgAccess, type Action, type Cloud, type OrgAccess, type Principal } from "@ard/cloud";
import { getCloud } from "./cloud";
import { assertSameOrigin, readForm, redirectTo, sessionPrincipal, withMessage } from "./http";

export interface OrgActionContext {
  cloud: Cloud;
  principal: Principal;
  access: OrgAccess;
  form: Map<string, string>;
  slug: string;
}

/**
 * The shared shell of every "button on an organization page" route. It does, in this order and every time:
 *   same-origin check -> signed-in person -> membership + role for `action` -> then your code.
 * A string returned from `run` becomes a green notice, a thrown CloudError becomes a red error, both shown on the same
 * page after a redirect (so a refresh never re-submits the form). Return a Response to take over (e.g. a checkout link).
 */
export async function orgAction(request: Request, context: { params: Promise<{ slug: string }> }, options: { action: Action; section: string }, run: (c: OrgActionContext) => Promise<Response | string | void> | Response | string | void): Promise<Response> {
  const cloud = getCloud();
  const { slug } = await context.params;
  const back = `/o/${slug}/${options.section}`.replace(/\/$/, "");
  try {
    assertSameOrigin(request, cloud);
    const principal = sessionPrincipal(request, cloud);
    const access = requireOrgAccess(cloud.control, principal, slug, options.action);
    const form = await readForm(request);
    const result = await run({ cloud, principal, access, form, slug });
    if (result instanceof Response) return result;
    return redirectTo(cloud, typeof result === "string" ? withMessage(back, "notice", result) : back);
  } catch (error) {
    if (isCloudError(error) && error.code === "unauthenticated") return redirectTo(cloud, `/?next=${encodeURIComponent(back)}`);
    if (isCloudError(error)) return redirectTo(cloud, withMessage(back, "error", error.message));
    console.error("[ard-cloud] unexpected error:", error);
    return redirectTo(cloud, withMessage(back, "error", "Something went wrong on the server."));
  }
}

export { CloudError };

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { CloudError, isCloudError, principalFromSession, requireOrgAccess, type Action, type Cloud, type LoginDeps, type OrgAccess, type Principal } from "@ard/cloud";
import { getCloud } from "./cloud";
import { sessionCookieName } from "./http";

export function loginDeps(cloud: Cloud): LoginDeps {
  return { control: cloud.control, secret: cloud.config.secret, baseUrl: cloud.config.baseUrl, oidc: cloud.oidc };
}

/** The signed-in person for a server-rendered page, or null. */
export async function currentPrincipal(): Promise<Principal | null> {
  const cloud = getCloud();
  const store = await cookies();
  return principalFromSession(cloud.control, store.get(sessionCookieName(cloud))?.value);
}

/** Pages that need a signed-in person send everyone else to the sign-in page and bring them back afterwards. */
export async function requirePrincipal(returnTo: string): Promise<Principal> {
  const principal = await currentPrincipal();
  if (!principal) redirect(`/?next=${encodeURIComponent(returnTo)}`);
  return principal;
}

export type OrgContext = { ok: true; principal: Principal; access: OrgAccess } | { ok: false; principal: Principal; message: string };

/**
 * Everything an organization page needs. A missing organization or non-membership becomes the same 404; a role that
 * is too low comes back as a message the page shows, so the person understands why.
 */
export async function orgContext(slug: string, action: Action, returnTo: string): Promise<OrgContext> {
  const principal = await requirePrincipal(returnTo);
  const cloud = getCloud();
  try {
    return { ok: true, principal, access: requireOrgAccess(cloud.control, principal, slug, action) };
  } catch (error) {
    if (isCloudError(error) && error.code === "not_found") notFound();
    if (isCloudError(error)) return { ok: false, principal, message: error.message };
    throw error;
  }
}

export { CloudError };

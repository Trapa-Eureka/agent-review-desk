import Flash from "../../../components/Flash";
import { requirePrincipal } from "../../../lib/auth";
import { getCloud } from "../../../lib/cloud";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const query = await searchParams;
  const principal = await requirePrincipal(`/invite/${token}`);
  const cloud = getCloud();
  const invitation = cloud.control.findInvitationByToken(token);
  const org = invitation ? cloud.control.getOrg(invitation.orgId) : null;
  const valid = invitation && org && !invitation.acceptedAt && Date.parse(invitation.expiresAt) > cloud.control.time().getTime();

  if (!valid || !invitation || !org) {
    return (
      <>
        <h1>Invitation</h1>
        <Flash params={query} />
        <p className="flash error">This invitation is not valid any more. Ask for a new one.</p>
      </>
    );
  }
  const wrongAccount = principal.user.email !== invitation.email;
  return (
    <>
      <h1>Join {org.name}</h1>
      <Flash params={query} />
      <p>
        You were invited as <strong>{invitation.role}</strong> (sent to {invitation.email}).
      </p>
      {wrongAccount ? (
        <p className="flash warn">You are signed in as {principal.user.email}. Sign out and sign in as {invitation.email} to accept.</p>
      ) : (
        <form method="post" action={`/api/invite/${token}`}>
          <button type="submit" className="btn primary">
            Join {org.name}
          </button>
        </form>
      )}
    </>
  );
}

import Flash from "../../../../components/Flash";
import OrgNav from "../../../../components/OrgNav";
import { orgContext } from "../../../../lib/auth";
import { getCloud } from "../../../../lib/cloud";

export const dynamic = "force-dynamic";

export default async function Sso({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const query = await searchParams;
  const ctx = await orgContext(slug, "sso.manage", `/o/${slug}/sso`);
  if (!ctx.ok) return <p className="flash error">{ctx.message}</p>;
  const cloud = getCloud();
  const { org, role } = ctx.access;
  const sso = cloud.control.getSsoConfig(org.id);
  const redirectUri = `${cloud.config.baseUrl}/api/auth/callback`;

  return (
    <>
      <h1>{org.name}</h1>
      <OrgNav slug={slug} role={role} current="sso" />
      <Flash params={query} />
      <p>Let your team sign in with your company&apos;s identity provider (Okta, Microsoft Entra ID, Google Workspace, Auth0 or any OpenID Connect provider). SAML is not supported yet.</p>

      <section className="card">
        <h2>In your identity provider</h2>
        <p>Create an OpenID Connect web application and give it this redirect URI:</p>
        <code className="copy">{redirectUri}</code>
        <p className="hint">Then paste its issuer URL, client id and client secret below. People then sign in at the home page with the organization address <strong>{slug}</strong>.</p>
      </section>

      <section className="card">
        <h2>{sso ? "Settings" : "Set up single sign-on"}</h2>
        <form method="post" action={`/api/o/${slug}/sso/save`} className="stack">
          <label>
            Issuer URL
            <input type="url" name="issuer" required defaultValue={sso?.issuer ?? ""} placeholder="https://login.example.com" />
          </label>
          <label>
            Client id
            <input type="text" name="clientId" required defaultValue={sso?.clientId ?? ""} autoComplete="off" />
          </label>
          <label>
            Client secret {sso ? "(enter it again to save changes)" : ""}
            <input type="password" name="clientSecret" required autoComplete="new-password" />
          </label>
          <label>
            Company e-mail domain
            <input type="text" name="emailDomain" required defaultValue={sso?.emailDomain ?? ""} placeholder="example.com" />
          </label>
          <label>
            Role for new people
            <select name="defaultRole" defaultValue={sso?.defaultRole ?? "member"}>
              <option value="member">member</option>
              <option value="reviewer">reviewer</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <button type="submit" className="btn primary">
            Save
          </button>
        </form>
        <p className="hint">The secret is encrypted before it is stored. Only e-mail addresses on the domain above can sign in this way.</p>
      </section>

      {sso ? (
        <section className="card">
          <h2>Require single sign-on</h2>
          <p>
            Currently: <strong>{org.ssoEnforced ? "required" : "optional"}</strong>. When required, members who sign in another way can no longer open this organization. Owners can still sign in directly, so you cannot lock yourself out.
          </p>
          <form method="post" action={`/api/o/${slug}/sso/enforce`} className="inline-form">
            {org.ssoEnforced ? (
              <button type="submit" className="btn plain">
                Stop requiring it
              </button>
            ) : (
              <>
                <input type="hidden" name="enforce" value="on" />
                <button type="submit" className="btn primary">
                  Require it
                </button>
              </>
            )}
          </form>
          <form method="post" action={`/api/o/${slug}/sso/remove`} style={{ marginTop: "1rem" }}>
            <button type="submit" className="btn danger">
              Remove single sign-on
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}

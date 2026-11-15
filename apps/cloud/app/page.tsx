import Link from "next/link";
import { orgEntitlement, safeReturnTo } from "@ard/cloud";
import Flash, { param } from "../components/Flash";
import { currentPrincipal } from "../lib/auth";
import { getCloud } from "../lib/cloud";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const cloud = getCloud();
  const principal = await currentPrincipal();
  const next = safeReturnTo(param(params.next));

  if (!principal) {
    return (
      <>
        <h1>Sign in</h1>
        <Flash params={params} />
        <p className="muted">A shared place for your team to review what AI coding agents did, approve it, and keep the record.</p>
        <div className="cols">
          {cloud.config.login ? (
            <section className="card">
              <h2>With {cloud.config.login.label}</h2>
              <form method="post" action="/api/auth/login" className="stack">
                <input type="hidden" name="next" value={next} />
                <button type="submit" className="btn primary">
                  Continue
                </button>
              </form>
            </section>
          ) : null}
          <section className="card">
            <h2>With your company (single sign-on)</h2>
            <form method="post" action="/api/auth/sso" className="stack">
              <label>
                Your organization&apos;s address
                <input type="text" name="org" placeholder="acme" required pattern="[a-z0-9-]+" autoComplete="off" />
              </label>
              <button type="submit" className="btn plain">
                Continue
              </button>
            </form>
          </section>
          {cloud.config.devLogin ? (
            <section className="card">
              <h2>Development login</h2>
              <p className="flash warn">Local development only. Anyone who can reach this server can sign in as anyone.</p>
              <form method="post" action="/api/auth/dev" className="stack">
                <input type="hidden" name="next" value={next} />
                <label>
                  E-mail
                  <input type="email" name="email" placeholder="you@example.com" required />
                </label>
                <button type="submit" className="btn plain">
                  Sign in
                </button>
              </form>
            </section>
          ) : null}
        </div>
      </>
    );
  }

  const orgs = cloud.control.listOrgsForUser(principal.user.id);
  const now = cloud.control.time();
  const canCreate = principal.user.homeOrgId === null;

  return (
    <>
      <h1>Your organizations</h1>
      <Flash params={params} />
      {orgs.length === 0 ? (
        <div className="empty">
          <p>You do not belong to an organization yet.</p>
          <p className="muted">{canCreate ? "Create one below, or open an invitation link someone sent you." : "Ask an owner of your company's organization to add you."}</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Organization</th>
              <th>Your role</th>
              <th>Plan</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map(({ org, role }) => {
              const plan = orgEntitlement(org, now);
              return (
                <tr key={org.id}>
                  <td>
                    <Link href={`/o/${org.slug}`}>{org.name}</Link>
                    <div className="muted small">{org.slug}</div>
                  </td>
                  <td>{role}</td>
                  <td>{plan.active ? <span className="badge ok">Team</span> : <span className="badge neutral">Free</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {canCreate ? (
        <section className="card">
          <h2>Create an organization</h2>
          <form method="post" action="/api/org/create" className="stack">
            <label>
              Name
              <input type="text" name="name" placeholder="Acme Inc" required maxLength={80} />
            </label>
            <label>
              Address (letters, digits, dashes)
              <input type="text" name="slug" placeholder="acme" required pattern="[a-z0-9]([a-z0-9-]{0,36}[a-z0-9])?" />
            </label>
            <button type="submit" className="btn primary">
              Create
            </button>
          </form>
        </section>
      ) : null}

      <section className="card">
        <h2>Connect the command line</h2>
        <p>In a project that already uses <code>ard</code>:</p>
        <code className="copy">ARD_CLOUD_URL={cloud.config.baseUrl} ard login</code>
        <p className="hint">It prints a short code and opens this site so you can confirm it. Then <code>ard sync</code> uploads your recorded sessions to an organization with an active Team plan.</p>
      </section>
    </>
  );
}

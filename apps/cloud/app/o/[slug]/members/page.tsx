import { can, canChangeRole, canRemoveMember, INVITABLE_ROLES, ROLES } from "@ard/cloud";
import { dateTime } from "@ard/ui/present";
import Flash, { param } from "../../../../components/Flash";
import OrgNav from "../../../../components/OrgNav";
import { orgContext } from "../../../../lib/auth";
import { getCloud } from "../../../../lib/cloud";

export const dynamic = "force-dynamic";

export default async function Members({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const query = await searchParams;
  const ctx = await orgContext(slug, "view", `/o/${slug}/members`);
  if (!ctx.ok) return <p className="flash error">{ctx.message}</p>;
  const cloud = getCloud();
  const { org, role } = ctx.access;
  const me = ctx.principal.user;
  const manage = can(role, "members.manage");
  const members = cloud.control.listMembers(org.id);
  const pending = manage ? cloud.control.listPendingInvitations(org.id) : [];
  const audit = can(role, "audit.view") ? cloud.control.listAudit(org.id, 50) : [];
  const inviteToken = param(query.invite);

  return (
    <>
      <h1>{org.name}</h1>
      <OrgNav slug={slug} role={role} current="members" />
      <Flash params={query} />
      {inviteToken && manage ? (
        <section className="card">
          <h2>Invitation link</h2>
          <p>Send this to the person. It works once, for 7 days, and only for the e-mail you entered.</p>
          <code className="copy">{`${cloud.config.baseUrl}/invite/${inviteToken}`}</code>
        </section>
      ) : null}

      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th>Joined</th>
            {manage ? <th></th> : null}
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId}>
              <td>
                {m.email}
                {m.userId === me.id ? <span className="muted"> (you)</span> : null}
                {m.homeOrgId ? <div className="muted small">signed in through company SSO</div> : null}
              </td>
              <td>
                {manage && canChangeRole(role, m.role, m.role) ? (
                  <form method="post" action={`/api/o/${slug}/members/role`} className="inline-form">
                    <input type="hidden" name="user" value={m.userId} />
                    <select name="role" defaultValue={m.role} aria-label={`Role of ${m.email}`}>
                      {ROLES.filter((r) => canChangeRole(role, m.role, r)).map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="btn plain">
                      Save
                    </button>
                  </form>
                ) : (
                  m.role
                )}
              </td>
              <td>{dateTime(m.since)}</td>
              {manage ? (
                <td>
                  {m.userId !== me.id && canRemoveMember(role, m.role) ? (
                    <form method="post" action={`/api/o/${slug}/members/remove`}>
                      <input type="hidden" name="user" value={m.userId} />
                      <button type="submit" className="btn danger">
                        Remove
                      </button>
                    </form>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      <section className="card">
        <h2>Roles</h2>
        <ul className="hint">
          <li><strong>owner</strong>: everything, including billing and single sign-on.</li>
          <li><strong>admin</strong>: members, reviews and the audit log.</li>
          <li><strong>reviewer</strong>: sync and review sessions.</li>
          <li><strong>member</strong>: sync and read sessions.</li>
        </ul>
        <form method="post" action={`/api/o/${slug}/members/leave`}>
          <button type="submit" className="btn danger">
            Leave this organization
          </button>
        </form>
      </section>

      {manage ? (
        <section className="card">
          <h2>Invite someone</h2>
          <form method="post" action={`/api/o/${slug}/members/invite`} className="stack">
            <label>
              E-mail
              <input type="email" name="email" required placeholder="teammate@example.com" />
            </label>
            <label>
              Role
              <select name="role" defaultValue="member">
                {INVITABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn primary">
              Create invitation
            </button>
          </form>
          {pending.length > 0 ? (
            <>
              <h3>Waiting to be accepted</h3>
              <ul>
                {pending.map((p) => (
                  <li key={p.id}>
                    {p.email} as {p.role} <span className="muted">(expires {dateTime(p.expiresAt)})</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {audit.length > 0 ? (
        <section>
          <h2>Audit log</h2>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td>{dateTime(a.at)}</td>
                  <td>{a.actorEmail ?? "system"}</td>
                  <td>
                    {a.action}
                    {a.detail ? <span className="muted"> · {a.detail}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}

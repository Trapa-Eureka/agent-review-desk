import Link from "next/link";
import { can, orgEntitlement } from "@ard/cloud";
import { formatDuration } from "@ard/core";
import AutoRefresh from "@ard/ui/AutoRefresh";
import { dateTime, shortId, tidyPath } from "@ard/ui/present";
import Flash from "../../../components/Flash";
import OrgNav from "../../../components/OrgNav";
import { orgContext } from "../../../lib/auth";
import { getCloud } from "../../../lib/cloud";

export const dynamic = "force-dynamic";

export default async function OrgSessions({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const query = await searchParams;
  const ctx = await orgContext(slug, "view", `/o/${slug}`);
  if (!ctx.ok) return <p className="flash error">{ctx.message}</p>;
  const cloud = getCloud();
  const { org, role } = ctx.access;
  const plan = orgEntitlement(org, cloud.control.time());
  const sessions = cloud.workspaces.with(org.id, (repo) => repo.listSessions(200));
  const uploaders = cloud.control.sessionUploaders(org.id);

  return (
    <>
      <AutoRefresh intervalMs={5000} />
      <h1>{org.name}</h1>
      <OrgNav slug={slug} role={role} current="sessions" />
      <Flash params={query} />
      {!plan.active ? (
        <p className="flash warn">
          This organization is on the free plan, so new sessions cannot be synced and reviews are paused. What is already here stays readable.{" "}
          {can(role, "billing.manage") ? <Link href={`/o/${slug}/billing`}>Subscribe →</Link> : "Ask an owner to subscribe."}
        </p>
      ) : plan.until ? (
        <p className="flash warn">The subscription ends on {dateTime(plan.until)}.</p>
      ) : null}

      {sessions.length === 0 ? (
        <div className="empty">
          <p>No sessions synced yet.</p>
          <p className="muted">
            In a project, run <code>ard sync --org {slug}</code>.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Who</th>
              <th>Agent</th>
              <th className="num">Commands</th>
              <th className="num">Files</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link href={`/o/${slug}/sessions/${encodeURIComponent(s.id)}`}>{dateTime(s.startedAt)}</Link>
                  <div className="muted small">
                    {shortId(s.id)} · {formatDuration(Date.parse(s.lastEventAt) - Date.parse(s.startedAt)) || "—"}
                  </div>
                </td>
                <td>{uploaders.get(s.id) ?? "—"}</td>
                <td>
                  {s.agent}
                  <div className="muted small path">{tidyPath(s.cwd)}</div>
                </td>
                <td className="num">{s.counts.commands}</td>
                <td className="num">{s.counts.fileChanges}</td>
                <td>
                  <div className="status">
                    {s.blocked > 0 ? <span className="badge bad">{s.blocked} blocked</span> : null}
                    {s.review ? <span className={`badge ${s.review.decision === "approved" ? "ok" : "bad"}`}>{s.review.decision}</span> : <span className="badge neutral">not reviewed</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

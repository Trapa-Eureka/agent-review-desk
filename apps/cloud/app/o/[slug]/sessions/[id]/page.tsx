import Link from "next/link";
import { notFound } from "next/navigation";
import { can, orgEntitlement } from "@ard/cloud";
import { formatDuration } from "@ard/core";
import DecisionForm from "@ard/ui/DecisionForm";
import Timeline from "@ard/ui/Timeline";
import { dateTime, tidyPath } from "@ard/ui/present";
import OrgNav from "../../../../../components/OrgNav";
import { orgContext } from "../../../../../lib/auth";
import { getCloud } from "../../../../../lib/cloud";

export const dynamic = "force-dynamic";

export default async function CloudSession({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await orgContext(slug, "view", `/o/${slug}/sessions/${id}`);
  if (!ctx.ok) return <p className="flash error">{ctx.message}</p>;
  const cloud = getCloud();
  const { org, role } = ctx.access;
  const data = cloud.workspaces.with(org.id, (repo) => {
    const session = repo.getSession(id);
    return session ? { session, events: repo.sessionEvents(id) } : null;
  });
  if (!data) notFound();
  const { session, events } = data;
  const uploader = cloud.control.sessionUploaders(org.id).get(id);
  const entitled = orgEntitlement(org, cloud.control.time()).active;
  const mayReview = can(role, "review");

  return (
    <>
      <h1>{org.name}</h1>
      <OrgNav slug={slug} role={role} current="sessions" />
      <p>
        <Link href={`/o/${slug}`}>← All sessions</Link>
      </p>
      <h2>
        {session.agent} <span className="muted">session</span>
      </h2>
      <dl className="facts">
        <div>
          <dt>Uploaded by</dt>
          <dd>{uploader ?? "—"}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{dateTime(session.startedAt)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(Date.parse(session.lastEventAt) - Date.parse(session.startedAt)) || "—"}</dd>
        </div>
        <div>
          <dt>Folder (on their machine)</dt>
          <dd className="path">{tidyPath(session.cwd)}</dd>
        </div>
        <div>
          <dt>Activity</dt>
          <dd>
            {session.counts.toolCalls} tool calls · {session.counts.commands} commands · {session.counts.fileChanges} file changes
          </dd>
        </div>
      </dl>

      <section className="card review" aria-label="Review this session">
        <h2>Team review</h2>
        {session.review ? (
          <p>
            <span className={`badge ${session.review.decision === "approved" ? "ok" : "bad"}`}>{session.review.decision}</span> by {session.review.by ?? "unknown"} on {dateTime(session.review.at)}
            {session.review.note ? <span className="note"> — “{session.review.note}”</span> : null}
          </p>
        ) : (
          <p className="muted">Not reviewed yet.</p>
        )}
        {mayReview && entitled ? (
          <DecisionForm endpoint={`/api/o/${slug}/sessions/${encodeURIComponent(id)}/review`} approveLabel="Approve session" rejectLabel="Reject session" />
        ) : mayReview ? (
          <p className="flash warn">Reviews are paused while this organization is on the free plan.</p>
        ) : (
          <p className="hint">Your role ({role}) can read sessions but not review them.</p>
        )}
        <p className="hint">Decisions are recorded with your e-mail. The newest one is shown; all of them stay in the history.</p>
      </section>

      <h2>Timeline</h2>
      <Timeline events={events} />
    </>
  );
}

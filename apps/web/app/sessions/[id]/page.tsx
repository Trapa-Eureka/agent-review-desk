import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDuration } from "@ard/core";
import ApprovalCard from "../../../components/ApprovalCard";
import AutoRefresh from "@ard/ui/AutoRefresh";
import DecisionForm from "@ard/ui/DecisionForm";
import Timeline from "@ard/ui/Timeline";
import { dateTime, tidyPath } from "@ard/ui/present";
import { withProject } from "../../../lib/server";

export const dynamic = "force-dynamic";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = withProject(({ repo }) => {
    const session = repo.getSession(id);
    if (!session) return null;
    return {
      session,
      events: repo.sessionEvents(id),
      pending: repo.requestsForSession(id).filter((r) => r.status === "pending" && Date.parse(r.expiresAt) > Date.now()),
    };
  });
  if (!data) notFound();
  const { session, events, pending } = data;

  return (
    <>
      <AutoRefresh />
      <p>
        <Link href="/">← All sessions</Link>
      </p>
      <h1>
        {session.agent} <span className="muted">session</span>
      </h1>
      <dl className="facts">
        <div>
          <dt>Started</dt>
          <dd>{dateTime(session.startedAt)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(Date.parse(session.lastEventAt) - Date.parse(session.startedAt)) || "—"}</dd>
        </div>
        <div>
          <dt>Folder</dt>
          <dd className="path">{tidyPath(session.cwd)}</dd>
        </div>
        <div>
          <dt>Activity</dt>
          <dd>
            {session.counts.toolCalls} tool calls · {session.counts.commands} commands · {session.counts.fileChanges} file changes
          </dd>
        </div>
      </dl>

      {pending.map((request) => (
        <ApprovalCard key={request.id} request={request} showSessionLink={false} />
      ))}

      <section className="card review" aria-label="Review this session">
        <h2>Your review</h2>
        {session.review ? (
          <p>
            <span className={`badge ${session.review.decision === "approved" ? "ok" : "bad"}`}>{session.review.decision}</span> by {session.review.by ?? "unknown"} on {dateTime(session.review.at)}
            {session.review.note ? <span className="note"> — “{session.review.note}”</span> : null}
          </p>
        ) : (
          <p className="muted">Not reviewed yet.</p>
        )}
        <DecisionForm endpoint={`/api/sessions/${encodeURIComponent(session.id)}/review`} approveLabel="Approve session" rejectLabel="Reject session" />
        <p className="muted small">You can change your decision later; the newest one is shown, and all of them stay in the log.</p>
      </section>

      <h2>Timeline</h2>
      <Timeline events={events} />
    </>
  );
}

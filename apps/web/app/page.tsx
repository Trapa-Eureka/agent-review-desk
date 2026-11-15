import Link from "next/link";
import type { SessionSummary } from "@ard/core";
import { formatDuration } from "@ard/core";
import ApprovalCard from "../components/ApprovalCard";
import AutoRefresh from "@ard/ui/AutoRefresh";
import { dateTime, shortId, tidyPath } from "@ard/ui/present";
import { withProject } from "../lib/server";

export const dynamic = "force-dynamic";

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

function Status({ session, now }: { session: SessionSummary; now: number }) {
  const idle = now - Date.parse(session.lastEventAt);
  return (
    <>
      {session.pendingApprovals > 0 ? <span className="badge warn">{session.pendingApprovals} waiting</span> : null}
      {session.blocked > 0 ? <span className="badge bad">{session.blocked} blocked</span> : null}
      {session.review ? <span className={`badge ${session.review.decision === "approved" ? "ok" : "bad"}`}>{session.review.decision}</span> : <span className="badge neutral">not reviewed</span>}
      {!session.ended && idle < ACTIVE_WINDOW_MS ? <span className="badge live">active</span> : null}
    </>
  );
}

export default function Home() {
  const { sessions, pending } = withProject(({ repo }) => ({
    sessions: repo.listSessions(100),
    pending: repo.listApprovalRequests({ status: "pending" }),
  }));
  const now = Date.now();

  return (
    <>
      <AutoRefresh />
      {pending.length > 0 ? (
        <section aria-label="Waiting for your decision">
          <h1>Waiting for your decision ({pending.length})</h1>
          {pending.map((request) => (
            <ApprovalCard key={request.id} request={request} />
          ))}
        </section>
      ) : null}

      <section aria-label="Sessions">
        <h1>Sessions</h1>
        {sessions.length === 0 ? (
          <div className="empty">
            <p>No sessions recorded yet.</p>
            <p className="muted">
              In a project, run <code>ard init</code> (Claude Code) or <code>ard run -- &lt;agent&gt;</code>, then use the agent as usual. Sessions appear here by themselves.
            </p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Agent</th>
                <th>Folder</th>
                <th className="num">Commands</th>
                <th className="num">Files</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>
                    <Link href={`/sessions/${encodeURIComponent(session.id)}`}>{dateTime(session.startedAt)}</Link>
                    <div className="muted small">
                      {shortId(session.id)} · {formatDuration(Date.parse(session.lastEventAt) - Date.parse(session.startedAt)) || "—"}
                    </div>
                  </td>
                  <td>{session.agent}</td>
                  <td className="path">{tidyPath(session.cwd)}</td>
                  <td className="num">{session.counts.commands}</td>
                  <td className="num">{session.counts.fileChanges}</td>
                  <td>
                    <div className="status">
                      <Status session={session} now={now} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

import Link from "next/link";
import type { SessionSummary } from "@ard/core";
import { filterByAgent, formatDuration, linkedSessions, summarizeByAgent } from "@ard/core";
import AgentOverview from "../components/AgentOverview";
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

const TABLE_LIMIT = 100;

function LinkHint({ session, all }: { session: SessionSummary; all: SessionSummary[] }) {
  const { wrapper, hooks } = linkedSessions(all, session);
  if (wrapper) {
    return (
      <div className="muted small">
        inside an <Link href={`/sessions/${encodeURIComponent(wrapper.id)}`}>ard run</Link> session
      </div>
    );
  }
  if (hooks.length > 0) {
    return (
      <div className="muted small">
        also recorded by {hooks.length === 1 ? <Link href={`/sessions/${encodeURIComponent(hooks[0]!.id)}`}>its hooks</Link> : `${hooks.length} hook sessions`}
      </div>
    );
  }
  return null;
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { agent: agentParam } = await searchParams;
  const { all, pending } = withProject(({ repo }) => ({
    all: repo.listSessions(500),
    pending: repo.listApprovalRequests({ status: "pending" }),
  }));
  const now = Date.now();
  const overview = summarizeByAgent(all);
  const requested = typeof agentParam === "string" && agentParam !== "" ? agentParam : null;
  // Only an agent that really has sessions is accepted as a filter; anything else is shown as "no such agent", never trusted.
  const selected = requested !== null && overview.some((row) => row.agent === requested) ? requested : null;
  const filtered = filterByAgent(all, selected);
  const sessions = filtered.slice(0, TABLE_LIMIT);

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

      <AgentOverview rows={overview} selected={selected} total={all.length} />

      <section aria-label="Sessions">
        <h1>
          Sessions{selected ? <span className="muted"> · {selected}</span> : null}
        </h1>
        {requested !== null && selected === null ? (
          <p className="muted">
            No sessions from an agent called “{requested}”. <Link href="/">Show all agents</Link>
          </p>
        ) : null}
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
                  <td>
                    {session.agent}
                    <LinkHint session={session} all={all} />
                  </td>
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
        {filtered.length > TABLE_LIMIT ? <p className="muted small">Showing the newest {TABLE_LIMIT} of {filtered.length} sessions.</p> : null}
      </section>
    </>
  );
}

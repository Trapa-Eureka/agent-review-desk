import Link from "next/link";
import type { AgentSummary } from "@ard/core";
import { dateTime } from "@ard/ui/present";

/** One row per agent, with what needs attention. The agent name filters the session list below. */
export default function AgentOverview({ rows, selected, total }: { rows: AgentSummary[]; selected: string | null; total: number }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Agents" className="agents">
      <h2>Agents</h2>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th className="num">Sessions</th>
            <th className="num">Not reviewed</th>
            <th className="num">Approved</th>
            <th className="num">Rejected</th>
            <th className="num">Blocked calls</th>
            <th className="num">Commands</th>
            <th className="num">File changes</th>
            <th>Last active</th>
          </tr>
        </thead>
        <tbody>
          <tr className={selected === null ? "current" : undefined}>
            <td>
              <Link href="/">All agents</Link>
            </td>
            <td className="num">{total}</td>
            <td className="num">{rows.reduce((n, r) => n + r.notReviewed, 0)}</td>
            <td className="num">{rows.reduce((n, r) => n + r.approved, 0)}</td>
            <td className="num">{rows.reduce((n, r) => n + r.rejected, 0)}</td>
            <td className="num">{rows.reduce((n, r) => n + r.blocked, 0)}</td>
            <td className="num">{rows.reduce((n, r) => n + r.commands, 0)}</td>
            <td className="num">{rows.reduce((n, r) => n + r.fileChanges, 0)}</td>
            <td />
          </tr>
          {rows.map((row) => (
            <tr key={row.agent} className={selected === row.agent ? "current" : undefined}>
              <td>
                <Link href={`/?agent=${encodeURIComponent(row.agent)}`}>{row.agent}</Link>
                {row.waiting > 0 ? <span className="badge warn">{row.waiting} waiting</span> : null}
              </td>
              <td className="num">{row.sessions}</td>
              <td className="num">{row.notReviewed > 0 ? <span className="badge neutral">{row.notReviewed}</span> : 0}</td>
              <td className="num">{row.approved}</td>
              <td className="num">{row.rejected > 0 ? <span className="badge bad">{row.rejected}</span> : 0}</td>
              <td className="num">{row.blocked > 0 ? <span className="badge bad">{row.blocked}</span> : 0}</td>
              <td className="num">{row.commands}</td>
              <td className="num">{row.fileChanges}</td>
              <td className="muted small">{dateTime(row.lastEventAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

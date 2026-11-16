import Link from "next/link";
import { hasLinks, type LinkedSessions as Links, type SessionSummary } from "@ard/core";
import { dateTime, shortId } from "@ard/ui/present";

function Row({ session, what }: { session: SessionSummary; what: string }) {
  return (
    <li>
      <Link href={`/sessions/${encodeURIComponent(session.id)}`}>
        {session.agent} · {dateTime(session.startedAt)}
      </Link>{" "}
      <span className="muted small">
        {shortId(session.id)} · {what} · {session.counts.commands} commands, {session.counts.fileChanges} file changes
        {session.review ? ` · ${session.review.decision}` : " · not reviewed"}
      </span>
    </li>
  );
}

/** The other half of one run: `ard run` sees which files changed, the agent's hooks see commands and tool calls. */
export default function LinkedSessions({ links }: { links: Links }) {
  if (!hasLinks(links)) return null;
  return (
    <section className="card linked" aria-label="Linked sessions">
      <h2>Same run, other recorder</h2>
      <p className="muted small">
        One run can be recorded twice: by <code>ard run</code> (from outside: changed files) and by the agent&apos;s hooks (from inside: commands and tool calls). Review each; they are listed separately.
      </p>
      <ul>
        {links.wrapper ? <Row session={links.wrapper} what="recorded from outside by ard run" /> : null}
        {links.hooks.map((s) => (
          <Row key={s.id} session={s} what="recorded from inside by the agent's hooks" />
        ))}
      </ul>
    </section>
  );
}

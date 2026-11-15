import type { ApprovalRequest } from "@ard/core";
import Link from "next/link";
import { clock } from "../lib/present";
import DecisionForm from "./DecisionForm";

/** One action an agent is blocked on, with what it wants to do, why it was flagged, and the decision buttons. */
export default function ApprovalCard({ request, showSessionLink = true }: { request: ApprovalRequest; showSessionLink?: boolean }) {
  return (
    <section className="card pending" aria-label={`Approval request: ${request.summary}`}>
      <div className="card-head">
        <span className="badge warn">Waiting for you</span>
        <span className="muted">
          asked {clock(request.createdAt)} · expires {clock(request.expiresAt)}
        </span>
        {showSessionLink ? (
          <Link className="muted" href={`/sessions/${encodeURIComponent(request.sessionId)}`}>
            open session →
          </Link>
        ) : null}
      </div>
      <p className="summary">
        <code>{request.summary}</code>
      </p>
      <ul className="rules">
        {request.rules.map((rule) => (
          <li key={rule.id}>
            <strong>{rule.id}</strong> — {rule.description}
          </li>
        ))}
      </ul>
      <details>
        <summary>Full tool input</summary>
        <pre>{JSON.stringify(request.input, null, 2)}</pre>
      </details>
      <p className="muted small">The agent is paused until you decide. Rejecting tells it the action was not allowed.</p>
      <DecisionForm endpoint={`/api/approvals/${encodeURIComponent(request.id)}`} approveLabel="Allow" rejectLabel="Block" />
    </section>
  );
}

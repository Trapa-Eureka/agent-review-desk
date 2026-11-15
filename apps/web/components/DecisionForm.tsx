"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  /** POST target, e.g. /api/approvals/<id> or /api/sessions/<id>/review. */
  endpoint: string;
  approveLabel: string;
  rejectLabel: string;
}

/** Approve / reject buttons with an optional note. Used for pending requests and for whole-session reviews. */
export default function DecisionForm({ endpoint, approveLabel, rejectLabel }: Props) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(decision: "approved" | "rejected") {
    setBusy(decision);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, note }),
      });
      if (response.ok) setNote("");
      else {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Request failed (${response.status}).`);
      }
    } catch {
      setError("Could not reach the review server.");
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  return (
    <div className="decision">
      <input
        type="text"
        value={note}
        maxLength={500}
        placeholder="Optional note"
        aria-label="Optional note"
        onChange={(event) => setNote(event.target.value)}
      />
      <button type="button" className="btn approve" disabled={busy !== null} onClick={() => send("approved")}>
        {busy === "approved" ? "Saving…" : approveLabel}
      </button>
      <button type="button" className="btn reject" disabled={busy !== null} onClick={() => send("rejected")}>
        {busy === "rejected" ? "Saving…" : rejectLabel}
      </button>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

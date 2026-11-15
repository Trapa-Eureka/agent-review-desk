"use client";

import { useState } from "react";

interface Preview {
  available: boolean;
  keySource: "environment" | "keychain" | null;
  model: string;
  warning?: string;
  destination: string;
  stats: { events: number; included: number; omitted: number; screenshots: number; chars: number };
  digest: string;
  sha256: string;
}

interface Result {
  summary: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  truncated: boolean;
}

type State = { step: "idle" } | { step: "loading" } | { step: "preview"; preview: Preview } | { step: "sending"; preview: Preview } | { step: "done"; result: Result } | { step: "error"; message: string };

/**
 * "Summarize with AI" for one session. Two steps on purpose: first the person sees exactly what would be sent and where,
 * and only a second, explicit click sends it. The summary is shown as plain text (never rendered as markup).
 */
export default function SummaryPanel({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<State>({ step: "idle" });
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/summary`;

  async function openPreview() {
    setState({ step: "loading" });
    try {
      const response = await fetch(endpoint);
      const data = (await response.json()) as Preview & { error?: string };
      if (!response.ok) return setState({ step: "error", message: data.error ?? `Request failed (${response.status}).` });
      setState({ step: "preview", preview: data });
    } catch {
      setState({ step: "error", message: "Could not reach the review server." });
    }
  }

  async function send(preview: Preview) {
    setState({ step: "sending", preview });
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true, sha256: preview.sha256 }) });
      const data = (await response.json()) as Result & { error?: string };
      if (!response.ok) return setState({ step: "error", message: data.error ?? `Request failed (${response.status}).` });
      setState({ step: "done", result: data });
    } catch {
      setState({ step: "error", message: "Could not reach the review server." });
    }
  }

  return (
    <section className="card summary" aria-label="AI summary">
      <h2>AI summary</h2>

      {state.step === "idle" ? (
        <>
          <p className="muted small">Optional. Uses your own Anthropic API key. You will see exactly what would be sent before anything leaves this computer.</p>
          <button type="button" className="btn" onClick={openPreview}>
            Summarize with AI…
          </button>
        </>
      ) : null}

      {state.step === "loading" ? <p className="muted">Preparing the preview…</p> : null}

      {state.step === "preview" || state.step === "sending" ? (
        <PreviewView preview={state.preview} sending={state.step === "sending"} onSend={() => send(state.preview)} onCancel={() => setState({ step: "idle" })} />
      ) : null}

      {state.step === "done" ? (
        <>
          <div className="summary-text">{state.result.summary}</div>
          {state.result.truncated ? <p className="muted small">The model reached its length limit, so this summary may be cut short.</p> : null}
          <p className="muted small">
            Written by {state.result.model} ({state.result.usage.inputTokens} tokens in, {state.result.usage.outputTokens} out, billed to your key). An AI summary can be wrong or miss things: the timeline below is the record.
          </p>
          <button type="button" className="btn" onClick={() => setState({ step: "idle" })}>
            Close
          </button>
        </>
      ) : null}

      {state.step === "error" ? (
        <>
          <p className="error" role="alert">
            {state.message}
          </p>
          <button type="button" className="btn" onClick={() => setState({ step: "idle" })}>
            Close
          </button>
        </>
      ) : null}
    </section>
  );
}

function PreviewView({ preview, sending, onSend, onCancel }: { preview: Preview; sending: boolean; onSend: () => void; onCancel: () => void }) {
  if (!preview.available) {
    return (
      <>
        <p>
          No Anthropic API key was found. Run <code>ard key set</code> once to save it in your system keychain, or set <code>ANTHROPIC_API_KEY</code> in the terminal where you run <code>ard review</code> and start it again. The key is never shown here and never leaves your computer except to Anthropic.
        </p>
        <button type="button" className="btn" onClick={onCancel}>
          Close
        </button>
      </>
    );
  }
  const { stats } = preview;
  return (
    <>
      <p>
        This will send the text below to Anthropic (<code>{preview.destination}</code>) using your API key ({preview.keySource === "keychain" ? "saved in your keychain with ard key set" : "from the ANTHROPIC_API_KEY environment variable"}) and the model <code>{preview.model}</code>. It is billed to your account. Nothing is sent until you press Send.
      </p>
      <ul className="small">
        <li>
          {stats.included} of {stats.events} events, {stats.chars.toLocaleString()} characters{stats.omitted > 0 ? `; ${stats.omitted} events are left out to keep it short` : ""}.
        </li>
        <li>Secrets are redacted again before this. Redaction is best effort: read the text if the session touched anything sensitive.</li>
        <li>{stats.screenshots > 0 ? `${stats.screenshots} screenshot(s) exist; the images are never sent.` : "Images are never sent."}</li>
      </ul>
      {preview.warning ? <p className="muted small">{preview.warning}</p> : null}
      <details>
        <summary>Show exactly what will be sent</summary>
        <pre>{preview.digest}</pre>
      </details>
      <div className="decision">
        <button type="button" className="btn approve" disabled={sending} onClick={onSend}>
          {sending ? "Sending…" : "Send to Anthropic"}
        </button>
        <button type="button" className="btn" disabled={sending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

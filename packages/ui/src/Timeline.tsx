import type { ArdEvent, FileChangeEvent } from "@ard/schema";
import { diffFromTexts, parseUnifiedDiff, type DiffLine } from "@ard/core";
import { clock } from "./present";
import DiffView, { DiffStats } from "./DiffView";

const MAX_OPEN_DIFF_LINES = 60;

/** Where the page serves a stored screenshot from. Pages that do not have the image files (the team workspace) leave it out. */
export type ScreenshotHref = (imageId: string) => string;

function fileDiff(event: FileChangeEvent): DiffLine[] {
  if (event.patch) return parseUnifiedDiff(event.patch).filter((l) => l.kind !== "meta");
  if (event.operation === "delete") return [];
  return diffFromTexts(event.oldText, event.newText);
}

function toolPreview(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const o = input as Record<string, unknown>;
  const pick = o.command ?? o.file_path ?? o.notebook_path ?? o.pattern ?? o.url ?? o.path;
  return typeof pick === "string" ? pick : "";
}

function Row({ event, kind, children }: { event: ArdEvent; kind: string; children: React.ReactNode }) {
  return (
    <li className={`row ${kind}`} id={`e-${event.id}`}>
      <time className="when" dateTime={event.ts}>
        {clock(event.ts)}
      </time>
      <div className="what">{children}</div>
    </li>
  );
}

function Event({ event, screenshotHref }: { event: ArdEvent; screenshotHref?: ScreenshotHref }) {
  switch (event.type) {
    case "session_start":
      return (
        <Row event={event} kind="boundary">
          <strong>Session started</strong> <span className="muted">via {event.capture}</span>
          {event.argv ? (
            <div>
              <code>{event.argv.join(" ")}</code>
            </div>
          ) : null}
          {event.model ? <span className="muted"> · model {event.model}</span> : null}
        </Row>
      );

    case "session_end":
      return (
        <Row event={event} kind="boundary">
          <strong>Session ended</strong>
          {event.exitCode !== undefined && event.exitCode !== null ? <span className="muted"> · exit code {event.exitCode}</span> : null}
          {event.signal ? <span className="muted"> · signal {event.signal}</span> : null}
          {event.reason ? <span className="muted"> · {event.reason}</span> : null}
        </Row>
      );

    case "tool_use": {
      if (event.phase === "post" && event.ok !== false) return null; // successful completions add no information
      if (event.phase === "post") {
        return (
          <Row event={event} kind="tool failed">
            <span className="badge bad">failed</span> <strong>{event.toolName}</strong> {event.error ? <code className="inline">{event.error.split("\n")[0]}</code> : null}
          </Row>
        );
      }
      const preview = toolPreview(event.input);
      return (
        <Row event={event} kind="tool">
          <span className="muted">tool</span> <strong>{event.toolName}</strong> {preview ? <code className="inline">{preview}</code> : null}
          {event.input !== undefined ? (
            <details>
              <summary>input</summary>
              <pre>{JSON.stringify(event.input, null, 2)}</pre>
            </details>
          ) : null}
        </Row>
      );
    }

    case "command":
      return (
        <Row event={event} kind="command">
          <code className="cmd">$ {event.command}</code>{" "}
          {event.exitCode !== undefined && event.exitCode !== null ? <span className={`badge ${event.exitCode === 0 ? "ok" : "bad"}`}>exit {event.exitCode}</span> : null}
          {event.interrupted ? <span className="badge warn">interrupted</span> : null}
          {event.stdout ? (
            <details>
              <summary>output</summary>
              <pre>{event.stdout}</pre>
            </details>
          ) : null}
          {event.stderr ? (
            <details>
              <summary>errors</summary>
              <pre>{event.stderr}</pre>
            </details>
          ) : null}
          {event.truncated ? <span className="muted small">output was cut to keep the log small</span> : null}
        </Row>
      );

    case "file_change": {
      const lines = fileDiff(event);
      return (
        <Row event={event} kind="file">
          <span className={`badge op-${event.operation}`}>{event.operation}</span> <code className="path">{event.path}</code> <DiffStats lines={lines} />
          {event.tool ? <span className="muted small"> via {event.tool}</span> : null}
          <details open={lines.length <= MAX_OPEN_DIFF_LINES}>
            <summary>{lines.length} lines</summary>
            <DiffView lines={lines} />
          </details>
          {event.truncated ? <span className="muted small">content was cut to keep the log small</span> : null}
        </Row>
      );
    }

    case "screenshot": {
      const href = screenshotHref ? screenshotHref(event.imageId) : null;
      return (
        <Row event={event} kind="screenshot">
          <strong>Screenshot</strong>
          {event.toolName ? <span className="muted"> · from {event.toolName}</span> : <span className="muted"> · attached by hand</span>}
          {event.caption ? <div className="note">“{event.caption}”</div> : null}
          {href ? (
            <a className="shot" href={href} target="_blank" rel="noopener noreferrer">
              {/* A recorded picture: a plain <img>, same origin, never a data URL, and sized by the browser. */}
              <img src={href} alt={event.caption ?? "Screenshot recorded during the session"} loading="lazy" />
            </a>
          ) : (
            <div className="muted small">This picture is stored on the machine that recorded it and is not available here.</div>
          )}
        </Row>
      );
    }

    case "approval": {
      const approved = event.decision === "approved";
      const scope = event.targetSessionId ? "Session review" : "Action";
      return (
        <Row event={event} kind={`approval ${event.decision}`}>
          <span className={`badge ${approved ? "ok" : "bad"}`}>{approved ? "approved" : "rejected"}</span> <strong>{scope}</strong> <span className="muted">by {event.decidedBy ?? "unknown"}</span>
          {event.note ? <div className="note">“{event.note}”</div> : null}
          {event.ruleIds && event.ruleIds.length > 0 ? <div className="muted small">rules: {event.ruleIds.join(", ")}</div> : null}
        </Row>
      );
    }
  }
}

/** The ordered story of a session: what the agent did, and what humans or policy decided about it. */
export default function Timeline({ events, screenshotHref }: { events: ArdEvent[]; screenshotHref?: ScreenshotHref }) {
  return (
    <ol className="timeline">
      {events.map((event) => (
        <Event key={event.id} event={event} {...(screenshotHref ? { screenshotHref } : {})} />
      ))}
    </ol>
  );
}

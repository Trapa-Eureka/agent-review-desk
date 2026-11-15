import { diffStats, type DiffLine } from "@ard/core";

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", ctx: " ", hunk: "", meta: "" };

/** A unified diff. Text is rendered as plain text nodes (never HTML), so recorded content cannot inject markup. */
export default function DiffView({ lines }: { lines: DiffLine[] }) {
  if (lines.length === 0) return <p className="muted small">No textual changes recorded.</p>;
  return (
    <div className="diff" role="table" aria-label="Diff">
      {lines.map((line, index) => (
        <div key={index} className={`diff-line ${line.kind}`} role="row">
          <span className="sign" aria-hidden="true">
            {SIGN[line.kind]}
          </span>
          <code>{line.text}</code>
        </div>
      ))}
    </div>
  );
}

export function DiffStats({ lines }: { lines: DiffLine[] }) {
  const { added, removed } = diffStats(lines);
  return (
    <span className="stats">
      <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
    </span>
  );
}

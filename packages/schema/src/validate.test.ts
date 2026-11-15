import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, parseJsonl, serializeEvent, validateEvent, type ArdEvent } from "./index.js";

const base = {
  v: SCHEMA_VERSION,
  id: "11111111-1111-4111-8111-111111111111",
  ts: "2026-11-15T10:00:00.000Z",
  sessionId: "s1",
  agent: "claude-code",
  cwd: "/proj",
} as const;

const samples: ArdEvent[] = [
  { ...base, type: "session_start", capture: "hook", startSource: "startup", model: "m" },
  { ...base, type: "session_start", capture: "wrapper", argv: ["claude"], gitHead: null },
  { ...base, type: "session_end", capture: "wrapper", exitCode: null, signal: "SIGTERM", durationMs: 12 },
  { ...base, type: "tool_use", phase: "pre", toolName: "Bash", toolUseId: "t1", input: { command: "ls" } },
  { ...base, type: "tool_use", phase: "post", toolName: "Bash", output: { stdout: "" } },
  { ...base, type: "command", command: "ls", exitCode: 0, stdout: "a", stderr: "", truncated: false },
  { ...base, type: "file_change", path: "src/a.ts", operation: "modify", oldText: "a", newText: "b" },
  { ...base, type: "file_change", path: "src/b.ts", operation: "create", patch: "+x" },
  { ...base, type: "approval", targetEventId: "e1", decision: "approved", decidedBy: "me" },
  { ...base, type: "approval", targetSessionId: "s1", decision: "rejected", note: "too risky", requestId: "r1", ruleIds: ["git-force-push"] },
  { ...base, type: "screenshot", imageId: "a".repeat(64), mediaType: "image/png", bytes: 1234, source: "hook", toolName: "mcp__x__computer", toolUseId: "t9", caption: "login page" },
  { ...base, type: "screenshot", imageId: "0123456789abcdef".repeat(4), mediaType: "image/webp", bytes: 1, source: "manual" },
];

test("every sample event type validates", () => {
  for (const sample of samples) {
    const result = validateEvent(sample);
    assert.equal(result.ok, true, `${sample.type}: ${result.ok ? "" : result.error}`);
  }
});

test("rejects non-objects and unknown versions/types", () => {
  assert.equal(validateEvent(null).ok, false);
  assert.equal(validateEvent([]).ok, false);
  assert.equal(validateEvent("x").ok, false);
  assert.equal(validateEvent({ ...samples[0], v: 2 }).ok, false);
  assert.equal(validateEvent({ ...samples[0], type: "nope" }).ok, false);
});

test("rejects missing or mistyped base fields", () => {
  const s = samples[0]!;
  assert.equal(validateEvent({ ...s, id: "" }).ok, false);
  assert.equal(validateEvent({ ...s, ts: "yesterday" }).ok, false);
  assert.equal(validateEvent({ ...s, sessionId: undefined }).ok, false);
  assert.equal(validateEvent({ ...s, cwd: 5 }).ok, false);
});

test("rejects mistyped type-specific fields", () => {
  assert.equal(validateEvent({ ...base, type: "tool_use", phase: "during", toolName: "Bash" }).ok, false);
  assert.equal(validateEvent({ ...base, type: "tool_use", phase: "pre", toolName: "" }).ok, false);
  assert.equal(validateEvent({ ...base, type: "command", command: 1 }).ok, false);
  assert.equal(validateEvent({ ...base, type: "command", command: "ls", exitCode: "0" }).ok, false);
  assert.equal(validateEvent({ ...base, type: "file_change", path: "a", operation: "rename" }).ok, false);
  assert.equal(validateEvent({ ...base, type: "approval", targetEventId: "e", decision: "maybe" }).ok, false);
  assert.equal(validateEvent({ ...base, type: "approval", decision: "approved" }).ok, false, "needs a target");
  assert.equal(validateEvent({ ...base, type: "approval", targetEventId: "", decision: "approved" }).ok, false);
  assert.equal(validateEvent({ ...base, type: "approval", targetEventId: "e", decision: "approved", ruleIds: [1] }).ok, false);
  assert.equal(validateEvent({ ...base, type: "session_start", capture: "hook", argv: [1] }).ok, false);
});

test("serializeEvent produces exactly one line and round-trips", () => {
  for (const sample of samples) {
    const line = serializeEvent(sample);
    assert.equal(line.endsWith("\n"), true);
    assert.equal(line.slice(0, -1).includes("\n"), false);
    assert.deepEqual(JSON.parse(line), sample);
  }
});

test("serializeEvent keeps multi-line text on a single line", () => {
  const event: ArdEvent = { ...base, type: "file_change", path: "a", operation: "write", newText: "line1\nline2\r\nline3" };
  const line = serializeEvent(event);
  assert.equal(line.split("\n").length, 2); // one line + trailing newline
});

test("parseJsonl returns valid events and reports bad lines without throwing", () => {
  const text = [serializeEvent(samples[0]!), "not json\n", "\n", JSON.stringify({ ...samples[0], v: 9 }) + "\n", serializeEvent(samples[3]!)].join("");
  const { events, errors } = parseJsonl(text);
  assert.equal(events.length, 2);
  assert.deepEqual(errors.map((e) => e.line), [2, 4]);
});

test("a screenshot event must point at a hex SHA-256 file name, never at a path", () => {
  const good = { ...base, type: "screenshot", imageId: "a".repeat(64), mediaType: "image/png", bytes: 10, source: "manual" };
  assert.equal(validateEvent(good).ok, true);
  for (const imageId of ["../../etc/passwd", "a".repeat(63), "a".repeat(65), "A".repeat(64), "a".repeat(63) + "/", "", 5, null]) {
    assert.equal(validateEvent({ ...good, imageId }).ok, false, String(imageId));
  }
});

test("a screenshot event only allows raster image types (no SVG, which can carry script)", () => {
  const good = { ...base, type: "screenshot", imageId: "b".repeat(64), mediaType: "image/png", bytes: 10, source: "hook" };
  for (const mediaType of ["image/svg+xml", "text/html", "application/pdf", "image/PNG", "", undefined]) {
    assert.equal(validateEvent({ ...good, mediaType }).ok, false, String(mediaType));
  }
  for (const bytes of [0, -1, 1.5, "10", null, Number.NaN]) assert.equal(validateEvent({ ...good, bytes }).ok, false, String(bytes));
  for (const source of ["tool", "", undefined]) assert.equal(validateEvent({ ...good, source }).ok, false, String(source));
});

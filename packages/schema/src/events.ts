/**
 * ard event schema, version 1.
 *
 * Every event is one JSON object on one line of `.ard/events.jsonl`.
 * Rules for evolving this file:
 *  - Adding an optional field is backwards compatible: keep `v: 1`.
 *  - Renaming/removing a field or changing its meaning requires bumping SCHEMA_VERSION.
 */

export const SCHEMA_VERSION = 1 as const;

/** Name of the per-project data folder that holds events and the local database. */
export const ARD_DIR = ".ard";
/** File name of the JSONL event log inside ARD_DIR. */
export const EVENTS_FILE = "events.jsonl";

export const EVENT_TYPES = [
  "session_start",
  "session_end",
  "tool_use",
  "command",
  "file_change",
  "approval",
  "screenshot",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** How an event was captured: by an agent's hook, or by the `ard run` process wrapper. */
export type CaptureSource = "hook" | "wrapper";

/** Fields shared by every event. */
export interface BaseEvent {
  /** Schema version. */
  v: typeof SCHEMA_VERSION;
  /** Unique event id (UUID). */
  id: string;
  /** ISO-8601 timestamp (UTC). */
  ts: string;
  /** Session id: the agent's own session id for hook events, a generated UUID for wrapper runs. */
  sessionId: string;
  /** Set on hook events that happened inside an `ard run` wrapper session. Links the two views. */
  wrapperSessionId?: string;
  /** Which agent produced the event, e.g. "claude-code", "codex", or the wrapped program name. */
  agent: string;
  /** Working directory of the agent when the event happened. */
  cwd: string;
}

export interface SessionStartEvent extends BaseEvent {
  type: "session_start";
  capture: CaptureSource;
  /** Hook: why the session started (e.g. "startup", "resume"). */
  startSource?: string;
  /** Hook: model name when the agent reports it. */
  model?: string;
  /** Wrapper: the wrapped command line. */
  argv?: string[];
  /** Wrapper: git HEAD commit at start (null when not a git repository). */
  gitHead?: string | null;
}

export interface SessionEndEvent extends BaseEvent {
  type: "session_end";
  capture: CaptureSource;
  /** Wrapper: exit code of the wrapped process (null if it was killed by a signal). */
  exitCode?: number | null;
  /** Wrapper: terminating signal, if any. */
  signal?: string | null;
  /** Hook: why the session ended (e.g. "clear", "logout", "other"). */
  reason?: string;
  durationMs?: number;
}

/** A tool call, recorded before (`pre`) and after (`post`) it runs. Values are redacted and size-capped. */
export interface ToolUseEvent extends BaseEvent {
  type: "tool_use";
  phase: "pre" | "post";
  toolName: string;
  /** Links the `pre` and `post` records of one call, when the agent provides it. */
  toolUseId?: string;
  input?: unknown;
  /** Only on `post`. Omitted for tools that also produce a `command` / `file_change` event. */
  output?: unknown;
  /** Only on `post`: false when the tool call failed. */
  ok?: boolean;
  /** Only on a failed `post`: the error text (redacted, size-capped). */
  error?: string;
}

/** A shell command run by the agent. */
export interface CommandEvent extends BaseEvent {
  type: "command";
  command: string;
  toolUseId?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  /** True when stdout/stderr were cut to the size cap. */
  truncated?: boolean;
}

export type FileOperation = "create" | "modify" | "delete" | "write";

/** A file changed by the agent. `write` means "created or overwritten" when the agent cannot tell which. */
export interface FileChangeEvent extends BaseEvent {
  type: "file_change";
  /** Path relative to the project root when inside it, otherwise as reported. */
  path: string;
  operation: FileOperation;
  /** The tool that made the change (hook mode). */
  tool?: string;
  toolUseId?: string;
  /** Hook mode: the replaced text (Edit) — redacted and size-capped. */
  oldText?: string;
  /** Hook mode: the new text (Edit/Write) — redacted and size-capped. */
  newText?: string;
  /** Wrapper mode: unified diff of the change — redacted and size-capped. */
  patch?: string;
  truncated?: boolean;
}

/**
 * A decision on an earlier event or on a whole session. Written by the review UI (human decisions),
 * or by the hook itself for automatic ones (policy denial, approval timeout).
 * Exactly one of `targetEventId` / `targetSessionId` identifies what the decision is about.
 */
export interface ApprovalEvent extends BaseEvent {
  type: "approval";
  /** The event decided on, e.g. the `pre` tool_use event of a call that needed approval. */
  targetEventId?: string;
  /** Set instead of `targetEventId` for a review decision on a whole session. */
  targetSessionId?: string;
  decision: "approved" | "rejected";
  /** Who decided: "reviewer" (UI), "policy" (rule denial) or "timeout" (nobody answered). */
  decidedBy?: string;
  note?: string;
  /** The approval request this decision answers (pre-approval flow). */
  requestId?: string;
  /** Policy rules that triggered the request or denial. */
  ruleIds?: string[];
}

/** Image formats a screenshot may have. Detected from the file's first bytes, never from a name or a claim. SVG is excluded on purpose (it can carry script). */
export const SCREENSHOT_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ScreenshotMediaType = (typeof SCREENSHOT_MEDIA_TYPES)[number];

/**
 * A picture the agent saw or did (e.g. a browser screenshot). The image itself is NOT in the log: it lives in
 * `.ard/screenshots/<imageId>`, content-addressed by its SHA-256, and this event points at it.
 * Unlike text, a picture cannot be redacted: it may show anything that was on the screen. Recording is therefore
 * opt-in, and screenshots are never uploaded by `ard sync`.
 */
export interface ScreenshotEvent extends BaseEvent {
  type: "screenshot";
  /** Lowercase hex SHA-256 of the image bytes, which is also its file name. */
  imageId: string;
  mediaType: ScreenshotMediaType;
  bytes: number;
  /** "hook": taken from a tool result; "manual": attached with `ard screenshot`. */
  source: "hook" | "manual";
  toolName?: string;
  toolUseId?: string;
  caption?: string;
}

export type ArdEvent =
  | SessionStartEvent
  | SessionEndEvent
  | ToolUseEvent
  | CommandEvent
  | FileChangeEvent
  | ApprovalEvent
  | ScreenshotEvent;

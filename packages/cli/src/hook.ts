import type { ArdEvent, FileChangeEvent } from "@ard/schema";
import { eventsPathFor, findProjectRoot, toProjectPath } from "./paths.js";
import { LIMITS, safeText, sanitize } from "./redact.js";
import { appendEvent, baseFields, type EventContext } from "./store.js";

/**
 * Claude Code hook payload (JSON on stdin). Every field is optional on purpose: the format is
 * owned by Claude Code and may change, so we read defensively and never throw on a surprise.
 * Verified against https://code.claude.com/docs/en/hooks (Nov 2026).
 */
export interface ClaudeHookPayload {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: unknown;
  /** PostToolUseFailure: error text. For Bash it starts with "Exit code N". */
  error?: unknown;
  is_interrupt?: unknown;
  /** SessionStart: startup | resume | clear | compact | fork. */
  source?: unknown;
  model?: unknown;
  /** SessionEnd: clear | resume | logout | prompt_input_exit | other. */
  reason?: unknown;
}

/** Hook events `ard init` registers. All are documented Claude Code events. */
export const CLAUDE_HOOK_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionEnd"] as const;

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Large text fields of file tools. They are recorded once, on the file_change event, not twice. */
const BULKY_KEYS = ["content", "old_string", "new_string", "new_source", "edits"];

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function preInput(toolName: string, toolInput: unknown): unknown {
  if (!FILE_TOOLS.has(toolName)) return sanitize(toolInput);
  const input = { ...rec(toolInput) };
  for (const key of BULKY_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    delete input[key];
    input[`${key}_chars`] = typeof value === "string" ? value.length : JSON.stringify(value)?.length ?? 0;
  }
  return sanitize(input);
}

function withToolUseId<T extends object>(event: T, id: string | undefined): T {
  return id ? { ...event, toolUseId: id } : event;
}

function fileChanges(ctx: EventContext, root: string, toolName: string, input: Record<string, unknown>, response: Record<string, unknown>, toolUseId: string | undefined): FileChangeEvent[] {
  const rawPath = str(input.file_path) ?? str(input.notebook_path) ?? str(response.filePath);
  if (!rawPath) return [];
  const path = toProjectPath(rawPath, root);
  const make = (operation: FileChangeEvent["operation"], oldText?: unknown, newText?: unknown): FileChangeEvent => {
    const event: FileChangeEvent = { ...baseFields(ctx), type: "file_change", path, operation, tool: toolName };
    if (toolUseId) event.toolUseId = toolUseId;
    let truncated = false;
    if (typeof oldText === "string") {
      const c = safeText(oldText, LIMITS.text);
      event.oldText = c.text;
      truncated ||= c.truncated;
    }
    if (typeof newText === "string") {
      const c = safeText(newText, LIMITS.text);
      event.newText = c.text;
      truncated ||= c.truncated;
    }
    if (truncated) event.truncated = true;
    return event;
  };

  switch (toolName) {
    case "Write": {
      const kind = response.type; // documented example: "create"
      const operation = kind === "create" ? "create" : kind === "update" ? "modify" : "write";
      return [make(operation, undefined, input.content)];
    }
    case "Edit":
      return [make("modify", input.old_string, input.new_string)];
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      return edits.map((e) => make("modify", rec(e).old_string, rec(e).new_string));
    }
    case "NotebookEdit":
      return [make("modify", undefined, input.new_source)];
    default:
      return [];
  }
}

function commandEvent(ctx: EventContext, input: Record<string, unknown>, toolUseId: string | undefined, extra: { exitCode: number | null; stdout?: unknown; stderr?: unknown; interrupted?: boolean }): ArdEvent {
  const event: ArdEvent = {
    ...baseFields(ctx),
    type: "command",
    command: safeText(str(input.command) ?? "", LIMITS.string).text,
    exitCode: extra.exitCode,
  };
  let truncated = false;
  if (typeof extra.stdout === "string" && extra.stdout !== "") {
    const c = safeText(extra.stdout, LIMITS.string);
    event.stdout = c.text;
    truncated ||= c.truncated;
  }
  if (typeof extra.stderr === "string" && extra.stderr !== "") {
    const c = safeText(extra.stderr, LIMITS.string);
    event.stderr = c.text;
    truncated ||= c.truncated;
  }
  if (extra.interrupted) event.interrupted = true;
  if (truncated) event.truncated = true;
  return withToolUseId(event, toolUseId);
}

/** Pure mapping: one Claude Code hook payload -> zero or more ard events. */
export function eventsFromClaudePayload(payload: ClaudeHookPayload, root: string, env: NodeJS.ProcessEnv = process.env): ArdEvent[] {
  const name = str(payload.hook_event_name);
  const ctx: EventContext = {
    sessionId: str(payload.session_id) ?? "unknown-session",
    agent: "claude-code",
    cwd: str(payload.cwd) ?? root,
  };
  const wrapper = str(env.ARD_SESSION_ID);
  if (wrapper) ctx.wrapperSessionId = wrapper;

  const toolName = str(payload.tool_name) ?? "unknown";
  const toolUseId = str(payload.tool_use_id);
  const input = rec(payload.tool_input);

  switch (name) {
    case "SessionStart": {
      const event: ArdEvent = { ...baseFields(ctx), type: "session_start", capture: "hook" };
      const startSource = str(payload.source);
      const model = str(payload.model);
      if (startSource) event.startSource = startSource;
      if (model) event.model = model;
      return [event];
    }
    case "SessionEnd": {
      const event: ArdEvent = { ...baseFields(ctx), type: "session_end", capture: "hook" };
      const reason = str(payload.reason);
      if (reason) event.reason = reason;
      return [event];
    }
    case "PreToolUse":
      return [withToolUseId({ ...baseFields(ctx), type: "tool_use" as const, phase: "pre" as const, toolName, input: preInput(toolName, payload.tool_input) }, toolUseId)];
    case "PostToolUse": {
      const response = rec(payload.tool_response);
      const derived: ArdEvent[] =
        toolName === "Bash"
          // PostToolUse only fires for successful calls, and Claude Code gives no numeric exit code, so success means 0.
          ? [commandEvent(ctx, input, toolUseId, { exitCode: 0, stdout: response.stdout, stderr: response.stderr, interrupted: response.interrupted === true })]
          : fileChanges(ctx, root, toolName, input, response, toolUseId);
      const post: ArdEvent = withToolUseId({ ...baseFields(ctx), type: "tool_use" as const, phase: "post" as const, toolName, ok: true }, toolUseId);
      if (derived.length === 0 && payload.tool_response !== undefined) post.output = sanitize(payload.tool_response);
      return [post, ...derived];
    }
    case "PostToolUseFailure": {
      const error = safeText(str(payload.error) ?? "", LIMITS.string).text;
      const post: ArdEvent = withToolUseId({ ...baseFields(ctx), type: "tool_use" as const, phase: "post" as const, toolName, ok: false, error }, toolUseId);
      if (toolName !== "Bash") return [post];
      const match = /^Exit code (\d+)/.exec(str(payload.error) ?? "");
      const exitCode = match ? Number(match[1]) : null;
      return [post, commandEvent(ctx, input, toolUseId, { exitCode, stderr: str(payload.error), interrupted: payload.is_interrupt === true })];
    }
    default:
      return []; // events we do not record
  }
}

/**
 * Handle one hook invocation: parse stdin, map, append. Returns the number of events written.
 * Throws on I/O failure; the CLI wrapper turns that into a warning and exit 0, because a
 * recorder must never break the agent it is observing.
 */
export function recordClaudeHook(stdinText: string, env: NodeJS.ProcessEnv = process.env, fallbackCwd: string = process.cwd()): number {
  const text = stdinText.trim();
  if (text === "") return 0;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return 0;
  const payload = parsed as ClaudeHookPayload;

  const projectDir = str(env.CLAUDE_PROJECT_DIR);
  const root = projectDir ?? findProjectRoot(str(payload.cwd) ?? fallbackCwd);
  const events = eventsFromClaudePayload(payload, root, env);
  if (events.length === 0) return 0;

  const path = eventsPathFor(root, env);
  for (const event of events) appendEvent(path, event);
  return events.length;
}

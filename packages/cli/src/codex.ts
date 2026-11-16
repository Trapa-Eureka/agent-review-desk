import type { ArdEvent, FileChangeEvent } from "@ard/schema";
import { LIMITS, baseFields, extractImages, safeText, sanitize, toProjectPath, type EventContext } from "@ard/core";

/**
 * Codex hook payload (JSON on stdin). Every field is optional on purpose: Codex owns the format and it is not stable,
 * so we read defensively and never throw on a surprise.
 *
 * What is KNOWN comes from payloads captured from a real Codex 0.169.0 session (see fixtures/codex):
 *  - events: SessionStart, SessionEnd, PreToolUse, PostToolUse, PermissionRequest, Stop (no "failure" event);
 *  - common fields: session_id, cwd, model, permission_mode, transcript_path, hook_event_name; tool events add turn_id,
 *    tool_name ("Bash" in every captured call), tool_input ({ command }), tool_use_id;
 *  - for Bash, `tool_response` is ONE STRING: the command's output. There is no exit code and no separate stderr, and a
 *    failing command (`false`) arrives as an empty string. So the exit code of a Codex command is unknown.
 *  - a file the agent wrote through a shell command (`printf … > notes.txt`) is just a Bash command: no file-change data.
 *
 * `apply_patch` (verified on 0.169.0): tool_name "apply_patch", the patch text in tool_input.command, the result one string.
 * Captured for real: an `Add File` patch, and one call that held an `Update File` (an `@@` with no line number or context,
 * just `-`/`+` lines) and a `Delete File` together, with ABSOLUTE paths and no content for the deleted file
 * (fixtures `*-apply-patch*.json`). `Move to` is not captured yet; it follows Codex's documented patch convention.
 */
export interface CodexHookPayload {
  session_id?: unknown;
  turn_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  model?: unknown;
  permission_mode?: unknown;
  /** SessionStart: "startup", ... */
  source?: unknown;
  /** SessionEnd: "other", ... */
  reason?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: unknown;
}

/**
 * VERIFIED on Codex 0.169.0: when a PreToolUse hook has not finished within its timeout, Codex stops waiting and RUNS THE
 * COMMAND ANYWAY. A timeout is therefore an unapproved execution, so ard must always give up (and block) BEFORE Codex does.
 * Codex documents 600 seconds as the hook timeout default, so that is the only long value known to be accepted: the hook
 * is registered with it, and ard waits for a human for less than that (a minute of margin). Longer waits on Codex are not offered.
 */
export const CODEX_PRE_TOOL_TIMEOUT_SECONDS = 600;
export const CODEX_MAX_WAIT_SECONDS = 540;

/** Hook events `ard init --agent codex` registers. */
export const CODEX_HOOK_EVENTS = ["SessionStart", "SessionEnd", "PreToolUse", "PostToolUse"] as const;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const isPatchTool = (name: string): boolean => name === "apply_patch" || name === "ApplyPatch";

export interface PatchedFile {
  path: string;
  operation: "create" | "modify" | "delete";
  /** Unified-diff-like body for modify, `+` lines for create. */
  patch?: string;
  newText?: string;
}

/**
 * Parse Codex's patch text:
 *   *** Begin Patch
 *   *** Add File: a.txt        (then "+line" lines)
 *   *** Update File: b.txt     (then optional "*** Move to: c.txt", then "@@" hunks of " ", "-", "+" lines)
 *   *** Delete File: d.txt
 *   *** End Patch
 * Anything that does not look like that yields no files (the caller still records the tool call itself).
 */
export function parseApplyPatch(text: string): PatchedFile[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim() === "*** Begin Patch");
  if (start === -1) return [];
  const files: PatchedFile[] = [];
  let current: { path: string; kind: "add" | "update" | "delete"; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    if (current.kind === "add") files.push({ path: current.path, operation: "create", newText: current.body.filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n") });
    else if (current.kind === "delete") files.push({ path: current.path, operation: "delete" });
    else {
      const body = current.body;
      // parseUnifiedDiff only reads lines after a hunk marker; Codex lets the first hunk omit it.
      const patch = body[0]?.startsWith("@@") ? body.join("\n") : ["@@", ...body].join("\n");
      files.push({ path: current.path, operation: "modify", patch });
    }
    current = null;
  };
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "*** End Patch") break;
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      flush();
      current = { path: header[2]!.trim(), kind: header[1]!.toLowerCase() as "add" | "update" | "delete", body: [] };
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current?.kind === "update") {
      current.path = move[1]!.trim();
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();
  return files.filter((f) => f.path !== "");
}

function patchChanges(ctx: EventContext, root: string, toolName: string, patchText: string, toolUseId: string | undefined): FileChangeEvent[] {
  return parseApplyPatch(patchText).map((file) => {
    const event: FileChangeEvent = { ...baseFields(ctx), type: "file_change", path: toProjectPath(file.path, root), operation: file.operation, tool: toolName };
    if (toolUseId) event.toolUseId = toolUseId;
    let truncated = false;
    if (file.patch !== undefined) {
      const c = safeText(file.patch, LIMITS.text);
      event.patch = c.text;
      truncated ||= c.truncated;
    }
    if (file.newText !== undefined) {
      const c = safeText(file.newText, LIMITS.text);
      event.newText = c.text;
      truncated ||= c.truncated;
    }
    if (truncated) event.truncated = true;
    return event;
  });
}

/** Command output as Codex reports it: normally one string; an object with stdout/stderr/exit code is accepted too in case a future version sends one. */
function readResponse(response: unknown): { stdout?: string; stderr?: string; exitCode: number | null } {
  if (typeof response === "string") return { stdout: response, exitCode: null };
  const o = rec(response);
  const exit = o.exit_code ?? o.exitCode;
  const stdout = str(o.stdout) ?? str(o.output);
  const stderr = str(o.stderr);
  return { ...(stdout !== undefined ? { stdout } : {}), ...(stderr !== undefined ? { stderr } : {}), exitCode: typeof exit === "number" && Number.isFinite(exit) ? exit : null };
}

function commandEvent(ctx: EventContext, command: string, toolUseId: string | undefined, response: unknown): ArdEvent {
  const read = readResponse(response);
  const event: ArdEvent = { ...baseFields(ctx), type: "command", command: safeText(command, LIMITS.string).text, exitCode: read.exitCode };
  let truncated = false;
  if (read.stdout) {
    const c = safeText(read.stdout, LIMITS.string);
    event.stdout = c.text;
    truncated ||= c.truncated;
  }
  if (read.stderr) {
    const c = safeText(read.stderr, LIMITS.string);
    event.stderr = c.text;
    truncated ||= c.truncated;
  }
  if (truncated) event.truncated = true;
  return toolUseId ? { ...event, toolUseId } : event;
}

/** Pure mapping: one Codex hook payload -> zero or more ard events. */
export function eventsFromCodexPayload(payload: CodexHookPayload, root: string, env: NodeJS.ProcessEnv = process.env): ArdEvent[] {
  const name = str(payload.hook_event_name);
  const ctx: EventContext = { sessionId: str(payload.session_id) ?? "unknown-session", agent: "codex", cwd: str(payload.cwd) ?? root };
  const wrapper = str(env.ARD_SESSION_ID);
  if (wrapper) ctx.wrapperSessionId = wrapper;

  const toolName = str(payload.tool_name) ?? "unknown";
  const toolUseId = str(payload.tool_use_id);
  const input = rec(payload.tool_input);
  const withId = <T extends object>(event: T): T => (toolUseId ? { ...event, toolUseId } : event);

  switch (name) {
    case "SessionStart": {
      const event: ArdEvent = { ...baseFields(ctx), type: "session_start", capture: "hook" };
      const source = str(payload.source);
      const model = str(payload.model);
      if (source) event.startSource = source;
      if (model) event.model = model;
      return [event];
    }
    case "SessionEnd": {
      const event: ArdEvent = { ...baseFields(ctx), type: "session_end", capture: "hook" };
      const reason = str(payload.reason);
      if (reason) event.reason = reason;
      return [event];
    }
    case "PreToolUse": {
      let toolInput: unknown = sanitize(payload.tool_input);
      if (isPatchTool(toolName)) {
        // The patch text is recorded once, as file_change events, not twice.
        const { command, ...rest } = input;
        toolInput = sanitize({ ...rest, ...(typeof command === "string" ? { command_chars: command.length } : {}) });
      }
      return [withId({ ...baseFields(ctx), type: "tool_use" as const, phase: "pre" as const, toolName, input: toolInput })];
    }
    case "PostToolUse": {
      const post: ArdEvent = withId({ ...baseFields(ctx), type: "tool_use" as const, phase: "post" as const, toolName, ok: true });
      const command = str(input.command);
      let derived: ArdEvent[] = [];
      if (toolName === "Bash" && command !== undefined) derived = [commandEvent(ctx, command, toolUseId, payload.tool_response)];
      else if (isPatchTool(toolName) && command !== undefined) derived = patchChanges(ctx, root, toolName, command, toolUseId);
      // Pictures are never written into the log as text (see the Claude mapping).
      if (derived.length === 0 && payload.tool_response !== undefined) post.output = sanitize(extractImages(payload.tool_response).stripped);
      return [post, ...derived];
    }
    default:
      return []; // Stop, PermissionRequest, UserPromptSubmit, ...: not recorded
  }
}

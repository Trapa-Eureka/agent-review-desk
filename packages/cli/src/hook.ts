import type { ArdEvent, FileChangeEvent, ScreenshotEvent } from "@ard/schema";
import { CODEX_MAX_WAIT_SECONDS, eventsFromCodexPayload } from "./codex.js";
import {
  LIMITS,
  appendEvent,
  baseFields,
  evaluatePolicy,
  extractImages,
  eventsPathFor,
  findProjectRoot,
  loadConfig,
  openProject,
  recordApprovalEvent,
  safeText,
  sanitize,
  saveScreenshot,
  summarizeCall,
  toProjectPath,
  waitForDecision,
  type EventContext,
  type FoundImage,
  type WaitOptions,
} from "@ard/core";

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
      // Pictures in a tool result are NEVER written into the log as text (base64 would bloat it and is useless there):
      // they are replaced by a small placeholder here. Whether the pictures are kept is decided in recordPayload.
      const stripped = extractImages(payload.tool_response).stripped;
      const response = rec(stripped);
      const derived: ArdEvent[] =
        toolName === "Bash"
          // PostToolUse only fires for successful calls, and Claude Code gives no numeric exit code, so success means 0.
          ? [commandEvent(ctx, input, toolUseId, { exitCode: 0, stdout: response.stdout, stderr: response.stderr, interrupted: response.interrupted === true })]
          : fileChanges(ctx, root, toolName, input, response, toolUseId);
      const post: ArdEvent = withToolUseId({ ...baseFields(ctx), type: "tool_use" as const, phase: "post" as const, toolName, ok: true }, toolUseId);
      if (derived.length === 0 && payload.tool_response !== undefined) post.output = sanitize(stripped);
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

/** Keep the pictures found in a tool result (only when ard.config.json says "screenshots": true). Never throws: a recorder must not break the agent. */
function screenshotEventsFor(images: FoundImage[], post: ArdEvent, root: string, env: NodeJS.ProcessEnv): ScreenshotEvent[] {
  const out: ScreenshotEvent[] = [];
  for (const image of images) {
    try {
      const saved = saveScreenshot(root, image.data, env);
      const ctx: EventContext = { sessionId: post.sessionId, agent: post.agent, cwd: post.cwd, ...(post.wrapperSessionId ? { wrapperSessionId: post.wrapperSessionId } : {}) };
      const event: ScreenshotEvent = { ...baseFields(ctx), type: "screenshot", imageId: saved.imageId, mediaType: saved.mediaType, bytes: saved.bytes, source: "hook" };
      if (post.type === "tool_use") {
        event.toolName = post.toolName;
        if (post.toolUseId) event.toolUseId = post.toolUseId;
      }
      out.push(event);
    } catch {
      // an image we cannot keep is simply not kept
    }
  }
  return out;
}

/** The agents ard has a hook adapter for. */
export type HookAgent = "claude-code" | "codex";
export const HOOK_AGENTS: readonly HookAgent[] = ["claude-code", "codex"];

export interface Recorded {
  payload: ClaudeHookPayload;
  root: string;
  events: ArdEvent[];
}

/**
 * Parse one hook invocation and append its events to the JSONL log. Returns null when there is
 * nothing to record. Throws on I/O failure; the caller turns that into a warning, because a
 * recorder must never break the agent it is observing.
 */
export function recordPayload(stdinText: string, env: NodeJS.ProcessEnv = process.env, fallbackCwd: string = process.cwd(), agent: HookAgent = "claude-code"): Recorded | null {
  const text = stdinText.trim();
  if (text === "") return null;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const payload = parsed as ClaudeHookPayload;

  // Claude Code names the project in CLAUDE_PROJECT_DIR; Codex gives no such variable, only the working directory.
  const projectDir = agent === "claude-code" ? str(env.CLAUDE_PROJECT_DIR) : undefined;
  const root = projectDir ?? findProjectRoot(str(payload.cwd) ?? fallbackCwd);
  const events = agent === "codex" ? eventsFromCodexPayload(payload, root, env) : eventsFromClaudePayload(payload, root, env);
  if (events.length === 0) return null;

  if (payload.hook_event_name === "PostToolUse") {
    const post = events.find((e) => e.type === "tool_use" && e.phase === "post");
    const { images } = extractImages(payload.tool_response);
    if (post && images.length > 0) {
      let keep = false;
      try {
        keep = loadConfig(root).screenshots;
      } catch {
        // an unreadable config means "off"
      }
      if (keep) events.push(...screenshotEventsFor(images, post, root, env));
    }
  }

  const path = eventsPathFor(root, env);
  for (const event of events) appendEvent(path, event);
  return { payload, root, events };
}

/** Record only (no policy). Returns the number of events written. */
export function recordClaudeHook(stdinText: string, env: NodeJS.ProcessEnv = process.env, fallbackCwd: string = process.cwd()): number {
  return recordPayload(stdinText, env, fallbackCwd)?.events.length ?? 0;
}

export interface HookResult {
  /** 0 = let the tool call proceed. 2 = block it (Claude Code shows `message` to the agent). */
  exitCode: 0 | 2;
  /** Why the call was blocked (exit 2), or a warning to log (exit 0). */
  message?: string;
}

export type HookDeps = WaitOptions;

const blocked = (message: string): HookResult => ({ exitCode: 2, message: `[ard] ${message} Do not retry or work around this; ask the user.` });

/**
 * The full hook: record the event, and for a PreToolUse call decide whether it may proceed.
 *
 * Fail-open/fail-closed, deliberately:
 *  - Anything wrong with *recording* or with evaluating the policy -> exit 0. A recorder must never break the agent.
 *  - A call the policy flagged as risky that cannot be approved (store unreachable) -> exit 2. Silently
 *    letting a flagged action through because our own plumbing broke would defeat the point.
 */
export async function handleClaudeHook(stdinText: string, env: NodeJS.ProcessEnv = process.env, fallbackCwd: string = process.cwd(), deps: HookDeps = {}): Promise<HookResult> {
  return handleHook("claude-code", stdinText, env, fallbackCwd, deps);
}

/** The same hook for any supported agent: record, then (for a PreToolUse call) apply the policy and pre-approval. */
export async function handleHook(agent: HookAgent, stdinText: string, env: NodeJS.ProcessEnv = process.env, fallbackCwd: string = process.cwd(), deps: HookDeps = {}): Promise<HookResult> {
  const recorded = recordPayload(stdinText, env, fallbackCwd, agent);
  if (!recorded || recorded.payload.hook_event_name !== "PreToolUse") return { exitCode: 0 };
  const { payload, root, events } = recorded;

  const config = loadConfig(root);
  if (!config.approvals) return { exitCode: 0, ...(config.warnings.length > 0 ? { message: config.warnings.join(" ") } : {}) };
  // Codex runs the command if the hook outlives its timeout (verified), so for Codex the wait is capped below that timeout.
  const waitSeconds = agent === "codex" ? Math.min(config.timeoutSeconds, CODEX_MAX_WAIT_SECONDS) : config.timeoutSeconds;

  const toolInput = rec(payload.tool_input);
  let verdict;
  try {
    verdict = evaluatePolicy({ toolName: str(payload.tool_name) ?? "unknown", toolInput, projectRoot: root }, config.rules);
  } catch (error) {
    return { exitCode: 0, message: `policy evaluation failed, allowing the call: ${(error as Error).message}` };
  }
  if (verdict.action === "allow") return { exitCode: 0 };

  const pre = events.find((e) => e.type === "tool_use" && e.phase === "pre");
  const sessionId = pre?.sessionId ?? "unknown-session";
  const cwd = pre?.cwd ?? root;
  const targetEventId = pre?.id;
  const ruleIds = verdict.matches.map((m) => m.id);
  const why = verdict.matches.map((m) => m.description).join("; ");
  const eventsPath = eventsPathFor(root, env);

  let repo;
  try {
    repo = openProject(root, env).repo;
  } catch (error) {
    // No database to ask a human through. Say so, record the denial in the plain log, and block.
    const text = `could not open the approval store (${(error as Error).message}); blocking this risky action (${why}).`;
    try {
      appendEvent(eventsPath, { ...baseFields({ sessionId, agent: "ard-review", cwd }), type: "approval", decision: "rejected", decidedBy: "policy", ...(targetEventId ? { targetEventId } : { targetSessionId: sessionId }), ruleIds, note: text });
    } catch {
      // nothing more we can do
    }
    return blocked(text);
  }

  try {
    if (verdict.action === "deny") {
      recordApprovalEvent(repo, eventsPath, { sessionId, cwd, decision: "rejected", decidedBy: "policy", targetEventId, ruleIds, note: `Denied by policy: ${why}` });
      return blocked(`Blocked by policy (${ruleIds.join(", ")}): ${why}.`);
    }

    const call = { toolName: str(payload.tool_name) ?? "unknown", toolInput, projectRoot: root };
    const request = repo.createApprovalRequest({
      sessionId,
      toolUseEventId: targetEventId ?? "",
      ...(str(payload.tool_use_id) ? { toolUseId: str(payload.tool_use_id)! } : {}),
      toolName: call.toolName,
      summary: summarizeCall(call),
      input: sanitize(toolInput),
      rules: verdict.matches.map((m) => ({ id: m.id, description: m.description })),
      timeoutMs: waitSeconds * 1000,
    });

    // If Claude Code interrupts us while we wait, retire the request so it cannot be approved later for nothing.
    const abandon = () => {
      try {
        repo.expireApprovalRequest(request.id);
      } catch {
        // best effort
      }
      process.exit(2);
    };
    process.once("SIGTERM", abandon);
    process.once("SIGINT", abandon);
    let outcome;
    try {
      outcome = await waitForDecision(repo, request.id, deps);
    } finally {
      process.off("SIGTERM", abandon);
      process.off("SIGINT", abandon);
    }

    if (outcome.status === "approved") return { exitCode: 0 };
    if (outcome.status === "rejected") {
      return blocked(`A reviewer (${outcome.decidedBy ?? "unknown"}) rejected this action${outcome.note ? `: ${outcome.note}` : "."}`);
    }
    recordApprovalEvent(repo, eventsPath, { sessionId, cwd, decision: "rejected", decidedBy: "timeout", targetEventId, requestId: request.id, ruleIds, note: `No decision within ${waitSeconds}s.` });
    return blocked(`Nobody approved this action within ${waitSeconds}s (${why}). Start the review UI with "ard review" and try again.`);
  } catch (error) {
    return blocked(`approval failed (${(error as Error).message}); blocking this risky action (${why}).`);
  } finally {
    repo.close();
  }
}

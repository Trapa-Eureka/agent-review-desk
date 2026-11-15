import {
  EVENT_TYPES,
  SCHEMA_VERSION,
  type ArdEvent,
  type EventType,
  type FileOperation,
} from "./events.js";

export type ValidationResult = { ok: true; event: ArdEvent } | { ok: false; error: string };

const FILE_OPERATIONS: readonly FileOperation[] = ["create", "modify", "delete", "write"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optional(o: Record<string, unknown>, key: string, check: (v: unknown) => boolean, label: string): string | null {
  if (o[key] === undefined) return null;
  return check(o[key]) ? null : `"${key}" must be ${label}`;
}

const isString = (v: unknown) => typeof v === "string";
const isBool = (v: unknown) => typeof v === "boolean";
const isNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isNumberOrNull = (v: unknown) => v === null || isNumber(v);
const isStringOrNull = (v: unknown) => v === null || isString(v);
const isStringArray = (v: unknown) => Array.isArray(v) && v.every(isString);

function firstError(...errors: Array<string | null>): string | null {
  return errors.find((e) => e !== null) ?? null;
}

function requireString(o: Record<string, unknown>, key: string): string | null {
  return typeof o[key] === "string" && o[key] !== "" ? null : `"${key}" must be a non-empty string`;
}

function validateBase(o: Record<string, unknown>): string | null {
  if (o.v !== SCHEMA_VERSION) return `unsupported schema version: ${String(o.v)} (expected ${SCHEMA_VERSION})`;
  if (!EVENT_TYPES.includes(o.type as EventType)) return `unknown event type: ${String(o.type)}`;
  const ts = o.ts;
  return firstError(
    requireString(o, "id"),
    typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? null : `"ts" must be an ISO-8601 timestamp`,
    requireString(o, "sessionId"),
    requireString(o, "agent"),
    typeof o.cwd === "string" ? null : `"cwd" must be a string`,
    optional(o, "wrapperSessionId", isString, "a string"),
  );
}

function validateByType(o: Record<string, unknown>): string | null {
  switch (o.type as EventType) {
    case "session_start":
      return firstError(
        o.capture === "hook" || o.capture === "wrapper" ? null : `"capture" must be "hook" or "wrapper"`,
        optional(o, "startSource", isString, "a string"),
        optional(o, "model", isString, "a string"),
        optional(o, "argv", isStringArray, "an array of strings"),
        optional(o, "gitHead", isStringOrNull, "a string or null"),
      );
    case "session_end":
      return firstError(
        o.capture === "hook" || o.capture === "wrapper" ? null : `"capture" must be "hook" or "wrapper"`,
        optional(o, "exitCode", isNumberOrNull, "a number or null"),
        optional(o, "signal", isStringOrNull, "a string or null"),
        optional(o, "reason", isString, "a string"),
        optional(o, "durationMs", isNumber, "a number"),
      );
    case "tool_use":
      return firstError(
        o.phase === "pre" || o.phase === "post" ? null : `"phase" must be "pre" or "post"`,
        requireString(o, "toolName"),
        optional(o, "toolUseId", isString, "a string"),
        optional(o, "ok", isBool, "a boolean"),
        optional(o, "error", isString, "a string"),
      );
    case "command":
      return firstError(
        typeof o.command === "string" ? null : `"command" must be a string`,
        optional(o, "toolUseId", isString, "a string"),
        optional(o, "exitCode", isNumberOrNull, "a number or null"),
        optional(o, "stdout", isString, "a string"),
        optional(o, "stderr", isString, "a string"),
        optional(o, "interrupted", isBool, "a boolean"),
        optional(o, "truncated", isBool, "a boolean"),
      );
    case "file_change":
      return firstError(
        requireString(o, "path"),
        FILE_OPERATIONS.includes(o.operation as FileOperation) ? null : `"operation" must be one of ${FILE_OPERATIONS.join(", ")}`,
        optional(o, "tool", isString, "a string"),
        optional(o, "toolUseId", isString, "a string"),
        optional(o, "oldText", isString, "a string"),
        optional(o, "newText", isString, "a string"),
        optional(o, "patch", isString, "a string"),
        optional(o, "truncated", isBool, "a boolean"),
      );
    case "approval":
      return firstError(
        requireString(o, "targetEventId"),
        o.decision === "approved" || o.decision === "rejected" ? null : `"decision" must be "approved" or "rejected"`,
        optional(o, "decidedBy", isString, "a string"),
        optional(o, "note", isString, "a string"),
      );
  }
}

/** Validate an unknown value as an ard event. Never throws. */
export function validateEvent(value: unknown): ValidationResult {
  if (!isObject(value)) return { ok: false, error: "event must be a JSON object" };
  const error = firstError(validateBase(value), validateByType(value));
  return error ? { ok: false, error } : { ok: true, event: value as unknown as ArdEvent };
}

/** Serialize an event as exactly one JSONL line (including the trailing newline). */
export function serializeEvent(event: ArdEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export interface ParsedJsonl {
  events: ArdEvent[];
  /** 1-based line numbers and reasons for lines that were skipped. */
  errors: Array<{ line: number; error: string }>;
}

/** Parse a whole JSONL document. Bad lines are reported, not thrown, so one corrupt line never hides the rest. */
export function parseJsonl(text: string): ParsedJsonl {
  const events: ArdEvent[] = [];
  const errors: ParsedJsonl["errors"] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push({ line: index + 1, error: "invalid JSON" });
      return;
    }
    const result = validateEvent(parsed);
    if (result.ok) events.push(result.event);
    else errors.push({ line: index + 1, error: result.error });
  });
  return { events, errors };
}

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_VERSION, serializeEvent, validateEvent, type ArdEvent, type BaseEvent } from "@ard/schema";

export interface EventContext {
  sessionId: string;
  agent: string;
  cwd: string;
  wrapperSessionId?: string;
}

/** Fresh id/timestamp plus the shared context fields. */
export function baseFields(ctx: EventContext): BaseEvent {
  const base: BaseEvent = {
    v: SCHEMA_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    agent: ctx.agent,
    cwd: ctx.cwd,
  };
  if (ctx.wrapperSessionId) base.wrapperSessionId = ctx.wrapperSessionId;
  return base;
}

/**
 * Append one event to the JSONL log (creating the folder with owner-only permissions: the log
 * holds code and command output). Each event is written with a single append so concurrent hook
 * processes do not interleave lines. Refuses to write an event that fails validation.
 */
export function appendEvent(eventsPath: string, event: ArdEvent): void {
  const check = validateEvent(event);
  if (!check.ok) throw new Error(`refusing to write invalid ${String((event as { type?: unknown }).type)} event: ${check.error}`);
  mkdirSync(dirname(eventsPath), { recursive: true, mode: 0o700 });
  appendFileSync(eventsPath, serializeEvent(event), { mode: 0o600 });
}

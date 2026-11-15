import type { ApprovalEvent } from "@ard/schema";
import { appendEvent, baseFields } from "./jsonl.js";
import { safeText } from "./redact.js";
import type { ApprovalRequest, Repository } from "./repository.js";

/** Who is recorded as the author of events that are not an agent's own. */
export const REVIEW_AGENT = "ard-review";

const NOTE_LIMIT = 1000;
const WHO_LIMIT = 64;

function cleanNote(note: string | null | undefined): string | undefined {
  const trimmed = note?.trim();
  return trimmed ? safeText(trimmed, NOTE_LIMIT).text : undefined;
}

function cleanWho(by: string | undefined, fallback: string): string {
  const trimmed = by?.trim().slice(0, WHO_LIMIT);
  return trimmed ? trimmed : fallback;
}

export interface ApprovalEventInput {
  sessionId: string;
  cwd: string;
  decision: "approved" | "rejected";
  decidedBy: string;
  note?: string;
  targetEventId?: string;
  targetSessionId?: string;
  requestId?: string;
  ruleIds?: string[];
}

/**
 * Append an approval event to the JSONL log (the source of truth) and index it for the UI right away.
 * Pass `eventsPath: null` where there is no JSONL log (the cloud workspace stores events in its database only).
 */
export function recordApprovalEvent(repo: Repository, eventsPath: string | null, input: ApprovalEventInput): ApprovalEvent {
  const event: ApprovalEvent = {
    ...baseFields({ sessionId: input.sessionId, agent: REVIEW_AGENT, cwd: input.cwd }),
    type: "approval",
    decision: input.decision,
    decidedBy: input.decidedBy,
  };
  if (input.targetEventId) event.targetEventId = input.targetEventId;
  if (input.targetSessionId) event.targetSessionId = input.targetSessionId;
  if (input.requestId) event.requestId = input.requestId;
  if (input.ruleIds && input.ruleIds.length > 0) event.ruleIds = input.ruleIds;
  const note = cleanNote(input.note);
  if (note) event.note = note;
  if (eventsPath !== null) appendEvent(eventsPath, event);
  repo.insertEvent(event);
  return event;
}

export interface WaitOptions {
  pollMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitOutcome {
  status: "approved" | "rejected" | "expired";
  decidedBy: string | null;
  note: string | null;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait (in a hook process) until a human decides the request, or its deadline passes.
 * On the deadline the request is marked expired -- unless a decision landed in the same instant,
 * in which case that decision wins, because the database is the single arbiter.
 */
export async function waitForDecision(repo: Repository, requestId: string, options: WaitOptions = {}): Promise<WaitOutcome> {
  const pollMs = options.pollMs ?? 400;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? realSleep;
  for (;;) {
    let request = repo.getApprovalRequest(requestId);
    if (!request) throw new Error(`approval request ${requestId} disappeared`);
    if (request.status === "pending" && now().getTime() >= Date.parse(request.expiresAt)) {
      repo.expireApprovalRequest(requestId, now());
      request = repo.getApprovalRequest(requestId)!;
    }
    if (request.status !== "pending") {
      return { status: request.status, decidedBy: request.decidedBy, note: request.note };
    }
    await sleep(pollMs);
  }
}

export type DecideResult = { ok: true; event: ApprovalEvent; request: ApprovalRequest } | { ok: false; reason: "not-found" | "already-decided" | "expired"; status?: string };

/**
 * A human answers a pending approval request in the review UI.
 * Only a still-pending, unexpired request can be decided; anything else is reported, never overwritten.
 */
export function decideRequest(repo: Repository, eventsPath: string, cwd: string, requestId: string, decision: "approved" | "rejected", options: { by?: string; note?: string | null; now?: Date } = {}): DecideResult {
  const before = repo.getApprovalRequest(requestId);
  if (!before) return { ok: false, reason: "not-found" };
  const by = cleanWho(options.by, "reviewer");
  const note = cleanNote(options.note) ?? null;
  if (!repo.decideApprovalRequest(requestId, decision, by, note, options.now)) {
    const current = repo.getApprovalRequest(requestId)!;
    return { ok: false, reason: current.status === "expired" || Date.parse(current.expiresAt) <= (options.now ?? new Date()).getTime() ? "expired" : "already-decided", status: current.status };
  }
  const request = repo.getApprovalRequest(requestId)!;
  const event = recordApprovalEvent(repo, eventsPath, {
    sessionId: request.sessionId,
    cwd,
    decision,
    decidedBy: by,
    note: note ?? undefined,
    targetEventId: request.toolUseEventId,
    requestId,
    ruleIds: request.rules.map((r) => r.id),
  });
  return { ok: true, event, request };
}

/** A human approves or rejects a whole session after the fact. The latest decision wins. */
export function reviewSession(repo: Repository, eventsPath: string | null, cwd: string, sessionId: string, decision: "approved" | "rejected", options: { by?: string; note?: string | null } = {}): ApprovalEvent | null {
  if (!repo.getSession(sessionId)) return null;
  return recordApprovalEvent(repo, eventsPath, {
    sessionId,
    cwd,
    decision,
    decidedBy: cleanWho(options.by, "reviewer"),
    note: cleanNote(options.note),
    targetSessionId: sessionId,
  });
}

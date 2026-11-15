import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Repository, openDb, redactString, sanitize, transaction } from "@ard/core";
import { validateEvent, type ArdEvent } from "@ard/schema";
import type { ControlStore } from "./control.js";
import { CloudError } from "./errors.js";

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Limits on what one request may carry. */
export const INGEST_LIMITS = {
  maxEvents: 500,
  /** One event, serialized. The CLI already caps text at 64 KiB per field. */
  maxEventBytes: 256 * 1024,
  /** A whole request body. */
  maxBodyBytes: 4 * 1024 * 1024,
  /** Per organization, unless the operator sets ARD_CLOUD_MAX_ORG_BYTES. */
  defaultOrgQuotaBytes: 1024 * 1024 * 1024,
} as const;

/**
 * One SQLite file per organization, holding that organization's synced sessions with the very same schema and
 * queries the local review UI uses. Separate files make tenant isolation structural: there is no query that could
 * leak another organization's rows, because they are not in the same file.
 */
export class Workspaces {
  constructor(private readonly dataDir: string) {}

  open(orgId: string): Repository {
    if (!ORG_ID.test(orgId)) throw new CloudError("bad_request", "Invalid organization id.");
    const dir = join(this.dataDir, "orgs", orgId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return new Repository(openDb(join(dir, "workspace.db")));
  }

  with<T>(orgId: string, fn: (repo: Repository) => T): T {
    const repo = this.open(orgId);
    try {
      return fn(repo);
    } finally {
      repo.close();
    }
  }
}

/**
 * Defence in depth: the CLI redacts before it uploads, but the server cannot assume every client is the current CLI.
 * Strings go through the same redaction again; structured fields (`input`, `output`, ...) go through the same deep
 * `sanitize` the local recorder uses, which also drops values under secret-looking names (`api_key`, `password`, ...)
 * and caps depth and size. Those values are not "token-shaped" text, so string redaction alone would keep them.
 */
export function prepareEventForStorage(event: ArdEvent): ArdEvent {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined) continue;
    out[key] = typeof value === "string" ? redactString(value) : typeof value === "object" && value !== null ? sanitize(value) : value;
  }
  return out as unknown as ArdEvent;
}

export interface IngestResult {
  accepted: number;
  /** Already stored (a re-upload). Harmless. */
  duplicates: number;
  /** Review decisions on whole sessions cannot be uploaded: only reviewers in the cloud UI may make those. */
  droppedReviews: number;
  rejected: Array<{ index: number; reason: string }>;
}

export interface IngestInput {
  orgId: string;
  userId: string;
  events: unknown[];
  quotaBytes?: number;
}

/**
 * Store events a member uploaded from `ard sync`.
 *  - Each event is validated; bad ones are reported, good ones still go in.
 *  - A session belongs to whoever uploaded it first: nobody else can add events to it (no tampering with a colleague's trail).
 *  - Whole-session review decisions are refused: otherwise any member could forge a reviewer's approval.
 *  - Uploading the same event again is harmless (ids are unique).
 */
export function ingestEvents(control: ControlStore, workspaces: Workspaces, input: IngestInput): IngestResult {
  if (!Array.isArray(input.events)) throw new CloudError("bad_request", "`events` must be an array.");
  if (input.events.length > INGEST_LIMITS.maxEvents) throw new CloudError("too_large", `At most ${INGEST_LIMITS.maxEvents} events per request.`);

  const result: IngestResult = { accepted: 0, duplicates: 0, droppedReviews: 0, rejected: [] };
  const candidates: Array<{ event: ArdEvent; bytes: number }> = [];

  input.events.forEach((raw, index) => {
    const checked = validateEvent(raw);
    if (!checked.ok) return void result.rejected.push({ index, reason: checked.error });
    if (checked.event.type === "approval" && checked.event.targetSessionId) return void result.droppedReviews++;
    // Pictures cannot be redacted, and the image bytes are not part of an upload anyway: a screenshot event here would be a broken link.
    if (checked.event.type === "screenshot") return void result.rejected.push({ index, reason: "screenshots are not synced; they stay on the machine that recorded them" });
    const event = prepareEventForStorage(checked.event);
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > INGEST_LIMITS.maxEventBytes) return void result.rejected.push({ index, reason: "event is too large" });
    const owner = control.sessionOwner(input.orgId, event.sessionId);
    if (owner !== null && owner !== input.userId) return void result.rejected.push({ index, reason: "this session was uploaded by another member" });
    candidates.push({ event, bytes });
  });

  const org = control.getOrg(input.orgId);
  const quota = input.quotaBytes ?? INGEST_LIMITS.defaultOrgQuotaBytes;

  // Everything below is one transaction on the workspace file. Order matters: store, then check the quota against what
  // was NEWLY stored (events we already hold cost nothing, so a re-upload near the limit still works), and only then
  // claim the sessions. A refused upload throws here, rolls every insert back, and leaves no session claimed.
  workspaces.with(input.orgId, (repo) => {
    transaction(repo.db, () => {
      let stored = 0;
      const sessions = new Set<string>();
      for (const { event, bytes } of candidates) {
        if (repo.insertEvent(event)) {
          result.accepted++;
          stored += bytes;
        } else result.duplicates++;
        sessions.add(event.sessionId);
      }
      if (org && org.storedBytes + stored > quota) throw new CloudError("too_large", "This organization has reached its storage limit.");
      for (const sessionId of sessions) control.claimSession(input.orgId, sessionId, input.userId);
      if (stored > 0) control.addStoredBytes(input.orgId, stored);
    });
  });
  return result;
}

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Repository, openDb, redactString, transaction } from "@ard/core";
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
 * Defence in depth: the CLI redacts before it uploads, but the server cannot assume every client is the
 * current CLI. Run every string through the same redaction again before it is stored.
 */
export function prepareEventForStorage(event: ArdEvent): ArdEvent {
  return JSON.parse(JSON.stringify(event, (_key, value: unknown) => (typeof value === "string" ? redactString(value) : value))) as ArdEvent;
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
  const toStore: Array<{ event: ArdEvent; bytes: number }> = [];

  input.events.forEach((raw, index) => {
    const checked = validateEvent(raw);
    if (!checked.ok) return void result.rejected.push({ index, reason: checked.error });
    if (checked.event.type === "approval" && checked.event.targetSessionId) return void result.droppedReviews++;
    const event = prepareEventForStorage(checked.event);
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > INGEST_LIMITS.maxEventBytes) return void result.rejected.push({ index, reason: "event is too large" });
    if (!control.claimSession(input.orgId, event.sessionId, input.userId)) return void result.rejected.push({ index, reason: "this session was uploaded by another member" });
    toStore.push({ event, bytes });
  });

  const org = control.getOrg(input.orgId);
  const quota = input.quotaBytes ?? INGEST_LIMITS.defaultOrgQuotaBytes;
  const incoming = toStore.reduce((sum, e) => sum + e.bytes, 0);
  if (org && org.storedBytes + incoming > quota) throw new CloudError("too_large", "This organization has reached its storage limit.");

  workspaces.with(input.orgId, (repo) => {
    transaction(repo.db, () => {
      let stored = 0;
      for (const { event, bytes } of toStore) {
        if (repo.insertEvent(event)) {
          result.accepted++;
          stored += bytes;
        } else result.duplicates++;
      }
      if (stored > 0) control.addStoredBytes(input.orgId, stored);
    });
  });
  return result;
}

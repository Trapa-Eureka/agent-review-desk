import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ardDirFor, eventsPathFor, findProjectRoot } from "@ard/core";
import { validateEvent, type ArdEvent } from "@ard/schema";
import { CloudHttpError, cloudRequest } from "./client.js";
import { requireToken, type AccountIo } from "./account.js";

/** Matches the server's per-request limits (INGEST_LIMITS), with headroom for the JSON envelope. */
export const BATCH_MAX_EVENTS = 500;
export const BATCH_MAX_BYTES = 3 * 1024 * 1024;

export interface SyncOptions {
  cwd: string;
  server: string;
  /** Organization address. Optional only when the account has exactly one. */
  org?: string;
  /** Consent to upload to this organization for the first time. */
  yes: boolean;
  dryRun: boolean;
}

interface SyncState {
  version: 1;
  /** `<server>|<org>` -> how many bytes of events.jsonl have been handled. */
  targets: Record<string, { offset: number; consentedAt: string }>;
}

const statePath = (root: string, env: NodeJS.ProcessEnv) => join(ardDirFor(root, env), "cloud-sync.json");

function readState(path: string): SyncState {
  if (!existsSync(path)) return { version: 1, targets: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SyncState>;
    if (typeof parsed.targets === "object" && parsed.targets !== null) return { version: 1, targets: parsed.targets };
  } catch {
    // fall through
  }
  throw new Error(`${path} is damaged. Delete it to upload everything again (the server ignores events it already has).`);
}

function writeState(path: string, state: SyncState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export interface Pending {
  /** Valid events, each with the byte offset just after its line. */
  events: Array<{ event: ArdEvent; endOffset: number; bytes: number }>;
  /** Lines that were skipped (not JSON, or not a valid event). */
  invalid: number;
  /** Screenshot events. They are never uploaded: pictures cannot be redacted, so they stay on this machine. */
  screenshots: number;
  /** Byte offset after the last complete line read (where to continue next time). */
  endOffset: number;
}

/**
 * Read what has been recorded since `offset`. Only complete lines count: a hook may be mid-write on the last one, and
 * it will be picked up by the next sync. Offsets are in BYTES, so multi-byte text cannot throw them off.
 */
export function readPending(eventsPath: string, offset: number): Pending {
  if (!existsSync(eventsPath)) return { events: [], invalid: 0, screenshots: 0, endOffset: offset };
  const size = statSync(eventsPath).size;
  const start = size < offset ? 0 : offset; // the log was replaced or cleared: start again (the server ignores duplicates)
  if (size === start) return { events: [], invalid: 0, screenshots: 0, endOffset: start };
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(eventsPath, "r");
  let read = 0;
  try {
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  const events: Pending["events"] = [];
  let invalid = 0;
  let screenshots = 0;
  let lineStart = 0;
  for (let i = 0; i < read; i++) {
    if (buffer[i] !== 0x0a) continue;
    const raw = buffer.subarray(lineStart, i).toString("utf8").trim();
    const endOffset = start + i + 1;
    if (raw !== "") {
      try {
        const checked = validateEvent(JSON.parse(raw));
        if (checked.ok && checked.event.type === "screenshot") screenshots++;
        else if (checked.ok) events.push({ event: checked.event, endOffset, bytes: i - lineStart + 1 });
        else invalid++;
      } catch {
        invalid++;
      }
    }
    lineStart = i + 1;
  }
  return { events, invalid, screenshots, endOffset: start + lineStart };
}

/** Split events into requests that respect the server's limits. */
export function batches(events: Pending["events"]): Array<Pending["events"]> {
  const out: Array<Pending["events"]> = [];
  let current: Pending["events"] = [];
  let bytes = 0;
  for (const item of events) {
    if (current.length > 0 && (current.length >= BATCH_MAX_EVENTS || bytes + item.bytes > BATCH_MAX_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += item.bytes;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function summarize(events: Pending["events"]): string {
  const counts = new Map<string, number>();
  for (const { event } of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  const sessions = new Set(events.map((e) => e.event.sessionId)).size;
  const kinds = [...counts.entries()].map(([type, n]) => `${n} ${type}`).join(", ");
  return `${events.length} events from ${sessions} session${sessions === 1 ? "" : "s"} (${kinds})`;
}

/**
 * `ard sync`: upload what was recorded since the last sync to a team workspace.
 *
 * Consent comes first: the log holds code diffs and command output, and uploading sends them to another computer.
 * Nothing leaves this machine until the person has seen what would be sent and passed --yes for that organization.
 */
export async function runSync(io: AccountIo, options: SyncOptions): Promise<number> {
  const root = findProjectRoot(options.cwd);
  const eventsPath = eventsPathFor(root, io.env);
  const path = statePath(root, io.env);
  const state = readState(path);
  const target = (slug: string) => `${options.server}|${slug}`;

  // Which organization? Ask the server when the person did not say.
  let slug = options.org;
  let token = "";
  if (!options.dryRun || !slug) {
    token = requireToken(io.env, options.server);
  }
  if (!slug) {
    const me = await cloudRequest(io.fetch, options.server, "/api/v1/me", { token });
    const orgs = (Array.isArray(me.organizations) ? me.organizations : []) as Array<{ slug: string }>;
    if (orgs.length === 0) throw new CloudHttpError(null, "You do not belong to an organization yet. Create or join one in the browser first.");
    if (orgs.length > 1) throw new CloudHttpError(null, `You belong to several organizations (${orgs.map((o) => o.slug).join(", ")}). Choose one with --org <slug>.`);
    slug = orgs[0]!.slug;
  }

  const known = state.targets[target(slug)];
  const pending = readPending(eventsPath, known?.offset ?? 0);
  const where = `"${slug}" at ${options.server}`;
  const staysHere = pending.screenshots > 0 ? ` ${pending.screenshots} screenshot${pending.screenshots === 1 ? "" : "s"} stay${pending.screenshots === 1 ? "s" : ""} on this machine (pictures cannot be redacted, so they are never uploaded).` : "";

  if (pending.events.length === 0) {
    io.out((pending.invalid > 0 ? `Nothing new to upload to ${where} (${pending.invalid} unreadable line(s) were skipped).` : `Nothing new to upload to ${where}.`) + staysHere);
    return 0;
  }
  io.out(`${summarize(pending.events)} to upload to ${where}.${staysHere}`);

  if (options.dryRun) {
    io.out("Dry run: nothing was sent. Secrets were already redacted when this was recorded, and the server redacts again.");
    return 0;
  }
  if (!known && !options.yes) {
    io.err(`This sends command output and file diffs from this project to ${options.server}, where everyone in "${slug}" can read them.\nSee exactly what would go with --dry-run. To go ahead, run again with --yes.`);
    return 1;
  }

  let offset = known?.offset ?? 0;
  const consentedAt = known?.consentedAt ?? io.now().toISOString();
  let accepted = 0;
  let duplicates = 0;
  let droppedReviews = 0;
  const rejected: string[] = [];

  try {
    for (const batch of batches(pending.events)) {
      const result = await cloudRequest(io.fetch, options.server, `/api/v1/orgs/${encodeURIComponent(slug)}/events`, { method: "POST", token, body: { events: batch.map((b) => b.event) }, timeoutMs: 60_000 });
      accepted += Number(result.accepted ?? 0);
      duplicates += Number(result.duplicates ?? 0);
      droppedReviews += Number(result.droppedReviews ?? 0);
      for (const r of (Array.isArray(result.rejected) ? result.rejected : []) as Array<{ reason?: string }>) rejected.push(String(r.reason ?? "rejected"));
      // This batch is handled (stored, a duplicate, or refused for good). Remember it so an interruption loses nothing.
      offset = batch[batch.length - 1]!.endOffset;
      state.targets[target(slug)] = { offset, consentedAt };
      writeState(path, state);
    }
    // Lines that were not valid events at the end of the log are skipped for good.
    state.targets[target(slug)] = { offset: pending.endOffset, consentedAt };
    writeState(path, state);
  } catch (error) {
    if (error instanceof CloudHttpError) {
      const progress = accepted + duplicates > 0 ? ` (${accepted} events were uploaded before this; the rest will go next time)` : "";
      if (error.status === 401) throw new CloudHttpError(401, `The server did not accept your login. Run: ard login${progress}`);
      if (error.status === 402) throw new CloudHttpError(402, `${error.message}${progress}`);
      if (error.status === 429) throw new CloudHttpError(429, `${error.message}${error.retryAfter ? ` Try again in ${error.retryAfter}s.` : ""}${progress}`);
      throw new CloudHttpError(error.status, `${error.message}${progress}`, error.code);
    }
    throw error;
  }

  io.out(`Uploaded ${accepted} new event${accepted === 1 ? "" : "s"} to ${where}${duplicates > 0 ? `; ${duplicates} were already there` : ""}.`);
  if (droppedReviews > 0) io.out(`${droppedReviews} review decision(s) were not uploaded: only reviewers in the cloud can review.`);
  if (rejected.length > 0) io.err(`${rejected.length} event(s) were refused by the server, for example: ${[...new Set(rejected)].slice(0, 3).join("; ")}.`);
  if (pending.invalid > 0) io.err(`${pending.invalid} unreadable line(s) in the log were skipped.`);
  return rejected.length > 0 ? 1 : 0;
}

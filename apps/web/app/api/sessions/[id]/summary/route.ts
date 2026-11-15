import { NextResponse } from "next/server";
import { NO_KEY_MESSAGE, SummaryError, buildDigest, clientFromKey, requestSummary, resolveApiKey, summaryConfig, type SummaryErrorCode } from "@ard/summary";
import { readJsonBody, withProject } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * AI summary of one session, with the person's API key (BYOK).
 *
 *  GET   shows exactly what WOULD be sent (nothing leaves the machine), where it would go, and with which model.
 *  POST  sends it, but only for the exact text that was previewed: the request must carry that text's SHA-256, so a session
 *        that changed in between has to be previewed again.
 *
 * The key comes from this process's environment (ANTHROPIC_API_KEY, from the terminal that started `ard review`) or, if
 * that is not set, from the OS keychain (`ard key set`). It is read only when a summary is actually sent, and is never
 * stored by this code, logged, put in a URL or returned. Like every /api route, this one sits behind the UI's middleware (token
 * cookie, Host and same-origin checks).
 */

const DESTINATION = "api.anthropic.com";
const COOLDOWN_MS = 3_000;
let inFlight = false;
let lastSentAt = 0;

function digestFor(sessionId: string) {
  const events = withProject(({ repo }) => (repo.getSession(sessionId) ? repo.sessionEvents(sessionId) : null));
  return events ? buildDigest(events) : null;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const digest = digestFor(id);
  if (!digest) return NextResponse.json({ error: "No such session." }, { status: 404 });
  const config = summaryConfig(process.env);
  return NextResponse.json({
    available: config.available,
    keySource: config.source,
    model: config.model,
    ...(config.warning ? { warning: config.warning } : {}),
    destination: DESTINATION,
    stats: digest.stats,
    digest: digest.text,
    sha256: digest.sha256,
  });
}

const STATUS: Record<SummaryErrorCode, number> = { no_key: 400, auth: 502, rate_limited: 429, bad_request: 502, unavailable: 502, refused: 422, empty: 502 };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await readJsonBody(request);
  if (!body || body.confirm !== true || typeof body.sha256 !== "string") {
    return NextResponse.json({ error: 'Body must be {"confirm":true,"sha256":"<hash of the previewed text>"}.' }, { status: 400 });
  }
  const config = summaryConfig(process.env);
  if (!config.available) return NextResponse.json({ error: NO_KEY_MESSAGE, code: "no_key" }, { status: 400 });

  const digest = digestFor(id);
  if (!digest) return NextResponse.json({ error: "No such session." }, { status: 404 });
  if (digest.sha256 !== body.sha256) return NextResponse.json({ error: "The session changed after you previewed it. Open the preview again to see what would be sent.", code: "changed" }, { status: 409 });

  // One request at a time, and not in a tight loop: this spends the person's own money.
  const now = Date.now();
  if (inFlight || now - lastSentAt < COOLDOWN_MS) return NextResponse.json({ error: "A summary is already being made. Wait a moment.", code: "busy" }, { status: 429 });
  inFlight = true;
  lastSentAt = now;
  try {
    const resolved = resolveApiKey(process.env);
    if (!resolved) return NextResponse.json({ error: NO_KEY_MESSAGE, code: "no_key" }, { status: 400 });
    const result = await requestSummary({ digest: digest.text, model: config.model, client: clientFromKey(resolved.key), key: resolved.key });
    return NextResponse.json({ summary: result.text, model: result.model, usage: result.usage, truncated: result.truncated });
  } catch (error) {
    if (error instanceof SummaryError) return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] });
    console.error(`[ard review] summary failed: ${error instanceof Error ? error.name : "unknown error"}`); // the name only: never the message, which could echo input
    return NextResponse.json({ error: "The summary failed unexpectedly." }, { status: 500 });
  } finally {
    inFlight = false;
  }
}

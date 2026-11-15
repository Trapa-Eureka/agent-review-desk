import { NextResponse } from "next/server";
import { decideRequest } from "@ard/core";
import { parseDecision, readJsonBody, withProject } from "../../../../lib/server";

export const dynamic = "force-dynamic";

/** A reviewer approves or rejects a pending request that an agent's hook is waiting on. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await readJsonBody(request);
  const parsed = body ? parseDecision(body) : null;
  if (!parsed) return NextResponse.json({ error: 'Body must be {"decision":"approved"|"rejected","note"?:string}.' }, { status: 400 });

  const result = withProject(({ root, repo, eventsPath }) => decideRequest(repo, eventsPath, root, id, parsed.decision, { by: "reviewer", note: parsed.note }));
  if (result.ok) return NextResponse.json({ ok: true, decision: parsed.decision });
  if (result.reason === "not-found") return NextResponse.json({ error: "No such approval request." }, { status: 404 });
  const message = result.reason === "expired" ? "This request already expired; the agent was told it was not approved." : "Someone already decided this request.";
  return NextResponse.json({ error: message, reason: result.reason }, { status: 409 });
}

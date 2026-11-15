import { NextResponse } from "next/server";
import { reviewSession } from "@ard/core";
import { parseDecision, readJsonBody, withProject } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/** A reviewer approves or rejects a whole session after the fact. The latest decision is the one shown. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await readJsonBody(request);
  const parsed = body ? parseDecision(body) : null;
  if (!parsed) return NextResponse.json({ error: 'Body must be {"decision":"approved"|"rejected","note"?:string}.' }, { status: 400 });

  const event = withProject(({ root, repo, eventsPath }) => reviewSession(repo, eventsPath, root, id, parsed.decision, { by: "reviewer", note: parsed.note }));
  if (!event) return NextResponse.json({ error: "No such session." }, { status: 404 });
  return NextResponse.json({ ok: true, decision: parsed.decision });
}

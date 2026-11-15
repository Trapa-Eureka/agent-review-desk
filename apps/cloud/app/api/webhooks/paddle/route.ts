import { handleWebhook } from "../../../../lib/webhook";

export const dynamic = "force-dynamic";

/** Paddle webhook endpoint. See lib/webhook.ts for the rules. */
export function POST(request: Request) {
  return handleWebhook(request, "paddle", "Paddle");
}

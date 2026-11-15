import { handleWebhook } from "../../../../lib/webhook";

export const dynamic = "force-dynamic";

/** Dodo Payments webhook endpoint. See lib/webhook.ts for the rules. */
export function POST(request: Request) {
  return handleWebhook(request, "dodo", "Dodo Payments");
}

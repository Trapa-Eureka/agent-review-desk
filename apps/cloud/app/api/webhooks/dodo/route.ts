import { WebhookVerificationError } from "@ard/billing";
import { applyBillingEvent } from "@ard/cloud";
import { getCloud } from "../../../../lib/cloud";
import { api, json, readText } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** Dodo Payments webhook endpoint (Standard Webhooks). Same rules as the Paddle one: verify the raw bytes, then apply. */
export function POST(request: Request) {
  return api(async () => {
    const cloud = getCloud();
    const provider = cloud.providers.get("dodo");
    if (!provider) return json({ error: "Dodo Payments is not configured on this server." }, 404);
    const raw = await readText(request, 1024 * 1024);
    let event;
    try {
      event = provider.verifyWebhook(raw, request.headers);
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        console.warn(`[ard-cloud] rejected a Dodo webhook: ${error.code}`);
        return json({ error: "Invalid webhook." }, error.code === "not_configured" ? 503 : 400);
      }
      throw error;
    }
    const outcome = applyBillingEvent(cloud.control, event);
    return json({ ok: true, outcome: outcome.status });
  });
}

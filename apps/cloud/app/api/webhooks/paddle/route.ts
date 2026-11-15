import { WebhookVerificationError } from "@ard/billing";
import { applyBillingEvent } from "@ard/cloud";
import { getCloud } from "../../../../lib/cloud";
import { api, json, readText } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/**
 * Paddle notification destination. The signature is checked against the EXACT bytes received, so the body is read
 * as text before anything parses it. Anything that is not a valid signature gets 400 and changes nothing; every valid
 * event gets 200 (including ones that belong to other products), because a non-2xx makes Paddle retry for days.
 */
export function POST(request: Request) {
  return api(async () => {
    const cloud = getCloud();
    const provider = cloud.providers.get("paddle");
    if (!provider) return json({ error: "Paddle is not configured on this server." }, 404);
    const raw = await readText(request, 1024 * 1024);
    let event;
    try {
      event = provider.verifyWebhook(raw, request.headers);
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        console.warn(`[ard-cloud] rejected a Paddle webhook: ${error.code}`);
        return json({ error: "Invalid webhook." }, error.code === "not_configured" ? 503 : 400);
      }
      throw error;
    }
    const outcome = applyBillingEvent(cloud.control, event);
    return json({ ok: true, outcome: outcome.status });
  });
}

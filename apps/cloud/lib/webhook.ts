import { WebhookVerificationError, type ProviderId } from "@ard/billing";
import { applyBillingEvent, webhookHttpStatus } from "@ard/cloud";
import { getCloud } from "./cloud";
import { api, json, readText } from "./http";

/**
 * Shared body of the Paddle and Dodo webhook endpoints. The signature is checked against the EXACT bytes received, so the
 * body is read as text before anything parses it. Anything that is not a valid signature gets 400 and changes nothing.
 * Every valid event gets 200 (including ones that belong to other products, and stale or duplicate ones), because a
 * non-2xx makes the provider retry for days. The one exception is a `conflict` (a subscription claimed by two
 * organizations): that is answered 409 so it shows up as a failed delivery in the provider's dashboard, where a human will see it.
 */
export function handleWebhook(request: Request, providerId: ProviderId, label: string): Promise<Response> {
  return api(async () => {
    const cloud = getCloud();
    const provider = cloud.providers.get(providerId);
    if (!provider) return json({ error: `${label} is not configured on this server.` }, 404);
    const raw = await readText(request, 1024 * 1024);
    let event;
    try {
      event = provider.verifyWebhook(raw, request.headers);
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        console.warn(`[ard-cloud] rejected a ${label} webhook: ${error.code}`);
        return json({ error: "Invalid webhook." }, error.code === "not_configured" ? 503 : 400);
      }
      throw error;
    }
    const outcome = applyBillingEvent(cloud.control, event);
    if (outcome.status === "conflict") console.error(`[ard-cloud] ${label} webhook conflict: a subscription is claimed by two organizations (see the audit log)`);
    return json({ ok: outcome.status !== "conflict", outcome: outcome.status }, webhookHttpStatus(outcome));
  });
}

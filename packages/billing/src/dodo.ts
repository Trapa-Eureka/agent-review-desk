import { asRecord, asString, callJson, hmacSha256, safeEqual, withinTolerance, type FetchLike } from "./http.js";
import {
  BillingApiError,
  WebhookVerificationError,
  type BillingEvent,
  type BillingProvider,
  type CheckoutInput,
  type CheckoutResult,
  type HeaderBag,
  type PortalInput,
  type SubscriptionSnapshot,
  type SubscriptionStatus,
} from "./types.js";

/**
 * Dodo Payments. Contract verified against docs.dodopayments.com (Nov 2026):
 *  - Webhooks follow the Standard Webhooks spec: headers webhook-id, webhook-timestamp, webhook-signature.
 *    Signed content `<id>.<timestamp>.<raw body>`, HMAC-SHA256, base64. The secret is `whsec_<base64>`: strip
 *    the prefix and base64-decode it. The signature header holds one or more space-separated `v1,<base64>`.
 *  - New subscriptions are created through `POST /checkouts` (the older `POST /subscriptions` is deprecated).
 *  - Customer portal: `POST /customers/{id}/customer-portal/session` -> { link }.
 *  - Our `metadata` comes back as `data.metadata` on subscription webhooks (propagation is implied by their
 *    examples rather than stated, so a missing nonce is handled, see `snapshotFrom` and the cloud's fallbacks).
 */

export const DODO_HOSTS = { test_mode: "https://test.dodopayments.com", live_mode: "https://live.dodopayments.com" } as const;
/** The Standard Webhooks libraries allow 5 minutes. */
export const DODO_TOLERANCE_MS = 5 * 60 * 1000;

export interface DodoConfig {
  apiKey: string;
  /** `whsec_…` from the webhook endpoint's settings. */
  webhookSecret: string;
  environment: "test_mode" | "live_mode";
  /** Product id of the monthly Team subscription. */
  productId: string;
  fetch?: FetchLike;
  toleranceMs?: number;
}

const STATUS: Record<string, SubscriptionStatus> = {
  pending: "incomplete",
  active: "active",
  on_hold: "past_due",
  paused: "paused",
  cancelled: "canceled",
  canceled: "canceled",
  expired: "expired",
  failed: "expired",
};

/** Used only when the payload has no usable `status`: infer it from the event name. */
const STATUS_BY_EVENT: Record<string, SubscriptionStatus> = {
  "subscription.active": "active",
  "subscription.renewed": "active",
  "subscription.unpaused": "active",
  "subscription.plan_changed": "active",
  "subscription.past_due": "past_due",
  "subscription.on_hold": "past_due",
  "subscription.paused": "paused",
  "subscription.cancelled": "canceled",
  "subscription.expired": "expired",
  "subscription.failed": "expired",
};

/** The raw HMAC key for a Standard Webhooks secret. */
export function dodoSecretKey(secret: string): Buffer {
  return Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
}

/** Compute the signature header Dodo would send. Used by tests and the local webhook simulator only. */
export function signDodoWebhook(secret: string, id: string, timestampSeconds: number, rawBody: string): string {
  return `v1,${hmacSha256(dodoSecretKey(secret), `${id}.${timestampSeconds}.${rawBody}`, "base64")}`;
}

function snapshotFrom(type: string, data: Record<string, unknown>): SubscriptionSnapshot | null {
  const subscriptionId = asString(data.subscription_id);
  if (!subscriptionId) return null;
  const status = STATUS[String(data.status)] ?? STATUS_BY_EVENT[type] ?? "paused"; // unknown -> no access
  return {
    provider: "dodo",
    subscriptionId,
    customerId: asString(asRecord(data.customer).customer_id),
    status,
    currentPeriodEnd: asString(data.next_billing_date) ?? asString(data.expires_at),
    cancelAtPeriodEnd: data.cancel_at_next_billing_date === true,
    checkoutNonce: asString(asRecord(data.metadata).ard_checkout),
    transactionId: null,
    planRef: asString(data.product_id),
  };
}

export class DodoProvider implements BillingProvider {
  readonly id = "dodo" as const;
  readonly label = "Dodo Payments";
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: DodoConfig) {
    this.fetchImpl = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  verifyWebhook(rawBody: string, headers: HeaderBag, now: Date = new Date()): BillingEvent {
    if (!this.config.webhookSecret) throw new WebhookVerificationError("not_configured", "Dodo webhook secret is not configured");
    const id = headers.get("webhook-id");
    const timestamp = headers.get("webhook-timestamp");
    const signature = headers.get("webhook-signature");
    if (!id || !timestamp || !signature) throw new WebhookVerificationError("missing_header", "webhook-id, webhook-timestamp or webhook-signature is missing");
    if (!/^\d{1,12}$/.test(timestamp)) throw new WebhookVerificationError("bad_format", "webhook-timestamp is malformed");
    if (!withinTolerance(Number(timestamp), now, this.config.toleranceMs ?? DODO_TOLERANCE_MS)) throw new WebhookVerificationError("stale", "webhook timestamp is outside the allowed window");

    const expected = hmacSha256(dodoSecretKey(this.config.webhookSecret), `${id}.${timestamp}.${rawBody}`, "base64");
    let matched = false;
    for (const entry of signature.split(" ")) {
      const comma = entry.indexOf(",");
      if (comma === -1 || entry.slice(0, comma) !== "v1") continue; // only v1 is defined; ignore anything else
      matched = safeEqual(expected, entry.slice(comma + 1)) || matched;
    }
    if (!matched) throw new WebhookVerificationError("bad_signature", "webhook signature does not match");

    let body: Record<string, unknown>;
    try {
      body = asRecord(JSON.parse(rawBody));
    } catch {
      throw new WebhookVerificationError("bad_body", "webhook body is not valid JSON");
    }
    const type = asString(body.type);
    if (!type) throw new WebhookVerificationError("bad_body", "webhook has no event type");
    const stamped = asString(body.timestamp);
    const occurredAt = stamped && !Number.isNaN(Date.parse(stamped)) ? new Date(stamped).toISOString() : new Date(Number(timestamp) * 1000).toISOString();
    const subscription = type.startsWith("subscription.") ? snapshotFrom(type, asRecord(body.data)) : null;
    return { provider: "dodo", eventId: id, type, occurredAt, subscription };
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const json = asRecord(
      await callJson("dodo", this.fetchImpl, `${DODO_HOSTS[this.config.environment]}/checkouts`, this.config.apiKey, "POST", {
        product_cart: [{ product_id: this.config.productId, quantity: 1 }],
        ...(input.email ? { customer: { email: input.email, ...(input.name ? { name: input.name } : {}) } } : {}),
        return_url: input.returnUrl,
        metadata: { ard_checkout: input.nonce },
      }),
    );
    const url = asString(json.checkout_url);
    if (!url) throw new BillingApiError("dodo", null, "Dodo created the checkout session but returned no checkout_url");
    return { url, reference: asString(json.session_id) };
  }

  async createPortalSession(input: PortalInput): Promise<{ url: string }> {
    const query = new URLSearchParams({ return_url: input.returnUrl });
    const json = asRecord(await callJson("dodo", this.fetchImpl, `${DODO_HOSTS[this.config.environment]}/customers/${encodeURIComponent(input.customerId)}/customer-portal/session?${query.toString()}`, this.config.apiKey, "POST"));
    const url = asString(json.link);
    if (!url) throw new BillingApiError("dodo", null, "Dodo returned no customer portal link");
    return { url };
  }
}

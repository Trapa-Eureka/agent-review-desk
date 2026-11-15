import { API_TIMEOUT_MS, asRecord, asString, callJson, hmacSha256, safeEqual, withinTolerance, type FetchLike } from "./http.js";
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
 * Paddle Billing. Contract verified against developer.paddle.com (Nov 2026):
 *  - Webhook header  `Paddle-Signature: ts=<unix>;h1=<hex>` (several h1 during secret rotation).
 *  - Signed payload  `<ts>:<raw body>`, HMAC-SHA256 with the endpoint secret as the key, hex digest.
 *  - Delivery is at-least-once and unordered: dedupe on event_id, compare occurred_at.
 *  - A checkout link is `POST /transactions` -> data.checkout.url. It only opens if the account's default
 *    payment link points at an approved page that includes Paddle.js (the cloud app serves /pay for that).
 *  - Customer portal: `POST /customers/{id}/portal-sessions` -> data.urls.
 */

export const PADDLE_HOSTS = { sandbox: "https://sandbox-api.paddle.com", production: "https://api.paddle.com" } as const;

/** Paddle's SDKs reject events older than 5 s. We allow 5 min: clocks drift, and replays are already harmless (event_id dedupe). */
export const PADDLE_TOLERANCE_MS = 5 * 60 * 1000;

export interface PaddleConfig {
  apiKey: string;
  /** The notification destination's secret key (`pdl_ntfset_…`). Sandbox and live have different ones. */
  webhookSecret: string;
  environment: "sandbox" | "production";
  /** Price id (`pri_…`) of the monthly Team plan. */
  priceId: string;
  fetch?: FetchLike;
  toleranceMs?: number;
}

const STATUS: Record<string, SubscriptionStatus> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  paused: "paused",
  canceled: "canceled",
};

/** Split `ts=…;h1=…;h1=…` into its parts. Unknown keys are ignored; order does not matter. */
export function parsePaddleSignature(header: string): { ts: string; h1: string[] } {
  let ts = "";
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "ts") ts = value;
    else if (key === "h1" && value !== "") h1.push(value);
  }
  if (!/^\d{1,12}$/.test(ts) || h1.length === 0) throw new WebhookVerificationError("bad_format", "Paddle-Signature is malformed");
  return { ts, h1 };
}

/** Compute the header Paddle would send. Used by tests and the local webhook simulator, never by the server path. */
export function signPaddleWebhook(secret: string, rawBody: string, timestampSeconds: number): string {
  return `ts=${timestampSeconds};h1=${hmacSha256(secret, `${timestampSeconds}:${rawBody}`, "hex")}`;
}

function snapshotFrom(data: Record<string, unknown>): SubscriptionSnapshot | null {
  const subscriptionId = asString(data.id);
  if (!subscriptionId) return null;
  const period = asRecord(data.current_billing_period);
  const change = asRecord(data.scheduled_change);
  const firstItem = asRecord(Array.isArray(data.items) ? data.items[0] : null);
  const custom = asRecord(data.custom_data);
  // An unknown status is treated as "no access" rather than crashing the handler or guessing generously.
  const status = STATUS[String(data.status)] ?? "paused";
  return {
    provider: "paddle",
    subscriptionId,
    customerId: asString(data.customer_id),
    status,
    currentPeriodEnd: asString(period.ends_at) ?? asString(change.effective_at),
    cancelAtPeriodEnd: change.action === "cancel",
    checkoutNonce: asString(custom.ard_checkout),
    transactionId: asString(data.transaction_id),
    planRef: asString(asRecord(firstItem.price).id),
  };
}

export class PaddleProvider implements BillingProvider {
  readonly id = "paddle" as const;
  readonly label = "Paddle";
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: PaddleConfig) {
    this.fetchImpl = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  verifyWebhook(rawBody: string, headers: HeaderBag, now: Date = new Date()): BillingEvent {
    if (!this.config.webhookSecret) throw new WebhookVerificationError("not_configured", "Paddle webhook secret is not configured");
    const header = headers.get("paddle-signature");
    if (!header) throw new WebhookVerificationError("missing_header", "Paddle-Signature header is missing");
    const { ts, h1 } = parsePaddleSignature(header);
    if (!withinTolerance(Number(ts), now, this.config.toleranceMs ?? PADDLE_TOLERANCE_MS)) throw new WebhookVerificationError("stale", "webhook timestamp is outside the allowed window");

    const expected = hmacSha256(this.config.webhookSecret, `${ts}:${rawBody}`, "hex");
    // Compare against every h1 without short-circuiting on the first hit, to keep timing independent of which one matched.
    let matched = false;
    for (const candidate of h1) matched = safeEqual(expected, candidate) || matched;
    if (!matched) throw new WebhookVerificationError("bad_signature", "webhook signature does not match");

    let body: Record<string, unknown>;
    try {
      body = asRecord(JSON.parse(rawBody));
    } catch {
      throw new WebhookVerificationError("bad_body", "webhook body is not valid JSON");
    }
    const eventId = asString(body.event_id);
    const type = asString(body.event_type);
    const occurredAt = asString(body.occurred_at);
    if (!eventId || !type || !occurredAt || Number.isNaN(Date.parse(occurredAt))) throw new WebhookVerificationError("bad_body", "webhook is missing event_id, event_type or occurred_at");
    const subscription = type.startsWith("subscription.") ? snapshotFrom(asRecord(body.data)) : null;
    return { provider: "paddle", eventId, type, occurredAt, subscription };
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const json = asRecord(
      await callJson("paddle", this.fetchImpl, `${PADDLE_HOSTS[this.config.environment]}/transactions`, this.config.apiKey, "POST", {
        items: [{ price_id: this.config.priceId, quantity: 1 }],
        collection_mode: "automatic",
        custom_data: { ard_checkout: input.nonce },
      }),
    );
    const data = asRecord(json.data);
    const url = asString(asRecord(data.checkout).url);
    if (!url) {
      throw new BillingApiError("paddle", null, "Paddle created the transaction but returned no checkout link. Set a default payment link (Paddle > Checkout settings) pointing at this server's /pay page.");
    }
    return { url, reference: asString(data.id) };
  }

  async createPortalSession(input: PortalInput): Promise<{ url: string }> {
    const json = asRecord(
      await callJson("paddle", this.fetchImpl, `${PADDLE_HOSTS[this.config.environment]}/customers/${encodeURIComponent(input.customerId)}/portal-sessions`, this.config.apiKey, "POST", input.subscriptionId ? { subscription_ids: [input.subscriptionId] } : {}),
    );
    const urls = asRecord(asRecord(json.data).urls);
    const first = asRecord(Array.isArray(urls.subscriptions) ? urls.subscriptions[0] : null);
    const url = asString(first.view_subscription) ?? asString(asRecord(urls.general).overview);
    if (!url) throw new BillingApiError("paddle", null, "Paddle returned no customer portal link");
    return { url };
  }
}

export { API_TIMEOUT_MS };

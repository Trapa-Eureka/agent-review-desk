/**
 * Provider-neutral billing model. The cloud server only ever talks to these types, so Paddle and
 * Dodo Payments (and any later provider) are interchangeable behind `BillingProvider`.
 */

export type ProviderId = "paddle" | "dodo";

/**
 * Normalized subscription state. `incomplete` means "created but never paid", and (like `paused`,
 * `canceled`, `expired`) grants no access on its own; see `entitlementFor`.
 */
export type SubscriptionStatus = "incomplete" | "trialing" | "active" | "past_due" | "paused" | "canceled" | "expired";

export interface SubscriptionSnapshot {
  provider: ProviderId;
  subscriptionId: string;
  customerId: string | null;
  status: SubscriptionStatus;
  /** End of the period that is already paid for, when the provider tells us. */
  currentPeriodEnd: string | null;
  /** True when the subscription will stop at the end of the paid period. */
  cancelAtPeriodEnd: boolean;
  /**
   * Our own one-time correlation value, set when WE created the checkout. It is how a webhook is
   * tied to an organization. Never trust an organization id that arrives in a payload.
   */
  checkoutNonce: string | null;
  /** Provider transaction id of the first payment (Paddle), a second way to tie it to our checkout. */
  transactionId: string | null;
  /** Price (Paddle) or product (Dodo) id that was bought. */
  planRef: string | null;
}

export interface BillingEvent {
  provider: ProviderId;
  /** Unique per event; the idempotency key. */
  eventId: string;
  /** The provider's own event name, e.g. "subscription.updated". */
  type: string;
  /** When it happened at the provider (ISO-8601). Compare this, not arrival time, to order events. */
  occurredAt: string;
  /** Present only for events that describe a subscription. Other events are verified but unused. */
  subscription: SubscriptionSnapshot | null;
}

/** Anything with a case-insensitive `get`: a WHATWG `Headers`, or a small wrapper around a plain map. */
export interface HeaderBag {
  get(name: string): string | null;
}

export type WebhookFailure = "missing_header" | "bad_format" | "stale" | "bad_signature" | "bad_body" | "not_configured";

/** Thrown for any webhook that must be rejected. The message is safe to log, never to echo back in detail. */
export class WebhookVerificationError extends Error {
  constructor(
    readonly code: WebhookFailure,
    message: string,
  ) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/** The provider's API said no, or could not be reached. Never contains credentials. */
export class BillingApiError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "BillingApiError";
  }
}

export interface CheckoutInput {
  /** One-time value stored with the checkout record; comes back in the subscription webhooks. */
  nonce: string;
  /** Prefills the checkout where the provider supports it. */
  email?: string;
  name?: string;
  /** Where the provider sends the customer afterwards (Dodo). */
  returnUrl: string;
}

export interface CheckoutResult {
  /** Hosted checkout the browser should be sent to. */
  url: string;
  /** Provider id of the transaction / session that was created. */
  reference: string | null;
}

export interface PortalInput {
  customerId: string;
  subscriptionId?: string;
  returnUrl: string;
}

export interface BillingProvider {
  readonly id: ProviderId;
  /** Human-readable name for buttons. */
  readonly label: string;
  /**
   * Verify the signature of a webhook and normalize it. `rawBody` MUST be the exact bytes received:
   * re-serialized JSON has different whitespace and fails verification.
   * @throws WebhookVerificationError
   */
  verifyWebhook(rawBody: string, headers: HeaderBag, now?: Date): BillingEvent;
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  createPortalSession(input: PortalInput): Promise<{ url: string }>;
}

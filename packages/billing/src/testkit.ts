// Fixtures and helpers for tests only. Payload shapes follow the providers' published webhook examples.
import type { FetchLike } from "./http.js";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stand-in that answers from a queue and records what was sent. */
export function stubFetch(...responses: Array<{ status?: number; json?: unknown; text?: string; throws?: Error }>): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const next = queue.shift() ?? { status: 500, json: { error: "stub exhausted" } };
    if (next.throws) throw next.throws;
    const status = next.status ?? 200;
    const text = next.text ?? (next.json === undefined ? "" : JSON.stringify(next.json));
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  return { fetch, calls };
}

export interface PaddleEventOptions {
  eventId?: string;
  eventType?: string;
  occurredAt?: string;
  status?: string;
  subscriptionId?: string;
  customerId?: string;
  transactionId?: string;
  priceId?: string;
  nonce?: string | null;
  periodEnd?: string | null;
  scheduledChange?: { action: "cancel" | "pause" | "resume"; effective_at: string; resume_at: string | null } | null;
}

/** A subscription webhook in Paddle's documented shape, pretty-printed so that the raw bytes differ from any re-serialization. */
export function paddleSubscriptionEvent(o: PaddleEventOptions = {}): string {
  const status = o.status ?? "active";
  const periodEnd = o.periodEnd === undefined ? "2026-12-15T10:00:00.000000Z" : o.periodEnd;
  const item = {
    price: {
      id: o.priceId ?? "pri_01gsz8x8sawmvhz1pv30nge1ke",
      name: "Team monthly",
      type: "standard",
      status: "active",
      quantity: { maximum: 1, minimum: 1 },
      tax_mode: "account_setting",
      created_at: "2026-01-01T00:00:00.000000Z",
      product_id: "pro_01gsz4t5hdjse780zja8vvr7jg",
      unit_price: { amount: "4900", currency_code: "USD" },
      updated_at: "2026-01-01T00:00:00.000000Z",
      custom_data: null,
      description: "Monthly",
      import_meta: null,
      trial_period: null,
      billing_cycle: { interval: "month", frequency: 1 },
      unit_price_overrides: [],
    },
    product: { id: "pro_01gsz4t5hdjse780zja8vvr7jg", name: "Agent Review Desk Team", type: "standard", tax_category: "standard", description: "Team plan", image_url: null, custom_data: null, status: "active", import_meta: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
    status: status === "trialing" ? "trialing" : "active",
    quantity: 1,
    recurring: true,
    created_at: "2026-11-15T10:00:00.000Z",
    updated_at: "2026-11-15T10:00:00.000Z",
    trial_dates: null,
    next_billed_at: periodEnd,
    previously_billed_at: "2026-11-15T10:00:00.000000Z",
  };
  const event = {
    event_id: o.eventId ?? "evt_01hv8x2acma2gz7he8kg2s0hna",
    event_type: o.eventType ?? "subscription.updated",
    occurred_at: o.occurredAt ?? "2026-11-15T10:00:01.000000Z",
    notification_id: "ntf_01hv8x2af22vrrz7k67g06x1kq",
    data: {
      id: o.subscriptionId ?? "sub_01hv8x29kz0t586xy6zn1a62ny",
      items: [item],
      status,
      discount: null,
      paused_at: null,
      address_id: "add_01hv8gq3318ktkfengj2r75gfx",
      created_at: "2026-11-15T10:00:00.000Z",
      started_at: "2026-11-15T10:00:00.000000Z",
      updated_at: "2026-11-15T10:00:00.000Z",
      business_id: null,
      canceled_at: status === "canceled" ? "2026-11-20T10:00:00.000Z" : null,
      custom_data: o.nonce === null ? null : { ard_checkout: o.nonce ?? "nonce-abc" },
      customer_id: o.customerId ?? "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
      import_meta: null,
      billing_cycle: { interval: "month", frequency: 1 },
      currency_code: "USD",
      next_billed_at: status === "canceled" ? null : periodEnd,
      transaction_id: o.transactionId ?? "txn_01hv8wptq8987qeep44cyrewp9",
      billing_details: null,
      collection_mode: "automatic",
      first_billed_at: "2026-11-15T10:00:00.000000Z",
      scheduled_change: o.scheduledChange === undefined ? null : o.scheduledChange,
      consent_requirements: [],
      current_billing_period: status === "canceled" || status === "paused" || periodEnd === null ? null : { starts_at: "2026-11-15T10:00:00.000000Z", ends_at: periodEnd },
    },
  };
  return JSON.stringify(event, null, 2);
}

export function paddleOtherEvent(eventType = "transaction.completed"): string {
  return JSON.stringify({ event_id: "evt_other_1", event_type: eventType, occurred_at: "2026-11-15T10:00:00.000000Z", notification_id: "ntf_other_1", data: { id: "txn_01hv8wptq8987qeep44cyrewp9", status: "completed" } }, null, 2);
}

export interface DodoEventOptions {
  type?: string;
  status?: string | null;
  subscriptionId?: string;
  customerId?: string | null;
  productId?: string;
  nonce?: string | null;
  nextBillingDate?: string | null;
  cancelAtNextBillingDate?: boolean;
  timestamp?: string;
}

export function dodoSubscriptionEvent(o: DodoEventOptions = {}): string {
  const data: Record<string, unknown> = {
    payload_type: "Subscription",
    subscription_id: o.subscriptionId ?? "sub_dodo_1",
    product_id: o.productId ?? "pdt_team_monthly",
    customer: o.customerId === null ? undefined : { customer_id: o.customerId ?? "cus_dodo_1", email: "owner@example.com", name: "Owner" },
    metadata: o.nonce === null ? {} : { ard_checkout: o.nonce ?? "nonce-abc" },
    next_billing_date: o.nextBillingDate === undefined ? "2026-12-15T10:00:00Z" : o.nextBillingDate,
    previous_billing_date: "2026-11-15T10:00:00Z",
    cancel_at_next_billing_date: o.cancelAtNextBillingDate ?? false,
    created_at: "2026-11-15T10:00:00Z",
    currency: "USD",
    quantity: 1,
  };
  if (o.status !== null) data.status = o.status ?? "active";
  return JSON.stringify({ business_id: "bus_test", type: o.type ?? "subscription.active", timestamp: o.timestamp ?? "2026-11-15T10:00:01Z", data }, null, 2);
}

export function dodoPaymentEvent(): string {
  return JSON.stringify({ business_id: "bus_test", type: "payment.succeeded", timestamp: "2026-11-15T10:00:01Z", data: { payload_type: "Payment", payment_id: "pay_1", total_amount: 4900 } }, null, 2);
}

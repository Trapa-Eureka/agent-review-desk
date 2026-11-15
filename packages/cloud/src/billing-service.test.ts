import { test } from "node:test";
import assert from "node:assert/strict";
import { DodoProvider, PaddleProvider, headerBag, signDodoWebhook, signPaddleWebhook, type BillingProvider, type ProviderId } from "@ard/billing";
import { dodoPaymentEvent, dodoSubscriptionEvent, paddleOtherEvent, paddleSubscriptionEvent, stubFetch } from "@ard/billing/testkit";
import { orgEntitlement } from "./auth.js";
import { applyBillingEvent, openBillingPortal, startCheckout, webhookHttpStatus } from "./billing-service.js";
import { CloudError } from "./errors.js";
import { makeHarness } from "./testkit.js";

const PADDLE_SECRET = "pdl_ntfset_test_" + "s".repeat(24);
const DODO_SECRET = "whsec_" + Buffer.from("dodo-webhook-secret-32-bytes!!!!").toString("base64");

const throwsCloud = (fn: () => Promise<unknown> | unknown, code: string, pattern?: RegExp) =>
  assert.rejects(async () => fn(), (e: unknown) => e instanceof CloudError && e.code === code && (!pattern || pattern.test(e.message)), `expected ${code}`);

function setup() {
  const h = makeHarness();
  const owner = h.user("owner@example.com", "Olive Owner");
  const org = h.org(owner, "acme");
  const other = h.org(h.user("boss@other.com"), "other");
  const paddle = new PaddleProvider({ apiKey: "pdl_sdbx_apikey_x", webhookSecret: PADDLE_SECRET, priceId: "pri_team", environment: "sandbox", fetch: stubFetch().fetch });
  const dodo = new DodoProvider({ apiKey: "dodo_key", webhookSecret: DODO_SECRET, productId: "pdt_team", environment: "test_mode", fetch: stubFetch().fetch });
  const providers = new Map<ProviderId, BillingProvider>([["paddle", paddle], ["dodo", dodo]]);
  const now = () => Math.floor(Date.now() / 1000);

  /** Deliver a webhook the way the route does: verify, then apply. */
  const viaPaddle = (raw: string) => applyBillingEvent(h.control, paddle.verifyWebhook(raw, headerBag({ "paddle-signature": signPaddleWebhook(PADDLE_SECRET, raw, now()) })));
  const viaDodo = (raw: string, id = `msg_${Math.random().toString(36).slice(2)}`) =>
    applyBillingEvent(h.control, dodo.verifyWebhook(raw, headerBag({ "webhook-id": id, "webhook-timestamp": String(now()), "webhook-signature": signDodoWebhook(DODO_SECRET, id, now(), raw) })));

  return { h, owner, org, other, providers, paddle, dodo, viaPaddle, viaDodo };
}

/** Start a Paddle checkout and return the nonce the server generated (read back from the request it sent). */
async function startPaddle(s: ReturnType<typeof setup>, forOrg = s.org, user = s.owner) {
  const stub = stubFetch({ status: 201, json: { data: { id: "txn_abc123", checkout: { url: "https://cloud.example.com/pay?_ptxn=txn_abc123" } } } });
  const paddle = new PaddleProvider({ apiKey: "pdl_sdbx_apikey_x", webhookSecret: PADDLE_SECRET, priceId: "pri_team", environment: "sandbox", fetch: stub.fetch });
  const result = await startCheckout(s.h.control, new Map([["paddle", paddle]]), { org: forOrg, user, providerId: "paddle", returnUrl: "https://cloud.example.com/o/x/billing", now: s.h.clock.now() });
  return { result, nonce: (stub.calls[0]!.body as { custom_data: { ard_checkout: string } }).custom_data.ard_checkout, transactionId: "txn_abc123", calls: stub.calls };
}

async function startDodo(s: ReturnType<typeof setup>, forOrg = s.org, user = s.owner) {
  const stub = stubFetch({ status: 200, json: { session_id: "cks_1", checkout_url: "https://test.checkout.dodopayments.com/session/cks_1" } });
  const dodo = new DodoProvider({ apiKey: "dodo_key", webhookSecret: DODO_SECRET, productId: "pdt_team", environment: "test_mode", fetch: stub.fetch });
  const result = await startCheckout(s.h.control, new Map([["dodo", dodo]]), { org: forOrg, user, providerId: "dodo", returnUrl: "https://cloud.example.com/o/x/billing", now: s.h.clock.now() });
  return { result, nonce: (stub.calls[0]!.body as { metadata: { ard_checkout: string } }).metadata.ard_checkout, calls: stub.calls };
}

// --------------------------------------------------------------- checkout

test("starting a Paddle checkout stores a hashed nonce and the transaction, and returns Paddle's link", async () => {
  const s = setup();
  try {
    const { result, nonce, transactionId, calls } = await startPaddle(s);
    assert.equal(result.url, "https://cloud.example.com/pay?_ptxn=txn_abc123");
    assert.match(nonce, /^[0-9a-f]{48}$/);
    assert.equal(s.h.control.findOrgIdByCheckoutNonce("paddle", nonce), s.org.id);
    assert.equal(s.h.control.findOrgIdByCheckoutReference("paddle", transactionId), s.org.id);
    assert.equal(JSON.stringify(s.h.control.db.prepare("SELECT * FROM checkouts").all()).includes(nonce), false, "the nonce is stored hashed");
    assert.equal((calls[0]!.body as { items: Array<{ price_id: string }> }).items[0]!.price_id, "pri_team");
    assert.ok(s.h.control.listAudit(s.org.id).some((a) => a.action === "billing.checkout_started"));
  } finally {
    s.h.cleanup();
  }
});

test("starting a Dodo checkout sends the product, the customer's e-mail and our nonce", async () => {
  const s = setup();
  try {
    const { result, nonce, calls } = await startDodo(s);
    assert.equal(result.url, "https://test.checkout.dodopayments.com/session/cks_1");
    const body = calls[0]!.body as { customer: { email: string; name: string }; product_cart: Array<{ product_id: string }> };
    assert.deepEqual(body.customer, { email: "owner@example.com", name: "Olive Owner" });
    assert.equal(body.product_cart[0]!.product_id, "pdt_team");
    assert.equal(s.h.control.findOrgIdByCheckoutNonce("dodo", nonce), s.org.id);
  } finally {
    s.h.cleanup();
  }
});

test("a provider that is not configured on this server is refused", async () => {
  const s = setup();
  try {
    await throwsCloud(() => startCheckout(s.h.control, new Map(), { org: s.org, user: s.owner, providerId: "paddle", returnUrl: "https://x" }), "bad_request", /not available/);
    await throwsCloud(() => startCheckout(s.h.control, s.providers, { org: s.org, user: s.owner, providerId: "stripe", returnUrl: "https://x" }), "bad_request");
  } finally {
    s.h.cleanup();
  }
});

test("an organization that already pays cannot start a second subscription (no double billing)", async () => {
  const s = setup();
  try {
    const { nonce, transactionId } = await startPaddle(s);
    s.viaPaddle(paddleSubscriptionEvent({ nonce, transactionId }));
    const org = s.h.control.getOrg(s.org.id)!;
    await throwsCloud(() => startCheckout(s.h.control, s.providers, { org, user: s.owner, providerId: "dodo", returnUrl: "https://x", now: s.h.clock.now() }), "conflict", /already has an active subscription/);
  } finally {
    s.h.cleanup();
  }
});

test("a subscription that is set to cancel may be started again (resubscribe)", async () => {
  const s = setup();
  try {
    const { nonce, transactionId } = await startPaddle(s);
    s.viaPaddle(paddleSubscriptionEvent({ nonce, transactionId, scheduledChange: { action: "cancel", effective_at: "2026-12-15T10:00:00.000000Z", resume_at: null } }));
    const org = s.h.control.getOrg(s.org.id)!;
    assert.equal(org.subCancelAtPeriodEnd, true);
    await assert.doesNotReject(() => startDodo(s, org));
  } finally {
    s.h.cleanup();
  }
});

// --------------------------------------------------------------- webhooks

test("Paddle: the subscription webhook switches the organization to the paid plan, found through OUR nonce", async () => {
  const s = setup();
  try {
    const { nonce, transactionId } = await startPaddle(s);
    assert.equal(orgEntitlement(s.h.control.getOrg(s.org.id)!, new Date()).active, false);
    const outcome = s.viaPaddle(paddleSubscriptionEvent({ nonce, transactionId, customerId: "ctm_777", subscriptionId: "sub_777" }));
    assert.deepEqual(outcome, { status: "applied", orgId: s.org.id });
    const org = s.h.control.getOrg(s.org.id)!;
    assert.deepEqual([org.billingProvider, org.billingCustomerId, org.billingSubscriptionId, org.subStatus], ["paddle", "ctm_777", "sub_777", "active"]);
    assert.equal(orgEntitlement(org, new Date("2026-11-20T00:00:00Z")).active, true);
    assert.equal(s.h.control.getOrg(s.other.id)!.subStatus, null, "nobody else is affected");
  } finally {
    s.h.cleanup();
  }
});

test("Dodo: the subscription webhook switches the organization to the paid plan", async () => {
  const s = setup();
  try {
    const { nonce } = await startDodo(s);
    const outcome = s.viaDodo(dodoSubscriptionEvent({ nonce, subscriptionId: "sub_d9", customerId: "cus_9" }));
    assert.equal(outcome.status, "applied");
    const org = s.h.control.getOrg(s.org.id)!;
    assert.deepEqual([org.billingProvider, org.billingCustomerId, org.billingSubscriptionId, org.subStatus], ["dodo", "cus_9", "sub_d9", "active"]);
  } finally {
    s.h.cleanup();
  }
});

test("a redelivered webhook is recognized and changes nothing", async () => {
  const s = setup();
  try {
    const { nonce, transactionId } = await startPaddle(s);
    const raw = paddleSubscriptionEvent({ nonce, transactionId });
    assert.equal(s.viaPaddle(raw).status, "applied");
    const before = JSON.stringify(s.h.control.getOrg(s.org.id));
    const auditBefore = s.h.control.listAudit(s.org.id).length;
    assert.deepEqual(s.viaPaddle(raw), { status: "duplicate" });
    assert.equal(JSON.stringify(s.h.control.getOrg(s.org.id)), before);
    assert.equal(s.h.control.listAudit(s.org.id).length, auditBefore);
  } finally {
    s.h.cleanup();
  }
});

test("events arriving out of order: an older snapshot never overwrites a newer one", async () => {
  const s = setup();
  try {
    const { nonce, transactionId } = await startPaddle(s);
    s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_new", nonce, transactionId, status: "active", occurredAt: "2026-11-15T12:00:00.000000Z" }));
    const outcome = s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_old", nonce, transactionId, status: "past_due", occurredAt: "2026-11-15T09:00:00.000000Z" }));
    assert.equal(outcome.status, "stale");
    assert.equal(s.h.control.getOrg(s.org.id)!.subStatus, "active");
    // ...and the next newer one still applies.
    assert.equal(s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_newer", nonce, transactionId, status: "past_due", occurredAt: "2026-11-15T13:00:00.000000Z" })).status, "applied");
    assert.equal(s.h.control.getOrg(s.org.id)!.subStatus, "past_due");
  } finally {
    s.h.cleanup();
  }
});

test("a webhook whose nonce we never issued is not applied to anyone (this is what stops a forged org id)", async () => {
  const s = setup();
  try {
    await startPaddle(s);
    const outcome = s.viaPaddle(paddleSubscriptionEvent({ nonce: "an-attacker-chose-this", transactionId: "txn_unknown", subscriptionId: "sub_evil" }));
    assert.deepEqual(outcome, { status: "unmatched" });
    for (const org of [s.org, s.other]) assert.equal(s.h.control.getOrg(org.id)!.subStatus, null);
    assert.equal(s.h.control.db.prepare("SELECT COUNT(*) AS n FROM billing_events").get()!.n, 0, "unmatched events are not marked as handled");
  } finally {
    s.h.cleanup();
  }
});

test("a nonce is only valid for the provider that issued it", async () => {
  const s = setup();
  try {
    const { nonce } = await startPaddle(s);
    assert.equal(s.viaDodo(dodoSubscriptionEvent({ nonce })).status, "unmatched");
    assert.equal(s.h.control.getOrg(s.org.id)!.subStatus, null);
  } finally {
    s.h.cleanup();
  }
});

test("Paddle without custom data is still found through the transaction id we recorded", async () => {
  const s = setup();
  try {
    const { transactionId } = await startPaddle(s);
    const outcome = s.viaPaddle(paddleSubscriptionEvent({ nonce: null, transactionId, subscriptionId: "sub_t" }));
    assert.deepEqual(outcome, { status: "applied", orgId: s.org.id });
  } finally {
    s.h.cleanup();
  }
});

test("later events carry no nonce, but the linked subscription id finds the organization", async () => {
  const s = setup();
  try {
    const { nonce } = await startDodo(s);
    s.viaDodo(dodoSubscriptionEvent({ nonce, subscriptionId: "sub_d1" }));
    const renewal = s.viaDodo(dodoSubscriptionEvent({ type: "subscription.renewed", nonce: null, subscriptionId: "sub_d1", timestamp: "2026-12-15T10:00:00Z", nextBillingDate: "2027-01-15T10:00:00Z" }));
    assert.equal(renewal.status, "applied");
    assert.equal(s.h.control.getOrg(s.org.id)!.subPeriodEnd, "2027-01-15T10:00:00Z");
  } finally {
    s.h.cleanup();
  }
});

test("a subscription already linked to one organization cannot be claimed by another organization's checkout", async () => {
  const s = setup();
  try {
    const mine = await startPaddle(s);
    s.viaPaddle(paddleSubscriptionEvent({ nonce: mine.nonce, transactionId: mine.transactionId, subscriptionId: "sub_shared" }));
    const theirs = await startPaddle(s, s.other, s.h.user("boss@other.com"));
    const outcome = s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_hijack", nonce: theirs.nonce, transactionId: "txn_other", subscriptionId: "sub_shared", occurredAt: "2026-11-16T10:00:00.000000Z" }));
    assert.deepEqual(outcome, { status: "conflict" });
    assert.equal(s.h.control.getOrg(s.other.id)!.subStatus, null);
    assert.ok(s.h.control.listAudit(s.org.id).some((a) => a.action === "billing.conflict"));
  } finally {
    s.h.cleanup();
  }
});

test("events that are not about a subscription are acknowledged and ignored", () => {
  const s = setup();
  try {
    assert.deepEqual(s.viaPaddle(paddleOtherEvent()), { status: "ignored" });
    assert.deepEqual(s.viaDodo(dodoPaymentEvent()), { status: "ignored" }, "payment.* events carry no subscription snapshot");
  } finally {
    s.h.cleanup();
  }
});

// ------------------------------------------------------- lifecycle & access

test("cancel at period end: access continues until the paid period runs out, then stops", async () => {
  const s = setup();
  try {
    const { nonce, transactionId } = await startPaddle(s);
    s.viaPaddle(paddleSubscriptionEvent({ nonce, transactionId, periodEnd: "2026-12-15T10:00:00.000000Z", scheduledChange: { action: "cancel", effective_at: "2026-12-15T10:00:00.000000Z", resume_at: null }, occurredAt: "2026-11-15T10:00:00.000000Z" }));
    const org = s.h.control.getOrg(s.org.id)!;
    assert.deepEqual([org.subStatus, org.subCancelAtPeriodEnd], ["active", true]);
    assert.deepEqual(orgEntitlement(org, new Date("2026-12-01T00:00:00Z")), { active: true, reason: "active", until: "2026-12-15T10:00:00.000000Z" });
    // The period ends and Paddle reports the subscription as canceled.
    s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_end", eventType: "subscription.canceled", nonce, transactionId, status: "canceled", periodEnd: null, occurredAt: "2026-12-15T10:00:05.000000Z" }));
    assert.equal(orgEntitlement(s.h.control.getOrg(s.org.id)!, new Date("2026-12-16T00:00:00Z")).active, false);
  } finally {
    s.h.cleanup();
  }
});

test("Dodo: on_hold is a payment problem (grace), cancelled with time left keeps access until then", async () => {
  const s = setup();
  try {
    const { nonce } = await startDodo(s);
    s.viaDodo(dodoSubscriptionEvent({ nonce, subscriptionId: "sub_d2", timestamp: "2026-11-15T10:00:00Z" }));
    s.viaDodo(dodoSubscriptionEvent({ type: "subscription.on_hold", status: "on_hold", nonce: null, subscriptionId: "sub_d2", timestamp: "2026-11-16T10:00:00Z" }));
    const held = s.h.control.getOrg(s.org.id)!;
    assert.equal(held.subStatus, "past_due");
    assert.equal(orgEntitlement(held, new Date("2026-11-17T00:00:00Z")).reason, "grace_period");
    s.viaDodo(dodoSubscriptionEvent({ type: "subscription.cancelled", status: "cancelled", nonce: null, subscriptionId: "sub_d2", timestamp: "2026-11-17T10:00:00Z", nextBillingDate: "2026-12-15T10:00:00Z" }));
    const canceled = s.h.control.getOrg(s.org.id)!;
    assert.equal(orgEntitlement(canceled, new Date("2026-11-20T00:00:00Z")).reason, "paid_until_period_end");
    assert.equal(orgEntitlement(canceled, new Date("2026-12-20T00:00:00Z")).active, false);
  } finally {
    s.h.cleanup();
  }
});

// ----------------------------------------------------------------- portal

test("the billing portal link comes from the provider the organization actually pays through", async () => {
  const s = setup();
  try {
    const { nonce, transactionId } = await startPaddle(s);
    s.viaPaddle(paddleSubscriptionEvent({ nonce, transactionId, customerId: "ctm_p", subscriptionId: "sub_p" }));
    const portal = stubFetch({ status: 201, json: { data: { urls: { general: { overview: "https://portal/o" }, subscriptions: [{ id: "sub_p", view_subscription: "https://portal/sub_p" }] } } } });
    const paddle = new PaddleProvider({ apiKey: "k", webhookSecret: PADDLE_SECRET, priceId: "pri_team", environment: "sandbox", fetch: portal.fetch });
    const result = await openBillingPortal(new Map([["paddle", paddle]]), { org: s.h.control.getOrg(s.org.id)!, returnUrl: "https://x" });
    assert.deepEqual(result, { url: "https://portal/sub_p" });
    assert.ok(portal.calls[0]!.url.endsWith("/customers/ctm_p/portal-sessions"));
  } finally {
    s.h.cleanup();
  }
});

test("no portal without a subscription, or when its provider is not configured here", async () => {
  const s = setup();
  try {
    await throwsCloud(() => openBillingPortal(s.providers, { org: s.org, returnUrl: "https://x" }), "not_found");
    const { nonce, transactionId } = await startPaddle(s);
    s.viaPaddle(paddleSubscriptionEvent({ nonce, transactionId }));
    await throwsCloud(() => openBillingPortal(new Map(), { org: s.h.control.getOrg(s.org.id)!, returnUrl: "https://x" }), "unavailable");
  } finally {
    s.h.cleanup();
  }
});

// ------------------------------------------- a replaced subscription must not switch the new one off

test("a late 'canceled' for an OLD, replaced subscription does not switch off the new paid one", async () => {
  const s = setup();
  try {
    // Subscription A, scheduled to cancel at period end: the owner may start a new checkout.
    const a = await startPaddle(s);
    s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_a1", nonce: a.nonce, transactionId: a.transactionId, subscriptionId: "sub_A", status: "active", occurredAt: "2026-11-15T10:00:00.000000Z", scheduledChange: { action: "cancel", effective_at: "2026-12-15T10:00:00.000000Z", resume_at: null } }));
    const b = await startPaddle(s); // checkout 2
    assert.equal(s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_b1", nonce: b.nonce, transactionId: "txn_b", subscriptionId: "sub_B", status: "active", occurredAt: "2026-11-16T10:00:00.000000Z" })).status, "applied");
    assert.equal(s.h.control.getOrg(s.org.id)!.billingSubscriptionId, "sub_B");

    // A's cancellation arrives late. It is NEWER than B's activation, so the per-organization clock alone would accept it.
    const late = s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_a2", nonce: a.nonce, transactionId: a.transactionId, subscriptionId: "sub_A", status: "canceled", occurredAt: "2026-11-17T10:00:00.000000Z" }));
    assert.equal(late.status, "stale");
    const org = s.h.control.getOrg(s.org.id)!;
    assert.equal(org.billingSubscriptionId, "sub_B");
    assert.equal(org.subStatus, "active");
    assert.equal(orgEntitlement(org, s.h.clock.now()).active, true, "the team that pays for B keeps access");

    // The same for any other non-live status from the old subscription.
    for (const status of ["past_due", "paused"]) {
      assert.equal(s.viaPaddle(paddleSubscriptionEvent({ eventId: `evt_a_${status}`, nonce: a.nonce, transactionId: a.transactionId, subscriptionId: "sub_A", status, occurredAt: "2026-11-18T10:00:00.000000Z" })).status, "stale", status);
    }
    assert.equal(s.h.control.getOrg(s.org.id)!.subStatus, "active");

    // B's own later events still apply normally.
    assert.equal(s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_b2", nonce: b.nonce, transactionId: "txn_b", subscriptionId: "sub_B", status: "past_due", occurredAt: "2026-11-19T10:00:00.000000Z" })).status, "applied");
    assert.equal(s.h.control.getOrg(s.org.id)!.subStatus, "past_due");
  } finally {
    s.h.cleanup();
  }
});

test("a different subscription may take over when the one on record has ended", async () => {
  const s = setup();
  try {
    const a = await startPaddle(s);
    s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_a1", nonce: a.nonce, transactionId: a.transactionId, subscriptionId: "sub_A", status: "canceled", occurredAt: "2026-11-15T10:00:00.000000Z" }));
    const b = await startPaddle(s);
    // Even a non-active first event for B is recorded, because nothing live is on record.
    assert.equal(s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_b1", nonce: b.nonce, transactionId: "txn_b", subscriptionId: "sub_B", status: "past_due", occurredAt: "2026-11-16T10:00:00.000000Z" })).status, "applied");
    assert.equal(s.h.control.getOrg(s.org.id)!.billingSubscriptionId, "sub_B");
  } finally {
    s.h.cleanup();
  }
});

test("switching provider: a late cancellation from the old provider does not touch the new subscription", async () => {
  const s = setup();
  try {
    const a = await startPaddle(s);
    s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_a1", nonce: a.nonce, transactionId: a.transactionId, subscriptionId: "sub_A", status: "active", occurredAt: "2026-11-15T10:00:00.000000Z", scheduledChange: { action: "cancel", effective_at: "2026-12-15T10:00:00.000000Z", resume_at: null } }));
    const d = await startDodo(s);
    assert.equal(s.viaDodo(dodoSubscriptionEvent({ nonce: d.nonce, subscriptionId: "sub_dodo", status: "active", type: "subscription.active", timestamp: "2026-11-16T10:00:00.000Z" })).status, "applied");
    assert.equal(s.h.control.getOrg(s.org.id)!.billingProvider, "dodo");
    assert.equal(s.viaPaddle(paddleSubscriptionEvent({ eventId: "evt_a2", nonce: a.nonce, transactionId: a.transactionId, subscriptionId: "sub_A", status: "canceled", occurredAt: "2026-11-17T10:00:00.000000Z" })).status, "stale");
    assert.equal(s.h.control.getOrg(s.org.id)!.subStatus, "active");
  } finally {
    s.h.cleanup();
  }
});

test("webhookHttpStatus: only a conflict is not acknowledged as success", () => {
  for (const status of ["applied", "stale", "duplicate", "ignored", "unmatched"] as const) assert.equal(webhookHttpStatus({ status, orgId: "x" } as never), 200, status);
  assert.equal(webhookHttpStatus({ status: "conflict" }), 409);
});

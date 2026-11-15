import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DODO_HOSTS, DODO_TOLERANCE_MS, DodoProvider, dodoSecretKey, signDodoWebhook } from "./dodo.js";
import { headerBag } from "./http.js";
import { dodoPaymentEvent, dodoSubscriptionEvent, stubFetch } from "./testkit.js";
import { BillingApiError, WebhookVerificationError } from "./types.js";

const SECRET = "whsec_" + Buffer.from("an-example-signing-key-of-32byte").toString("base64");
const API_KEY = "dodo_test_" + "k".repeat(40);
const NOW = new Date("2026-11-15T10:00:05.000Z");
const TS = Math.floor(NOW.getTime() / 1000);

const provider = (extra: Partial<ConstructorParameters<typeof DodoProvider>[0]> = {}) =>
  new DodoProvider({ apiKey: API_KEY, webhookSecret: SECRET, productId: "pdt_team_monthly", environment: "test_mode", ...extra });
const signed = (raw: string, id = "msg_1", ts = TS, secret = SECRET) => headerBag({ "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signDodoWebhook(secret, id, ts, raw) });
const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof WebhookVerificationError && e.code === code, `expected ${code}`);

type StandardWebhook = { sign(id: string, timestamp: Date, payload: string): string; verify(payload: string, headers: Record<string, string>): unknown };
const standardWebhooks = (secret = SECRET) => {
  const lib = createRequire(import.meta.url)("standardwebhooks") as { Webhook: new (secret: string) => StandardWebhook };
  return new lib.Webhook(secret);
};

// ---------------------------------------------------------------- signature: independent cross-check

test("a signature made by the official Standard Webhooks library is accepted by our verifier", () => {
  const raw = dodoSubscriptionEvent();
  const when = new Date(NOW.getTime() - 1000);
  const signature = standardWebhooks().sign("msg_lib_1", when, raw);
  const bag = headerBag({ "webhook-id": "msg_lib_1", "webhook-timestamp": String(Math.floor(when.getTime() / 1000)), "webhook-signature": signature });
  const event = provider().verifyWebhook(raw, bag, NOW);
  assert.equal(event.eventId, "msg_lib_1");
  assert.equal(event.subscription?.subscriptionId, "sub_dodo_1");
});

test("and a signature made by us is accepted by the official library (both directions agree)", () => {
  const raw = dodoSubscriptionEvent();
  const headers = { "webhook-id": "msg_ours_1", "webhook-timestamp": String(TS), "webhook-signature": signDodoWebhook(SECRET, "msg_ours_1", TS, raw) };
  // The library enforces a 5 minute tolerance against the real clock, so sign "now" for this cross-check.
  const nowTs = Math.floor(Date.now() / 1000);
  const fresh = { ...headers, "webhook-timestamp": String(nowTs), "webhook-signature": signDodoWebhook(SECRET, "msg_ours_1", nowTs, raw) };
  assert.doesNotThrow(() => standardWebhooks().verify(raw, fresh));
  assert.throws(() => standardWebhooks().verify(raw + " ", fresh));
});

test("the secret is decoded from base64 after removing whsec_, and also works without the prefix", () => {
  assert.equal(dodoSecretKey(SECRET).toString(), "an-example-signing-key-of-32byte");
  assert.equal(dodoSecretKey(SECRET.slice(6)).toString(), "an-example-signing-key-of-32byte");
  const raw = dodoSubscriptionEvent();
  assert.ok(provider({ webhookSecret: SECRET.slice(6) }).verifyWebhook(raw, signed(raw, "m", TS, SECRET.slice(6)), NOW));
});

// ---------------------------------------------------------------- normalization

test("a correctly signed subscription event is accepted and normalized", () => {
  const raw = dodoSubscriptionEvent({ nonce: "n-7" });
  const event = provider().verifyWebhook(raw, signed(raw, "msg_abc"), NOW);
  assert.equal(event.provider, "dodo");
  assert.equal(event.eventId, "msg_abc");
  assert.equal(event.type, "subscription.active");
  assert.equal(event.occurredAt, "2026-11-15T10:00:01.000Z");
  assert.deepEqual(event.subscription, {
    provider: "dodo",
    subscriptionId: "sub_dodo_1",
    customerId: "cus_dodo_1",
    status: "active",
    currentPeriodEnd: "2026-12-15T10:00:00Z",
    cancelAtPeriodEnd: false,
    checkoutNonce: "n-7",
    transactionId: null,
    planRef: "pdt_team_monthly",
  });
});

test("status mapping from the payload's own status", () => {
  const table: Array<[string, string]> = [["pending", "incomplete"], ["active", "active"], ["on_hold", "past_due"], ["paused", "paused"], ["cancelled", "canceled"], ["expired", "expired"], ["failed", "expired"]];
  for (const [status, expected] of table) {
    const raw = dodoSubscriptionEvent({ status });
    assert.equal(provider().verifyWebhook(raw, signed(raw), NOW).subscription!.status, expected, status);
  }
});

test("when the payload has no status the event name decides", () => {
  const table: Array<[string, string]> = [["subscription.active", "active"], ["subscription.renewed", "active"], ["subscription.on_hold", "past_due"], ["subscription.paused", "paused"], ["subscription.cancelled", "canceled"], ["subscription.expired", "expired"], ["subscription.failed", "expired"]];
  for (const [type, expected] of table) {
    const raw = dodoSubscriptionEvent({ type, status: null });
    assert.equal(provider().verifyWebhook(raw, signed(raw), NOW).subscription!.status, expected, type);
  }
});

test("an unknown status on an unknown event never grants access", () => {
  const raw = dodoSubscriptionEvent({ type: "subscription.some_new_event", status: "mystery" });
  assert.equal(provider().verifyWebhook(raw, signed(raw), NOW).subscription!.status, "paused");
});

test("cancel_at_next_billing_date marks a pending cancellation and keeps the paid-until date", () => {
  const raw = dodoSubscriptionEvent({ cancelAtNextBillingDate: true });
  const sub = provider().verifyWebhook(raw, signed(raw), NOW).subscription!;
  assert.equal(sub.status, "active");
  assert.equal(sub.cancelAtPeriodEnd, true);
  assert.equal(sub.currentPeriodEnd, "2026-12-15T10:00:00Z");
});

test("missing metadata, customer or billing date degrade to nulls instead of failing", () => {
  const raw = dodoSubscriptionEvent({ nonce: null, customerId: null, nextBillingDate: null });
  const sub = provider().verifyWebhook(raw, signed(raw), NOW).subscription!;
  assert.deepEqual([sub.checkoutNonce, sub.customerId, sub.currentPeriodEnd], [null, null, null]);
});

test("payment events are verified but carry no subscription snapshot", () => {
  const raw = dodoPaymentEvent();
  const event = provider().verifyWebhook(raw, signed(raw), NOW);
  assert.equal(event.type, "payment.succeeded");
  assert.equal(event.subscription, null);
});

test("a subscription event without a subscription id carries no snapshot", () => {
  const raw = JSON.stringify({ type: "subscription.active", timestamp: "2026-11-15T10:00:01Z", data: {} });
  assert.equal(provider().verifyWebhook(raw, signed(raw), NOW).subscription, null);
});

test("when the envelope has no timestamp, the signed header timestamp is used", () => {
  const raw = JSON.stringify({ type: "payment.succeeded", data: {} });
  assert.equal(provider().verifyWebhook(raw, signed(raw), NOW).occurredAt, new Date(TS * 1000).toISOString());
});

// ---------------------------------------------------------------- rejection

test("rejects missing headers", () => {
  const raw = dodoSubscriptionEvent();
  rejects(() => provider().verifyWebhook(raw, headerBag({}), NOW), "missing_header");
  const bag = signed(raw);
  for (const drop of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
    const copy = headerBag({ "webhook-id": bag.get("webhook-id") ?? undefined, "webhook-timestamp": bag.get("webhook-timestamp") ?? undefined, "webhook-signature": bag.get("webhook-signature") ?? undefined, [drop]: undefined });
    rejects(() => provider().verifyWebhook(raw, copy, NOW), "missing_header");
  }
});

test("rejects a malformed timestamp", () => {
  const raw = dodoSubscriptionEvent();
  for (const ts of ["abc", "12.5", "-1", ""]) {
    rejects(() => provider().verifyWebhook(raw, headerBag({ "webhook-id": "m", "webhook-timestamp": ts, "webhook-signature": "v1,xx" }), NOW), ts === "" ? "missing_header" : "bad_format");
  }
});

test("rejects a changed body, a changed id, a changed timestamp, and another secret", () => {
  const raw = dodoSubscriptionEvent();
  const good = signed(raw, "msg_1", TS);
  rejects(() => provider().verifyWebhook(raw + "\n", good, NOW), "bad_signature");
  rejects(() => provider().verifyWebhook(raw, headerBag({ "webhook-id": "msg_2", "webhook-timestamp": String(TS), "webhook-signature": good.get("webhook-signature") ?? "" }), NOW), "bad_signature");
  rejects(() => provider().verifyWebhook(raw, headerBag({ "webhook-id": "msg_1", "webhook-timestamp": String(TS + 1), "webhook-signature": good.get("webhook-signature") ?? "" }), NOW), "bad_signature");
  rejects(() => provider().verifyWebhook(raw, signed(raw, "msg_1", TS, "whsec_" + Buffer.from("a-completely-different-secret-xx").toString("base64")), NOW), "bad_signature");
});

test("rejects replays outside the window, in either direction", () => {
  const raw = dodoSubscriptionEvent();
  const span = Math.ceil(DODO_TOLERANCE_MS / 1000) + 5;
  rejects(() => provider().verifyWebhook(raw, signed(raw, "m", TS - span), NOW), "stale");
  rejects(() => provider().verifyWebhook(raw, signed(raw, "m", TS + span), NOW), "stale");
  assert.ok(provider().verifyWebhook(raw, signed(raw, "m", TS - 120), NOW));
});

test("several space-separated signatures: any valid v1 passes; non-v1 and junk entries are ignored", () => {
  const raw = dodoSubscriptionEvent();
  const good = signDodoWebhook(SECRET, "m", TS, raw);
  const header = (sig: string) => headerBag({ "webhook-id": "m", "webhook-timestamp": String(TS), "webhook-signature": sig });
  assert.ok(provider().verifyWebhook(raw, header(`v1,AAAA ${good} v1,BBBB`), NOW));
  assert.ok(provider().verifyWebhook(raw, header(`v2,whatever ${good}`), NOW));
  rejects(() => provider().verifyWebhook(raw, header(`v1,AAAA v1,BBBB`), NOW), "bad_signature");
  rejects(() => provider().verifyWebhook(raw, header(`v2,${good.slice(3)}`), NOW), "bad_signature");
  rejects(() => provider().verifyWebhook(raw, header(`${good.slice(3)}`), NOW), "bad_signature");
  rejects(() => provider().verifyWebhook(raw, header(`garbage`), NOW), "bad_signature");
});

test("a validly signed but unusable body is rejected as bad_body", () => {
  const notJson = "not json";
  rejects(() => provider().verifyWebhook(notJson, signed(notJson), NOW), "bad_body");
  const noType = JSON.stringify({ data: {} });
  rejects(() => provider().verifyWebhook(noType, signed(noType), NOW), "bad_body");
});

test("an unconfigured secret refuses everything", () => {
  const raw = dodoSubscriptionEvent();
  rejects(() => provider({ webhookSecret: "" }).verifyWebhook(raw, signed(raw), NOW), "not_configured");
});

// ---------------------------------------------------------------- API calls

test("createCheckout posts to /checkouts with the product, return url and our nonce", async () => {
  const stub = stubFetch({ status: 200, json: { session_id: "cks_1", checkout_url: "https://test.checkout.dodopayments.com/session/cks_1" } });
  const result = await provider({ fetch: stub.fetch }).createCheckout({ nonce: "n-9", returnUrl: "https://cloud.example.com/o/acme/billing" });
  assert.deepEqual(result, { url: "https://test.checkout.dodopayments.com/session/cks_1", reference: "cks_1" });
  const [call] = stub.calls;
  assert.equal(call!.url, `${DODO_HOSTS.test_mode}/checkouts`);
  assert.equal(call!.method, "POST");
  assert.equal(call!.headers.authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(call!.body, { product_cart: [{ product_id: "pdt_team_monthly", quantity: 1 }], return_url: "https://cloud.example.com/o/acme/billing", metadata: { ard_checkout: "n-9" } });
});

test("an email (and name) prefill the checkout when given; live mode uses the live host", async () => {
  const stub = stubFetch({ json: { session_id: "cks_2", checkout_url: "https://c/2" } });
  await provider({ fetch: stub.fetch, environment: "live_mode" }).createCheckout({ nonce: "n", email: "a@b.co", name: "A B", returnUrl: "https://x" });
  assert.equal(stub.calls[0]!.url, `${DODO_HOSTS.live_mode}/checkouts`);
  assert.deepEqual((stub.calls[0]!.body as { customer: unknown }).customer, { email: "a@b.co", name: "A B" });
});

test("API errors name the cause but never leak the key", async () => {
  const stub = stubFetch({ status: 401, json: { code: "UNAUTHORIZED", message: "Invalid API key" } });
  await assert.rejects(
    () => provider({ fetch: stub.fetch }).createCheckout({ nonce: "n", returnUrl: "https://x" }),
    (e: unknown) => e instanceof BillingApiError && e.status === 401 && /Invalid API key/.test(e.message) && !e.message.includes(API_KEY),
  );
});

test("a response without checkout_url, a dead network and a timeout are all clear errors", async () => {
  await assert.rejects(() => provider({ fetch: stubFetch({ json: { session_id: "x" } }).fetch }).createCheckout({ nonce: "n", returnUrl: "https://x" }), /no checkout_url/);
  await assert.rejects(
    () => provider({ fetch: stubFetch({ throws: new Error(`ECONNRESET ${API_KEY}`) }).fetch }).createCheckout({ nonce: "n", returnUrl: "https://x" }),
    (e: unknown) => e instanceof BillingApiError && !e.message.includes(API_KEY),
  );
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  await assert.rejects(() => provider({ fetch: stubFetch({ throws: timeout }).fetch }).createCheckout({ nonce: "n", returnUrl: "https://x" }), /did not answer/);
});

test("createPortalSession asks for a portal link for the customer and returns it", async () => {
  const stub = stubFetch({ status: 200, json: { link: "https://test.customer.dodopayments.com/portal/abc" } });
  const result = await provider({ fetch: stub.fetch }).createPortalSession({ customerId: "cus_1", returnUrl: "https://cloud.example.com/o/acme/billing" });
  assert.deepEqual(result, { url: "https://test.customer.dodopayments.com/portal/abc" });
  assert.equal(stub.calls[0]!.url, `${DODO_HOSTS.test_mode}/customers/cus_1/customer-portal/session?return_url=${encodeURIComponent("https://cloud.example.com/o/acme/billing")}`);
  assert.equal(stub.calls[0]!.method, "POST");
});

test("a missing portal link is an error, and the customer id cannot alter the path", async () => {
  await assert.rejects(() => provider({ fetch: stubFetch({ json: {} }).fetch }).createPortalSession({ customerId: "cus_1", returnUrl: "https://x" }), /no customer portal link/);
  const stub = stubFetch({ json: { link: "https://l" } });
  await provider({ fetch: stub.fetch }).createPortalSession({ customerId: "../payments", returnUrl: "https://x" });
  assert.ok(stub.calls[0]!.url.includes("..%2Fpayments"), stub.calls[0]!.url);
});

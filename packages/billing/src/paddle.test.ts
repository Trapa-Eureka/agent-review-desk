import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { headerBag } from "./http.js";
import { PADDLE_HOSTS, PADDLE_TOLERANCE_MS, PaddleProvider, parsePaddleSignature, signPaddleWebhook } from "./paddle.js";
import { paddleOtherEvent, paddleSubscriptionEvent, stubFetch } from "./testkit.js";
import { BillingApiError, WebhookVerificationError } from "./types.js";

const SECRET = "pdl_ntfset_01test_" + "s".repeat(32);
const API_KEY = "pdl_sdbx_apikey_" + "k".repeat(40);
const NOW = new Date("2026-11-15T10:00:05.000Z");
const TS = Math.floor(NOW.getTime() / 1000);

const provider = (extra: Partial<ConstructorParameters<typeof PaddleProvider>[0]> = {}) =>
  new PaddleProvider({ apiKey: API_KEY, webhookSecret: SECRET, priceId: "pri_team", environment: "sandbox", ...extra });
const headers = (raw: string, ts = TS, secret = SECRET) => headerBag({ "Paddle-Signature": signPaddleWebhook(secret, raw, ts) });
const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof WebhookVerificationError && e.code === code, `expected ${code}`);

// ---------------------------------------------------------------- signature: independent cross-check

test("our signature is accepted by Paddle's own SDK, and a tampered body is rejected by it (algorithm cross-check)", async () => {
  const sdk = createRequire(import.meta.url)("@paddle/paddle-node-sdk") as { Paddle: new (key: string) => { webhooks: { unmarshal(body: string, secret: string, signature: string): Promise<unknown> } } };
  const paddle = new sdk.Paddle(API_KEY);
  const raw = paddleSubscriptionEvent();
  const signature = signPaddleWebhook(SECRET, raw, Math.floor(Date.now() / 1000));
  const event = (await paddle.webhooks.unmarshal(raw, SECRET, signature)) as { eventId?: string };
  assert.equal(event.eventId, "evt_01hv8x2acma2gz7he8kg2s0hna");
  await assert.rejects(() => paddle.webhooks.unmarshal(raw.replace("active", "actives"), SECRET, signature), /signature|verify|match/i);
  await assert.rejects(() => paddle.webhooks.unmarshal(raw, SECRET + "x", signature), /signature|verify|match/i);
});

test("parsePaddleSignature reads ts and every h1, in any order", () => {
  assert.deepEqual(parsePaddleSignature("ts=1671552777;h1=aa"), { ts: "1671552777", h1: ["aa"] });
  assert.deepEqual(parsePaddleSignature("h1=aa;ts=1;h1=bb;x=y"), { ts: "1", h1: ["aa", "bb"] });
  assert.deepEqual(parsePaddleSignature(" ts=1 ; h1=aa "), { ts: "1", h1: ["aa"] });
});

test("parsePaddleSignature rejects malformed headers", () => {
  for (const bad of ["", "garbage", "ts=1", "h1=aa", "ts=abc;h1=aa", "ts=;h1=aa", "ts=1;h1=", "ts=-5;h1=aa", "ts=99999999999999;h1=aa"]) {
    assert.throws(() => parsePaddleSignature(bad), (e: unknown) => e instanceof WebhookVerificationError && e.code === "bad_format", bad);
  }
});

// ---------------------------------------------------------------- verification

test("a correctly signed subscription event is accepted and normalized", () => {
  const raw = paddleSubscriptionEvent({ nonce: "n-1" });
  const event = provider().verifyWebhook(raw, headers(raw), NOW);
  assert.equal(event.provider, "paddle");
  assert.equal(event.eventId, "evt_01hv8x2acma2gz7he8kg2s0hna");
  assert.equal(event.type, "subscription.updated");
  assert.equal(event.occurredAt, "2026-11-15T10:00:01.000000Z");
  assert.deepEqual(event.subscription, {
    provider: "paddle",
    subscriptionId: "sub_01hv8x29kz0t586xy6zn1a62ny",
    customerId: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
    status: "active",
    currentPeriodEnd: "2026-12-15T10:00:00.000000Z",
    cancelAtPeriodEnd: false,
    checkoutNonce: "n-1",
    transactionId: "txn_01hv8wptq8987qeep44cyrewp9",
    planRef: "pri_01gsz8x8sawmvhz1pv30nge1ke",
  });
});

test("a scheduled cancellation keeps access until the paid period ends and is flagged", () => {
  const raw = paddleSubscriptionEvent({ scheduledChange: { action: "cancel", effective_at: "2026-12-15T10:00:00.000000Z", resume_at: null } });
  const sub = provider().verifyWebhook(raw, headers(raw), NOW).subscription!;
  assert.equal(sub.status, "active");
  assert.equal(sub.cancelAtPeriodEnd, true);
  assert.equal(sub.currentPeriodEnd, "2026-12-15T10:00:00.000000Z");
});

test("a scheduled pause is not a cancellation", () => {
  const raw = paddleSubscriptionEvent({ scheduledChange: { action: "pause", effective_at: "2026-12-15T10:00:00.000000Z", resume_at: null } });
  assert.equal(provider().verifyWebhook(raw, headers(raw), NOW).subscription!.cancelAtPeriodEnd, false);
});

test("status mapping: active, trialing, past_due, paused, canceled", () => {
  for (const [status, expected] of [["active", "active"], ["trialing", "trialing"], ["past_due", "past_due"], ["paused", "paused"], ["canceled", "canceled"]] as const) {
    const raw = paddleSubscriptionEvent({ status });
    assert.equal(provider().verifyWebhook(raw, headers(raw), NOW).subscription!.status, expected, status);
  }
});

test("a canceled subscription has no paid period left", () => {
  const raw = paddleSubscriptionEvent({ status: "canceled", periodEnd: null });
  const sub = provider().verifyWebhook(raw, headers(raw), NOW).subscription!;
  assert.equal(sub.status, "canceled");
  assert.equal(sub.currentPeriodEnd, null);
});

test("an unknown status never grants access: it is treated as paused", () => {
  const raw = paddleSubscriptionEvent({ status: "some_future_status" });
  assert.equal(provider().verifyWebhook(raw, headers(raw), NOW).subscription!.status, "paused");
});

test("missing custom_data yields no nonce but still carries the transaction id for the fallback lookup", () => {
  const raw = paddleSubscriptionEvent({ nonce: null });
  const sub = provider().verifyWebhook(raw, headers(raw), NOW).subscription!;
  assert.equal(sub.checkoutNonce, null);
  assert.equal(sub.transactionId, "txn_01hv8wptq8987qeep44cyrewp9");
});

test("events that are not about a subscription are verified but carry no snapshot", () => {
  const raw = paddleOtherEvent();
  const event = provider().verifyWebhook(raw, headers(raw), NOW);
  assert.equal(event.type, "transaction.completed");
  assert.equal(event.subscription, null);
});

test("every subscription.* event type is handled the same way (the payload is a full snapshot)", () => {
  for (const eventType of ["subscription.created", "subscription.activated", "subscription.updated", "subscription.canceled", "subscription.past_due", "subscription.paused", "subscription.resumed", "subscription.trialing"]) {
    const raw = paddleSubscriptionEvent({ eventType });
    assert.ok(provider().verifyWebhook(raw, headers(raw), NOW).subscription, eventType);
  }
});

test("the header name is matched case-insensitively", () => {
  const raw = paddleSubscriptionEvent();
  const bag = headerBag({ "PADDLE-SIGNATURE": signPaddleWebhook(SECRET, raw, TS) });
  assert.ok(provider().verifyWebhook(raw, bag, NOW));
});

// ---------------------------------------------------------------- rejection

test("rejects a missing signature header", () => {
  rejects(() => provider().verifyWebhook(paddleSubscriptionEvent(), headerBag({}), NOW), "missing_header");
});

test("rejects a body that changed by even one character, including whitespace (raw bytes are what is signed)", () => {
  const raw = paddleSubscriptionEvent();
  const h = headers(raw);
  rejects(() => provider().verifyWebhook(raw + " ", h, NOW), "bad_signature");
  rejects(() => provider().verifyWebhook(raw.replace("active", "actives"), h, NOW), "bad_signature");
  rejects(() => provider().verifyWebhook(JSON.stringify(JSON.parse(raw)), h, NOW), "bad_signature");
});

test("rejects a signature made with another secret (e.g. sandbox key against live endpoint)", () => {
  const raw = paddleSubscriptionEvent();
  rejects(() => provider().verifyWebhook(raw, headers(raw, TS, "pdl_ntfset_someone_else"), NOW), "bad_signature");
});

test("rejects a replay outside the time window, in either direction", () => {
  const raw = paddleSubscriptionEvent();
  const old = TS - Math.ceil(PADDLE_TOLERANCE_MS / 1000) - 5;
  const future = TS + Math.ceil(PADDLE_TOLERANCE_MS / 1000) + 5;
  rejects(() => provider().verifyWebhook(raw, headers(raw, old), NOW), "stale");
  rejects(() => provider().verifyWebhook(raw, headers(raw, future), NOW), "stale");
  assert.ok(provider().verifyWebhook(raw, headers(raw, TS - 60), NOW), "a minute of clock drift is fine");
});

test("the tolerance is configurable", () => {
  const raw = paddleSubscriptionEvent();
  rejects(() => provider({ toleranceMs: 1000 }).verifyWebhook(raw, headers(raw, TS - 10), NOW), "stale");
});

test("secret rotation: any matching h1 is enough, and a header with only wrong ones is refused", () => {
  const raw = paddleSubscriptionEvent();
  const good = signPaddleWebhook(SECRET, raw, TS).split(";h1=")[1];
  const rotating = headerBag({ "paddle-signature": `ts=${TS};h1=${"0".repeat(64)};h1=${good}` });
  assert.ok(provider().verifyWebhook(raw, rotating, NOW));
  const wrong = headerBag({ "paddle-signature": `ts=${TS};h1=${"0".repeat(64)};h1=${"f".repeat(64)}` });
  rejects(() => provider().verifyWebhook(raw, wrong, NOW), "bad_signature");
});

test("signatures of the wrong length or non-hex are refused without throwing a different error", () => {
  const raw = paddleSubscriptionEvent();
  for (const sig of ["ab", "z".repeat(64), "A".repeat(200)]) {
    rejects(() => provider().verifyWebhook(raw, headerBag({ "paddle-signature": `ts=${TS};h1=${sig}` }), NOW), "bad_signature");
  }
});

test("a validly signed but unusable body is rejected as bad_body", () => {
  const notJson = "this is not json";
  rejects(() => provider().verifyWebhook(notJson, headers(notJson), NOW), "bad_body");
  const missing = JSON.stringify({ event_type: "subscription.updated", data: {} });
  rejects(() => provider().verifyWebhook(missing, headers(missing), NOW), "bad_body");
  const badDate = JSON.stringify({ event_id: "e", event_type: "x", occurred_at: "yesterday" });
  rejects(() => provider().verifyWebhook(badDate, headers(badDate), NOW), "bad_body");
});

test("an unconfigured secret refuses everything instead of accepting unsigned input", () => {
  const raw = paddleSubscriptionEvent();
  rejects(() => provider({ webhookSecret: "" }).verifyWebhook(raw, headers(raw), NOW), "not_configured");
});

// ---------------------------------------------------------------- API calls

test("createCheckout posts a transaction tagged with our nonce and returns Paddle's checkout link", async () => {
  const stub = stubFetch({ status: 201, json: { data: { id: "txn_123", checkout: { url: "https://pay.example.com/pay?_ptxn=txn_123" } } } });
  const result = await provider({ fetch: stub.fetch }).createCheckout({ nonce: "n-42", returnUrl: "https://x" });
  assert.deepEqual(result, { url: "https://pay.example.com/pay?_ptxn=txn_123", reference: "txn_123" });
  const [call] = stub.calls;
  assert.equal(call!.url, `${PADDLE_HOSTS.sandbox}/transactions`);
  assert.equal(call!.method, "POST");
  assert.equal(call!.headers.authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(call!.body, { items: [{ price_id: "pri_team", quantity: 1 }], collection_mode: "automatic", custom_data: { ard_checkout: "n-42" } });
});

test("production mode talks to the production host", async () => {
  const stub = stubFetch({ json: { data: { id: "txn_1", checkout: { url: "https://p/pay" } } } });
  await provider({ fetch: stub.fetch, environment: "production" }).createCheckout({ nonce: "n", returnUrl: "https://x" });
  assert.equal(stub.calls[0]!.url, `${PADDLE_HOSTS.production}/transactions`);
});

test("API errors explain what Paddle said but never leak the API key", async () => {
  const stub = stubFetch({ status: 403, json: { error: { type: "request_error", code: "forbidden", detail: "You do not have permission to create transactions" } } });
  await assert.rejects(
    () => provider({ fetch: stub.fetch }).createCheckout({ nonce: "n", returnUrl: "https://x" }),
    (e: unknown) => e instanceof BillingApiError && e.status === 403 && /permission/.test(e.message) && !e.message.includes(API_KEY),
  );
});

test("a transaction without a checkout link tells the operator how to fix it", async () => {
  const stub = stubFetch({ status: 201, json: { data: { id: "txn_1", checkout: null } } });
  await assert.rejects(() => provider({ fetch: stub.fetch }).createCheckout({ nonce: "n", returnUrl: "https://x" }), /default payment link/);
});

test("network failures and unreadable answers become BillingApiError without secrets", async () => {
  const down = stubFetch({ throws: new Error(`connect ECONNREFUSED while sending ${API_KEY}`) });
  await assert.rejects(
    () => provider({ fetch: down.fetch }).createCheckout({ nonce: "n", returnUrl: "https://x" }),
    (e: unknown) => e instanceof BillingApiError && e.status === null && !e.message.includes(API_KEY),
  );
  const junk = stubFetch({ status: 200, text: "<html>oops</html>" });
  await assert.rejects(() => provider({ fetch: junk.fetch }).createCheckout({ nonce: "n", returnUrl: "https://x" }), /unreadable/);
});

test("a timeout is reported as such", async () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const stub = stubFetch({ throws: timeout });
  await assert.rejects(() => provider({ fetch: stub.fetch }).createCheckout({ nonce: "n", returnUrl: "https://x" }), /did not answer/);
});

test("createPortalSession deep-links to the subscription, falling back to the overview", async () => {
  const deep = stubFetch({ status: 201, json: { data: { urls: { general: { overview: "https://portal/overview" }, subscriptions: [{ id: "sub_1", view_subscription: "https://portal/sub_1" }] } } } });
  assert.deepEqual(await provider({ fetch: deep.fetch }).createPortalSession({ customerId: "ctm_1", subscriptionId: "sub_1", returnUrl: "https://x" }), { url: "https://portal/sub_1" });
  assert.equal(deep.calls[0]!.url, `${PADDLE_HOSTS.sandbox}/customers/ctm_1/portal-sessions`);
  assert.deepEqual(deep.calls[0]!.body, { subscription_ids: ["sub_1"] });

  const plain = stubFetch({ status: 201, json: { data: { urls: { general: { overview: "https://portal/overview" }, subscriptions: [] } } } });
  assert.deepEqual(await provider({ fetch: plain.fetch }).createPortalSession({ customerId: "ctm_1", returnUrl: "https://x" }), { url: "https://portal/overview" });
  assert.deepEqual(plain.calls[0]!.body, {});
});

test("a customer id is URL-encoded so it cannot change the request path", async () => {
  const stub = stubFetch({ status: 201, json: { data: { urls: { general: { overview: "https://portal/o" } } } } });
  await provider({ fetch: stub.fetch }).createPortalSession({ customerId: "../../transactions", returnUrl: "https://x" });
  assert.ok(stub.calls[0]!.url.includes("..%2F..%2Ftransactions"), stub.calls[0]!.url);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GRACE_DAYS, entitlementFor, type EntitlementInput } from "./entitlement.js";
import { providersFromEnv } from "./index.js";

const NOW = new Date("2026-11-15T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const sub = (over: Partial<EntitlementInput> = {}): EntitlementInput => ({ status: "active", currentPeriodEnd: "2026-12-15T00:00:00Z", cancelAtPeriodEnd: false, ...over });

test("no subscription means no access", () => {
  assert.deepEqual(entitlementFor(null, NOW), { active: false, reason: "no_subscription", until: null });
});

test("active and trialing grant access", () => {
  assert.deepEqual(entitlementFor(sub(), NOW), { active: true, reason: "active", until: null });
  assert.equal(entitlementFor(sub({ status: "trialing" }), NOW).reason, "trialing");
});

test("an active subscription set to cancel still works, and says until when", () => {
  assert.deepEqual(entitlementFor(sub({ cancelAtPeriodEnd: true }), NOW), { active: true, reason: "active", until: "2026-12-15T00:00:00Z" });
});

test("past_due keeps access during the grace period, then stops", () => {
  const since = new Date(NOW.getTime() - 3 * DAY).toISOString();
  const within = entitlementFor(sub({ status: "past_due", pastDueSince: since }), NOW);
  assert.equal(within.active, true);
  assert.equal(within.reason, "grace_period");
  assert.equal(within.until, new Date(NOW.getTime() - 3 * DAY + DEFAULT_GRACE_DAYS * DAY).toISOString());

  const long = new Date(NOW.getTime() - (DEFAULT_GRACE_DAYS + 1) * DAY).toISOString();
  assert.deepEqual(entitlementFor(sub({ status: "past_due", pastDueSince: long }), NOW), { active: false, reason: "payment_failed", until: null });
});

test("the grace period is configurable, and an unknown start is treated generously rather than locking the team out", () => {
  const since = new Date(NOW.getTime() - 2 * DAY).toISOString();
  assert.equal(entitlementFor(sub({ status: "past_due", pastDueSince: since }), NOW, 1).active, false);
  assert.equal(entitlementFor(sub({ status: "past_due", pastDueSince: null }), NOW).active, true);
});

test("canceled / expired grant access only for a period that was already paid for", () => {
  assert.deepEqual(entitlementFor(sub({ status: "canceled", currentPeriodEnd: "2026-11-20T00:00:00Z" }), NOW), { active: true, reason: "paid_until_period_end", until: "2026-11-20T00:00:00Z" });
  assert.deepEqual(entitlementFor(sub({ status: "canceled", currentPeriodEnd: "2026-11-10T00:00:00Z" }), NOW), { active: false, reason: "ended", until: null });
  assert.equal(entitlementFor(sub({ status: "expired", currentPeriodEnd: null }), NOW).active, false);
  assert.equal(entitlementFor(sub({ status: "canceled", currentPeriodEnd: "not a date" }), NOW).active, false);
});

test("paused and never-paid grant nothing", () => {
  assert.deepEqual(entitlementFor(sub({ status: "paused" }), NOW), { active: false, reason: "paused", until: null });
  assert.deepEqual(entitlementFor(sub({ status: "incomplete" }), NOW), { active: false, reason: "never_paid", until: null });
});

// ---------------------------------------------------------------- environment

const paddleEnv = { ARD_PADDLE_API_KEY: "k", ARD_PADDLE_WEBHOOK_SECRET: "s", ARD_PADDLE_PRICE_ID: "pri_1" };
const dodoEnv = { ARD_DODO_API_KEY: "k", ARD_DODO_WEBHOOK_SECRET: "whsec_" + Buffer.from("x").toString("base64"), ARD_DODO_PRODUCT_ID: "pdt_1" };

test("providersFromEnv enables each provider only when fully configured", () => {
  assert.equal(providersFromEnv({}).providers.size, 0);
  assert.deepEqual([...providersFromEnv(paddleEnv).providers.keys()], ["paddle"]);
  assert.deepEqual([...providersFromEnv(dodoEnv).providers.keys()], ["dodo"]);
  assert.deepEqual([...providersFromEnv({ ...paddleEnv, ...dodoEnv }).providers.keys()].sort(), ["dodo", "paddle"]);
});

test("a half-configured provider is disabled with a warning that says what is missing", () => {
  const result = providersFromEnv({ ARD_PADDLE_API_KEY: "k" });
  assert.equal(result.providers.size, 0);
  assert.match(result.warnings[0]!, /Paddle is partly configured/);
  assert.match(providersFromEnv({ ARD_DODO_PRODUCT_ID: "p" }).warnings[0]!, /Dodo Payments is partly configured/);
});

test("both providers default to sandbox / test mode; going live must be explicit and typos are refused", () => {
  assert.equal(providersFromEnv(paddleEnv).providers.size, 1);
  assert.equal(providersFromEnv({ ...paddleEnv, ARD_PADDLE_ENV: "production" }).providers.size, 1);
  const typo = providersFromEnv({ ...paddleEnv, ARD_PADDLE_ENV: "prod" });
  assert.equal(typo.providers.size, 0);
  assert.match(typo.warnings[0]!, /sandbox.*production/);
  assert.equal(providersFromEnv({ ...dodoEnv, ARD_DODO_ENV: "live_mode" }).providers.size, 1);
  assert.match(providersFromEnv({ ...dodoEnv, ARD_DODO_ENV: "live" }).warnings[0]!, /test_mode.*live_mode/);
});

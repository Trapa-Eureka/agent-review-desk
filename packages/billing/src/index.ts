export * from "./types.js";
export * from "./entitlement.js";
export { headerBag, type FetchLike } from "./http.js";
export { PaddleProvider, parsePaddleSignature, signPaddleWebhook, PADDLE_HOSTS, PADDLE_TOLERANCE_MS, type PaddleConfig } from "./paddle.js";
export { DodoProvider, signDodoWebhook, dodoSecretKey, DODO_HOSTS, DODO_TOLERANCE_MS, type DodoConfig } from "./dodo.js";

import { DodoProvider } from "./dodo.js";
import { PaddleProvider } from "./paddle.js";
import type { BillingProvider, ProviderId } from "./types.js";

export interface ProvidersFromEnv {
  providers: Map<ProviderId, BillingProvider>;
  /** Providers that are partly configured: told to the operator at startup instead of failing at the first checkout. */
  warnings: string[];
}

/**
 * Read provider settings from the environment. A provider is enabled only when ALL of its values are present,
 * and both default to their test/sandbox mode: going live is a deliberate act (`..._ENV=production|live_mode`).
 *
 *   ARD_PADDLE_API_KEY  ARD_PADDLE_WEBHOOK_SECRET  ARD_PADDLE_PRICE_ID    [ARD_PADDLE_ENV=sandbox|production]
 *   ARD_DODO_API_KEY    ARD_DODO_WEBHOOK_SECRET    ARD_DODO_PRODUCT_ID    [ARD_DODO_ENV=test_mode|live_mode]
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ProvidersFromEnv {
  const providers = new Map<ProviderId, BillingProvider>();
  const warnings: string[] = [];
  const read = (name: string) => (env[name] && env[name] !== "" ? env[name]! : undefined);

  const paddle = { apiKey: read("ARD_PADDLE_API_KEY"), webhookSecret: read("ARD_PADDLE_WEBHOOK_SECRET"), priceId: read("ARD_PADDLE_PRICE_ID") };
  if (paddle.apiKey || paddle.webhookSecret || paddle.priceId) {
    const environment = read("ARD_PADDLE_ENV") ?? "sandbox";
    if (!paddle.apiKey || !paddle.webhookSecret || !paddle.priceId) warnings.push("Paddle is partly configured: set ARD_PADDLE_API_KEY, ARD_PADDLE_WEBHOOK_SECRET and ARD_PADDLE_PRICE_ID together. It is disabled.");
    else if (environment !== "sandbox" && environment !== "production") warnings.push(`ARD_PADDLE_ENV must be "sandbox" or "production" (got "${environment}"). Paddle is disabled.`);
    else providers.set("paddle", new PaddleProvider({ apiKey: paddle.apiKey, webhookSecret: paddle.webhookSecret, priceId: paddle.priceId, environment }));
  }

  const dodo = { apiKey: read("ARD_DODO_API_KEY"), webhookSecret: read("ARD_DODO_WEBHOOK_SECRET"), productId: read("ARD_DODO_PRODUCT_ID") };
  if (dodo.apiKey || dodo.webhookSecret || dodo.productId) {
    const environment = read("ARD_DODO_ENV") ?? "test_mode";
    if (!dodo.apiKey || !dodo.webhookSecret || !dodo.productId) warnings.push("Dodo Payments is partly configured: set ARD_DODO_API_KEY, ARD_DODO_WEBHOOK_SECRET and ARD_DODO_PRODUCT_ID together. It is disabled.");
    else if (environment !== "test_mode" && environment !== "live_mode") warnings.push(`ARD_DODO_ENV must be "test_mode" or "live_mode" (got "${environment}"). Dodo Payments is disabled.`);
    else providers.set("dodo", new DodoProvider({ apiKey: dodo.apiKey, webhookSecret: dodo.webhookSecret, productId: dodo.productId, environment }));
  }
  return { providers, warnings };
}

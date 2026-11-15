import { createHmac, timingSafeEqual } from "node:crypto";
import { BillingApiError, type HeaderBag, type ProviderId } from "./types.js";

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export const API_TIMEOUT_MS = 10_000;

/** Wrap a plain header map (e.g. from a test or another framework) as a case-insensitive HeaderBag. */
export function headerBag(map: Record<string, string | undefined>): HeaderBag {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/** Constant-time comparison of two strings of any length (false when lengths differ). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hmacSha256(key: string | Buffer, data: string, encoding: "hex" | "base64"): string {
  return createHmac("sha256", key).update(data, "utf8").digest(encoding);
}

/** Is `timestampSeconds` within `toleranceMs` of `now`, in either direction? */
export function withinTolerance(timestampSeconds: number, now: Date, toleranceMs: number): boolean {
  return Number.isFinite(timestampSeconds) && Math.abs(now.getTime() - timestampSeconds * 1000) <= toleranceMs;
}

/**
 * Call a provider's JSON API. Errors carry the provider's own explanation when it gives one, but never the
 * request headers, so an API key cannot end up in a log or an error page.
 */
export async function callJson(provider: ProviderId, fetchImpl: FetchLike, url: string, apiKey: string, method: "POST" | "GET", body?: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json", ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = (error as { name?: string }).name === "TimeoutError" || (error as { name?: string }).name === "AbortError";
    throw new BillingApiError(provider, null, timedOut ? `${provider} did not answer within ${API_TIMEOUT_MS / 1000}s` : `could not reach ${provider}`);
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    // keep null; handled below
  }
  if (!response.ok) throw new BillingApiError(provider, response.status, `${provider} rejected the request (HTTP ${response.status})${describeError(json)}`);
  if (json === null) throw new BillingApiError(provider, response.status, `${provider} returned an unreadable response`);
  return json;
}

/** Pull a short human explanation out of the common error shapes, bounded in length. */
function describeError(json: unknown): string {
  if (typeof json !== "object" || json === null) return "";
  const o = json as Record<string, unknown>;
  const nested = typeof o.error === "object" && o.error !== null ? (o.error as Record<string, unknown>) : {};
  const text = [nested.detail, nested.code, o.message, o.error, o.code].find((v): v is string => typeof v === "string" && v !== "");
  return text ? `: ${text.slice(0, 200)}` : "";
}

export const asRecord = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const asString = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

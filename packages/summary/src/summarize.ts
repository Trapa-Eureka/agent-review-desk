import Anthropic from "@anthropic-ai/sdk";
import { systemKeyStore, type KeyStore } from "@ard/core";
import { SUMMARY_SYSTEM_PROMPT, summaryUserPrompt } from "./prompt.js";

/** Models this feature will use. The request shape (adaptive thinking, `effort`) is the one these models accept. */
export const SUMMARY_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export const DEFAULT_SUMMARY_MODEL = "claude-opus-5-5";
/** Thinking tokens count toward this on the newest models, so it is not set tight. */
const MAX_TOKENS = 16_000;
const TIMEOUT_MS = 120_000;

export type KeySource = "environment" | "keychain";

export interface SummaryConfig {
  /** An API key is available (in the environment or in the keychain). */
  available: boolean;
  /** Where it would come from. The environment wins when both exist. */
  source: KeySource | null;
  model: string;
  /** Set when ARD_SUMMARY_MODEL named something this feature does not use. */
  warning?: string;
}

const envKey = (env: NodeJS.ProcessEnv): string | null => (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== "" ? env.ANTHROPIC_API_KEY.trim() : null);

/**
 * The person's own key. It comes from exactly two places: the ANTHROPIC_API_KEY environment variable of the terminal that
 * started `ard review`, or the operating system's keychain (saved with `ard key set`). Never a file in a project folder.
 * The key is never written to disk by this code, logged, put in a URL or sent to the browser.
 *
 * `store` is the keychain to look in (null: none). The default is this system's own.
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env, store: KeyStore | null = systemKeyStore()): { key: string; source: KeySource } | null {
  const fromEnv = envKey(env);
  if (fromEnv) return { key: fromEnv, source: "environment" };
  const stored = store?.get() ?? null;
  return stored ? { key: stored, source: "keychain" } : null;
}

/** Is there a key, and where from? Looking in the keychain only checks that an entry exists: it does not read the key. */
export function summaryConfig(env: NodeJS.ProcessEnv = process.env, store: KeyStore | null = systemKeyStore()): SummaryConfig {
  const source: KeySource | null = envKey(env) ? "environment" : store?.has() ? "keychain" : null;
  const wanted = env.ARD_SUMMARY_MODEL?.trim();
  const base = { available: source !== null, source };
  if (wanted && (SUMMARY_MODELS as readonly string[]).includes(wanted)) return { ...base, model: wanted };
  return { ...base, model: DEFAULT_SUMMARY_MODEL, ...(wanted ? { warning: `ARD_SUMMARY_MODEL="${wanted.slice(0, 60)}" is not supported here; using ${DEFAULT_SUMMARY_MODEL}. Choose one of: ${SUMMARY_MODELS.join(", ")}.` } : {}) };
}

export type SummaryErrorCode = "no_key" | "auth" | "rate_limited" | "bad_request" | "unavailable" | "refused" | "empty";

export class SummaryError extends Error {
  constructor(
    message: string,
    readonly code: SummaryErrorCode,
  ) {
    super(message);
  }
}

export interface MessageLike {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

/** The one call this module makes. A stand-in with the same shape is used in tests. */
export interface MessagesClient {
  create(params: Record<string, unknown>): Promise<MessageLike>;
}

export interface SummaryResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /** The reply was cut off by the length limit. */
  truncated: boolean;
}

export const NO_KEY_MESSAGE = "No Anthropic API key found. Run `ard key set` to save one in your keychain, or set ANTHROPIC_API_KEY in the terminal where you run `ard review`, then start it again.";

export function clientFromKey(apiKey: string): MessagesClient {
  if (apiKey.trim() === "") throw new SummaryError(NO_KEY_MESSAGE, "no_key");
  const sdk = new Anthropic({ apiKey: apiKey.trim(), timeout: TIMEOUT_MS, maxRetries: 2 });
  return { create: (params) => sdk.beta.messages.create(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming) as unknown as Promise<MessageLike> };
}

/** Make sure no message we show can contain the key, whatever an error happens to say. */
export function scrub(text: string, key: string | undefined): string {
  let out = text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
  if (key && key.length >= 8) out = out.split(key).join("[REDACTED]");
  return out;
}

function explain(error: unknown, key: string | undefined): SummaryError {
  if (error instanceof SummaryError) return error;
  const detail = (e: unknown) => scrub(e instanceof Error ? e.message : String(e), key).slice(0, 300);
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new SummaryError("Anthropic did not accept the API key (it may be wrong, revoked, or without access to this model). Check ANTHROPIC_API_KEY.", "auth");
  }
  if (error instanceof Anthropic.RateLimitError) return new SummaryError("Anthropic says you are sending too many requests or have hit a limit. Wait a minute and try again.", "rate_limited");
  if (error instanceof Anthropic.BadRequestError) return new SummaryError(`Anthropic refused the request: ${detail(error)}`, "bad_request");
  if (error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.APIConnectionTimeoutError) return new SummaryError("Could not reach Anthropic (network problem or timeout). Try again.", "unavailable");
  if (error instanceof Anthropic.APIError) {
    return new SummaryError(error.status === 529 || (error.status ?? 0) >= 500 ? "Anthropic is busy or having problems right now. Try again in a moment." : `Anthropic returned an error (${error.status ?? "unknown"}): ${detail(error)}`, "unavailable");
  }
  return new SummaryError(`The summary failed: ${detail(error)}`, "unavailable");
}

/**
 * Ask Claude to summarize a digest. One request, text in, text out.
 * Request notes for the newest models: no sampling parameters (temperature/top_p/top_k are rejected), thinking is left at
 * its default (always on; `disabled` is a 400), `effort` is set low because this is a short summary, and server-side
 * fallbacks are on so a safety-classifier decline (for example while summarizing a security-related session) is retried
 * on a substitute model instead of simply failing.
 */
export async function requestSummary(input: { digest: string; model: string; client: MessagesClient; key?: string }): Promise<SummaryResult> {
  let response: MessageLike;
  try {
    response = await input.client.create({
      model: input.model,
      max_tokens: MAX_TOKENS,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: summaryUserPrompt(input.digest) }],
    });
  } catch (error) {
    throw explain(error, input.key);
  }

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category;
    throw new SummaryError(`The model declined to summarize this session${category ? ` (${category})` : ""}. Read the timeline instead.`, "refused");
  }
  const text = response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
  if (text === "") throw new SummaryError("The model returned no text. Try again.", "empty");
  return {
    text: scrub(text, input.key),
    model: response.model,
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    truncated: response.stop_reason === "max_tokens",
  };
}

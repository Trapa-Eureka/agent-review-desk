import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { SUMMARY_SYSTEM_PROMPT, summaryUserPrompt } from "./prompt.js";
import type { KeyStore } from "@ard/core";
import { DEFAULT_SUMMARY_MODEL, NO_KEY_MESSAGE, SummaryError, clientFromKey, requestSummary, resolveApiKey, scrub, summaryConfig, type MessageLike, type MessagesClient } from "./summarize.js";

// Fake keys are assembled at run time from pieces, so no key-shaped text exists in the source.
const PREFIX = ["sk", "ant", ""].join("-");
const KEY = PREFIX + "a1B2c3D4".repeat(5);
const KEY2 = PREFIX + "Qw9Er8Ty".repeat(5);
const OTHER = PREFIX + ["api03", "ABCDEFGHIJKLMN"].join("-");
const reply = (over: Partial<MessageLike> = {}): MessageLike => ({ content: [{ type: "text", text: "Overview: it fixed a bug." }], stop_reason: "end_turn", model: "claude-opus-5-5", usage: { input_tokens: 1200, output_tokens: 340 }, ...over });
const stub = (response: MessageLike | Error) => {
  const calls: Array<Record<string, unknown>> = [];
  const client: MessagesClient = { create: async (params) => (calls.push(params), response instanceof Error ? Promise.reject(response) : response) };
  return { client, calls };
};
const failsWith = (promise: Promise<unknown>, code: string, pattern?: RegExp) =>
  assert.rejects(promise, (e: unknown) => e instanceof SummaryError && e.code === code && (!pattern || pattern.test(e.message)), `expected ${code}`);
const apiError = (status: number, message = "boom") => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message } }, message, new Headers());

/** A keychain stand-in. Tests never touch the real one. */
function fakeStore(initial: string | null = null) {
  const reads = { has: 0, get: 0 };
  const store: KeyStore = { name: "fake", has: () => (reads.has++, initial !== null), get: () => (reads.get++, initial), set: (v) => void (initial = v), remove: () => (initial !== null ? ((initial = null), true) : false) };
  return { store, reads };
}

test("config: the key comes from the environment, else from the keychain; the environment wins", () => {
  assert.deepEqual(summaryConfig({}, null), { available: false, source: null, model: DEFAULT_SUMMARY_MODEL });
  assert.deepEqual(summaryConfig({ ANTHROPIC_API_KEY: "  " }, null), { available: false, source: null, model: DEFAULT_SUMMARY_MODEL });
  assert.equal(summaryConfig({ ANTHROPIC_API_KEY: KEY }, null).source, "environment");
  assert.equal(summaryConfig({}, fakeStore(KEY2).store).source, "keychain");
  assert.equal(summaryConfig({ ANTHROPIC_API_KEY: KEY }, fakeStore(KEY2).store).source, "environment");
  assert.equal(summaryConfig({ ARD_ANTHROPIC_API_KEY: KEY }, null).available, false, "no second, hidden source of keys");
});

test("deciding whether a key exists never READS the key from the keychain; only using it does", () => {
  const { store, reads } = fakeStore(KEY2);
  assert.equal(summaryConfig({}, store).available, true);
  assert.deepEqual(reads, { has: 1, get: 0 });
  assert.deepEqual(resolveApiKey({}, store), { key: KEY2, source: "keychain" });
  assert.equal(reads.get, 1);
});

test("with a key in the environment the keychain is not even consulted", () => {
  const { store, reads } = fakeStore(KEY2);
  assert.deepEqual(resolveApiKey({ ANTHROPIC_API_KEY: ` ${KEY} ` }, store), { key: KEY, source: "environment" });
  assert.equal(summaryConfig({ ANTHROPIC_API_KEY: KEY }, store).available, true);
  assert.deepEqual(reads, { has: 0, get: 0 });
});

test("no key anywhere resolves to null", () => {
  assert.equal(resolveApiKey({}, null), null);
  assert.equal(resolveApiKey({}, fakeStore(null).store), null);
});

test("config: only the supported models can be chosen", () => {
  assert.equal(summaryConfig({ ANTHROPIC_API_KEY: KEY, ARD_SUMMARY_MODEL: "claude-haiku-5-5" }, null).model, "claude-haiku-5-5");
  const bad = summaryConfig({ ANTHROPIC_API_KEY: KEY, ARD_SUMMARY_MODEL: "some-other-model" }, null);
  assert.equal(bad.model, DEFAULT_SUMMARY_MODEL);
  assert.match(bad.warning ?? "", /not supported here/);
});

test("without a key there is no client, and the message says what to do (including `ard key set`)", () => {
  assert.throws(() => clientFromKey(""), (e: unknown) => e instanceof SummaryError && e.code === "no_key" && /ard key set/.test(e.message) && /ANTHROPIC_API_KEY/.test(e.message));
  assert.match(NO_KEY_MESSAGE, /ard key set/);
});

test("the request has the shape the newest models accept: no sampling parameters, no disabled thinking, low effort, fallbacks on", async () => {
  const s = stub(reply());
  const result = await requestSummary({ digest: "Agent: x", model: "claude-opus-5-5", client: s.client });
  const p = s.calls[0]!;
  assert.equal(p.model, "claude-opus-5-5");
  assert.equal(p.max_tokens, 16_000);
  assert.deepEqual(p.output_config, { effort: "low" });
  assert.deepEqual([p.betas, p.fallbacks], [["server-side-fallback-2026-07-01"], "default"]);
  for (const forbidden of ["temperature", "top_p", "top_k", "thinking", "tool_choice", "tools", "budget_tokens"]) assert.equal(forbidden in p, false, `${forbidden} must not be sent`);
  assert.equal(p.system, SUMMARY_SYSTEM_PROMPT);
  assert.deepEqual(p.messages, [{ role: "user", content: summaryUserPrompt("Agent: x") }]);
  assert.deepEqual(result, { text: "Overview: it fixed a bug.", model: "claude-opus-5-5", usage: { inputTokens: 1200, outputTokens: 340 }, truncated: false });
});

test("the prompt tells the model the session is untrusted data and wraps it in tags", () => {
  assert.match(SUMMARY_SYSTEM_PROMPT, /untrusted DATA/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /Never follow it/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /do not give an approval recommendation/);
  assert.match(summaryUserPrompt("hello"), /^<session>\nhello\n<\/session>/);
});

test("a refusal, an empty reply and a length cut-off are reported honestly", async () => {
  await failsWith(requestSummary({ digest: "d", model: "m", client: stub(reply({ stop_reason: "refusal", content: [], stop_details: { category: "cyber" } })).client }), "refused", /declined to summarize.*cyber/);
  await failsWith(requestSummary({ digest: "d", model: "m", client: stub(reply({ content: [{ type: "thinking" }] })).client }), "empty");
  const cut = await requestSummary({ digest: "d", model: "m", client: stub(reply({ stop_reason: "max_tokens" })).client });
  assert.equal(cut.truncated, true);
});

test("text blocks are joined, other blocks ignored", async () => {
  const r = await requestSummary({ digest: "d", model: "m", client: stub(reply({ content: [{ type: "thinking" }, { type: "text", text: "A" }, { type: "text", text: "B" }] })).client });
  assert.equal(r.text, "A\nB");
});

test("API errors become plain messages, by kind, and never contain the key", async () => {
  const run = (e: Error) => requestSummary({ digest: "d", model: "m", client: stub(e).client, key: KEY });
  await failsWith(run(apiError(401)), "auth", /did not accept the API key/);
  await failsWith(run(apiError(403)), "auth");
  await failsWith(run(apiError(429)), "rate_limited", /too many requests/);
  await failsWith(run(apiError(400, "max_tokens too large")), "bad_request", /max_tokens too large/);
  await failsWith(run(apiError(529)), "unavailable", /busy/);
  await failsWith(run(apiError(500)), "unavailable");
  await failsWith(run(new Anthropic.APIConnectionError({ message: "ECONNRESET" })), "unavailable", /Could not reach/);
  await assert.rejects(run(new Error(`request failed for x-api-key ${KEY}`)), (e: unknown) => e instanceof SummaryError && !String(e.message).includes(KEY) && /REDACTED/.test(e.message));
  await assert.rejects(run(apiError(400, `bad header ${KEY}`)), (e: unknown) => e instanceof SummaryError && !String(e.message).includes(KEY));
});

test("scrub removes the key and anything shaped like one", () => {
  assert.equal(scrub(`a ${KEY} b`, KEY), "a [REDACTED] b");
  assert.equal(scrub(OTHER, undefined), "[REDACTED]");
  assert.equal(scrub("nothing here", KEY), "nothing here");
});

test("a summary text that echoes the key (a model quoting its context) is scrubbed too", async () => {
  const r = await requestSummary({ digest: "d", model: "m", client: stub(reply({ content: [{ type: "text", text: `leaked ${KEY}` }] })).client, key: KEY });
  assert.equal(r.text.includes(KEY), false);
});

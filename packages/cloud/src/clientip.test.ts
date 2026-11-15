import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardedClient } from "./clientip.js";

test("one proxy hop: the entry our proxy appended (rightmost), not what the client wrote", () => {
  assert.equal(forwardedClient("203.0.113.9", 1), "203.0.113.9");
  assert.equal(forwardedClient("198.51.100.1, 203.0.113.9", 1), "203.0.113.9");
});

test("ATTACK: a client that sends its own X-Forwarded-For cannot choose its rate-limit key", () => {
  // The client sent "1.2.3.4"; our proxy appended the real address after it.
  const keys = new Set(["1.2.3.4", "5.6.7.8", "9.9.9.9", "random-" + 1].map((spoof) => forwardedClient(`${spoof}, 203.0.113.9`, 1)));
  assert.deepEqual([...keys], ["203.0.113.9"]);
});

test("two hops (CDN + proxy): the second entry from the right", () => {
  assert.equal(forwardedClient("1.2.3.4, 203.0.113.9, 10.0.0.2", 2), "203.0.113.9");
});

test("missing header, too few entries, or nonsense hops fall back to a shared bucket", () => {
  assert.equal(forwardedClient(null, 1), "direct");
  assert.equal(forwardedClient("", 1), "direct");
  assert.equal(forwardedClient(" , ", 1), "direct");
  assert.equal(forwardedClient("203.0.113.9", 2), "direct");
  assert.equal(forwardedClient("203.0.113.9", 0), "direct");
  assert.equal(forwardedClient("203.0.113.9", Number.NaN), "direct");
});

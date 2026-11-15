import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameOriginRequest } from "./csrf.js";

const SITE = "https://cloud.example.com";
const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

test("a browser form post from our own page is allowed even though its Origin is the string 'null' (no-referrer policy)", () => {
  assert.equal(isSameOriginRequest(headers({ "sec-fetch-site": "same-origin", origin: "null" }), SITE), true);
  assert.equal(isSameOriginRequest(headers({ "sec-fetch-site": "same-origin" }), SITE), true);
  assert.equal(isSameOriginRequest(headers({ "sec-fetch-site": "same-origin", origin: SITE }), SITE), true);
});

test("a typed or bookmarked request ('none') is allowed", () => {
  assert.equal(isSameOriginRequest(headers({ "sec-fetch-site": "none" }), SITE), true);
});

test("ATTACK: requests from any other page are refused, whatever Origin claims", () => {
  for (const site of ["cross-site", "same-site", "", "weird"]) {
    assert.equal(isSameOriginRequest(headers({ "sec-fetch-site": site }), SITE), false, site);
    assert.equal(isSameOriginRequest(headers({ "sec-fetch-site": site, origin: SITE }), SITE), false, `${site} with a forged-looking Origin`);
  }
  assert.equal(isSameOriginRequest(headers({ "sec-fetch-site": "cross-site", origin: "null" }), SITE), false);
});

test("without Sec-Fetch-Site (non-browser clients) Origin must match our address exactly", () => {
  assert.equal(isSameOriginRequest(headers({ origin: SITE }), SITE), true);
  for (const origin of ["null", "https://evil.example", "https://cloud.example.com.evil.example", "http://cloud.example.com", "https://cloud.example.com:8443", ""]) {
    assert.equal(isSameOriginRequest(headers({ origin }), SITE), false, origin);
  }
});

test("a request with neither header is refused", () => {
  assert.equal(isSameOriginRequest(headers({}), SITE), false);
});

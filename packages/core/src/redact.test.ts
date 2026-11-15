import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, capString, redactString, safeText, sanitize } from "./redact.js";
import { fake } from "./testutil.js";

test("redacts known token formats", () => {
  for (const secret of [fake.anthropic, fake.github, fake.aws]) {
    const out = redactString(`before ${secret} after`);
    assert.equal(out.includes(secret), false, `still contains secret: ${out}`);
    assert.match(out, /\[REDACTED:/);
  }
});

test("redacts a whole PEM private key block, including its body", () => {
  const out = redactString(`key:\n${fake.pem}\nend`);
  assert.equal(out.includes("MIIBOgIBAAJB"), false);
  assert.match(out, /\[REDACTED:private-key\]/);
});

test("redacts the value of KEY=value and password: value assignments but keeps the name", () => {
  assert.equal(redactString("ANTHROPIC_API_KEY=abc123xyz"), "ANTHROPIC_API_KEY=[REDACTED]");
  assert.equal(redactString('db_password: "hunter2"'), "db_password: [REDACTED]");
  assert.equal(redactString("export GITHUB_TOKEN='abc def'"), "export GITHUB_TOKEN=[REDACTED]");
});

test("leaves empty or unrelated text alone", () => {
  assert.equal(redactString("ANTHROPIC_API_KEY="), "ANTHROPIC_API_KEY=");
  assert.equal(redactString("const x = process.env.ANTHROPIC_API_KEY;"), "const x = process.env.ANTHROPIC_API_KEY;");
  assert.equal(redactString("hello world"), "hello world");
});

test("capString truncates with a marker and reports it", () => {
  const short = capString("abc", 10);
  assert.deepEqual(short, { text: "abc", truncated: false });
  const long = capString("x".repeat(100), 10);
  assert.equal(long.truncated, true);
  assert.match(long.text, /\[truncated 90 chars\]$/);
});

test("safeText redacts before cutting, so a secret on the cut line is never partially exposed", () => {
  const max = 100;
  const text = "a".repeat(max - 10) + fake.anthropic + "tail";
  const out = safeText(text, max);
  assert.equal(out.text.includes("sk-ant"), false);
  assert.equal(out.text.includes("sk-"), false);
});

test("sanitize drops values of secret-named keys and redacts nested strings", () => {
  const out = sanitize({ command: `echo ${fake.github}`, password: "hunter2", nested: { apiKey: "zzz", note: `x ${fake.aws}` } }) as Record<string, unknown>;
  assert.equal(out.password, "[REDACTED]");
  assert.equal((out.nested as Record<string, unknown>).apiKey, "[REDACTED]");
  assert.equal(JSON.stringify(out).includes(fake.github), false);
  assert.equal(JSON.stringify(out).includes(fake.aws), false);
});

test("sanitize caps depth, array length and string size", () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 20; i++) deep = { child: deep };
  assert.match(JSON.stringify(sanitize(deep)), /max depth/);

  const arr = sanitize(Array.from({ length: LIMITS.items + 25 }, (_, i) => i)) as unknown[];
  assert.equal(arr.length, LIMITS.items + 1);
  assert.match(String(arr[arr.length - 1]), /25 more items/);

  const str = sanitize("y".repeat(LIMITS.string + 500)) as string;
  assert.ok(str.length < LIMITS.string + 100);
  assert.match(str, /truncated 500 chars/);
});

test("sanitize passes primitives through", () => {
  assert.equal(sanitize(null), null);
  assert.equal(sanitize(5), 5);
  assert.equal(sanitize(true), true);
  assert.equal(sanitize(undefined), undefined);
});

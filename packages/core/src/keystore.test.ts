import { test } from "node:test";
import assert from "node:assert/strict";
import { API_KEY_PATTERN, KEY_ACCOUNT, KeyStoreError, systemKeyStore, type RunFn, type RunResult } from "./keystore.js";

// Fake keys are assembled at run time from pieces, so no key-shaped text exists in the source.
const KEY = ["sk", "ant", "api03"].join("-") + "-" + "Zq8Lm2Xp".repeat(6);
const KEY2 = ["sk", "ant", "api03"].join("-") + "-" + "Bt5Vn9Rc".repeat(6);

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const fail = (status: number, stderr = "boom"): RunResult => ({ status, stdout: "", stderr });

/** An in-memory stand-in for the macOS `security` tool that records every call. */
function fakeMac() {
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  let stored: string | null = null;
  let silentlyIgnoreWrites = false;
  const run: RunFn = (command, args, input) => {
    calls.push({ command, args, ...(input === undefined ? {} : { input }) });
    if (command !== "security") return fail(127);
    if (args[0] === "find-generic-password") return stored === null ? fail(44) : ok(args.includes("-w") ? `${stored}\n` : "attributes…\n");
    if (args[0] === "-i") {
      const match = /^add-generic-password -a (\S+) -s (\S+) -w (\S+) -U\n$/.exec(input ?? "");
      if (!match) return fail(1, "bad command");
      if (!silentlyIgnoreWrites) stored = match[3]!;
      return ok();
    }
    if (args[0] === "delete-generic-password") {
      if (stored === null) return fail(44);
      stored = null;
      return ok();
    }
    return fail(1);
  };
  return { run, calls, ignoreWrites: () => (silentlyIgnoreWrites = true), get stored() { return stored; } };
}

test("macOS: save, check, read and delete go through the `security` tool, and the key is saved verified", () => {
  const mac = fakeMac();
  const store = systemKeyStore({ platform: "darwin", run: mac.run, service: "test-service" })!;
  assert.equal(store.has(), false);
  assert.equal(store.get(), null);
  store.set(KEY);
  assert.equal(mac.stored, KEY);
  assert.equal(store.has(), true);
  assert.equal(store.get(), KEY);
  store.set(KEY2); // replace
  assert.equal(store.get(), KEY2);
  assert.equal(store.remove(), true);
  assert.equal(store.has(), false);
  assert.equal(store.remove(), false, "nothing left to remove");
});

test("the secret is NEVER in a command line, only on standard input (ps shows arguments to everyone)", () => {
  const mac = fakeMac();
  const store = systemKeyStore({ platform: "darwin", run: mac.run })!;
  store.set(KEY);
  store.get();
  store.has();
  store.remove();
  for (const call of mac.calls) assert.equal(call.args.some((a) => a.includes(KEY)), false, `${call.command} ${call.args.join(" ")}`);
  const writer = mac.calls.find((c) => c.args[0] === "-i")!;
  assert.match(writer.input!, /add-generic-password/);
  assert.ok(writer.input!.includes(KEY));
});

test("checking that a key exists never reads its value (no -w)", () => {
  const mac = fakeMac();
  const store = systemKeyStore({ platform: "darwin", run: mac.run })!;
  store.set(KEY);
  mac.calls.length = 0;
  assert.equal(store.has(), true);
  assert.equal(mac.calls.length, 1);
  assert.equal(mac.calls[0]!.args.includes("-w"), false);
});

test("ATTACK: a pasted value that is not a plain key is refused before ANY command runs (it could add a second command)", () => {
  const mac = fakeMac();
  const store = systemKeyStore({ platform: "darwin", run: mac.run })!;
  const bad = [`${KEY}\ndelete-generic-password -s something-else`, `${KEY} -T /usr/bin/evil`, `"${KEY}"`, `${KEY};rm`, "short", "", " ".repeat(30), `${KEY}\u0000`, "a".repeat(401), "ключ-ключ-ключ-ключ-ключ-ключ"];
  for (const value of bad) {
    assert.throws(() => store.set(value), (e: unknown) => e instanceof KeyStoreError && /does not look like an API key/.test(e.message), JSON.stringify(value).slice(0, 40));
  }
  assert.equal(mac.calls.length, 0, "nothing was run");
  assert.equal(mac.stored, null);
  assert.equal(API_KEY_PATTERN.test(KEY), true);
});

test("macOS: if the Keychain silently did not save (locked), set() says so instead of pretending", () => {
  const mac = fakeMac();
  mac.ignoreWrites();
  const store = systemKeyStore({ platform: "darwin", run: mac.run })!;
  assert.throws(() => store.set(KEY), (e: unknown) => e instanceof KeyStoreError && /did not save the key/.test(e.message));
});

test("macOS: a failing tool is an error on remove, but `has` and `get` just say no", () => {
  const run: RunFn = () => ({ status: null, stdout: "", stderr: "", error: new Error("spawn security ENOENT") });
  const store = systemKeyStore({ platform: "darwin", run })!;
  assert.equal(store.has(), false);
  assert.equal(store.get(), null);
  assert.throws(() => store.set(KEY), KeyStoreError);
  assert.throws(() => store.remove(), KeyStoreError);
});

test("Linux: secret-tool store/lookup/clear, with the secret on standard input", () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  let stored: string | null = null;
  const run: RunFn = (command, args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    if (command !== "secret-tool") return fail(127);
    if (args[0] === "store") return (stored = input ?? null), ok();
    if (args[0] === "lookup") return stored === null ? fail(1) : ok(stored);
    if (args[0] === "clear") return (stored = null), ok();
    return fail(1);
  };
  const store = systemKeyStore({ platform: "linux", run, service: "svc" })!;
  assert.equal(store.has(), false);
  store.set(KEY);
  assert.equal(store.get(), KEY);
  assert.equal(store.has(), true);
  for (const c of calls) assert.equal(c.args.some((a) => a.includes(KEY)), false);
  assert.ok(calls.find((c) => c.args[0] === "store")!.args.includes(KEY_ACCOUNT));
  assert.equal(store.remove(), true);
  assert.equal(store.remove(), false);
});

test("Linux without secret-tool: a clear message, not a crash", () => {
  const enoent = Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" });
  const run: RunFn = () => ({ status: null, stdout: "", stderr: "", error: enoent });
  const store = systemKeyStore({ platform: "linux", run })!;
  assert.equal(store.has(), false);
  assert.throws(() => store.set(KEY), (e: unknown) => e instanceof KeyStoreError && /secret-tool.*not installed/.test(e.message) && /ANTHROPIC_API_KEY/.test(e.message));
});

test("other systems have no keychain", () => {
  assert.equal(systemKeyStore({ platform: "win32" }), null);
  assert.equal(systemKeyStore({ platform: "freebsd" }), null);
});

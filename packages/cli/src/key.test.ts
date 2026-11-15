import { test } from "node:test";
import assert from "node:assert/strict";
import { systemKeyStore, type KeyStore, type RunFn } from "@ard/core";
import { cleanEnv } from "@ard/core/testutil";
import { main, type Io } from "./cli.js";

// Fake keys are assembled at run time from pieces, so no key-shaped text exists in the source.
const KEY = ["sk", "ant", "api03"].join("-") + "-" + "Zq8Lm2Xp".repeat(6);
const OTHER = ["sk", "ant", "api03"].join("-") + "-" + "Bt5Vn9Rc".repeat(6);

/** The macOS `security` tool, in memory. */
function macStore(): { store: KeyStore; stored: () => string | null } {
  let stored: string | null = null;
  const run: RunFn = (_command, args, input) => {
    if (args[0] === "find-generic-password") return stored === null ? { status: 44, stdout: "", stderr: "" } : { status: 0, stdout: args.includes("-w") ? `${stored}\n` : "x\n", stderr: "" };
    if (args[0] === "-i") {
      const m = /-w (\S+) -U/.exec(input ?? "");
      if (m) stored = m[1]!;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "delete-generic-password") {
      if (stored === null) return { status: 44, stdout: "", stderr: "" };
      stored = null;
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
  return { store: systemKeyStore({ platform: "darwin", run })!, stored: () => stored };
}

function harness(over: { secret?: string | Error; store?: KeyStore | null; env?: NodeJS.ProcessEnv } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const io: Io = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    readStdin: async () => "",
    cwd: process.cwd(),
    env: over.env ?? cleanEnv(),
    readSecret: async (prompt) => {
      prompts.push(prompt);
      if (over.secret instanceof Error) throw over.secret;
      return over.secret ?? "";
    },
    ...(over.store === undefined ? {} : { keyStore: over.store }),
  };
  const all = () => [...out, ...err, ...prompts].join("\n");
  return { io, out, err, prompts, all };
}

test("`ard key set` asks without showing, saves to the keychain, and never prints the key", async () => {
  const mac = macStore();
  const h = harness({ secret: `  ${KEY}\n`, store: mac.store });
  assert.equal(await main(["key", "set"], h.io), 0, h.err.join("\n"));
  assert.equal(mac.stored(), KEY, "trimmed and saved");
  assert.match(h.prompts[0]!, /will not be shown/);
  assert.match(h.out.join("\n"), /Saved in the macOS Keychain/);
  assert.equal(h.all().includes(KEY), false, "the key is not echoed anywhere");
});

test("`ard key status` says where a key would come from and never prints it", async () => {
  const mac = macStore();
  let h = harness({ store: mac.store });
  assert.equal(await main(["key", "status"], h.io), 0);
  assert.match(h.out.join("\n"), /no key saved/);
  assert.match(h.out.join("\n"), /would use: none/);
  mac.store.set(KEY);
  h = harness({ store: mac.store });
  await main(["key", "status"], h.io);
  assert.match(h.out.join("\n"), /a key is saved/);
  assert.match(h.out.join("\n"), /would use: the saved keychain key/);
  h = harness({ store: mac.store, env: cleanEnv({ ANTHROPIC_API_KEY: OTHER }) });
  await main(["key", "status"], h.io);
  assert.match(h.out.join("\n"), /set in this terminal/);
  assert.match(h.out.join("\n"), /would use: the environment variable/);
  assert.equal(h.all().includes(KEY) || h.all().includes(OTHER), false);
});

test("`ard key set` mentions that an environment variable still takes precedence", async () => {
  const mac = macStore();
  const h = harness({ secret: KEY, store: mac.store, env: cleanEnv({ ANTHROPIC_API_KEY: OTHER }) });
  assert.equal(await main(["key", "set"], h.io), 0);
  assert.match(h.out.join("\n"), /takes precedence/);
});

test("`ard key remove` deletes it, says so when there was none, and reminds about the environment variable", async () => {
  const mac = macStore();
  mac.store.set(KEY);
  let h = harness({ store: mac.store });
  assert.equal(await main(["key", "remove"], h.io), 0);
  assert.equal(mac.stored(), null);
  assert.match(h.out.join("\n"), /Removed the key/);
  h = harness({ store: mac.store, env: cleanEnv({ ANTHROPIC_API_KEY: OTHER }) });
  assert.equal(await main(["key", "remove"], h.io), 0);
  assert.match(h.out.join("\n"), /No key was saved/);
  assert.match(h.out.join("\n"), /still set in this terminal/);
});

test("ATTACK: a pasted value that is not a plain key is refused and nothing is saved", async () => {
  for (const value of [`${KEY}\ndelete-generic-password -s other`, `${KEY} -T /usr/bin/evil`, "not a key", `"${KEY}"`]) {
    const mac = macStore();
    const h = harness({ secret: value, store: mac.store });
    assert.equal(await main(["key", "set"], h.io), 1, JSON.stringify(value).slice(0, 30));
    assert.match(h.err.join("\n"), /does not look like an API key/);
    assert.equal(mac.stored(), null);
  }
});

test("nothing entered, or cancelled, saves nothing", async () => {
  const mac = macStore();
  const empty = harness({ secret: "  \n", store: mac.store });
  assert.equal(await main(["key", "set"], empty.io), 1);
  assert.match(empty.err.join("\n"), /nothing was entered/);
  const cancelled = harness({ secret: new Error("cancelled"), store: mac.store });
  assert.equal(await main(["key", "set"], cancelled.io), 1);
  assert.match(cancelled.err.join("\n"), /cancelled/);
  assert.equal(mac.stored(), null);
});

test("a key that does not start with sk-ant- is saved with a warning", async () => {
  const mac = macStore();
  const odd = "abcdefghij".repeat(3);
  const h = harness({ secret: odd, store: mac.store });
  assert.equal(await main(["key", "set"], h.io), 0);
  assert.match(h.err.join("\n"), /does not start with sk-ant-/);
  assert.equal(mac.stored(), odd);
});

test("on a system without a keychain, set and remove explain the environment variable, and status still works", async () => {
  for (const action of ["set", "remove"]) {
    const h = harness({ secret: KEY, store: null });
    assert.equal(await main(["key", action], h.io), 1);
    assert.match(h.err.join("\n"), /no supported keychain/);
    assert.match(h.err.join("\n"), /ANTHROPIC_API_KEY/);
  }
  const s = harness({ store: null });
  assert.equal(await main(["key", "status"], s.io), 0);
  assert.match(s.out.join("\n"), /none supported on this system/);
});

test("bad usage exits 2", async () => {
  for (const argv of [["key"], ["key", "show"], ["key", "set", "extra"], ["key", "--help"]]) {
    const h = harness({ store: null });
    assert.equal(await main(argv, h.io), 2, argv.join(" "));
    assert.match(h.err.join("\n"), /usage: ard key set \| status \| remove/);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { CONFIG_FILE, DEFAULT_TIMEOUT_SECONDS, configPath, loadConfig, setApprovals } from "./config.js";
import { makeTmp } from "./testutil.js";

function withDir(fn: (dir: string) => void) {
  const tmp = makeTmp("ard-config-");
  try {
    fn(tmp.dir);
  } finally {
    tmp.cleanup();
  }
}
const write = (dir: string, text: string) => writeFileSync(configPath(dir), text);

test("no config file: approvals are off, defaults apply, no warnings", () => {
  withDir((dir) => {
    assert.deepEqual(loadConfig(dir), { approvals: false, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, rules: {}, warnings: [] });
  });
});

test("a valid config is read", () => {
  withDir((dir) => {
    write(dir, JSON.stringify({ approvals: true, timeoutSeconds: 90, rules: { "git-force-push": "deny", "package-publish": "allow" } }));
    const config = loadConfig(dir);
    assert.equal(config.approvals, true);
    assert.equal(config.timeoutSeconds, 90);
    assert.deepEqual(config.rules, { "git-force-push": "deny", "package-publish": "allow" });
    assert.deepEqual(config.warnings, []);
  });
});

test("a broken config never throws: it falls back to approvals OFF and says why", () => {
  withDir((dir) => {
    write(dir, "{ nope");
    const config = loadConfig(dir);
    assert.equal(config.approvals, false);
    assert.match(config.warnings[0]!, /not valid JSON/);
    write(dir, "[1]");
    assert.match(loadConfig(dir).warnings[0]!, /must contain a JSON object/);
  });
});

test("bad values are ignored one by one, with warnings", () => {
  withDir((dir) => {
    write(dir, JSON.stringify({ approvals: "yes", timeoutSeconds: 1, rules: { "git-force-push": "maybe", "no-such-rule": "deny", "package-publish": "deny" } }));
    const config = loadConfig(dir);
    assert.equal(config.approvals, false);
    assert.equal(config.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
    assert.deepEqual(config.rules, { "package-publish": "deny" });
    assert.equal(config.warnings.length, 4);
    write(dir, JSON.stringify({ timeoutSeconds: 99999 }));
    assert.equal(loadConfig(dir).timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
    write(dir, JSON.stringify({ rules: [] }));
    assert.match(loadConfig(dir).warnings[0]!, /"rules" must be an object/);
  });
});

test("setApprovals creates the file, merges into an existing one, and is idempotent", () => {
  withDir((dir) => {
    assert.deepEqual(setApprovals(dir, true), { path: configPath(dir), created: true, changed: true });
    assert.equal(loadConfig(dir).approvals, true);
    assert.deepEqual(setApprovals(dir, true), { path: configPath(dir), created: false, changed: false });

    write(dir, JSON.stringify({ approvals: false, timeoutSeconds: 60, rules: { "package-publish": "deny" } }));
    setApprovals(dir, true);
    const saved = JSON.parse(readFileSync(configPath(dir), "utf8"));
    assert.deepEqual(saved, { approvals: true, timeoutSeconds: 60, rules: { "package-publish": "deny" } });

    setApprovals(dir, false);
    assert.equal(loadConfig(dir).approvals, false);
  });
});

test("setApprovals refuses to overwrite a file it cannot parse", () => {
  withDir((dir) => {
    write(dir, "{ nope");
    assert.throws(() => setApprovals(dir, true), new RegExp(`${CONFIG_FILE.replace(".", "\\.")} is not valid JSON|not valid JSON`));
    assert.equal(readFileSync(configPath(dir), "utf8"), "{ nope");
    write(dir, "[1]");
    assert.throws(() => setApprovals(dir, true), /must contain a JSON object/);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudConfigError, createCloud, loadCloudConfig } from "./config.js";

const SECRET = "x".repeat(40);
const base = { ARD_CLOUD_SECRET: SECRET, ARD_CLOUD_BASE_URL: "https://cloud.example.com", ARD_CLOUD_LOGIN_ISSUER: "https://accounts.example.com", ARD_CLOUD_LOGIN_CLIENT_ID: "id", ARD_CLOUD_LOGIN_CLIENT_SECRET: "secret" };

const problems = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadCloudConfig(env);
    return [];
  } catch (error) {
    if (error instanceof CloudConfigError) return error.problems;
    throw error;
  }
};

test("a complete production configuration loads, with sensible defaults", () => {
  const config = loadCloudConfig({ ...base, ARD_CLOUD_DATA_DIR: "/var/lib/ard" });
  assert.equal(config.baseUrl, "https://cloud.example.com");
  assert.equal(config.dataDir, "/var/lib/ard");
  assert.equal(config.devLogin, false);
  assert.equal(config.login?.issuer, "https://accounts.example.com");
  assert.equal(config.login?.label, "your account");
  assert.equal(config.maxOrgBytes, 1024 * 1024 * 1024);
  assert.equal(config.paddleEnvironment, "sandbox", "Paddle defaults to sandbox: going live is deliberate");
});

test("every problem is reported in one go, so the operator fixes them together", () => {
  const all = problems({});
  assert.ok(all.some((p) => /ARD_CLOUD_SECRET is required/.test(p)));
  assert.ok(all.some((p) => /ARD_CLOUD_BASE_URL is required/.test(p)));
  assert.ok(all.some((p) => /No way to sign in/.test(p)));
  assert.ok(all.length >= 3);
});

test("the secret must be long enough", () => {
  assert.ok(problems({ ...base, ARD_CLOUD_SECRET: "short" }).some((p) => /at least 32/.test(p)));
});

test("the public URL must be https, except for localhost", () => {
  assert.ok(problems({ ...base, ARD_CLOUD_BASE_URL: "http://cloud.example.com" }).some((p) => /https/.test(p)));
  assert.ok(problems({ ...base, ARD_CLOUD_BASE_URL: "not a url" }).some((p) => /full URL/.test(p)));
  assert.deepEqual(problems({ ...base, ARD_CLOUD_BASE_URL: "http://127.0.0.1:3000" }), []);
  assert.deepEqual(problems({ ...base, ARD_CLOUD_BASE_URL: "http://localhost:3000" }), []);
  assert.equal(loadCloudConfig({ ...base, ARD_CLOUD_BASE_URL: "https://cloud.example.com/some/path/" }).baseUrl, "https://cloud.example.com", "only the origin is kept");
});

test("dev login (sign in by typing an e-mail) is refused on anything but localhost", () => {
  const dev = { ARD_CLOUD_SECRET: SECRET, ARD_CLOUD_DEV_LOGIN: "1" };
  assert.deepEqual(problems({ ...dev, ARD_CLOUD_BASE_URL: "http://127.0.0.1:3000" }), []);
  assert.ok(problems({ ...dev, ARD_CLOUD_BASE_URL: "https://cloud.example.com" }).some((p) => /anyone sign in as anyone/.test(p)));
  assert.equal(loadCloudConfig({ ...dev, ARD_CLOUD_BASE_URL: "http://localhost:3000" }).devLogin, true);
});

test("a partly configured login provider is an error, not a silent fallback", () => {
  const { ARD_CLOUD_LOGIN_CLIENT_SECRET: _omit, ...partial } = base;
  assert.ok(problems(partial).some((p) => /together/.test(p)));
});

test("limits and Paddle environment are validated", () => {
  assert.ok(problems({ ...base, ARD_CLOUD_MAX_ORG_BYTES: "lots" }).some((p) => /MAX_ORG_BYTES/.test(p)));
  assert.ok(problems({ ...base, ARD_CLOUD_MAX_ORG_BYTES: "-5" }).some((p) => /MAX_ORG_BYTES/.test(p)));
  assert.ok(problems({ ...base, ARD_PADDLE_ENV: "prod" }).some((p) => /ARD_PADDLE_ENV/.test(p)));
  assert.equal(loadCloudConfig({ ...base, ARD_PADDLE_ENV: "production", ARD_PADDLE_CLIENT_TOKEN: "live_abc" }).paddleClientToken, "live_abc");
});

test("createCloud prepares the data folder and warns about risky or missing settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "ard-cloud-cfg-"));
  try {
    const config = loadCloudConfig({ ARD_CLOUD_SECRET: SECRET, ARD_CLOUD_BASE_URL: "http://127.0.0.1:3000", ARD_CLOUD_DEV_LOGIN: "1", ARD_CLOUD_DATA_DIR: join(dir, "data") });
    const cloud = createCloud(config, {});
    assert.equal(existsSync(join(dir, "data", "control.db")), true);
    assert.ok(cloud.warnings.some((w) => /DEV LOGIN IS ON/.test(w)));
    assert.ok(cloud.warnings.some((w) => /No payment provider/.test(w)));
    cloud.control.close();

    const paddleEnv = { ARD_PADDLE_API_KEY: "k", ARD_PADDLE_WEBHOOK_SECRET: "s", ARD_PADDLE_PRICE_ID: "pri_1", ARD_DODO_API_KEY: "k" };
    const second = createCloud(config, paddleEnv);
    assert.deepEqual([...second.providers.keys()], ["paddle"]);
    assert.ok(second.warnings.some((w) => /Dodo Payments is partly configured/.test(w)));
    second.control.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

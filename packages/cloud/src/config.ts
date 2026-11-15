import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { providersFromEnv, type BillingProvider, type ProviderId } from "@ard/billing";
import { openDb } from "@ard/core";
import { ControlStore } from "./control.js";
import { RateLimiter } from "./limits.js";
import type { OidcOptions } from "./oidc.js";
import type { PlatformLoginConfig } from "./login.js";
import { CLOUD_MIGRATIONS } from "./schema.js";
import { Workspaces, INGEST_LIMITS } from "./workspace.js";

export interface CloudConfig {
  /** Encrypts SSO client secrets at rest. Must be long and random; losing it means SSO secrets must be re-entered. */
  secret: string;
  dataDir: string;
  /** Public URL, used for OIDC redirect URIs and billing return links. */
  baseUrl: string;
  /** Sign in by typing an e-mail address, no password. ONLY for local development; refused on non-loopback URLs. */
  devLogin: boolean;
  login: PlatformLoginConfig | null;
  maxOrgBytes: number;
  allowPrivateOidc: boolean;
  /** Paddle.js client-side token (public by design). Needed by the /pay page that Paddle's default payment link points at. */
  paddleClientToken: string | null;
  paddleEnvironment: "sandbox" | "production";
}

export class CloudConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid cloud configuration:\n - ${problems.join("\n - ")}`);
    this.name = "CloudConfigError";
  }
}

const isLoopback = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

/**
 * Read the server's settings from the environment, collecting EVERY problem so the operator fixes them in one go.
 *
 *   ARD_CLOUD_SECRET            (required, 32+ characters)
 *   ARD_CLOUD_BASE_URL          (required) e.g. https://cloud.example.com
 *   ARD_CLOUD_DATA_DIR          default ./cloud-data
 *   ARD_CLOUD_LOGIN_ISSUER / _CLIENT_ID / _CLIENT_SECRET / _LABEL   sign-in provider, e.g. https://accounts.google.com
 *   ARD_CLOUD_DEV_LOGIN=1       local development only
 *   ARD_CLOUD_MAX_ORG_BYTES     per-organization storage quota
 *   ARD_CLOUD_ALLOW_PRIVATE_OIDC=1   development only: allow identity providers on private addresses / http
 *   ARD_PADDLE_CLIENT_TOKEN     public Paddle.js token for the /pay page
 */
export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const problems: string[] = [];
  const read = (name: string) => (env[name] && env[name] !== "" ? env[name]! : undefined);

  const secret = read("ARD_CLOUD_SECRET");
  if (!secret) problems.push("ARD_CLOUD_SECRET is required (generate one with: openssl rand -hex 32).");
  else if (secret.length < 32) problems.push("ARD_CLOUD_SECRET must be at least 32 characters.");

  let baseUrl = read("ARD_CLOUD_BASE_URL") ?? "";
  let parsed: URL | null = null;
  try {
    parsed = new URL(baseUrl);
    baseUrl = parsed.origin;
  } catch {
    problems.push("ARD_CLOUD_BASE_URL is required and must be a full URL, e.g. https://cloud.example.com");
  }
  if (parsed && parsed.protocol !== "https:" && !isLoopback(parsed)) problems.push("ARD_CLOUD_BASE_URL must use https (plain http is only accepted for localhost).");

  const devLogin = read("ARD_CLOUD_DEV_LOGIN") === "1";
  if (devLogin && parsed && !isLoopback(parsed)) problems.push("ARD_CLOUD_DEV_LOGIN=1 is only allowed when ARD_CLOUD_BASE_URL is localhost. It lets anyone sign in as anyone.");

  const issuer = read("ARD_CLOUD_LOGIN_ISSUER");
  const clientId = read("ARD_CLOUD_LOGIN_CLIENT_ID");
  const clientSecret = read("ARD_CLOUD_LOGIN_CLIENT_SECRET");
  let login: PlatformLoginConfig | null = null;
  if (issuer || clientId || clientSecret) {
    if (!issuer || !clientId || !clientSecret) problems.push("Set ARD_CLOUD_LOGIN_ISSUER, ARD_CLOUD_LOGIN_CLIENT_ID and ARD_CLOUD_LOGIN_CLIENT_SECRET together.");
    else login = { issuer, clientId, clientSecret, label: read("ARD_CLOUD_LOGIN_LABEL") ?? "your account" };
  }
  if (!login && !devLogin) problems.push("No way to sign in: configure ARD_CLOUD_LOGIN_* (an OpenID Connect provider such as Google) or, for local development only, ARD_CLOUD_DEV_LOGIN=1.");

  const maxOrgBytes = Number(read("ARD_CLOUD_MAX_ORG_BYTES") ?? INGEST_LIMITS.defaultOrgQuotaBytes);
  if (!Number.isFinite(maxOrgBytes) || maxOrgBytes <= 0) problems.push("ARD_CLOUD_MAX_ORG_BYTES must be a positive number.");

  const paddleEnv = read("ARD_PADDLE_ENV") ?? "sandbox";
  if (paddleEnv !== "sandbox" && paddleEnv !== "production") problems.push('ARD_PADDLE_ENV must be "sandbox" or "production".');

  if (problems.length > 0) throw new CloudConfigError(problems);
  return {
    secret: secret!,
    dataDir: resolve(read("ARD_CLOUD_DATA_DIR") ?? "./cloud-data"),
    baseUrl,
    devLogin,
    login,
    maxOrgBytes,
    allowPrivateOidc: read("ARD_CLOUD_ALLOW_PRIVATE_OIDC") === "1",
    paddleClientToken: read("ARD_PADDLE_CLIENT_TOKEN") ?? null,
    paddleEnvironment: paddleEnv as "sandbox" | "production",
  };
}

/** Everything the running server needs, built once. */
export interface Cloud {
  config: CloudConfig;
  control: ControlStore;
  workspaces: Workspaces;
  providers: ReadonlyMap<ProviderId, BillingProvider>;
  warnings: string[];
  oidc: OidcOptions;
  /** Wrong device-code guesses, per user. */
  deviceGuesses: RateLimiter;
  /** Uploads per API token. */
  uploads: RateLimiter;
  /** Sign-in attempts per client address. */
  logins: RateLimiter;
}

export function createCloud(config: CloudConfig, env: NodeJS.ProcessEnv = process.env, clock: () => Date = () => new Date()): Cloud {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const { providers, warnings } = providersFromEnv(env);
  if (providers.size === 0) warnings.push("No payment provider is configured: organizations cannot subscribe yet (see ARD_PADDLE_* / ARD_DODO_*).");
  if (config.devLogin) warnings.push("DEV LOGIN IS ON: anyone who can reach this server can sign in as anyone. Never use this in production.");
  return {
    config,
    control: new ControlStore(openDb(join(config.dataDir, "control.db"), CLOUD_MIGRATIONS), clock),
    workspaces: new Workspaces(config.dataDir),
    providers,
    warnings,
    oidc: { allowPrivateNetwork: config.allowPrivateOidc, now: clock },
    deviceGuesses: new RateLimiter(10, 10 * 60 * 1000),
    uploads: new RateLimiter(120, 60 * 1000),
    logins: new RateLimiter(30, 10 * 60 * 1000),
  };
}

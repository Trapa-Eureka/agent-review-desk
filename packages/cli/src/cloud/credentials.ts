import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The login token lives in a file only its owner can read: `~/.config/ard/credentials.json` (0600, folder 0700).
 * `ARD_CONFIG_DIR` relocates it. It is a bearer token: anyone who can read the file can act as you on that server,
 * exactly like an SSH key or a `gh` token. `ard logout` revokes it on the server as well as deleting it here.
 */

export interface Credential {
  token: string;
  email: string;
  savedAt: string;
}

interface Store {
  version: 1;
  servers: Record<string, Credential>;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ARD_CONFIG_DIR && env.ARD_CONFIG_DIR !== "") return env.ARD_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== "" ? env.XDG_CONFIG_HOME : join(homedir(), ".config"), "ard");
}

export const credentialsPath = (env: NodeJS.ProcessEnv = process.env): string => join(configDir(env), "credentials.json");

function readStore(path: string): Store {
  if (!existsSync(path)) return { version: 1, servers: {} };
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return { version: 1, servers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON. Fix or delete it; ard will not overwrite a file it cannot read.`);
  }
  const servers = typeof parsed === "object" && parsed !== null ? (parsed as { servers?: unknown }).servers : undefined;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw new Error(`${path} has an unexpected shape. Fix or delete it.`);
  return { version: 1, servers: servers as Record<string, Credential> };
}

function writeStore(path: string, store: Store): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Write to a temp file, then rename: a crash can never leave a half-written credentials file.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function getCredential(env: NodeJS.ProcessEnv, server: string): Credential | null {
  const credential = readStore(credentialsPath(env)).servers[server];
  return credential && typeof credential.token === "string" ? credential : null;
}

export function saveCredential(env: NodeJS.ProcessEnv, server: string, credential: Credential): void {
  const path = credentialsPath(env);
  const store = readStore(path);
  store.servers[server] = credential;
  writeStore(path, store);
}

export function removeCredential(env: NodeJS.ProcessEnv, server: string): boolean {
  const path = credentialsPath(env);
  const store = readStore(path);
  if (!(server in store.servers)) return false;
  delete store.servers[server];
  writeStore(path, store);
  return true;
}

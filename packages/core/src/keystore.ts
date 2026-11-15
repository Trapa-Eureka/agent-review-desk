import { spawnSync } from "node:child_process";

/**
 * Where a person's own API key can be kept: the operating system's keychain, never a file in a project folder.
 *
 *  - macOS:  the login Keychain, through the `security` tool.
 *  - Linux:  the desktop secret service, through `secret-tool` (libsecret), when it is installed.
 *  - others: not supported (the caller falls back to an environment variable).
 *
 * Rules this module keeps:
 *  - The secret never appears in a command line (`ps` shows arguments to every user). It goes to the tool on standard input.
 *  - Because it is written into a command that the tool parses, a secret may only contain letters, digits, `_` and `-`
 *    (every API key does). Anything else is refused BEFORE any command runs, so a pasted value can never add a second command.
 *  - Checking that a key exists never reads its value; the value is read only when it is about to be used.
 *  - A save is verified by reading it back.
 */

export const KEY_SERVICE = "agent-review-desk-anthropic";
export const KEY_ACCOUNT = "api-key";
export const API_KEY_PATTERN = /^[A-Za-z0-9_-]{20,400}$/;

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
/** Runs a program with optional standard input. Tests replace it. */
export type RunFn = (command: string, args: string[], input?: string, cwd?: string) => RunResult;

export const defaultRun: RunFn = (command, args, input, cwd) => {
  const result = spawnSync(command, args, { ...(input === undefined ? {} : { input }), ...(cwd === undefined ? {} : { cwd }), encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error ? { error: result.error } : {}) };
};

export class KeyStoreError extends Error {}

export interface KeyStore {
  /** Human name of the place, for messages. */
  readonly name: string;
  /** Is a key stored? Does not read the key. (On Linux the tool offers no such check, so there it does read and discard.) */
  has(): boolean;
  get(): string | null;
  /** Save (replace) the key. Throws KeyStoreError. */
  set(secret: string): void;
  /** Delete the key. false when there was none. */
  remove(): boolean;
}

export interface KeyStoreOptions {
  platform?: NodeJS.Platform;
  run?: RunFn;
  service?: string;
}

const first = (text: string): string => text.trim().split("\n")[0]?.slice(0, 200) ?? "";

function assertAcceptable(secret: string): void {
  if (!API_KEY_PATTERN.test(secret)) {
    throw new KeyStoreError("That does not look like an API key (only letters, digits, - and _, 20 to 400 characters, no spaces or quotes). Nothing was saved.");
  }
}

function macStore(run: RunFn, service: string): KeyStore {
  const lookup = (extra: string[]) => run("security", ["find-generic-password", "-s", service, "-a", KEY_ACCOUNT, ...extra]);
  const store: KeyStore = {
    name: "the macOS Keychain",
    has: () => lookup([]).status === 0,
    get: () => {
      const result = lookup(["-w"]);
      const value = result.stdout.trim();
      return result.status === 0 && value !== "" ? value : null;
    },
    set: (secret) => {
      assertAcceptable(secret);
      // `security -i` reads commands from standard input, so the secret stays out of the process list.
      const result = run("security", ["-i"], `add-generic-password -a ${KEY_ACCOUNT} -s ${service} -w ${secret} -U\n`);
      if (result.error) throw new KeyStoreError(`Could not run the macOS \`security\` tool: ${result.error.message}`);
      if (store.get() !== secret) throw new KeyStoreError(`The macOS Keychain did not save the key${first(result.stderr) ? `: ${first(result.stderr)}` : "."} Is the login keychain locked?`);
    },
    remove: () => {
      const result = run("security", ["delete-generic-password", "-s", service, "-a", KEY_ACCOUNT]);
      if (result.status === 0) return true;
      if (result.status === 44) return false; // errSecItemNotFound
      throw new KeyStoreError(`Could not remove the key from the macOS Keychain${first(result.stderr) ? `: ${first(result.stderr)}` : "."}`);
    },
  };
  return store;
}

function linuxStore(run: RunFn, service: string): KeyStore {
  const attributes = ["service", service, "account", KEY_ACCOUNT];
  const missing = (error: Error | undefined) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  const noTool = new KeyStoreError("`secret-tool` (libsecret) is not installed, so there is no keychain to use. Install it (for example `sudo apt install libsecret-tools`) or set ANTHROPIC_API_KEY instead.");
  const store: KeyStore = {
    name: "the desktop keyring (secret-tool)",
    has: () => store.get() !== null,
    get: () => {
      const result = run("secret-tool", ["lookup", ...attributes]);
      const value = result.stdout.trim();
      return !result.error && result.status === 0 && value !== "" ? value : null;
    },
    set: (secret) => {
      assertAcceptable(secret);
      const result = run("secret-tool", ["store", "--label=Agent Review Desk: Anthropic API key", ...attributes], secret);
      if (missing(result.error)) throw noTool;
      if (store.get() !== secret) throw new KeyStoreError(`The desktop keyring did not save the key${first(result.stderr) ? `: ${first(result.stderr)}` : "."} Is a keyring service running and unlocked?`);
    },
    remove: () => {
      if (!store.has()) return false;
      const result = run("secret-tool", ["clear", ...attributes]);
      if (missing(result.error)) throw noTool;
      if (result.status !== 0) throw new KeyStoreError(`Could not remove the key from the desktop keyring${first(result.stderr) ? `: ${first(result.stderr)}` : "."}`);
      return true;
    },
  };
  return store;
}

/** The keychain of this system, or null when there is no supported one. */
export function systemKeyStore(options: KeyStoreOptions = {}): KeyStore | null {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const service = options.service ?? KEY_SERVICE;
  if (platform === "darwin") return macStore(run, service);
  if (platform === "linux") return linuxStore(run, service);
  return null;
}

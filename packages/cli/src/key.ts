import { systemKeyStore, type KeyStore } from "@ard/core";

export interface KeyIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  /** Ask for the key without showing it. */
  readSecret: (prompt: string) => Promise<string>;
  /** The keychain to use. undefined: this system's own; null: none. */
  store?: KeyStore | null;
}

const NO_STORE = "There is no supported keychain on this system (supported: macOS Keychain, and Linux with `secret-tool`). Use the ANTHROPIC_API_KEY environment variable instead: ANTHROPIC_API_KEY=... ard review";

const envKeySet = (env: NodeJS.ProcessEnv): boolean => typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== "";

/**
 * `ard key set | status | remove`: keep your own Anthropic API key (for the optional AI summary) in the operating
 * system's keychain, so you do not have to type it into every terminal. It is never written to a file in your project,
 * never printed, and never leaves your computer except to Anthropic when you ask for a summary.
 */
export async function runKey(action: string, io: KeyIo): Promise<number> {
  const store = io.store === undefined ? systemKeyStore() : io.store;

  if (action === "status") {
    io.out(`environment variable ANTHROPIC_API_KEY: ${envKeySet(io.env) ? "set in this terminal" : "not set"}`);
    if (!store) {
      io.out("keychain: none supported on this system");
    } else {
      io.out(`keychain (${store.name}): ${store.has() ? "a key is saved" : "no key saved"}`);
    }
    const inUse = envKeySet(io.env) ? "the environment variable" : store?.has() ? "the saved keychain key" : "none (the AI summary is off)";
    io.out(`the AI summary would use: ${inUse}`);
    return 0;
  }

  if (!store) {
    io.err(`ard key ${action}: ${NO_STORE}`);
    return 1;
  }

  if (action === "remove") {
    try {
      io.out(store.remove() ? `Removed the key from ${store.name}.` : `No key was saved in ${store.name}.`);
      if (envKeySet(io.env)) io.out("ANTHROPIC_API_KEY is still set in this terminal; unset it to stop using that one too.");
      return 0;
    } catch (error) {
      io.err(`ard key remove: ${(error as Error).message}`);
      return 1;
    }
  }

  // set
  let secret: string;
  try {
    secret = (await io.readSecret("Paste your Anthropic API key (it will not be shown): ")).trim();
  } catch {
    io.err("ard key set: cancelled. Nothing was saved.");
    return 1;
  }
  if (secret === "") {
    io.err("ard key set: nothing was entered. Nothing was saved.");
    return 1;
  }
  try {
    store.set(secret);
  } catch (error) {
    io.err(`ard key set: ${(error as Error).message}`);
    return 1;
  }
  io.out(`Saved in ${store.name}. "ard review" will use it for the AI summary. Remove it any time with: ard key remove`);
  if (!secret.startsWith("sk-ant-")) io.err("warning: this does not start with sk-ant-, which Anthropic API keys do. It was saved anyway; check it if summaries fail.");
  if (envKeySet(io.env)) io.out("Note: ANTHROPIC_API_KEY is also set in this terminal, and it takes precedence over the saved key.");
  return 0;
}

/** Read a line from the terminal without echoing it (works for pasted input too). Ctrl-C cancels. */
export function readHidden(prompt: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const finish = () => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return resolve(value);
        }
        if (ch === "\u0003" || ch === "\u0004") {
          finish();
          return reject(new Error("cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}

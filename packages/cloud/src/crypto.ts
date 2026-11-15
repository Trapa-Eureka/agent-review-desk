import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** A random, URL-safe secret: session ids, API tokens, invitation links, checkout nonces. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("hex");

/** Secrets are stored only as this hash, so a leaked database cannot be replayed as credentials. */
export const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A separate key for each purpose, derived from the one server secret, so a key for one use is never reused for another. */
function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "ard-cloud", purpose, 32));
}

/** Encrypt a small secret at rest (e.g. an SSO client secret). AES-256-GCM; the result is `v1.<iv>.<tag>.<ciphertext>`. */
export function seal(secret: string, purpose: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, purpose), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** Decrypt what `seal` produced. Returns null for anything tampered with, truncated, or sealed under another secret/purpose. */
export function unseal(secret: string, purpose: string, sealed: string): string | null {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, purpose), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** No vowels (so a code never spells a word) and no look-alikes (0/O, 1/I). 28 symbols. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

/** `ABCD-EFGH`: short enough to type from a terminal, with about 37 bits of entropy. */
export function newUserCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Accept what a person typed: any case, with or without the dash or spaces. */
export function normalizeUserCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "");
  if (cleaned.length !== 8 || [...cleaned].some((c) => !USER_CODE_ALPHABET.includes(c))) return null;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

/** PKCE (RFC 7636): a verifier and its S256 challenge. */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

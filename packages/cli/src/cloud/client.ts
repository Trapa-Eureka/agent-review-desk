export type CloudFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: "error" }) => Promise<{ status: number; text(): Promise<string> }>;

export class CloudHttpError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    /** The server's `code` (e.g. "payment_required") when it sent one. */
    readonly code?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "CloudHttpError";
  }
}

const isLoopback = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

/**
 * Which cloud server? `--server` wins, then ARD_CLOUD_URL. The token is a bearer credential, so it is only ever sent
 * over https (plain http is accepted for localhost, for development).
 */
export function resolveServer(env: NodeJS.ProcessEnv, flag?: string): string {
  const raw = flag ?? (env.ARD_CLOUD_URL && env.ARD_CLOUD_URL !== "" ? env.ARD_CLOUD_URL : undefined);
  if (!raw) throw new Error("No cloud server given. Pass --server <url> or set ARD_CLOUD_URL (the address of your Agent Review Desk Cloud, e.g. https://cloud.example.com).");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }
  if (url.username || url.password) throw new Error("The server URL must not contain a user name or password.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) throw new Error("The server URL must use https (http is only allowed for localhost). Your login token would otherwise travel unencrypted.");
  return url.origin;
}

interface RequestOptions {
  method?: "GET" | "POST";
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

/** One JSON request to the cloud. Redirects are refused (so a token cannot be forwarded elsewhere). */
export async function cloudRequest(doFetch: CloudFetch, server: string, path: string, options: RequestOptions = {}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await doFetch(`${server}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      redirect: "error",
    });
  } catch (error) {
    const timedOut = (error as { name?: string }).name === "TimeoutError" || (error as { name?: string }).name === "AbortError";
    throw new CloudHttpError(null, timedOut ? `${server} did not answer in time.` : `Could not reach ${server}. Check the address and your connection.`);
  }
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = text === "" ? {} : JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    if (response.status >= 200 && response.status < 300) throw new CloudHttpError(response.status, `${server} sent an answer that is not JSON. Is this really an Agent Review Desk Cloud?`);
  }
  if (response.status < 200 || response.status >= 300) {
    const message = typeof json.error === "string" ? json.error : `The server answered HTTP ${response.status}.`;
    const retry = Number(json.retry_after);
    throw new CloudHttpError(response.status, message, typeof json.code === "string" ? json.code : typeof json.error === "string" && /^[a-z_]+$/.test(json.error) ? json.error : undefined, Number.isFinite(retry) ? retry : undefined);
  }
  return json;
}

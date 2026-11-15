export type CloudErrorCode = "bad_request" | "unauthenticated" | "payment_required" | "forbidden" | "not_found" | "conflict" | "too_large" | "rate_limited" | "unavailable";

const STATUS: Record<CloudErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  payment_required: 402,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  rate_limited: 429,
  unavailable: 503,
};

/** A failure the caller should see. The message is written for a person and never contains secrets. */
export class CloudError extends Error {
  readonly status: number;
  constructor(
    readonly code: CloudErrorCode,
    message: string,
    /** Seconds to wait before retrying (rate limits). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "CloudError";
    this.status = STATUS[code];
  }
}

export const isCloudError = (error: unknown): error is CloudError => error instanceof CloudError;

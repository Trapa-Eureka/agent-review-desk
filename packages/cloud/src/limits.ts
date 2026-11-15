/**
 * A fixed-window rate limiter held in memory. It is meant to blunt guessing and abuse on a single server,
 * not to be a distributed quota system; a restart resets it. The clock is injectable for tests.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Count one attempt for `key`. `retryAfterMs` says how long until the window opens again. */
  hit(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = this.clock();
    if (this.hits.size > 10_000) this.sweep(now);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    entry.count += 1;
    return entry.count <= this.max ? { allowed: true, retryAfterMs: 0 } : { allowed: false, retryAfterMs: entry.resetAt - now };
  }

  /** Forget a key (e.g. after a success, so a typo does not count against a user for an hour). */
  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

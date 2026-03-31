/**
 * Token-bucket rate limiter with smooth refill.
 *
 * Two separate buckets are maintained:
 * - **general** — for all requests (default 300 req/min).
 * - **search**  — for search-specific requests (default 20 req/min).
 *
 * Both buckets refill continuously rather than in bulk,
 * spreading traffic evenly over the time window.
 *
 * @module
 */

/** Configuration for the rate limiter. */
export interface RateLimitConfig {
  /** Maximum general requests per minute. Default: `300`. */
  requestsPerMinute?: number;
  /** Maximum search requests per minute. Default: `20`. */
  searchRequestsPerMinute?: number;
}

/** Cross-platform monotonic-ish clock in milliseconds. */
function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * A single token bucket that refills at a constant rate.
 *
 * @internal
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  /** Milliseconds between token additions. */
  private readonly refillInterval: number;
  private readonly capacity: number;

  constructor(requestsPerMinute: number) {
    this.capacity = requestsPerMinute;
    this.tokens = requestsPerMinute; // start full
    this.lastRefill = now();
    // e.g. 300 req/min → one token every 200 ms
    this.refillInterval = 60_000 / requestsPerMinute;
  }

  /** Refill tokens based on elapsed time. */
  private refill(): void {
    const current = now();
    const elapsed = current - this.lastRefill;
    const newTokens = Math.floor(elapsed / this.refillInterval);
    if (newTokens >= 1) {
      this.tokens = Math.min(this.capacity, this.tokens + newTokens);
      this.lastRefill += newTokens * this.refillInterval;
    }
  }

  /**
   * Peek at how long to wait without consuming a token.
   *
   * @returns `0` if a token is available right now, otherwise ms to wait.
   */
  peekWait(): number {
    this.refill();
    if (this.tokens >= 1) {
      return 0;
    }
    const elapsed = now() - this.lastRefill;
    return Math.max(this.refillInterval - elapsed, 1);
  }

  /**
   * Consume one token. Must only be called when `peekWait()` returned `0`.
   */
  consume(): void {
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rate limiter that enforces per-minute request quotas using token buckets.
 *
 * ```ts
 * const limiter = new RateLimiter({ requestsPerMinute: 300 });
 * await limiter.wait();          // general request
 * await limiter.wait(true);      // search request (also counts as general)
 * ```
 */
export class RateLimiter {
  private readonly generalBucket: TokenBucket;
  private readonly searchBucket: TokenBucket;

  constructor(config?: RateLimitConfig) {
    const rpm = config?.requestsPerMinute ?? 300;
    const srpm = config?.searchRequestsPerMinute ?? 20;
    this.generalBucket = new TokenBucket(rpm);
    this.searchBucket = new TokenBucket(srpm);
  }

  /**
   * Wait until a token is available, then consume it.
   *
   * For search requests both the general and search budgets must be
   * available before any tokens are consumed (atomic acquire).
   *
   * @param isSearch - If `true`, the request also counts against the
   *                   stricter search-request budget.
   */
  async wait(isSearch?: boolean): Promise<void> {
    for (;;) {
      const generalWait = this.generalBucket.peekWait();
      const searchWait = isSearch ? this.searchBucket.peekWait() : 0;
      const totalWait = Math.max(generalWait, searchWait);

      if (totalWait <= 0) {
        // Both buckets are ready — consume atomically.
        this.generalBucket.consume();
        if (isSearch) {
          this.searchBucket.consume();
        }
        return;
      }

      await sleep(totalWait);
    }
  }
}

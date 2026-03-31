/**
 * Retry handler with exponential back-off and jitter.
 *
 * Respects `Retry-After` headers on 429 responses and only retries
 * errors that are genuinely transient.
 *
 * @module
 */

import {
  HttpError,
  NetworkError,
  RateLimitError,
  RetryExhaustedError,
} from './errors.js';

/** Configuration for the retry handler. */
export interface RetryConfig {
  /** Maximum number of retries (not counting the initial attempt). Default: `3`. */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential back-off. Default: `1000`. */
  baseDelay?: number;
  /** Maximum delay cap in milliseconds. Default: `30_000`. */
  maxDelay?: number;
  /**
   * Set of HTTP status codes that should be retried.
   * Default: `{429, 502, 503, 504}`.
   */
  retryStatuses?: Set<number>;
  /** Optional callback invoked before each retry wait. */
  onRetry?: (attempt: number, delay: number, error: Error) => void;
}

const DEFAULT_RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** Resolve user-supplied config merged with defaults. */
function resolveConfig(cfg?: RetryConfig) {
  return {
    maxRetries: cfg?.maxRetries ?? 3,
    baseDelay: cfg?.baseDelay ?? 1000,
    maxDelay: cfg?.maxDelay ?? 30_000,
    retryStatuses: cfg?.retryStatuses ?? DEFAULT_RETRY_STATUSES,
    onRetry: cfg?.onRetry,
  } as const;
}

/**
 * Determine whether an error is retryable.
 *
 * - {@link HttpError} is retryable only when its status is in `retryStatuses`.
 * - {@link NetworkError} is retryable when {@link NetworkError.isTransient} is `true`.
 * - Everything else is **not** retryable.
 */
function isRetryable(error: unknown, retryStatuses: Set<number>): boolean {
  if (error instanceof HttpError) {
    return retryStatuses.has(error.statusCode);
  }
  if (error instanceof NetworkError) {
    return error.isTransient;
  }
  return false;
}

/**
 * Calculate the delay before the next attempt.
 *
 * Uses exponential back-off (`baseDelay * 2^attempt`) capped at `maxDelay`,
 * with ±25 % random jitter.  For {@link RateLimitError} the server-supplied
 * `retryAfter` value takes precedence (still capped at `maxDelay`).
 */
function computeDelay(
  attempt: number,
  error: unknown,
  baseDelay: number,
  maxDelay: number,
): number {
  // Prefer Retry-After from the server.
  if (error instanceof HttpError && error.retryAfter !== undefined) {
    const serverDelay = error.retryAfter * 1000; // seconds → ms
    return Math.min(serverDelay, maxDelay);
  }

  const exponential = baseDelay * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelay);
  // Add jitter: ±25 %
  const jitter = capped * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async function with automatic retries on transient failures.
 *
 * @typeParam T - Return type of `fn`.
 * @param fn     - The async operation to execute.
 * @param config - Optional retry configuration.
 * @returns The result of a successful invocation of `fn`.
 * @throws {@link RetryExhaustedError} when all attempts are exhausted.
 * @throws The original error immediately for non-retryable failures.
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  config?: RetryConfig,
): Promise<T> {
  const cfg = resolveConfig(config);
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;

      // If not retryable or we've used all retries, bail out.
      if (!isRetryable(error, cfg.retryStatuses) || attempt >= cfg.maxRetries) {
        if (attempt > 0 && attempt >= cfg.maxRetries) {
          throw new RetryExhaustedError(attempt + 1, error);
        }
        throw error;
      }

      const delay = computeDelay(attempt, error, cfg.baseDelay, cfg.maxDelay);
      cfg.onRetry?.(attempt + 1, delay, error);
      await sleep(delay);
    }
  }

  // Should be unreachable, but satisfies the type checker.
  throw new RetryExhaustedError(cfg.maxRetries + 1, lastError!);
}

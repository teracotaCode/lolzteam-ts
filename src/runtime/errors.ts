/**
 * Error hierarchy for the Lolzteam API client.
 *
 * All errors thrown by this library extend {@link LolzteamError},
 * making it easy to catch any library error with a single type guard.
 *
 * @module
 */

/**
 * Base error for every error originating from this library.
 */
export class LolzteamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    // Fix prototype chain for instanceof checks when targeting ES5
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * An HTTP response was received but indicated an error status code.
 */
export class HttpError extends LolzteamError {
  /**
   * @param statusCode    - HTTP status code (e.g. 400, 500).
   * @param responseBody  - Parsed response body, if available.
   * @param retryAfter    - Value of the Retry-After header in **seconds**, if present.
   */
  constructor(
    public readonly statusCode: number,
    public readonly responseBody: unknown,
    public readonly retryAfter?: number,
  ) {
    const bodyPreview =
      typeof responseBody === 'string'
        ? responseBody.slice(0, 200)
        : JSON.stringify(responseBody)?.slice(0, 200) ?? '';
    super(`HTTP ${statusCode}: ${bodyPreview}`);
  }
}

/** HTTP 401 — invalid or expired token. */
export class AuthError extends HttpError {}

/** HTTP 403 — insufficient permissions. */
export class ForbiddenError extends HttpError {}

/** HTTP 404 — resource not found. */
export class NotFoundError extends HttpError {}

/** HTTP 429 — rate limit exceeded. */
export class RateLimitError extends HttpError {}

/** HTTP 500+ — server-side failure. */
export class ServerError extends HttpError {}

/** HTTP 422 — request validation failed. */
export class ValidationError extends HttpError {}

/**
 * A network-level error occurred (DNS failure, timeout, connection reset, etc.).
 */
export class NetworkError extends LolzteamError {
  /**
   * @param original - The underlying error that caused the network failure.
   */
  constructor(public readonly original: Error) {
    super(`Network error: ${original.message}`);
  }

  /**
   * Whether this error is likely transient and worth retrying.
   *
   * Transient errors include connection resets, DNS timeouts, and
   * abort-related failures that were not user-initiated.
   */
  get isTransient(): boolean {
    const msg = this.original.message.toLowerCase();
    return (
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('enetunreach') ||
      msg.includes('epipe') ||
      msg.includes('socket hang up') ||
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('dns') ||
      this.original.name === 'AbortError' ||
      this.original.name === 'TimeoutError'
    );
  }
}

/**
 * The client configuration is invalid (e.g. missing token, bad base URL).
 */
export class ConfigError extends LolzteamError {}

/**
 * All retry attempts have been exhausted.
 */
export class RetryExhaustedError extends LolzteamError {
  /**
   * @param attempts  - Total number of attempts made (including the initial one).
   * @param lastError - The error from the final attempt.
   */
  constructor(
    public readonly attempts: number,
    public readonly lastError: Error,
  ) {
    super(
      `All ${attempts} attempts exhausted. Last error: ${lastError.message}`,
    );
  }
}

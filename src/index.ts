/**
 * Lolzteam API client for TypeScript / JavaScript.
 *
 * ```ts
 * import { ForumClient, MarketClient } from 'lzt-api-ts';
 *
 * const forum = new ForumClient('your-token');
 * const market = new MarketClient({ token: 'your-token', proxy: { url: 'socks5://...' } });
 * ```
 *
 * @module
 */

import { ForumClient as GeneratedForumClient } from './generated/forum/client.js';
import { MarketClient as GeneratedMarketClient } from './generated/market/client.js';
import {
  HttpClient,
  type HttpClientConfig,
  type ProxyConfig,
  type RateLimitConfig,
  type RetryConfig,
  ConfigError,
} from './runtime/index.js';

// ---------------------------------------------------------------------------
// Public config type
// ---------------------------------------------------------------------------

/** Configuration accepted by the top-level client constructors. */
export interface ClientConfig {
  /** API bearer token. */
  token: string;
  /** Override the base URL (useful for testing / self-hosted). */
  baseUrl?: string;
  /** Proxy configuration (Node.js only). */
  proxy?: ProxyConfig;
  /** Retry behaviour. */
  retry?: RetryConfig;
  /** Rate-limit budgets. */
  rateLimit?: RateLimitConfig;
  /** Per-request timeout in milliseconds. Default: `60_000`. */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Forum client
// ---------------------------------------------------------------------------

/** Default base URL for the Forum API. */
const FORUM_BASE_URL = 'https://prod-api.lolz.live';

/**
 * High-level client for the Lolzteam **Forum** API.
 *
 * Extends the auto-generated client with convenience construction and
 * lifecycle management.
 *
 * ```ts
 * // Simple — just a token:
 * const forum = new ForumClient('my-token');
 *
 * // Advanced — full config:
 * const forum = new ForumClient({
 *   token: 'my-token',
 *   proxy: { url: 'socks5://127.0.0.1:1080' },
 *   retry: { maxRetries: 5 },
 * });
 * ```
 */
export class ForumClient extends GeneratedForumClient {
  /** @internal */
  private readonly _httpClient: HttpClient;

  /**
   * @param tokenOrConfig - Either a plain API token string, or a full
   *                        {@link ClientConfig} object.
   */
  constructor(tokenOrConfig: string | ClientConfig) {
    const cfg = normaliseConfig(tokenOrConfig, FORUM_BASE_URL);
    const httpClient = new HttpClient(cfg);
    super(httpClient.requestFn);
    this._httpClient = httpClient;
  }

  /**
   * Release any resources held by the underlying HTTP client.
   *
   * After calling `close()` further requests will fail.
   */
  close(): void {
    // Currently a no-op; reserved for future connection pooling teardown.
    // Marking it now ensures callers adopt the pattern early.
  }
}

/**
 * Alias for {@link ForumClient}.
 *
 * Every method already returns a `Promise`, so there is no distinction
 * between "sync" and "async" variants in TypeScript.
 */
export const AsyncForumClient = ForumClient;

// ---------------------------------------------------------------------------
// Market client
// ---------------------------------------------------------------------------

/** Default base URL for the Market API. */
const MARKET_BASE_URL = 'https://prod-api.lzt.market';

/**
 * High-level client for the Lolzteam **Market** API.
 *
 * Extends the auto-generated client with convenience construction and
 * lifecycle management.
 *
 * ```ts
 * const market = new MarketClient('my-token');
 * ```
 */
export class MarketClient extends GeneratedMarketClient {
  /** @internal */
  private readonly _httpClient: HttpClient;

  /**
   * @param tokenOrConfig - Either a plain API token string, or a full
   *                        {@link ClientConfig} object.
   */
  constructor(tokenOrConfig: string | ClientConfig) {
    const cfg = normaliseConfig(tokenOrConfig, MARKET_BASE_URL);
    const httpClient = new HttpClient(cfg);
    super(httpClient.requestFn);
    this._httpClient = httpClient;
  }

  /** Release any resources held by the underlying HTTP client. */
  close(): void {
    // Reserved for future cleanup.
  }
}

/** Alias for {@link MarketClient}. */
export const AsyncMarketClient = MarketClient;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise the flexible constructor input into a concrete config. */
function normaliseConfig(
  input: string | ClientConfig,
  defaultBaseUrl: string,
): HttpClientConfig {
  if (typeof input === 'string') {
    if (!input) throw new ConfigError('API token must be a non-empty string.');
    return { token: input, baseUrl: defaultBaseUrl };
  }

  if (!input.token) {
    throw new ConfigError('API token is required in the config object.');
  }

  return {
    token: input.token,
    baseUrl: input.baseUrl ?? defaultBaseUrl,
    proxy: input.proxy,
    retry: input.retry,
    rateLimit: input.rateLimit,
    timeout: input.timeout,
  };
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { ClientConfig as LztConfig };

export {
  // Errors
  LolzteamError,
  HttpError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
  NetworkError,
  ConfigError,
  RetryExhaustedError,
  // Runtime config types
  type ProxyConfig,
  type RetryConfig,
  type RateLimitConfig,
  type HttpClientConfig,
  type RequestOptions,
  type RequestFn,
  // Runtime utilities
  HttpClient,
  RateLimiter,
  executeWithRetry,
  validateProxy,
} from './runtime/index.js';

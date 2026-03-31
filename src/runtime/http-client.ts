/**
 * Universal HTTP client for the Lolzteam API.
 *
 * Works in **both** Node.js 18+ and modern browsers using the native
 * `fetch()` API.  Proxy support (Node-only) is provided via an
 * optional dynamic import of `undici`.
 *
 * @module
 */

import {
  AuthError,
  ConfigError,
  ForbiddenError,
  HttpError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from './errors.js';
import { type ProxyConfig, validateProxy } from './proxy.js';
import { type RateLimitConfig, RateLimiter } from './rate-limiter.js';
import { type RetryConfig, executeWithRetry } from './retry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Full configuration for the HTTP client. */
export interface HttpClientConfig {
  /** API bearer token. */
  token: string;
  /** Base URL for the API (no trailing slash). */
  baseUrl: string;
  /** Optional proxy configuration (Node.js only). */
  proxy?: ProxyConfig;
  /** Retry behaviour. */
  retry?: RetryConfig;
  /** Rate-limit budgets. */
  rateLimit?: RateLimitConfig;
  /** Per-request timeout in milliseconds. Default: `60_000`. */
  timeout?: number;
}

/** Options for a single HTTP request. */
export interface RequestOptions {
  /** Query-string parameters. */
  params?: Record<string, unknown>;
  /** JSON body. */
  json?: Record<string, unknown> | unknown[];
  /** URL-encoded form body. */
  data?: Record<string, unknown>;
  /** Multipart file uploads. */
  files?: Record<string, Blob | Uint8Array>;
  /** Whether this request counts toward the search rate-limit bucket. */
  isSearch?: boolean;
}

/**
 * Signature of the bound `request` function that generated client
 * classes receive.
 */
export type RequestFn = (
  method: string,
  path: string,
  options?: RequestOptions,
) => Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a value to a string suitable for query / form encoding.
 *
 * - `boolean` → `"1"` / `"0"`
 * - `null` / `undefined` → skipped (returns `undefined`)
 * - everything else → `String(value)`
 */
function stringifyValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/**
 * Append key/value pairs to a {@link URLSearchParams} (or plain
 * array of `[key, value]` tuples), handling:
 * - Arrays → repeated `key=value` pairs.
 * - Plain objects → `key[sub]=value` (deepObject style).
 * - Primitives → single `key=value`.
 */
function flattenParams(
  target: URLSearchParams,
  key: string,
  value: unknown,
): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      const str = stringifyValue(item);
      if (str !== undefined) target.append(key, str);
    }
    return;
  }

  if (typeof value === 'object' && !(value instanceof Blob) && !(value instanceof Uint8Array)) {
    for (const [sub, v] of Object.entries(value as Record<string, unknown>)) {
      flattenParams(target, `${key}[${sub}]`, v);
    }
    return;
  }

  const str = stringifyValue(value);
  if (str !== undefined) target.append(key, str);
}

/**
 * Build a query string and append it to a URL.
 */
function appendQueryString(url: string, params?: Record<string, unknown>): string {
  if (!params) return url;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    flattenParams(sp, k, v);
  }
  const qs = sp.toString();
  if (!qs) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}

/**
 * Build a `URLSearchParams` body from a record, using the same
 * flattening rules as query params.
 */
function buildFormBody(data: Record<string, unknown>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    flattenParams(sp, k, v);
  }
  return sp;
}

/**
 * Build a `FormData` body from JSON-like data **and** file entries.
 */
function buildMultipartBody(
  data?: Record<string, unknown>,
  files?: Record<string, Blob | Uint8Array>,
): FormData {
  const fd = new FormData();

  if (data) {
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'boolean') {
        fd.append(k, v ? '1' : '0');
      } else {
        fd.append(k, String(v));
      }
    }
  }

  if (files) {
    for (const [k, v] of Object.entries(files)) {
      if (v instanceof Blob) {
        fd.append(k, v);
      } else {
        // Uint8Array → Blob
        fd.append(k, new Blob([v as BlobPart]));
      }
    }
  }

  return fd;
}

/**
 * Parse the `Retry-After` header value.
 *
 * Supports both delta-seconds (`120`) and HTTP-date
 * (`Wed, 21 Oct 2015 07:28:00 GMT`) formats.
 *
 * @returns Seconds to wait, or `undefined` when the header is absent
 *          or cannot be parsed.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  // Try numeric seconds first.
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds;
  }

  // Try HTTP-date.
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const delta = (date - Date.now()) / 1000;
    return Math.max(0, Math.ceil(delta));
  }

  return undefined;
}

/**
 * Map an HTTP status code to the appropriate {@link HttpError} subclass.
 */
function createHttpError(
  status: number,
  body: unknown,
  retryAfter?: number,
): HttpError {
  switch (status) {
    case 401:
      return new AuthError(status, body, retryAfter);
    case 403:
      return new ForbiddenError(status, body, retryAfter);
    case 404:
      return new NotFoundError(status, body, retryAfter);
    case 422:
      return new ValidationError(status, body, retryAfter);
    case 429:
      return new RateLimitError(status, body, retryAfter);
    default:
      if (status >= 500) {
        return new ServerError(status, body, retryAfter);
      }
      return new HttpError(status, body, retryAfter);
  }
}

// ---------------------------------------------------------------------------
// HttpClient
// ---------------------------------------------------------------------------

/**
 * Universal HTTP client for the Lolzteam API.
 *
 * Handles authentication, rate limiting, retries, proxy configuration,
 * and body encoding automatically.
 */
export class HttpClient {
  private readonly config: Required<
    Pick<HttpClientConfig, 'token' | 'baseUrl' | 'timeout'>
  > & {
    proxy?: ProxyConfig;
    retry: RetryConfig;
  };

  private readonly limiter: RateLimiter;
  private fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
  private dispatcherReady: Promise<void> | undefined;

  constructor(config: HttpClientConfig) {
    if (!config.token) {
      throw new ConfigError('API token is required.');
    }
    if (!config.baseUrl) {
      throw new ConfigError('Base URL is required.');
    }

    this.config = {
      token: config.token,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      timeout: config.timeout ?? 60_000,
      proxy: config.proxy ? validateProxy(config.proxy) : undefined,
      retry: config.retry ?? {},
    };

    this.limiter = new RateLimiter(config.rateLimit);

    // If a proxy is configured, asynchronously set up undici.
    if (this.config.proxy) {
      this.dispatcherReady = this.initProxy(this.config.proxy);
    }
  }

  // -----------------------------------------------------------------------
  // Proxy initialisation (Node.js only, lazy-loaded)
  // -----------------------------------------------------------------------

  private async initProxy(proxy: ProxyConfig): Promise<void> {
    try {
      // Dynamic import — only resolved in Node.js when `undici` is installed.
      // We use a string variable to prevent bundlers from resolving it statically.
      const moduleName = 'undici';
      const undici = await (import(moduleName) as Promise<{
        ProxyAgent: new (url: string) => unknown;
      }>);
      const agent = new undici.ProxyAgent(proxy.url);

      // Node’s global fetch (backed by undici) accepts a `dispatcher`
      // option.  We wrap the native fetch to inject it.
      const nativeFetch = globalThis.fetch;
      this.fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
        nativeFetch(input, {
          ...init,
          // The `dispatcher` option is Node/undici-specific and not in the
          // standard RequestInit type.
          ...(({ dispatcher: agent }) as Record<string, unknown>),
        } as RequestInit);
    } catch {
      throw new ConfigError(
        'Proxy support requires the "undici" package. ' +
          'Install it with: npm install undici',
      );
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Perform an HTTP request against the API.
   *
   * @param method  - HTTP method (`GET`, `POST`, `PUT`, `DELETE`, …).
   * @param path    - URL path **relative** to the base URL (e.g. `/threads/123`).
   * @param options - Optional query params, body, files.
   * @returns Parsed JSON response body.
   */
  async request(
    method: string,
    path: string,
    options?: RequestOptions,
  ): Promise<Record<string, unknown>> {
    // Ensure the proxy agent has finished initialising.
    if (this.dispatcherReady) {
      await this.dispatcherReady;
    }

    // Rate-limit.
    await this.limiter.wait(options?.isSearch);

    // Build the request inside the retry wrapper so each attempt is fresh.
    return executeWithRetry(async () => {
      const url = appendQueryString(
        `${this.config.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`,
        options?.params,
      );

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/json',
      };

      let body: BodyInit | undefined;

      if (options?.files) {
        // Multipart (files + optional data).
        body = buildMultipartBody(options.data ?? (Array.isArray(options.json) ? undefined : options.json), options.files);
        // Let fetch set Content-Type with boundary.
      } else if (options?.json) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.json);
      } else if (options?.data) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = buildFormBody(options.data);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeout,
      );

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: method.toUpperCase(),
          headers,
          body,
          signal: controller.signal,
        });
      } catch (err: unknown) {
        throw new NetworkError(
          err instanceof Error ? err : new Error(String(err)),
        );
      } finally {
        clearTimeout(timeoutId);
      }

      // --- Parse response body -------------------------------------------
      let responseBody: unknown;
      const contentType = response.headers.get('content-type') ?? '';
      try {
        if (contentType.includes('application/json')) {
          responseBody = await response.json();
        } else {
          responseBody = await response.text();
        }
      } catch {
        responseBody = null;
      }

      if (!response.ok) {
        const retryAfter = parseRetryAfter(
          response.headers.get('retry-after'),
        );
        throw createHttpError(response.status, responseBody, retryAfter);
      }

      return (responseBody ?? {}) as Record<string, unknown>;
    }, this.config.retry);
  }

  /**
   * Return a bound {@link RequestFn} suitable for passing to generated
   * client constructors.
   */
  get requestFn(): RequestFn {
    return this.request.bind(this);
  }
}

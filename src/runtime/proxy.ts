/**
 * Proxy configuration helpers.
 *
 * Proxy support is **Node.js only** — browsers cannot configure
 * per-request proxies via `fetch()`.  Calling {@link validateProxy}
 * in a browser environment will throw a clear error.
 *
 * @module
 */

import { ConfigError } from './errors.js';

/** Proxy configuration. */
export interface ProxyConfig {
  /** Proxy URL. Supported schemes: `http`, `https`, `socks5`. */
  url: string;
}

/** Schemes accepted for proxy URLs. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'socks5:']);

/**
 * Whether the current runtime is a browser (i.e. NOT Node.js).
 *
 * @internal
 */
function isBrowser(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return typeof process === 'undefined' || typeof process.versions?.node === 'undefined';
}

/**
 * Validate a proxy configuration and return a normalised copy.
 *
 * @param config - User-supplied proxy configuration.
 * @returns A validated {@link ProxyConfig}.
 * @throws {@link ConfigError} when the URL is malformed, uses an
 *         unsupported scheme, or the code is running in a browser.
 */
export function validateProxy(config: ProxyConfig): ProxyConfig {
  if (isBrowser()) {
    throw new ConfigError(
      'Proxy is not supported in browser environments. ' +
        'Proxying can only be configured when running under Node.js.',
    );
  }

  if (!config.url || typeof config.url !== 'string') {
    throw new ConfigError('Proxy URL must be a non-empty string.');
  }

  let parsed: URL;
  try {
    // socks5:// is not recognised by the URL constructor natively.
    // Replace temporarily with http:// just to validate structure.
    const normalisedForParsing = config.url.replace(/^socks5:\/\//, 'http://');
    parsed = new URL(normalisedForParsing);
  } catch {
    throw new ConfigError(`Invalid proxy URL: ${config.url}`);
  }

  // Extract the *original* scheme.
  const scheme = config.url.slice(0, config.url.indexOf('://') + 1);
  if (!ALLOWED_SCHEMES.has(scheme)) {
    throw new ConfigError(
      `Unsupported proxy scheme "${scheme}". ` +
        `Allowed: ${[...ALLOWED_SCHEMES].join(', ')}.`,
    );
  }

  if (!parsed.hostname) {
    throw new ConfigError('Proxy URL must include a hostname.');
  }

  return { url: config.url };
}

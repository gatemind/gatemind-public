import type { Secret } from '@gatemind/types';
import { RedisStoreError } from './errors';

/** A parsed store URL. It can hold a password, so it is never logged or put in an error. */
export interface StoreEndpoint {
  readonly host: string;
  readonly port: number;
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly db: number;
  readonly tls: boolean;
}

/**
 * Splits `redis://[user]:[password]@host[:port][/db]` (or `rediss://` for TLS). The URL is a
 * secret because it can hold a password, so the error names the store and never the URL.
 */
export function parseStoreUrl(secret: Secret, store: string): StoreEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(secret.reveal());
  } catch {
    throw new RedisStoreError('invalid_url', `The ${store} store URL is not a valid URL`);
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new RedisStoreError(
      'invalid_url',
      `The ${store} store URL must start with redis:// or rediss://`,
    );
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === '') {
    throw new RedisStoreError('invalid_url', `The ${store} store URL needs a host`);
  }
  const dbMatch = /^\/?(\d{0,4})$/.exec(parsed.pathname);
  if (dbMatch === null) {
    throw new RedisStoreError(
      'invalid_url',
      `The ${store} store URL path must be empty or a database number`,
    );
  }
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  return {
    host,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    username: username === '' ? undefined : username,
    password: password === '' ? undefined : password,
    db: dbMatch[1] === undefined || dbMatch[1] === '' ? 0 : Number(dbMatch[1]),
    tls: parsed.protocol === 'rediss:',
  };
}

/**
 * Two endpoints are the same instance when host and port match, whatever the database number:
 * the eviction policy belongs to the instance, not to a database (SEC-022, ADR 0003).
 */
export function isSameInstance(a: StoreEndpoint, b: StoreEndpoint): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port;
}

import { Redis } from 'ioredis';
import { RedisStoreError } from './errors';
import type { StoreEndpoint } from './store-url';

export interface StoreTimeouts {
  /** How long the first connection may take before the store counts as unreachable. */
  readonly connectTimeoutMs: number;
  /** How long one command may take. A slower command fails, so a hung store cannot hang a request. */
  readonly commandTimeoutMs: number;
}

export const DEFAULT_TIMEOUTS: StoreTimeouts = { connectTimeoutMs: 2_000, commandTimeoutMs: 1_000 };

/**
 * Connection settings shared by every connection to a store, in a plain shape that both ioredis
 * and BullMQ accept. No password is ever put in a log or an error.
 */
export interface ConnectionSettings {
  readonly host: string;
  readonly port: number;
  readonly db: number;
  readonly username?: string;
  readonly password?: string;
  readonly tls?: { readonly servername: string };
}

export function baseOptions(endpoint: StoreEndpoint): ConnectionSettings {
  return {
    host: endpoint.host,
    port: endpoint.port,
    db: endpoint.db,
    ...(endpoint.username === undefined ? {} : { username: endpoint.username }),
    ...(endpoint.password === undefined ? {} : { password: endpoint.password }),
    ...(endpoint.tls ? { tls: { servername: endpoint.host } } : {}),
  };
}

/**
 * Creates a command connection that is built to fail fast (SEC-022):
 * - it is not connected until `connectClient` is called, so a store that is down at startup is an
 *   error and not a hang;
 * - it never queues commands while disconnected (`enableOfflineQueue: false`), so a command
 *   during an outage is refused at once;
 * - every command has a timeout, and a command is retried at most once.
 * After it has been ready once it reconnects on its own, with a short, capped backoff.
 */
export function createClient(endpoint: StoreEndpoint, timeouts: StoreTimeouts): Redis {
  let wasReady = false;
  const client = new Redis({
    ...baseOptions(endpoint),
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: timeouts.connectTimeoutMs,
    commandTimeout: timeouts.commandTimeoutMs,
    retryStrategy: (attempt) => (wasReady ? Math.min(attempt * 100, 2_000) : null),
  });
  client.once('ready', () => {
    wasReady = true;
  });
  // An unhandled 'error' event would crash the process. Failures surface from commands instead.
  client.on('error', () => undefined);
  return client;
}

/** Connects once. The error names the store and the error code, never the URL or the host. */
export async function connectClient(
  client: Redis,
  store: string,
  timeouts: StoreTimeouts,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeouts.connectTimeoutMs + 500);
  });
  try {
    await Promise.race([client.connect(), deadline]);
  } catch (error) {
    client.disconnect();
    const code = (error as { code?: unknown }).code;
    const reason = typeof code === 'string' ? code : 'no answer';
    throw new RedisStoreError('unreachable', `The ${store} store cannot be reached (${reason})`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A queue store that evicts data would silently drop queued jobs (SEC-022, ADR 0003), so the
 * queue store must run with `maxmemory-policy noeviction`. This reads the policy from `INFO`,
 * which managed services allow even when they block `CONFIG`.
 */
export async function assertNeverEvicts(client: Redis): Promise<void> {
  let info: string;
  try {
    info = await client.info('memory');
  } catch {
    throw new RedisStoreError('unreachable', 'The queue store did not answer the policy check');
  }
  const policy = /^maxmemory_policy:(\S+)/m.exec(info)?.[1];
  if (policy === undefined) {
    throw new RedisStoreError(
      'unsupported_reply',
      'The queue store did not report its eviction policy, so noeviction cannot be confirmed',
    );
  }
  if (policy !== 'noeviction') {
    throw new RedisStoreError(
      'queue_may_evict',
      `The queue store uses maxmemory-policy ${policy}. It must be noeviction, ` +
        'or queued jobs can be lost (SEC-022). Use a separate instance for the cache.',
    );
  }
}

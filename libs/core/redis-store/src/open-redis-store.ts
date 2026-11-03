import type { CachePort, QueuePort, RateLimiterPort } from '@gatemind/ports';
import type { Secret } from '@gatemind/types';
import type { Redis } from 'ioredis';
import { createBullMqQueue } from './bullmq-queue';
import {
  DEFAULT_TIMEOUTS,
  assertNeverEvicts,
  connectClient,
  createClient,
  type StoreTimeouts,
} from './connection';
import { RedisStoreError } from './errors';
import { createRedisCache } from './redis-cache';
import { createRedisRateLimiter } from './redis-rate-limiter';
import { isSameInstance, parseStoreUrl } from './store-url';

export interface RedisStoreOptions {
  /** URL of the cache instance: cache, rate-limit counters, pub/sub. It may evict. */
  readonly cacheUrl: Secret;
  /** URL of the queue instance: BullMQ only. It must use `noeviction` and differ from the cache. */
  readonly queueUrl: Secret;
  readonly timeouts?: Partial<StoreTimeouts>;
}

export interface StorePing {
  readonly cache: boolean;
  readonly queue: boolean;
}

/** The Redis-compatible stores behind their ports. Nothing else in the product imports a client. */
export interface RedisStore {
  readonly cache: CachePort;
  readonly rateLimiter: RateLimiterPort;
  readonly queue: QueuePort;
  /** For readiness checks (Story 1.7): can each store answer right now? Never rejects. */
  ping(): Promise<StorePing>;
  /** Closes every connection. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Opens both stores and refuses to start on an unsafe setup (ADR 0003, SEC-022):
 * the two URLs must name different instances, both must answer, and the queue instance must
 * use `maxmemory-policy noeviction`. Errors never contain a URL, a host or a password.
 */
export async function openRedisStore(options: RedisStoreOptions): Promise<RedisStore> {
  const timeouts: StoreTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const cacheEndpoint = parseStoreUrl(options.cacheUrl, 'cache');
  const queueEndpoint = parseStoreUrl(options.queueUrl, 'queue');
  if (isSameInstance(cacheEndpoint, queueEndpoint)) {
    throw new RedisStoreError(
      'same_instance',
      'The cache and the queue must be separate instances (SEC-022): the queue must never ' +
        'share a store that may evict',
    );
  }

  const opened: Redis[] = [];
  const track = (client: Redis): Redis => {
    opened.push(client);
    return client;
  };
  const closeAll = (): void => {
    for (const client of opened) client.disconnect();
  };

  try {
    const cacheClient = track(createClient(cacheEndpoint, timeouts));
    await connectClient(cacheClient, 'cache', timeouts);

    // The probe connection checks the queue policy now and answers `ping` later. BullMQ opens
    // its own connections for the queues and workers.
    const queueProbe = track(createClient(queueEndpoint, timeouts));
    await connectClient(queueProbe, 'queue', timeouts);
    await assertNeverEvicts(queueProbe);

    const cache = createRedisCache({
      client: cacheClient,
      openSubscriber: async () => {
        const subscriber = track(createClient(cacheEndpoint, timeouts));
        await connectClient(subscriber, 'cache', timeouts);
        return subscriber;
      },
    });
    const queue = createBullMqQueue({ endpoint: queueEndpoint, timeouts });
    let closed = false;

    const answers = async (client: Redis): Promise<boolean> => {
      try {
        return (await client.ping()) === 'PONG';
      } catch {
        return false;
      }
    };

    return {
      cache,
      rateLimiter: createRedisRateLimiter(cacheClient),
      queue,
      async ping() {
        const [cacheOk, queueOk] = await Promise.all([answers(cacheClient), answers(queueProbe)]);
        return { cache: cacheOk, queue: queueOk };
      },
      async close() {
        if (closed) return;
        closed = true;
        await queue.close();
        await cache.close();
        closeAll();
      },
    };
  } catch (error) {
    closeAll();
    throw error;
  }
}

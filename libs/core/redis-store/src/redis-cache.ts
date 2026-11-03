import { StoreUnavailableError, type CachePort, type CacheUnsubscribe } from '@gatemind/ports';
import { tenantCacheKey } from '@gatemind/tenancy';
import type { TenantId } from '@gatemind/types';
import type { Redis } from 'ioredis';

export interface RedisCacheOptions {
  /** Command connection. Owned by the caller, which closes it. */
  readonly client: Redis;
  /** Opens a dedicated connection for subscriptions. Owned by the cache, closed by `close()`. */
  readonly openSubscriber: () => Promise<Redis>;
}

export interface RedisCache extends CachePort {
  /** Stops all subscriptions and closes the subscriber connection. */
  close(): Promise<void>;
}

interface HandlerEntry {
  readonly handler: (message: string) => void;
}

function unavailable(): never {
  // The cause is dropped on purpose: driver errors can name a host. Callers only need the fact.
  throw new StoreUnavailableError();
}

function requireTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError('ttlMs must be an integer of at least 1');
  }
}

/** `CachePort` on a Redis-compatible store. Keys and channels always carry the tenant (ARC-023). */
export function createRedisCache(options: RedisCacheOptions): RedisCache {
  const { client, openSubscriber } = options;
  const handlers = new Map<string, Set<HandlerEntry>>();
  let subscriber: Promise<Redis> | undefined;
  let closed = false;

  const dispatch = (channel: string, message: string): void => {
    for (const entry of handlers.get(channel) ?? []) {
      try {
        entry.handler(message);
      } catch {
        // A failing handler must not affect the others or the subscription.
      }
    }
  };

  const getSubscriber = (): Promise<Redis> => {
    if (subscriber === undefined) {
      const opened = openSubscriber().then((connection) => {
        connection.on('message', dispatch);
        return connection;
      });
      subscriber = opened;
      opened.catch(() => {
        if (subscriber === opened) subscriber = undefined;
      });
    }
    return subscriber;
  };

  const storeKey = (tenantId: TenantId, key: string): string =>
    tenantCacheKey(tenantId, 'cache', key);
  const storeChannel = (tenantId: TenantId, channel: string): string =>
    tenantCacheKey(tenantId, 'pubsub', channel);

  return {
    async get(tenantId, key) {
      const name = storeKey(tenantId, key);
      try {
        return (await client.get(name)) ?? undefined;
      } catch {
        return unavailable();
      }
    },

    async set(tenantId, key, value, setOptions) {
      requireTtl(setOptions.ttlMs);
      const name = storeKey(tenantId, key);
      try {
        await client.set(name, value, 'PX', setOptions.ttlMs);
      } catch {
        unavailable();
      }
    },

    async delete(tenantId, key) {
      const name = storeKey(tenantId, key);
      try {
        await client.del(name);
      } catch {
        unavailable();
      }
    },

    async publish(tenantId, channel, message) {
      const name = storeChannel(tenantId, channel);
      try {
        await client.publish(name, message);
      } catch {
        unavailable();
      }
    },

    async subscribe(tenantId, channel, handler): Promise<CacheUnsubscribe> {
      const name = storeChannel(tenantId, channel);
      const entry: HandlerEntry = { handler };
      const entries = handlers.get(name) ?? new Set<HandlerEntry>();
      entries.add(entry);
      handlers.set(name, entries);
      const drop = (): boolean => {
        entries.delete(entry);
        if (entries.size > 0) return false;
        handlers.delete(name);
        return true;
      };
      try {
        // Subscribing again to a channel the connection already has is harmless.
        await (await getSubscriber()).subscribe(name);
      } catch {
        drop();
        return unavailable();
      }
      let active = true;
      return async () => {
        if (!active) return;
        active = false;
        if (!drop() || subscriber === undefined) return;
        try {
          await (await subscriber).unsubscribe(name);
        } catch {
          // The connection is gone, so there is nothing left to unsubscribe from.
        }
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      handlers.clear();
      const current = subscriber;
      subscriber = undefined;
      if (current !== undefined) {
        try {
          (await current).disconnect();
        } catch {
          // Never opened: nothing to close.
        }
      }
    },
  };
}

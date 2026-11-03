import { randomBytes } from 'node:crypto';
import { asTenantId } from '@gatemind/types';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUTS, connectClient, createClient } from './connection';
import { readDevStoreUrls } from './dev-store.test-support';
import { createRedisCache, type RedisCache } from './redis-cache';
import { parseStoreUrl } from './store-url';

const endpoint = parseStoreUrl(readDevStoreUrls().cacheUrl, 'cache');
const tenant = (label: string) => asTenantId(`${label}-${randomBytes(4).toString('hex')}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

let client: Redis;
let cache: RedisCache;

beforeAll(async () => {
  client = createClient(endpoint, DEFAULT_TIMEOUTS);
  await connectClient(client, 'cache', DEFAULT_TIMEOUTS);
  cache = createRedisCache({
    client,
    openSubscriber: async () => {
      const subscriber = createClient(endpoint, DEFAULT_TIMEOUTS);
      await connectClient(subscriber, 'cache', DEFAULT_TIMEOUTS);
      return subscriber;
    },
  });
});

afterAll(async () => {
  await cache.close();
  client.disconnect();
});

describe('RedisCache values', () => {
  it('stores and returns a value, and returns undefined for a missing key', async () => {
    const a = tenant('acme');
    await cache.set(a, 'greeting', 'hello', { ttlMs: 5_000 });
    expect(await cache.get(a, 'greeting')).toBe('hello');
    expect(await cache.get(a, 'never-set')).toBeUndefined();
  });

  it('expires a value after its time to live', async () => {
    const a = tenant('acme');
    await cache.set(a, 'short', 'x', { ttlMs: 150 });
    expect(await cache.get(a, 'short')).toBe('x');
    await sleep(400);
    expect(await cache.get(a, 'short')).toBeUndefined();
  });

  it('deletes a value', async () => {
    const a = tenant('acme');
    await cache.set(a, 'gone', 'x', { ttlMs: 5_000 });
    await cache.delete(a, 'gone');
    expect(await cache.get(a, 'gone')).toBeUndefined();
  });

  it('refuses a time to live that is not a positive whole number', async () => {
    const a = tenant('acme');
    for (const ttlMs of [0, -5, 1.5, Number.NaN]) {
      await expect(cache.set(a, 'k', 'v', { ttlMs })).rejects.toThrow(TypeError);
    }
  });
});

describe('RedisCache tenant isolation (ARC-023, SEC-003)', () => {
  it('keeps tenants apart even when they use the same logical key', async () => {
    const a = tenant('tenant-a');
    const b = tenant('tenant-b');
    await cache.set(a, 'session', 'a-value', { ttlMs: 5_000 });
    expect(await cache.get(b, 'session')).toBeUndefined();
    await cache.set(b, 'session', 'b-value', { ttlMs: 5_000 });
    expect(await cache.get(a, 'session')).toBe('a-value');
    expect(await cache.get(b, 'session')).toBe('b-value');
    await cache.delete(b, 'session');
    expect(await cache.get(a, 'session')).toBe('a-value');
  });

  it('stores every key under the tenant prefix', async () => {
    const a = tenant('tenant-a');
    await cache.set(a, 'shape', 'v', { ttlMs: 5_000 });
    expect(await client.get(`t:${a}:cache:shape`)).toBe('v');
  });

  it('cannot reach another tenant by faking the tenant inside the key text', async () => {
    const a = tenant('tenant-a');
    const b = tenant('tenant-b');
    await cache.set(b, 'secret', 'b-only', { ttlMs: 5_000 });
    for (const key of [`${b}:cache:secret`, `../${b}/secret`, `t:${b}:cache:secret`, 'secret']) {
      expect(await cache.get(a, key)).toBeUndefined();
    }
  });
});

describe('RedisCache pub/sub', () => {
  it('delivers a message only to subscribers of the same tenant and channel', async () => {
    const a = tenant('tenant-a');
    const b = tenant('tenant-b');
    const forA: string[] = [];
    const forB: string[] = [];
    const stopA = await cache.subscribe(a, 'revoked', (m) => forA.push(m));
    const stopB = await cache.subscribe(b, 'revoked', (m) => forB.push(m));
    const stopOther = await cache.subscribe(a, 'other', (m) => forA.push(`other:${m}`));

    await cache.publish(a, 'revoked', 'key-1');
    await waitFor(() => forA.length === 1);
    await sleep(100);
    expect(forA).toEqual(['key-1']);
    expect(forB).toEqual([]);

    await Promise.all([stopA(), stopB(), stopOther()]);
  });

  it('stops delivering after unsubscribe, and unsubscribing twice is harmless', async () => {
    const a = tenant('tenant-a');
    const received: string[] = [];
    const stop = await cache.subscribe(a, 'news', (m) => received.push(m));
    await cache.publish(a, 'news', 'one');
    await waitFor(() => received.length === 1);
    await stop();
    await stop();
    await cache.publish(a, 'news', 'two');
    await sleep(150);
    expect(received).toEqual(['one']);
  });

  it('keeps delivering to the other handler when one handler unsubscribes or throws', async () => {
    const a = tenant('tenant-a');
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = await cache.subscribe(a, 'multi', (m) => {
      first.push(m);
      throw new Error('handler failure');
    });
    const stopSecond = await cache.subscribe(a, 'multi', (m) => second.push(m));

    await cache.publish(a, 'multi', 'm1');
    await waitFor(() => first.length === 1 && second.length === 1);

    await stopFirst();
    await cache.publish(a, 'multi', 'm2');
    await waitFor(() => second.length === 2);
    expect(first).toEqual(['m1']);
    expect(second).toEqual(['m1', 'm2']);
    await stopSecond();
  });
});

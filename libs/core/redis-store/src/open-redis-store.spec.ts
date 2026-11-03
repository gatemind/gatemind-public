import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { Secret, asTenantId } from '@gatemind/types';
import { describe, expect, it } from 'vitest';
import { RedisStoreError } from './errors';
import { readDevStoreUrls } from './dev-store.test-support';
import { openRedisStore } from './open-redis-store';

const urls = readDevStoreUrls();
const hex = () => randomBytes(4).toString('hex');
const tenant = () => asTenantId(`acme-${hex()}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function failureOf(call: Promise<unknown>): Promise<RedisStoreError> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(RedisStoreError);
    return error as RedisStoreError;
  }
  throw new Error('expected the store to refuse to open');
}

describe('openRedisStore', () => {
  it('opens both stores, answers ping and serves all three ports', async () => {
    const store = await openRedisStore({ cacheUrl: urls.cacheUrl, queueUrl: urls.queueUrl });
    try {
      expect(await store.ping()).toEqual({ cache: true, queue: true });

      const a = tenant();
      await store.cache.set(a, 'k', 'v', { ttlMs: 5_000 });
      expect(await store.cache.get(a, 'k')).toBe('v');

      expect(
        await store.rateLimiter.consume({ tenantId: a, bucket: 'b', limit: 1, windowMs: 5_000 }),
      ).toMatchObject({ allowed: true });

      const name = `test-${hex()}`;
      const seen: string[] = [];
      await store.queue.process(name, async (job) => {
        seen.push(job.name);
      });
      await store.queue.enqueue(name, { tenantId: a, name: 'hello', payload: {} });
      const deadline = Date.now() + 10_000;
      while (seen.length === 0 && Date.now() < deadline) await sleep(20);
      expect(seen).toEqual(['hello']);
    } finally {
      await store.close();
      await store.close(); // safe to call twice
    }
  });

  it('refuses to open when cache and queue are the same instance', async () => {
    const error = await failureOf(
      openRedisStore({ cacheUrl: urls.cacheUrl, queueUrl: urls.cacheUrl }),
    );
    expect(error.code).toBe('same_instance');
  });

  it('refuses a queue instance that may evict data (SEC-022)', async () => {
    // The cache instance runs allkeys-lru, so using it as the queue must be refused.
    const error = await failureOf(
      openRedisStore({ cacheUrl: urls.queueUrl, queueUrl: urls.cacheUrl }),
    );
    expect(error.code).toBe('queue_may_evict');
    expect(error.message).toContain('noeviction');
  });

  it('reports a store that cannot be reached, naming the store but not the URL', async () => {
    const canary = `canary-${hex()}${hex()}`;
    const error = await failureOf(
      openRedisStore({
        cacheUrl: new Secret(`redis://:${canary}@127.0.0.1:1`),
        queueUrl: urls.queueUrl,
        timeouts: { connectTimeoutMs: 300 },
      }),
    );
    expect(error.code).toBe('unreachable');
    expect(error.message).toContain('cache store');
    for (const text of [error.message, String(error), inspect(error, { depth: 5 })]) {
      expect(text).not.toContain(canary);
      expect(text).not.toContain('127.0.0.1');
    }
  });

  it('refuses a URL that is not a Redis URL without echoing it', async () => {
    const canary = `canary-${hex()}${hex()}`;
    const error = await failureOf(
      openRedisStore({
        cacheUrl: new Secret(`mysql://user:${canary}@localhost:3306/db`),
        queueUrl: urls.queueUrl,
      }),
    );
    expect(error.code).toBe('invalid_url');
    expect(error.message).not.toContain(canary);
  });
});

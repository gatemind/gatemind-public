import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { StoreUnavailableError } from '@gatemind/ports';
import { Secret, asTenantId } from '@gatemind/types';
import { describe, expect, it } from 'vitest';
import { createBullMqQueue } from './bullmq-queue';
import { createClient } from './connection';
import { createRedisCache } from './redis-cache';
import { createRedisRateLimiter } from './redis-rate-limiter';
import { parseStoreUrl } from './store-url';

// Log-safety canary (SEC-087, NFR5) for the store ports. The store URL holds a password. Every
// way a port can fail, against a store that does not answer, must leave that password out of the
// error text, the error object and anything a logger would print. Story 2.1 wires the central
// canary harness; this suite is the store ports' own check until then.
const canary = `canary-${randomBytes(12).toString('hex')}`;
const endpoint = parseStoreUrl(new Secret(`redis://app:${canary}@127.0.0.1:1`), 'cache');
const timeouts = { connectTimeoutMs: 200, commandTimeoutMs: 200 };
const tenant = asTenantId('acme');

function expectClean(error: unknown): void {
  const texts = [
    String(error),
    inspect(error, { depth: 10 }),
    JSON.stringify(error, Object.getOwnPropertyNames(error as object)),
  ];
  for (const text of texts) {
    expect(text).not.toContain(canary);
    expect(text).not.toContain('127.0.0.1');
  }
}

async function failureOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

describe('store ports never leak the store URL, host or password', () => {
  it('on every cache operation against a store that does not answer', async () => {
    const client = createClient(endpoint, timeouts);
    const cache = createRedisCache({
      client,
      openSubscriber: async () => {
        throw new Error(`connect failed for redis://app:${canary}@127.0.0.1:1`);
      },
    });
    const failures = [
      await failureOf(cache.get(tenant, 'k')),
      await failureOf(cache.set(tenant, 'k', 'v', { ttlMs: 1_000 })),
      await failureOf(cache.delete(tenant, 'k')),
      await failureOf(cache.publish(tenant, 'c', 'm')),
      await failureOf(cache.subscribe(tenant, 'c', () => undefined)),
    ];
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(StoreUnavailableError);
      expectClean(failure);
    }
    await cache.close();
    client.disconnect();
  });

  it('on the rate limiter, whose decision carries no error at all', async () => {
    const client = createClient(endpoint, timeouts);
    const decision = await createRedisRateLimiter(client).consume({
      tenantId: tenant,
      bucket: 'b',
      limit: 1,
      windowMs: 1_000,
    });
    expect(JSON.stringify(decision)).not.toContain(canary);
    expect(decision).toEqual({ allowed: false, reason: 'store_unavailable' });
    client.disconnect();
  });

  it('on the queue', async () => {
    const queue = createBullMqQueue({ endpoint, timeouts });
    const failure = await failureOf(
      queue.enqueue('canary-queue', { tenantId: tenant, name: 'x', payload: {} }),
    );
    expect(failure).toBeInstanceOf(StoreUnavailableError);
    expectClean(failure);
    await queue.close();
  });

  it('the parsed endpoint is not printed by accident either', () => {
    // The endpoint object holds the password, so it is documented as never to be logged. This
    // test records the one place a password is held in clear text: the endpoint, not the Secret.
    expect(JSON.stringify(endpoint)).toContain(canary);
    expect(String(new Secret(canary))).not.toContain(canary);
  });
});

import { randomBytes } from 'node:crypto';
import { asTenantId } from '@gatemind/types';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUTS, connectClient, createClient } from './connection';
import { readDevStoreUrls } from './dev-store.test-support';
import { createRedisRateLimiter } from './redis-rate-limiter';
import { parseStoreUrl } from './store-url';

const endpoint = parseStoreUrl(readDevStoreUrls().cacheUrl, 'cache');
const tenant = (label: string) => asTenantId(`${label}-${randomBytes(4).toString('hex')}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let clientA: Redis;
let clientB: Redis;

beforeAll(async () => {
  clientA = createClient(endpoint, DEFAULT_TIMEOUTS);
  clientB = createClient(endpoint, DEFAULT_TIMEOUTS);
  await connectClient(clientA, 'cache', DEFAULT_TIMEOUTS);
  await connectClient(clientB, 'cache', DEFAULT_TIMEOUTS);
});

afterAll(() => {
  clientA.disconnect();
  clientB.disconnect();
});

describe('RedisRateLimiter', () => {
  it('allows up to the limit, counts down, then refuses with a retry time', async () => {
    const limiter = createRedisRateLimiter(clientA);
    const request = {
      tenantId: tenant('acme'),
      bucket: 'signin:ip:203.0.113.7',
      limit: 3,
      windowMs: 5_000,
    };

    const first = await limiter.consume(request);
    expect(first).toMatchObject({ allowed: true, remaining: 2 });
    expect(await limiter.consume(request)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await limiter.consume(request)).toMatchObject({ allowed: true, remaining: 0 });

    const refused = await limiter.consume(request);
    expect(refused.allowed).toBe(false);
    if (refused.allowed || refused.reason !== 'limit_exceeded')
      throw new Error('expected a refusal');
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  it('starts a new window once the old one has passed', async () => {
    const limiter = createRedisRateLimiter(clientA);
    const request = { tenantId: tenant('acme'), bucket: 'burst', limit: 1, windowMs: 300 };
    expect((await limiter.consume(request)).allowed).toBe(true);
    expect((await limiter.consume(request)).allowed).toBe(false);
    await sleep(450);
    expect((await limiter.consume(request)).allowed).toBe(true);
  });

  it('counts each tenant and each bucket separately (ARC-023)', async () => {
    const limiter = createRedisRateLimiter(clientA);
    const a = tenant('tenant-a');
    const b = tenant('tenant-b');
    expect(
      (await limiter.consume({ tenantId: a, bucket: 'x', limit: 1, windowMs: 5_000 })).allowed,
    ).toBe(true);
    expect(
      (await limiter.consume({ tenantId: a, bucket: 'x', limit: 1, windowMs: 5_000 })).allowed,
    ).toBe(false);
    expect(
      (await limiter.consume({ tenantId: b, bucket: 'x', limit: 1, windowMs: 5_000 })).allowed,
    ).toBe(true);
    expect(
      (await limiter.consume({ tenantId: a, bucket: 'y', limit: 1, windowMs: 5_000 })).allowed,
    ).toBe(true);
  });

  it('never lets concurrent callers on separate connections exceed the limit (atomic)', async () => {
    const limiterA = createRedisRateLimiter(clientA);
    const limiterB = createRedisRateLimiter(clientB);
    const request = { tenantId: tenant('acme'), bucket: 'hot', limit: 50, windowMs: 10_000 };
    const decisions = await Promise.all(
      Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? limiterA : limiterB).consume(request)),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(50);
    expect(decisions.filter((d) => !d.allowed && d.reason === 'limit_exceeded')).toHaveLength(150);
  });

  it('stores every counter under the tenant prefix with an expiry', async () => {
    const limiter = createRedisRateLimiter(clientA);
    const a = tenant('acme');
    await limiter.consume({ tenantId: a, bucket: 'shape', limit: 5, windowMs: 5_000 });
    const ttl = await clientA.pttl(`t:${a}:ratelimit:shape`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5_000);
  });

  it('repairs a counter that has lost its expiry, so it cannot become permanent', async () => {
    const limiter = createRedisRateLimiter(clientA);
    const a = tenant('acme');
    await clientA.set(`t:${a}:ratelimit:stuck`, '5');
    expect(await clientA.pttl(`t:${a}:ratelimit:stuck`)).toBe(-1);
    const decision = await limiter.consume({
      tenantId: a,
      bucket: 'stuck',
      limit: 10,
      windowMs: 5_000,
    });
    expect(decision).toMatchObject({ allowed: true, remaining: 4 });
    expect(await clientA.pttl(`t:${a}:ratelimit:stuck`)).toBeGreaterThan(0);
  });

  it('refuses an invalid request as a programming error', async () => {
    const limiter = createRedisRateLimiter(clientA);
    const base = { tenantId: tenant('acme'), bucket: 'b', limit: 1, windowMs: 1_000 };
    await expect(limiter.consume({ ...base, bucket: '' })).rejects.toThrow(TypeError);
    await expect(limiter.consume({ ...base, limit: 0 })).rejects.toThrow(TypeError);
    await expect(limiter.consume({ ...base, limit: 1.5 })).rejects.toThrow(TypeError);
    await expect(limiter.consume({ ...base, windowMs: 0 })).rejects.toThrow(TypeError);
  });
});

describe('RedisRateLimiter fails closed (SEC-022)', () => {
  it('refuses when the connection to the store is gone', async () => {
    const lost = createClient(endpoint, DEFAULT_TIMEOUTS);
    await connectClient(lost, 'cache', DEFAULT_TIMEOUTS);
    lost.disconnect();
    const limiter = createRedisRateLimiter(lost);
    expect(
      await limiter.consume({ tenantId: tenant('acme'), bucket: 'x', limit: 100, windowMs: 1_000 }),
    ).toEqual({ allowed: false, reason: 'store_unavailable' });
  });

  it('refuses when the store was never reached', async () => {
    const never = createClient({ ...endpoint, port: 1 }, DEFAULT_TIMEOUTS);
    const limiter = createRedisRateLimiter(never);
    expect(
      await limiter.consume({ tenantId: tenant('acme'), bucket: 'x', limit: 100, windowMs: 1_000 }),
    ).toEqual({ allowed: false, reason: 'store_unavailable' });
    never.disconnect();
  });
});

import { randomBytes } from 'node:crypto';
import { StoreUnavailableError, type ReceivedJob } from '@gatemind/ports';
import { asTenantId } from '@gatemind/types';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBullMqQueue, type BullMqQueue } from './bullmq-queue';
import { DEFAULT_TIMEOUTS, baseOptions } from './connection';
import { readDevStoreUrls } from './dev-store.test-support';
import { parseStoreUrl } from './store-url';

const endpoint = parseStoreUrl(readDevStoreUrls().queueUrl, 'queue');
const hex = () => randomBytes(4).toString('hex');
const tenant = (label: string) => asTenantId(`${label}-${hex()}`);
const queueName = () => `test-${hex()}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

let queue: BullMqQueue;
const rawQueues: Queue[] = [];

/** A direct BullMQ handle for what the port deliberately hides: reading and forging jobs. */
function rawQueue(name: string): Queue {
  const raw = new Queue(name, { connection: baseOptions(endpoint) });
  raw.on('error', () => undefined);
  rawQueues.push(raw);
  return raw;
}

beforeAll(() => {
  queue = createBullMqQueue({ endpoint, timeouts: DEFAULT_TIMEOUTS });
});

afterAll(async () => {
  await queue.close();
  for (const raw of rawQueues) {
    await raw.obliterate({ force: true });
    await raw.close();
  }
});

describe('BullMqQueue delivery', () => {
  it('hands a job to the worker with its tenant, name and payload', async () => {
    const name = queueName();
    const a = tenant('acme');
    const received: ReceivedJob<{ n: number; text: string }>[] = [];
    await queue.process<{ n: number; text: string }>(name, async (job) => {
      received.push(job);
    });
    rawQueue(name); // so the queue is cleaned up afterwards

    const receipt = await queue.enqueue(name, {
      tenantId: a,
      name: 'usage event/1',
      payload: { n: 7, text: 'héllo' },
    });
    expect(receipt.jobId).not.toBe('');

    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({
      tenantId: a,
      name: 'usage event/1',
      payload: { n: 7, text: 'héllo' },
      attemptsMade: 0,
    });
  });

  it('retries a failing handler with backoff until it succeeds', async () => {
    const name = queueName();
    const attemptsSeen: number[] = [];
    await queue.process(name, async (job) => {
      attemptsSeen.push(job.attemptsMade);
      if (job.attemptsMade === 0) throw new Error('first try fails');
    });
    rawQueue(name);

    await queue.enqueue(name, {
      tenantId: tenant('acme'),
      name: 'flaky',
      payload: {},
      attempts: 3,
      backoffMs: 50,
    });
    await waitFor(() => attemptsSeen.length === 2);
    expect(attemptsSeen).toEqual([0, 1]);
  });

  it('does not retry when only one attempt is allowed', async () => {
    const name = queueName();
    let calls = 0;
    await queue.process(name, async () => {
      calls += 1;
      throw new Error('always fails');
    });
    const raw = rawQueue(name);

    await queue.enqueue(name, { tenantId: tenant('acme'), name: 'once', payload: {} });
    await waitFor(async () => (await raw.getFailedCount()) === 1);
    await sleep(200);
    expect(calls).toBe(1);
  });
});

describe('BullMqQueue tenant context (ARC-023)', () => {
  it('stores the tenant in the job name and the data, and bounds retained history', async () => {
    const name = queueName();
    const a = tenant('acme');
    const raw = rawQueue(name);

    const { jobId } = await queue.enqueue(name, {
      tenantId: a,
      name: 'later',
      payload: { ok: true },
      delayMs: 60_000,
    });
    const stored = await raw.getJob(jobId);
    expect(stored?.name).toBe(`t:${a}:later`);
    expect(stored?.data).toEqual({ tenantId: a, payload: { ok: true } });
    expect(stored?.opts.removeOnComplete).toEqual({ count: 1_000 });
    expect(stored?.opts.removeOnFail).toEqual({ count: 5_000 });
  });

  it('refuses a job whose tenant disagrees with its name, and a job with no tenant', async () => {
    const name = queueName();
    const a = tenant('tenant-a');
    const b = tenant('tenant-b');
    const handled: string[] = [];
    await queue.process(name, async (job) => {
      handled.push(job.name);
    });
    const raw = rawQueue(name);

    await raw.add(`t:${a}:forged`, { tenantId: b, payload: { stolen: true } });
    await raw.add(`t:${a}:untenanted`, { payload: {} });
    await raw.add('plain-name', { tenantId: a, payload: {} });

    await waitFor(async () => (await raw.getFailedCount()) === 3);
    expect(handled).toEqual([]);
  });

  it('never puts a payload in the reason a job failed', async () => {
    const name = queueName();
    const a = tenant('tenant-a');
    const b = tenant('tenant-b');
    await queue.process(name, async () => undefined);
    const raw = rawQueue(name);
    const canary = `payload-canary-${hex()}`;

    const forged = await raw.add(`t:${a}:forged`, { tenantId: b, payload: { canary } });
    await waitFor(async () => (await raw.getFailedCount()) === 1);
    const failed = await raw.getJob(forged.id as string);
    expect(failed?.failedReason).toBe('The job tenant does not match its name');
    expect(failed?.failedReason).not.toContain(canary);
  });
});

describe('BullMqQueue input checks', () => {
  it('refuses unsafe queue names and invalid options as programming errors', async () => {
    const a = tenant('acme');
    const job = { tenantId: a, name: 'x', payload: {} };
    for (const bad of [
      '',
      'Upper',
      'has:colon',
      'has space',
      '1starts-with-digit',
      'a'.repeat(64),
    ]) {
      await expect(queue.enqueue(bad, job)).rejects.toThrow(TypeError);
      await expect(queue.process(bad, async () => undefined)).rejects.toThrow(TypeError);
    }
    const name = queueName();
    await expect(queue.enqueue(name, { ...job, name: '' })).rejects.toThrow(TypeError);
    await expect(queue.enqueue(name, { ...job, attempts: 0 })).rejects.toThrow(TypeError);
    await expect(queue.enqueue(name, { ...job, delayMs: -1 })).rejects.toThrow(TypeError);
    await expect(queue.enqueue(name, { ...job, backoffMs: 1.5 })).rejects.toThrow(TypeError);
    await expect(queue.process(name, async () => undefined, { concurrency: 0 })).rejects.toThrow(
      TypeError,
    );
  });
});

describe('BullMqQueue when the store is unreachable', () => {
  it('rejects an enqueue with StoreUnavailableError, without hanging', async () => {
    const unreachable = createBullMqQueue({
      endpoint: { ...endpoint, port: 1 },
      timeouts: { connectTimeoutMs: 300, commandTimeoutMs: 300 },
    });
    const started = Date.now();
    await expect(
      unreachable.enqueue(queueName(), { tenantId: tenant('acme'), name: 'x', payload: {} }),
    ).rejects.toThrow(StoreUnavailableError);
    expect(Date.now() - started).toBeLessThan(5_000);
    await unreachable.close();
  });
});

import {
  StoreUnavailableError,
  type QueueHandler,
  type QueueJobSpec,
  type QueuePort,
  type QueueReceipt,
  type QueueWorkerOptions,
} from '@gatemind/ports';
import { tenantQueueJobName } from '@gatemind/tenancy';
import { asTenantId } from '@gatemind/types';
import { Queue, Worker } from 'bullmq';
import { baseOptions, type StoreTimeouts } from './connection';
import type { StoreEndpoint } from './store-url';

export interface BullMqQueueOptions {
  readonly endpoint: StoreEndpoint;
  readonly timeouts: StoreTimeouts;
}

export interface BullMqQueue extends QueuePort {
  /** Stops the workers and closes every connection this queue opened. Safe to call twice. */
  close(): Promise<void>;
}

/** What a job carries. The tenant is also in the job name, so the two can be checked. */
interface JobData {
  readonly tenantId: string;
  readonly payload: unknown;
}

const QUEUE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_NAME_LENGTH = 100;
const MAX_ATTEMPTS = 50;
const DEFAULT_BACKOFF_MS = 1_000;
const MAX_CONCURRENCY = 100;

/**
 * Finished and failed jobs are trimmed. The queue store never evicts (SEC-022), so without a
 * bound the history would grow until the store is full.
 */
const KEEP_COMPLETED = 1_000;
const KEEP_FAILED = 5_000;

function requireQueueName(queue: string): void {
  if (!QUEUE_NAME.test(queue)) {
    throw new TypeError(
      'A queue name must be 1 to 63 characters: lower-case letters, digits and "-", starting with a letter',
    );
  }
}

function requireInteger(value: number, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer from ${min} to ${max}`);
  }
}

/** Gives up on a call that does not settle in time. A hung store must never hang a request. */
async function withDeadline<T>(call: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StoreUnavailableError()), deadlineMs);
  });
  try {
    return await Promise.race([call, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function unavailable(): never {
  // The cause is dropped on purpose: driver errors can name a host. Callers only need the fact.
  throw new StoreUnavailableError();
}

/** `QueuePort` on BullMQ. Job names carry the tenant (ARC-023); a mismatch fails the job. */
export function createBullMqQueue(options: BullMqQueueOptions): BullMqQueue {
  const { endpoint, timeouts } = options;
  const queues = new Map<string, Queue>();
  const workers: Worker[] = [];
  let closed = false;

  // Producers fail fast: no offline queue and a command timeout. Workers keep a blocking
  // connection, which must have neither (a blocking read is long by design), so they get the
  // plain endpoint options and BullMQ sets the rest.
  const producerConnection = {
    ...baseOptions(endpoint),
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: timeouts.connectTimeoutMs,
    commandTimeout: timeouts.commandTimeoutMs,
  };
  const workerConnection = { ...baseOptions(endpoint), maxRetriesPerRequest: null };

  const queueFor = (name: string): Queue => {
    let queue = queues.get(name);
    if (queue === undefined) {
      queue = new Queue(name, {
        connection: producerConnection,
        defaultJobOptions: {
          removeOnComplete: { count: KEEP_COMPLETED },
          removeOnFail: { count: KEEP_FAILED },
        },
      });
      // An unhandled 'error' event would crash the process. Failures surface from `add`.
      queue.on('error', () => undefined);
      queues.set(name, queue);
    }
    return queue;
  };

  return {
    async enqueue<TPayload>(queueName: string, job: QueueJobSpec<TPayload>): Promise<QueueReceipt> {
      requireQueueName(queueName);
      if (job.name === '' || job.name.length > MAX_NAME_LENGTH) {
        throw new TypeError(`A job name must be 1 to ${MAX_NAME_LENGTH} characters`);
      }
      const attempts = job.attempts ?? 1;
      requireInteger(attempts, 'attempts', 1, MAX_ATTEMPTS);
      const delay = job.delayMs ?? 0;
      requireInteger(delay, 'delayMs', 0, 31 * 24 * 60 * 60 * 1000);
      const backoff = job.backoffMs ?? DEFAULT_BACKOFF_MS;
      requireInteger(backoff, 'backoffMs', 0, 60 * 60 * 1000);

      const jobName = tenantQueueJobName(job.tenantId, job.name);
      const data: JobData = { tenantId: job.tenantId, payload: job.payload };
      try {
        const added = await withDeadline(
          queueFor(queueName).add(jobName, data, {
            delay,
            attempts,
            ...(attempts > 1 ? { backoff: { type: 'exponential', delay: backoff } } : {}),
          }),
          timeouts.connectTimeoutMs + timeouts.commandTimeoutMs,
        );
        if (added.id === undefined) return unavailable();
        return { jobId: String(added.id) };
      } catch (error) {
        if (error instanceof StoreUnavailableError) throw error;
        return unavailable();
      }
    },

    async process<TPayload>(
      queueName: string,
      handler: QueueHandler<TPayload>,
      workerOptions?: QueueWorkerOptions,
    ): Promise<void> {
      requireQueueName(queueName);
      const concurrency = workerOptions?.concurrency ?? 1;
      requireInteger(concurrency, 'concurrency', 1, MAX_CONCURRENCY);

      const worker = new Worker(
        queueName,
        async (job) => {
          const data = job.data as Partial<JobData> | undefined;
          const tenant = typeof data?.tenantId === 'string' ? data.tenantId : '';
          const prefix = `t:${tenant}:`;
          // A job whose tenant and name disagree could cross a tenant boundary: refuse it.
          // The messages are fixed text and never include the payload (SEC-050).
          const tenantId = asTenantId(tenant);
          if (!job.name.startsWith(prefix)) {
            throw new Error('The job tenant does not match its name');
          }
          await handler({
            tenantId,
            name: decodeURIComponent(job.name.slice(prefix.length)),
            payload: data?.payload as TPayload,
            attemptsMade: job.attemptsMade,
          });
        },
        { connection: workerConnection, concurrency },
      );
      worker.on('error', () => undefined);
      workers.push(worker);
      await worker.waitUntilReady();
    },

    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(workers.map((worker) => worker.close()));
      await Promise.allSettled([...queues.values()].map((queue) => queue.close()));
    },
  };
}

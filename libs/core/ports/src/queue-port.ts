import type { TenantId } from '@gatemind/types';

export interface QueueJobSpec<TPayload> {
  readonly tenantId: TenantId;
  /** What kind of job this is within the queue, for example `usage.event`. Not a secret. */
  readonly name: string;
  /** Must survive a JSON round trip. Never put a secret or a prompt in a payload (SEC-050). */
  readonly payload: TPayload;
  readonly delayMs?: number;
  /** Total tries including the first. Default 1 (no retry). */
  readonly attempts?: number;
  /** Base delay for exponential backoff between tries, in milliseconds. Default 1000. */
  readonly backoffMs?: number;
}

export interface QueueReceipt {
  readonly jobId: string;
}

export interface ReceivedJob<TPayload> {
  readonly tenantId: TenantId;
  readonly name: string;
  readonly payload: TPayload;
  /** Tries already made before this one. */
  readonly attemptsMade: number;
}

/** Resolve to finish the job. Reject (throw) to fail it, which retries it while tries remain. */
export type QueueHandler<TPayload> = (job: ReceivedJob<TPayload>) => Promise<void>;

export interface QueueWorkerOptions {
  /** Jobs handled at the same time by this process. Default 1. */
  readonly concurrency?: number;
}

/**
 * Background job queue port (ARC-055). The default implementation uses BullMQ on a dedicated
 * Redis-compatible instance that never evicts data (SEC-022, ADR 0003).
 *
 * Contract:
 * - `queue` is a short static name such as `usage`: lower-case letters, digits and `-`.
 *   It never holds tenant data. Tenant context travels in the job: the stored job name starts
 *   with the tenant, and a worker refuses a job whose tenant disagrees with its name (ARC-023).
 * - Delivery is at least once. Handlers must be idempotent.
 * - Retention is bounded: finished and failed jobs are trimmed, so the queue cannot grow without
 *   limit on a store that never evicts.
 * - `process` returns once the worker is ready; the worker runs until `close()`.
 * - `close()` waits for running jobs, then releases every connection.
 */
export interface QueuePort {
  enqueue<TPayload>(queue: string, job: QueueJobSpec<TPayload>): Promise<QueueReceipt>;
  process<TPayload>(
    queue: string,
    handler: QueueHandler<TPayload>,
    options?: QueueWorkerOptions,
  ): Promise<void>;
  close(): Promise<void>;
}

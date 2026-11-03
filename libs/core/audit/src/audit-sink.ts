import { setTimeout as sleep } from 'node:timers/promises';
import {
  type AuditEvent,
  type AuditReceipt,
  type AuditSink,
  type Clock,
  systemClock,
} from '@gatemind/ports';
import { GENESIS_HASH, computeEntryHash } from './chain';
import { AuditError } from './errors';
import type { AuditStorage } from './storage';
import { validateAuditEvent } from './validate';

export interface AuditSinkOptions {
  readonly storage: AuditStorage;
  readonly clock?: Clock;
  /** How many times to retry after losing a race with another writer. Default 50. */
  readonly maxAttempts?: number;
}

/**
 * The `AuditSink` implementation: a hash chain per tenant (SEC-070).
 *
 * Concurrency. Within one process, events of a tenant are written one after the other, so they
 * do not compete. Across processes the database decides: two writers cannot both store the same
 * position or extend the same entry (unique keys), so the loser reads the new head and tries
 * again. The chain therefore never forks, and no event is lost: `record` either stores it or
 * rejects.
 *
 * The caller never sets the timestamp, the sequence number or a hash.
 */
export function createAuditSink(options: AuditSinkOptions): AuditSink {
  const { storage } = options;
  const clock = options.clock ?? systemClock;
  const maxAttempts = options.maxAttempts ?? 50;
  const tails = new Map<string, Promise<void>>();

  async function append(event: AuditEvent): Promise<AuditReceipt> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const head = await storage.head(event.tenantId);
      const seq = head === undefined ? 1 : head.seq + 1;
      const prevHash = head === undefined ? GENESIS_HASH : head.hash;
      const occurredAtMs = clock.nowMs();
      if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
        throw new AuditError('invalid_event', 'The audit timestamp is not valid');
      }
      const fields = {
        tenantId: event.tenantId,
        seq,
        occurredAtMs,
        actor: event.actor,
        action: event.action,
        target: event.target,
        prevHash,
      };
      const hash = computeEntryHash(fields);
      if (await storage.append({ ...fields, hash })) return { seq, hash };
      await sleep(Math.floor(Math.random() * Math.min(50, 2 * (attempt + 1))));
    }
    throw new AuditError(
      'write_contention',
      'The audit entry could not be stored because of too many concurrent writers',
    );
  }

  return {
    // `async`, so an invalid event rejects the returned promise and never throws synchronously.
    async record(event) {
      validateAuditEvent(event);
      // Copy after validating, so a caller cannot change the event while it waits its turn.
      const copy: AuditEvent = {
        tenantId: event.tenantId,
        actor: event.actor,
        action: event.action,
        target: event.target,
      };
      const previous = tails.get(copy.tenantId) ?? Promise.resolve();
      const run = previous.then(() => append(copy));
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(copy.tenantId, tail);
      void tail.then(() => {
        if (tails.get(copy.tenantId) === tail) tails.delete(copy.tenantId);
      });
      return run;
    },
  };
}

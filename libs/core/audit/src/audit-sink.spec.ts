import type { Clock } from '@gatemind/ports';
import type { EpochMs } from '@gatemind/types';
import { describe, expect, it } from 'vitest';
import { createAuditSink } from './audit-sink';
import { GENESIS_HASH, computeEntryHash } from './chain';
import { AuditError } from './errors';
import { MemoryAuditStorage } from './memory-storage';
import type { AuditStorage } from './storage';
import { verifyAuditChain } from './verify';

function steppingClock(start = 1_700_000_000_000): Clock {
  let now = start;
  return { nowMs: () => now++ as EpochMs };
}

const event = (n: number, tenantId = 'tenant-a') => ({
  tenantId,
  actor: 'user:alice',
  action: 'provider.key.rotate',
  target: `provider-connection:${n}`,
});

describe('writing through the AuditSink port', () => {
  it('stores actor, action, target, timestamp, tenant and the previous hash', async () => {
    const storage = new MemoryAuditStorage();
    const sink = createAuditSink({ storage, clock: steppingClock(1000) });

    const first = await sink.record(event(1));
    const second = await sink.record(event(2));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    const [a, b] = storage.rows;
    expect(Object.keys(a ?? {}).sort()).toEqual(
      ['action', 'actor', 'hash', 'occurredAtMs', 'prevHash', 'seq', 'target', 'tenantId'].sort(),
    );
    expect(a).toMatchObject({
      tenantId: 'tenant-a',
      seq: 1,
      occurredAtMs: 1000,
      actor: 'user:alice',
      action: 'provider.key.rotate',
      target: 'provider-connection:1',
      prevHash: GENESIS_HASH,
      hash: first.hash,
    });
    expect(b?.prevHash).toBe(a?.hash);
    expect(first.hash).toBe(computeEntryHash(a!));
  });

  it('keeps a separate chain for every tenant', async () => {
    const storage = new MemoryAuditStorage();
    const sink = createAuditSink({ storage });
    await sink.record(event(1, 'tenant-a'));
    await sink.record(event(1, 'tenant-b'));
    const second = await sink.record(event(2, 'tenant-a'));

    expect(second.seq).toBe(2);
    expect(storage.rows.filter((r) => r.tenantId === 'tenant-b').map((r) => r.seq)).toEqual([1]);
    expect(storage.rows.find((r) => r.tenantId === 'tenant-b')?.prevHash).toBe(GENESIS_HASH);
  });

  it('writes many concurrent events into one valid chain with no fork', async () => {
    const storage = new MemoryAuditStorage();
    const sink = createAuditSink({ storage });

    const receipts = await Promise.all(
      Array.from({ length: 100 }, (_, i) => sink.record(event(i))),
    );

    expect(new Set(receipts.map((r) => r.seq)).size).toBe(100);
    expect(storage.rows).toHaveLength(100);
    const result = await verifyAuditChain(storage);
    expect(result).toMatchObject({ ok: true, entries: 100 });
  });

  it('stays a single chain when two writers race, as two processes would', async () => {
    const storage = new MemoryAuditStorage();
    const writerA = createAuditSink({ storage });
    const writerB = createAuditSink({ storage });

    await Promise.all([
      ...Array.from({ length: 40 }, (_, i) => writerA.record(event(i))),
      ...Array.from({ length: 40 }, (_, i) => writerB.record(event(100 + i))),
    ]);

    expect(storage.rows).toHaveLength(80);
    expect(new Set(storage.rows.map((r) => r.seq)).size).toBe(80);
    expect(new Set(storage.rows.map((r) => r.prevHash)).size).toBe(80);
    expect(await verifyAuditChain(storage)).toMatchObject({ ok: true, entries: 80 });
  });

  it('rejects instead of dropping an event when it cannot win a position', async () => {
    const storage: AuditStorage = {
      head: async () => undefined,
      append: async () => false,
      list: async () => [],
      listTenantIds: async () => [],
    };
    const sink = createAuditSink({ storage, maxAttempts: 3 });
    await expect(sink.record(event(1))).rejects.toMatchObject({ code: 'write_contention' });
  });

  it('passes a storage failure on and keeps working afterwards', async () => {
    const storage = new MemoryAuditStorage();
    let fail = true;
    const flaky: AuditStorage = {
      head: (t) => storage.head(t),
      append: async (entry) => {
        if (fail) throw new Error('database down');
        return storage.append(entry);
      },
      list: (t, o) => storage.list(t, o),
      listTenantIds: () => storage.listTenantIds(),
    };
    const sink = createAuditSink({ storage: flaky });

    await expect(sink.record(event(1))).rejects.toThrow('database down');
    fail = false;
    expect(await sink.record(event(2))).toMatchObject({ seq: 1 });
  });
});

describe('what an audit entry may contain (SEC-050)', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['an e-mail address as actor', { actor: 'alice@example.com' }],
    ['a space in the target', { target: 'password is hunter2' }],
    ['a key=value pair', { target: 'token=abc123' }],
    ['an upper case action', { action: 'Auth.SignIn' }],
    ['an empty target', { target: '' }],
    ['an over-long target', { target: 'a'.repeat(129) }],
    ['a non-string actor', { actor: { id: 'x' } }],
    ['an invalid tenant id', { tenantId: 'tenant a' }],
  ];

  it.each(bad)('rejects %s', async (_name, patch) => {
    const sink = createAuditSink({ storage: new MemoryAuditStorage() });
    await expect(sink.record({ ...event(1), ...patch } as never)).rejects.toBeInstanceOf(
      AuditError,
    );
  });

  it('never repeats a rejected value in the error, and stores nothing', async () => {
    const storage = new MemoryAuditStorage();
    const sink = createAuditSink({ storage });
    const canary = 'CANARY=sk-live-4f9a7c1e2b';

    const error = await sink.record({ ...event(1), target: canary }).then(
      () => undefined,
      (e: unknown) => e as AuditError,
    );

    expect(error?.code).toBe('invalid_event');
    expect(String(error?.message)).not.toContain('CANARY');
    expect(String(error?.stack)).not.toContain('sk-live');
    expect(storage.rows).toHaveLength(0);
  });

  it('has no field that could carry a payload: only the eight columns exist', async () => {
    const storage = new MemoryAuditStorage();
    const sink = createAuditSink({ storage });
    await sink.record({ ...event(1), extra: 'Bearer abc', password: 'x' } as never);
    expect(Object.keys(storage.rows[0] ?? {})).toHaveLength(8);
    expect(JSON.stringify(storage.rows)).not.toContain('Bearer');
  });

  it('ignores a change to the event made while it waits for its turn', async () => {
    const storage = new MemoryAuditStorage();
    const sink = createAuditSink({ storage });
    const mutable = { ...event(1) };
    const first = sink.record(event(0));
    const second = sink.record(mutable);
    mutable.target = 'tampered:later';
    await Promise.all([first, second]);
    expect(storage.rows[1]?.target).toBe('provider-connection:1');
  });
});

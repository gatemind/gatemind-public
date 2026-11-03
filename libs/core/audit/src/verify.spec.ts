import type { EpochMs } from '@gatemind/types';
import { describe, expect, it } from 'vitest';
import { createAuditSink } from './audit-sink';
import { computeEntryHash } from './chain';
import { MemoryAuditStorage } from './memory-storage';
import { verifyAuditChain } from './verify';

async function chain(count: number, tenantId = 'tenant-a'): Promise<MemoryAuditStorage> {
  const storage = new MemoryAuditStorage();
  let now = 1_700_000_000_000;
  const sink = createAuditSink({ storage, clock: { nowMs: () => now++ as EpochMs } });
  for (let i = 1; i <= count; i += 1) {
    await sink.record({
      tenantId,
      actor: 'user:alice',
      action: 'project.create',
      target: `project:${i}`,
    });
  }
  return storage;
}

const row = (storage: MemoryAuditStorage, seq: number) => {
  const found = storage.rows.find((r) => r.seq === seq);
  if (found === undefined) throw new Error(`no row ${seq}`);
  return found;
};

describe('verifying an intact chain', () => {
  it('reports OK with the entry count and the chain-head hash', async () => {
    const storage = await chain(5);
    const result = await verifyAuditChain(storage);
    expect(result).toEqual({
      ok: true,
      entries: 5,
      tenants: [{ tenantId: 'tenant-a', entries: 5, headHash: row(storage, 5).hash }],
    });
  });

  it('is valid across batch boundaries', async () => {
    const storage = await chain(7);
    expect(await verifyAuditChain(storage, { batchSize: 2 })).toMatchObject({
      ok: true,
      entries: 7,
    });
  });

  it('covers every tenant, or only the one asked for', async () => {
    const storage = await chain(2, 'tenant-a');
    const other = await chain(3, 'tenant-b');
    storage.rows.push(...other.rows);

    const all = await verifyAuditChain(storage);
    expect(all).toMatchObject({ ok: true, entries: 5 });
    const one = await verifyAuditChain(storage, { tenantId: 'tenant-b' });
    expect(one).toMatchObject({ ok: true, entries: 3 });
  });

  it('reports an empty log and an unknown tenant as intact with no head', async () => {
    expect(await verifyAuditChain(new MemoryAuditStorage())).toEqual({
      ok: true,
      entries: 0,
      tenants: [],
    });
    const result = await verifyAuditChain(new MemoryAuditStorage(), { tenantId: 'nobody' });
    expect(result).toMatchObject({
      ok: true,
      tenants: [{ tenantId: 'nobody', entries: 0, headHash: undefined }],
    });
  });
});

describe('verifying a chain that was changed directly in the database (FR-5)', () => {
  it('names an altered entry', async () => {
    const storage = await chain(5);
    storage.rows = storage.rows.map((r) => (r.seq === 3 ? { ...r, actor: 'user:mallory' } : r));

    expect(await verifyAuditChain(storage)).toMatchObject({
      ok: false,
      entriesVerified: 2,
      broken: { tenantId: 'tenant-a', seq: 3, reason: 'content_altered' },
    });
  });

  it('names the entry after a deleted one', async () => {
    const storage = await chain(5);
    storage.rows = storage.rows.filter((r) => r.seq !== 3);

    expect(await verifyAuditChain(storage)).toMatchObject({
      ok: false,
      broken: { seq: 4, reason: 'missing_entry' },
    });
  });

  it('notices when the first entry was deleted', async () => {
    const storage = await chain(3);
    storage.rows = storage.rows.filter((r) => r.seq !== 1);
    expect(await verifyAuditChain(storage)).toMatchObject({
      ok: false,
      broken: { seq: 2, reason: 'missing_entry' },
    });
  });

  it('names the first entry that is out of order when two are swapped', async () => {
    const storage = await chain(5);
    storage.rows = storage.rows.map((r) =>
      r.seq === 2 ? { ...r, seq: 3 } : r.seq === 3 ? { ...r, seq: 2 } : r,
    );

    expect(await verifyAuditChain(storage)).toMatchObject({
      ok: false,
      broken: { seq: 2, reason: 'link_broken' },
    });
  });

  it('notices an altered entry even when its own hash was recomputed', async () => {
    const storage = await chain(4);
    storage.rows = storage.rows.map((r) => {
      if (r.seq !== 2) return r;
      const forged = { ...r, target: 'project:forged' };
      return { ...forged, hash: computeEntryHash(forged) };
    });

    expect(await verifyAuditChain(storage)).toMatchObject({
      ok: false,
      broken: { seq: 3, reason: 'link_broken' },
    });
  });

  it('notices a changed timestamp, tenant column or previous hash', async () => {
    for (const patch of [{ occurredAtMs: 5 }, { prevHash: 'f'.repeat(64) }]) {
      const storage = await chain(3);
      storage.rows = storage.rows.map((r) => (r.seq === 2 ? { ...r, ...patch } : r));
      const result = await verifyAuditChain(storage);
      expect(result.ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it('stops at the first break and does not hide a later one', async () => {
    const storage = await chain(6);
    storage.rows = storage.rows.map((r) =>
      r.seq === 2 || r.seq === 5 ? { ...r, actor: 'user:mallory' } : r,
    );
    expect(await verifyAuditChain(storage)).toMatchObject({ broken: { seq: 2 } });
  });

  it('only checks the tenant asked for', async () => {
    const storage = await chain(2, 'tenant-a');
    const other = await chain(2, 'tenant-b');
    storage.rows.push(...other.rows.map((r) => (r.seq === 1 ? { ...r, actor: 'user:x' } : r)));

    expect(await verifyAuditChain(storage, { tenantId: 'tenant-a' })).toMatchObject({ ok: true });
    expect(await verifyAuditChain(storage)).toMatchObject({
      ok: false,
      broken: { tenantId: 'tenant-b', seq: 1 },
    });
  });
});

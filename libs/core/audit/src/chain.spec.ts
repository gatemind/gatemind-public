import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, type HashedFields, computeEntryHash } from './chain';

const base: HashedFields = {
  tenantId: 'tenant-a',
  seq: 1,
  occurredAtMs: 1_700_000_000_000,
  actor: 'user:alice',
  action: 'auth.signin',
  target: 'user:alice',
  prevHash: GENESIS_HASH,
};

describe('entry hash', () => {
  it('is a stable 64 character SHA-256 hex digest', () => {
    expect(computeEntryHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEntryHash({ ...base })).toBe(computeEntryHash(base));
  });

  it('changes when any covered field changes', () => {
    const original = computeEntryHash(base);
    const changed: Partial<HashedFields>[] = [
      { tenantId: 'tenant-b' },
      { seq: 2 },
      { occurredAtMs: base.occurredAtMs + 1 },
      { actor: 'user:bob' },
      { action: 'auth.signout' },
      { target: 'user:bob' },
      { prevHash: '1'.repeat(64) },
    ];
    for (const change of changed) {
      expect(computeEntryHash({ ...base, ...change }), JSON.stringify(change)).not.toBe(original);
    }
  });

  it('cannot be confused by moving text between neighbouring fields', () => {
    const a = computeEntryHash({ ...base, actor: 'a:b', action: 'c' });
    const b = computeEntryHash({ ...base, actor: 'a', action: 'b:c' });
    expect(a).not.toBe(b);
  });

  it('starts every chain from 64 zeros', () => {
    expect(GENESIS_HASH).toBe('0'.repeat(64));
  });
});

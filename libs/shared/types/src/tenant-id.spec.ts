import { describe, expect, it } from 'vitest';
import { asTenantId, isTenantId } from './index';

describe('TenantId', () => {
  it('accepts safe identifiers', () => {
    for (const value of ['t1', 'tenant-a', 'Org_42', '0188f9c4-7a52-7c1e-9d3b-2f6a1c0e5b77']) {
      expect(isTenantId(value)).toBe(true);
      expect(asTenantId(value)).toBe(value);
    }
  });

  it('rejects anything that could break a key, path or log field', () => {
    const unsafe = [
      '',
      ' ',
      'a:b',
      'a/b',
      '../x',
      'a b',
      'a\nb',
      '-lead',
      '_lead',
      'x'.repeat(65),
      'ü',
    ];
    for (const value of unsafe) {
      expect(isTenantId(value)).toBe(false);
      expect(() => asTenantId(value)).toThrow(TypeError);
    }
    expect(isTenantId(42)).toBe(false);
    expect(isTenantId(undefined)).toBe(false);
  });
});

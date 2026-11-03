import { asTenantId } from '@gatemind/types';
import { describe, expect, it } from 'vitest';
import { createTenantContext } from './tenant-context';
import {
  tenantCacheKey,
  tenantLogFields,
  tenantQueueJobName,
  tenantStoragePath,
} from './tenant-keys';

const a = asTenantId('tenant-a');
const b = asTenantId('tenant-b');

describe('tenant-scoped names (ARC-023)', () => {
  it('prefixes cache keys with the tenant, so two tenants never share a key', () => {
    expect(tenantCacheKey(a, 'routes', 'snapshot')).toBe('t:tenant-a:routes:snapshot');
    expect(tenantCacheKey(a, 'x')).not.toBe(tenantCacheKey(b, 'x'));
  });

  it('encodes parts so a part cannot forge another tenant prefix', () => {
    const key = tenantCacheKey(a, 't:tenant-b:secret');
    expect(key.startsWith('t:tenant-a:')).toBe(true);
    expect(key.split(':')).toHaveLength(3);
  });

  it('scopes queue job names and log fields', () => {
    expect(tenantQueueJobName(a, 'usage-rollup')).toBe('t:tenant-a:usage-rollup');
    expect(tenantLogFields(a)).toEqual({ tenant_id: 'tenant-a' });
  });

  it('builds storage paths inside the tenant folder only', () => {
    expect(tenantStoragePath(a, 'exports', 'usage.csv')).toBe('tenants/tenant-a/exports/usage.csv');
    for (const bad of ['..', '.', 'a/b', 'a\\b', '', 'a\0b']) {
      expect(() => tenantStoragePath(a, bad)).toThrow(TypeError);
    }
  });

  it('rejects missing parts and invalid tenant ids at runtime', () => {
    expect(() => tenantCacheKey(a)).toThrow(TypeError);
    expect(() => tenantCacheKey(a, '')).toThrow(TypeError);
    expect(() => tenantCacheKey('a:b' as never, 'x')).toThrow(TypeError);
    expect(() => createTenantContext('bad id')).toThrow(TypeError);
  });
});

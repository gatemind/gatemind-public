import { describe, expect, it } from 'vitest';
import { createScopeContext } from './tenant-context';

const ids = {
  tenantId: 'default',
  workspaceId: 'default',
  projectId: 'default',
  environmentId: 'default',
};

describe('createScopeContext', () => {
  it('builds a frozen context holding the tenant and the three scope ids', () => {
    const scope = createScopeContext(ids);
    expect(scope).toEqual(ids);
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it('rejects an invalid tenant id', () => {
    expect(() => createScopeContext({ ...ids, tenantId: 'bad/tenant' })).toThrow(TypeError);
  });

  it('rejects an empty or oversized scope id', () => {
    expect(() => createScopeContext({ ...ids, workspaceId: '' })).toThrow(TypeError);
    expect(() => createScopeContext({ ...ids, projectId: 'x'.repeat(65) })).toThrow(TypeError);
    expect(() => createScopeContext({ ...ids, environmentId: '' })).toThrow(TypeError);
  });
});

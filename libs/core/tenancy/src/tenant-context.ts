import { type TenantId, asTenantId } from '@gatemind/types';

/**
 * The tenant a unit of work runs for. `tenantId` is the organization (ARC-024).
 * Workspace, project and environment are scope columns inside the tenant (see `ScopeContext`).
 */
export interface TenantContext {
  readonly tenantId: TenantId;
}

export function createTenantContext(tenantId: string): TenantContext {
  return Object.freeze({ tenantId: asTenantId(tenantId) });
}

/**
 * The tenant plus the workspace, project and environment a unit of work runs in (ARC-024).
 * Only the organization is the tenant boundary; the other three ids narrow the scope.
 */
export interface ScopeContext extends TenantContext {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

export interface ScopeIds {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
}

const MAX_SCOPE_ID_LENGTH = 64;

function requireScopeId(label: string, value: string): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_SCOPE_ID_LENGTH) {
    throw new TypeError(`Invalid ${label}: use 1 to ${MAX_SCOPE_ID_LENGTH} characters`);
  }
  return value;
}

export function createScopeContext(ids: ScopeIds): ScopeContext {
  return Object.freeze({
    ...createTenantContext(ids.tenantId),
    workspaceId: requireScopeId('workspace id', ids.workspaceId),
    projectId: requireScopeId('project id', ids.projectId),
    environmentId: requireScopeId('environment id', ids.environmentId),
  });
}

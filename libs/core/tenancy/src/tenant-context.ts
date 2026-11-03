import { type TenantId, asTenantId } from '@gatemind/types';

/**
 * The tenant a unit of work runs for. `tenantId` is the organization (ARC-024).
 * Workspace, project and environment scopes are added with the hierarchy (Story 1.4).
 */
export interface TenantContext {
  readonly tenantId: TenantId;
}

export function createTenantContext(tenantId: string): TenantContext {
  return Object.freeze({ tenantId: asTenantId(tenantId) });
}

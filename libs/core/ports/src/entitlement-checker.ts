import type { TenantId } from '@gatemind/types';

/**
 * Decides whether a tenant may use a capability that is outside the open-source scope (ARC-050).
 * The decision is always made on the server; hiding a screen is never access control.
 */
export interface EntitlementChecker {
  isEntitled(tenantId: TenantId, entitlement: string): Promise<boolean>;
}

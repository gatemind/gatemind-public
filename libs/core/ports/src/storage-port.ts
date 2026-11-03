import type { TenantId } from '@gatemind/types';

/**
 * Object storage port (ARC-055), for example backup files. Paths are given as segments and the
 * implementation places them under the tenant (`tenantStoragePath`), so a segment can never
 * escape the tenant (ARC-023). A later story supplies the first implementation.
 */
export interface StoragePort {
  put(tenantId: TenantId, segments: readonly string[], data: Uint8Array): Promise<void>;
  get(tenantId: TenantId, segments: readonly string[]): Promise<Uint8Array | undefined>;
  delete(tenantId: TenantId, segments: readonly string[]): Promise<void>;
}

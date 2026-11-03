import { type TenantId, asTenantId } from '@gatemind/types';

/**
 * Tenant-scoped names for everything that is not a database row (ARC-023, SEC-003):
 * cache keys, queue job names, file paths and log fields. Building these names only through
 * the helpers below means tenant context cannot be forgotten at a call site.
 */

function requirePart(value: string, what: string): string {
  if (value === '') throw new TypeError(`${what} must not be empty`);
  return value;
}

/** `t:<tenant>:<part>:<part>`. Parts are URI-encoded, so a part can never fake a tenant prefix. */
export function tenantCacheKey(tenantId: TenantId, ...parts: readonly string[]): string {
  asTenantId(tenantId);
  if (parts.length === 0) throw new TypeError('A cache key needs at least one part');
  return [
    't',
    tenantId,
    ...parts.map((p) => encodeURIComponent(requirePart(p, 'A cache key part'))),
  ].join(':');
}

/** `t:<tenant>:<job>` for queue job names and ids. */
export function tenantQueueJobName(tenantId: TenantId, jobName: string): string {
  asTenantId(tenantId);
  return `t:${tenantId}:${encodeURIComponent(requirePart(jobName, 'A job name'))}`;
}

/** Structured-log fields that identify the tenant. Merge them into every log record. */
export function tenantLogFields(tenantId: TenantId): { readonly tenant_id: TenantId } {
  asTenantId(tenantId);
  return { tenant_id: tenantId };
}

/** `tenants/<tenant>/<segment>/...` with traversal and separators rejected. */
export function tenantStoragePath(tenantId: TenantId, ...segments: readonly string[]): string {
  asTenantId(tenantId);
  if (segments.length === 0) throw new TypeError('A storage path needs at least one segment');
  for (const segment of segments) {
    requirePart(segment, 'A storage path segment');
    if (segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) {
      throw new TypeError('A storage path segment must not contain separators or traversal');
    }
  }
  return ['tenants', tenantId, ...segments].join('/');
}

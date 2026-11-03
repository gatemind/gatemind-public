import { organizations } from './organizations';

export { organizations };

/** Every table of the core schema (ARC-052). Tables of any other edition never appear here. */
export const coreSchema = { organizations } as const;

/** Name of the core migration journal table, separate from any ee journal (ARC-052). */
export const CORE_MIGRATIONS_TABLE = '__core_migrations';

export type NonTenantTableKind = 'tenant-root' | 'reference';

export interface NonTenantTable {
  readonly kind: NonTenantTableKind;
  readonly reason: string;
}

/**
 * The explicit list of tables that are NOT tenant-owned (ARC-021). The CI schema check
 * requires `tenant_id` on every other table. Adding a table here needs a stated reason and review.
 *  - `tenant-root`: the organization table; other tables reference it only through `tenant_id`.
 *  - `reference`: global reference data that holds nothing a tenant owns (Story 3.2).
 */
export const NON_TENANT_TABLES: Readonly<Record<string, NonTenantTable>> = {
  organizations: { kind: 'tenant-root', reason: 'Its id is the tenant id (ARC-024).' },
};

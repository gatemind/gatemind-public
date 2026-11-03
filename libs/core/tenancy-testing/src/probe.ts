import { TenantRepository, type TenantContext, type TenantDb } from '@gatemind/tenancy';
import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type { Connection } from 'mysql2/promise';

/**
 * A tenant-owned fixture table for the cross-tenant harness. It lives only in the probe
 * database, never in the core schema. Its composite primary key `(tenant_id, id)` follows
 * ARC-021, so two tenants can use the same id value independently.
 */
export const probeItems = mysqlTable('probe_items', {
  tenantId: varchar('tenant_id', { length: 64 }).notNull(),
  id: varchar('id', { length: 64 }).notNull(),
  label: varchar('label', { length: 255 }).notNull(),
});

export class ProbeItemRepository extends TenantRepository<typeof probeItems> {
  constructor(db: TenantDb, tenant: TenantContext) {
    super(db, probeItems, tenant);
  }
}

/** Child table whose foreign key includes the tenant, so it can never point at another tenant. */
export const PROBE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE probe_items (
     tenant_id VARCHAR(64) NOT NULL,
     id VARCHAR(64) NOT NULL,
     label VARCHAR(255) NOT NULL,
     PRIMARY KEY (tenant_id, id)
   )`,
  `CREATE TABLE probe_children (
     tenant_id VARCHAR(64) NOT NULL,
     id VARCHAR(64) NOT NULL,
     item_id VARCHAR(64) NOT NULL,
     PRIMARY KEY (tenant_id, id),
     KEY probe_children_item_idx (tenant_id, item_id),
     CONSTRAINT probe_children_item_fk FOREIGN KEY (tenant_id, item_id)
       REFERENCES probe_items (tenant_id, id)
   )`,
];

/** Drops and recreates the probe tables. Needs the migration user (DDL rights). */
export async function resetProbeSchema(connection: Connection): Promise<void> {
  await connection.query('DROP TABLE IF EXISTS probe_children');
  await connection.query('DROP TABLE IF EXISTS probe_items');
  for (const statement of PROBE_SCHEMA_STATEMENTS) {
    await connection.query(statement);
  }
}

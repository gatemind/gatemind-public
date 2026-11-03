import { sql } from 'drizzle-orm';
import {
  foreignKey,
  mysqlTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { organizations } from './organizations';

/**
 * A workspace inside an organization (ARC-024). It is a scope column set, not a tenant boundary:
 * `tenant_id` is the organization, and the foreign key to it uses only `tenant_id`.
 */
export const workspaces = mysqlTable(
  'workspaces',
  {
    tenantId: varchar('tenant_id', { length: 64 }).notNull(),
    id: varchar('id', { length: 64 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    primaryKey({ name: 'workspaces_pk', columns: [t.tenantId, t.id] }),
    foreignKey({
      name: 'workspaces_tenant_fk',
      columns: [t.tenantId],
      foreignColumns: [organizations.id],
    }),
    uniqueIndex('workspaces_tenant_name_uq').on(t.tenantId, t.name),
  ],
);

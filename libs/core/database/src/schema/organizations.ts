import { sql } from 'drizzle-orm';
import { mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';

/**
 * The tenant root (ARC-024): `organizations.id` is the `tenant_id` of every tenant-owned table.
 * It is the one table that is not tenant-owned, so it is declared in NON_TENANT_TABLES.
 * The `region` attribute exists from the first schema version (ARC-059).
 * The default organization is created by Story 1.4.
 */
export const organizations = mysqlTable('organizations', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  region: varchar('region', { length: 32 }).notNull(),
  createdAt: timestamp('created_at', { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`),
});

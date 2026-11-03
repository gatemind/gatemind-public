import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  int,
  mysqlTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { organizations } from './organizations';

/**
 * Per-tenant data-encryption keys (SEC-011), stored only in wrapped form. `wrapped_key` is an
 * opaque string produced by the `KeyManagement` port; it carries the id of the master key that
 * wrapped it (`master_key_id` repeats that id so rows that still need re-wrapping after a master
 * key rotation can be found with an index). The plaintext DEK and the master key are never stored.
 * `version` is the key version written into every ciphertext envelope.
 */
export const tenantKeys = mysqlTable(
  'tenant_keys',
  {
    tenantId: varchar('tenant_id', { length: 64 }).notNull(),
    id: varchar('id', { length: 64 }).notNull(),
    version: int('version').notNull(),
    wrappedKey: varchar('wrapped_key', { length: 512 }).notNull(),
    masterKeyId: varchar('master_key_id', { length: 32 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt: timestamp('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    wrappedAt: timestamp('wrapped_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    primaryKey({ name: 'tenant_keys_pk', columns: [t.tenantId, t.id] }),
    foreignKey({
      name: 'tenant_keys_tenant_fk',
      columns: [t.tenantId],
      foreignColumns: [organizations.id],
    }),
    uniqueIndex('tenant_keys_tenant_version_uq').on(t.tenantId, t.version),
    index('tenant_keys_tenant_master_key_idx').on(t.tenantId, t.masterKeyId),
  ],
);

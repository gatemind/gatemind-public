import { bigint, char, mysqlTable, primaryKey, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

/** Journal table of the audit migrations, separate from the core journal (ARC-052). */
export const AUDIT_MIGRATIONS_TABLE = '__audit_migrations';

/**
 * The tamper-evident audit log (SEC-070). It lives in its own database, apart from the core
 * schema, because the application user is granted only `SELECT` and `INSERT` there: MySQL cannot
 * take `UPDATE` or `DELETE` away from one table of a schema the user may otherwise write to.
 *
 * One hash chain per tenant: `seq` runs 1, 2, 3 ... and each entry's `prev_hash` is the `hash` of
 * the entry before it (64 zeros for the first). The unique keys on `(tenant_id, hash)` and
 * `(tenant_id, prev_hash)` mean two writers can never both extend the same entry, so the chain
 * cannot fork. There is no foreign key to the organization table: the audit database is separate,
 * and the history of a tenant must outlive any change to the core data.
 *
 * `occurred_at_ms` is epoch milliseconds, so the hashed value is exactly what is stored.
 * There is deliberately no free-text column (SEC-050).
 */
export const auditLog = mysqlTable(
  'audit_log',
  {
    tenantId: varchar('tenant_id', { length: 64 }).notNull(),
    seq: bigint('seq', { mode: 'number', unsigned: true }).notNull(),
    occurredAtMs: bigint('occurred_at_ms', { mode: 'number' }).notNull(),
    actor: varchar('actor', { length: 128 }).notNull(),
    action: varchar('action', { length: 64 }).notNull(),
    target: varchar('target', { length: 128 }).notNull(),
    prevHash: char('prev_hash', { length: 64 }).notNull(),
    hash: char('hash', { length: 64 }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'audit_log_pk', columns: [t.tenantId, t.seq] }),
    uniqueIndex('audit_log_tenant_hash_uq').on(t.tenantId, t.hash),
    uniqueIndex('audit_log_tenant_prev_hash_uq').on(t.tenantId, t.prevHash),
  ],
);

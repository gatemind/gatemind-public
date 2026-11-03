import type { Connection } from 'mysql2/promise';
import { describeMysqlSchema } from './introspect';
import { CORE_MIGRATIONS_TABLE, NON_TENANT_TABLES } from './schema';
import { checkTenantRules } from './tenant-rules';

/** Runs the tenant rules against the real core schema of a migrated database. */
export async function checkCoreSchema(connection: Connection, schema: string): Promise<string[]> {
  const tables = await describeMysqlSchema(connection, schema);
  return checkTenantRules(tables, {
    nonTenantTables: NON_TENANT_TABLES,
    ignoredTables: [CORE_MIGRATIONS_TABLE],
  });
}

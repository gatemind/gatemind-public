import type { NonTenantTable } from './schema';
import type { TableDescription } from './schema-description';

export const TENANT_COLUMN = 'tenant_id';

export interface TenantRulesOptions {
  /** Tables that are not tenant-owned, with the reason (ARC-021). */
  nonTenantTables: Readonly<Record<string, NonTenantTable>>;
  /** Tables to skip, such as migration journals. */
  ignoredTables?: readonly string[];
}

/**
 * The ADR 0001 / ARC-021 schema rules. Returns one message per violation; an empty list means
 * the schema is clean. For every tenant-owned table:
 *  1. it has a `tenant_id` column that is NOT NULL and a primary key;
 *  2. every index, unique key and the primary key starts with `tenant_id`;
 *  3. every foreign key starts with `tenant_id`; a key to the tenant root is exactly `tenant_id`;
 *     a key to another tenant-owned table also starts with `tenant_id` on the referenced side,
 *     so a row can never point at another tenant's row.
 */
export function checkTenantRules(
  tables: readonly TableDescription[],
  options: TenantRulesOptions,
): string[] {
  const ignored = new Set(options.ignoredTables ?? []);
  const violations: string[] = [];

  for (const table of tables) {
    if (ignored.has(table.name) || options.nonTenantTables[table.name] !== undefined) continue;

    const tenantColumn = table.columns.find((c) => c.name === TENANT_COLUMN);
    if (tenantColumn === undefined) {
      violations.push(`${table.name}: missing the ${TENANT_COLUMN} column`);
    } else if (tenantColumn.nullable) {
      violations.push(`${table.name}: ${TENANT_COLUMN} must be NOT NULL`);
    }

    if (!table.indexes.some((i) => i.primary)) {
      violations.push(`${table.name}: no primary key`);
    }

    for (const index of table.indexes) {
      if (index.columns[0] !== TENANT_COLUMN) {
        violations.push(
          `${table.name}: index ${index.name} must start with ${TENANT_COLUMN} (starts with ${index.columns[0] ?? 'nothing'})`,
        );
      }
    }

    for (const fk of table.foreignKeys) {
      const target = options.nonTenantTables[fk.referencedTable];
      if (target?.kind === 'reference') continue;
      if (fk.columns[0] !== TENANT_COLUMN) {
        violations.push(`${table.name}: foreign key ${fk.name} must start with ${TENANT_COLUMN}`);
        continue;
      }
      if (target?.kind === 'tenant-root') {
        if (fk.columns.length !== 1) {
          violations.push(
            `${table.name}: foreign key ${fk.name} to ${fk.referencedTable} must use only ${TENANT_COLUMN}`,
          );
        }
      } else if (fk.referencedColumns[0] !== TENANT_COLUMN) {
        violations.push(
          `${table.name}: foreign key ${fk.name} must reference ${TENANT_COLUMN} of ${fk.referencedTable}`,
        );
      }
    }
  }
  return violations;
}

import { DEV_DATABASES, openConnection, readDevDatabaseConfig } from '@gatemind/tenancy-testing';
import { getTableName } from 'drizzle-orm';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCoreSchema } from './check-schema';
import { runCoreMigrations } from './migrate';
import { CORE_MIGRATIONS_TABLE, NON_TENANT_TABLES, coreSchema } from './schema';

/**
 * The migration CI check (ADR 0001 control 4, ARC-021, ARC-052). It migrates an empty database
 * as the migration user and then inspects what really exists. `npm run check:schema` runs this
 * file alone; `npm run test` runs it with everything else, so a bad migration fails the build.
 */
const config = readDevDatabaseConfig();
const database = DEV_DATABASES.test;
let migrator: Connection;

async function tableNames(): Promise<string[]> {
  const [rows] = await migrator.query<RowDataPacket[]>(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [database],
  );
  return rows.map((r) => String(r['name']));
}

async function dropEverything(): Promise<void> {
  // The hierarchy tables reference each other, so a parent cannot be dropped first.
  await migrator.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const name of await tableNames()) {
      await migrator.query(`DROP TABLE IF EXISTS \`${name}\``);
    }
  } finally {
    await migrator.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

beforeAll(async () => {
  migrator = await openConnection(config.migratorUrl(database));
  await dropEverything();
});

afterAll(async () => {
  await migrator?.end();
});

describe('core migrations on MySQL 9.7 (Story 1.3)', () => {
  it('runs on MySQL 9.7', async () => {
    const [rows] = await migrator.query<RowDataPacket[]>('SELECT VERSION() AS version');
    expect(String(rows[0]?.['version'])).toMatch(/^9\.7\./);
  });

  it('applies the core migrations to an empty database and records them in the core journal', async () => {
    await runCoreMigrations({ url: config.migratorUrl(database) });
    const tables = await tableNames();
    expect(tables).toContain('organizations');
    expect(tables).toContain(CORE_MIGRATIONS_TABLE);

    const [journal] = await migrator.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM \`${CORE_MIGRATIONS_TABLE}\``,
    );
    expect(Number(journal[0]?.['n'])).toBeGreaterThan(0);
  });

  it('keeps the core journal separate from any other journal (ARC-052)', async () => {
    expect(CORE_MIGRATIONS_TABLE).toBe('__core_migrations');
    const tables = await tableNames();
    expect(tables).not.toContain('__drizzle_migrations');
    expect(tables.filter((t) => t.includes('migrations'))).toEqual([CORE_MIGRATIONS_TABLE]);
  });

  it('is idempotent: running again changes nothing', async () => {
    const before = await tableNames();
    await runCoreMigrations({ url: config.migratorUrl(database) });
    expect(await tableNames()).toEqual(before);
  });

  it('creates exactly the tables declared in the core schema', async () => {
    const declared = Object.values(coreSchema).map((table) => getTableName(table));
    const tables = (await tableNames()).filter((t) => t !== CORE_MIGRATIONS_TABLE);
    expect(tables).toEqual([...declared].sort());
  });
});

describe('tenant rules on the real core schema (ARC-021)', () => {
  it('passes: every tenant-owned table has tenant_id first in its indexes and foreign keys', async () => {
    expect(await checkCoreSchema(migrator, database)).toEqual([]);
  });

  it('declares every non-tenant table with a stated reason', () => {
    for (const [name, entry] of Object.entries(NON_TENANT_TABLES)) {
      expect(entry.reason.length, `${name} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('fails when a tenant-owned table is added without tenant_id', async () => {
    await migrator.query('CREATE TABLE rogue_table (id VARCHAR(64) NOT NULL PRIMARY KEY)');
    try {
      const violations = await checkCoreSchema(migrator, database);
      expect(violations).toContain('rogue_table: missing the tenant_id column');
    } finally {
      await migrator.query('DROP TABLE rogue_table');
    }
    expect(await checkCoreSchema(migrator, database)).toEqual([]);
  });
});

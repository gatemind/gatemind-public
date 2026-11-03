import { createTenantContext } from '@gatemind/tenancy';
import {
  DEV_DATABASES,
  ProbeItemRepository,
  crossTenantScenarios,
  openConnection,
  probeItems,
  readDevDatabaseConfig,
  resetProbeSchema,
} from '@gatemind/tenancy-testing';
import { eq } from 'drizzle-orm';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, createDatabase } from './connection';
import { describeMysqlSchema } from './introspect';
import { checkTenantRules } from './tenant-rules';

/**
 * Tenant isolation against the real database (ARC-020, ARC-021, ARC-022, NFR2): the reusable
 * cross-tenant harness attacks a tenant-owned table through the tenant-scoped repository as the
 * restricted application user. A failing scenario fails the build.
 */
const config = readDevDatabaseConfig();
const probe = DEV_DATABASES.probe;
const ER_NO_REFERENCED_ROW = 1452;
let migrator: Connection;
let appConnection: Connection;
let appDatabase: Database;

const repositoryFor = (tenantId: string) =>
  new ProbeItemRepository(appDatabase.db, createTenantContext(tenantId));

beforeAll(async () => {
  migrator = await openConnection(config.migratorUrl(probe));
  appConnection = await openConnection(config.appUrl(probe));
  await resetProbeSchema(migrator);
  appDatabase = createDatabase({ url: config.appUrl(probe), connectionLimit: 4 });
});

afterAll(async () => {
  await appDatabase?.close();
  await Promise.all([migrator?.end(), appConnection?.end()]);
});

describe('cross-tenant harness on MySQL (probe_items)', () => {
  const scenarios = crossTenantScenarios({
    name: 'probe_items',
    repositoryFor,
    makeRow: (id, marker) => ({ id, label: marker }),
    makePatch: (marker) => ({ label: marker }),
    markerOf: (row) => (row as { label: string }).label,
  });

  it('covers read, list, update, delete, forged writes, tenant moves and shared ids', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(7);
  });

  for (const scenario of scenarios) {
    it(scenario.name, scenario.run);
  }
});

describe('tenant-scoped repository on MySQL', () => {
  it('combines a caller filter with the tenant filter using AND', async () => {
    const a = repositoryFor('repo-tenant-a');
    const b = repositoryFor('repo-tenant-b');
    await a.insert({ id: 'f1', label: 'same-label' });
    await b.insert({ id: 'f2', label: 'same-label' });
    try {
      const rows = await a.list({ where: eq(probeItems.label, 'same-label') });
      expect(rows.map((r) => r.id)).toEqual(['f1']);
    } finally {
      await a.delete('f1');
      await b.delete('f2');
    }
  });

  it('caps a list at the requested limit', async () => {
    const a = repositoryFor('repo-tenant-a');
    await a.insert({ id: 'l1', label: 'x' });
    await a.insert({ id: 'l2', label: 'x' });
    try {
      expect(await a.list({ limit: 1 })).toHaveLength(1);
    } finally {
      await a.delete('l1');
      await a.delete('l2');
    }
  });
});

describe('foreign keys include the tenant (ARC-021)', () => {
  const insertChild = (tenantId: string, id: string, itemId: string) =>
    appConnection.query('INSERT INTO probe_children (tenant_id, id, item_id) VALUES (?, ?, ?)', [
      tenantId,
      id,
      itemId,
    ]);

  it('lets a child point at an item of its own tenant', async () => {
    await repositoryFor('fk-tenant-a').insert({ id: 'item-1', label: 'parent' });
    try {
      await insertChild('fk-tenant-a', 'child-1', 'item-1');
      await appConnection.query('DELETE FROM probe_children WHERE tenant_id = ?', ['fk-tenant-a']);
    } finally {
      await repositoryFor('fk-tenant-a').delete('item-1');
    }
  });

  it('refuses a child that points at an item of another tenant', async () => {
    await repositoryFor('fk-tenant-a').insert({ id: 'item-2', label: 'parent' });
    try {
      await expect(insertChild('fk-tenant-b', 'child-2', 'item-2')).rejects.toMatchObject({
        errno: ER_NO_REFERENCED_ROW,
      });
    } finally {
      await repositoryFor('fk-tenant-a').delete('item-2');
    }
  });
});

describe('tenant rules on the probe schema (ARC-021)', () => {
  const violations = async (): Promise<string[]> =>
    checkTenantRules(await describeMysqlSchema(migrator, probe), { nonTenantTables: {} });

  it('accepts the probe tables', async () => {
    expect(await violations()).toEqual([]);
  });

  it('flags a table without tenant_id, a nullable tenant_id and an index that does not lead with it', async () => {
    await migrator.query('CREATE TABLE bad_no_tenant (id VARCHAR(64) NOT NULL PRIMARY KEY)');
    await migrator.query(
      'CREATE TABLE bad_nullable (tenant_id VARCHAR(64) NULL, id VARCHAR(64) NOT NULL, PRIMARY KEY (id))',
    );
    await migrator.query(
      `CREATE TABLE bad_index_order (
         tenant_id VARCHAR(64) NOT NULL, id VARCHAR(64) NOT NULL, label VARCHAR(32) NOT NULL,
         PRIMARY KEY (tenant_id, id), KEY by_label (label, tenant_id))`,
    );
    try {
      const found = await violations();
      expect(found).toContain('bad_no_tenant: missing the tenant_id column');
      expect(found).toContain('bad_nullable: tenant_id must be NOT NULL');
      expect(found).toContain(
        'bad_index_order: index by_label must start with tenant_id (starts with label)',
      );
    } finally {
      for (const table of ['bad_no_tenant', 'bad_nullable', 'bad_index_order']) {
        await migrator.query(`DROP TABLE IF EXISTS ${table}`);
      }
    }
  });

  it('flags a foreign key that ignores the tenant', async () => {
    await migrator.query(
      'CREATE TABLE bad_parent (tenant_id VARCHAR(64) NOT NULL, id VARCHAR(64) NOT NULL, PRIMARY KEY (id))',
    );
    await migrator.query(
      `CREATE TABLE bad_child (
         tenant_id VARCHAR(64) NOT NULL, id VARCHAR(64) NOT NULL, parent_id VARCHAR(64) NOT NULL,
         PRIMARY KEY (tenant_id, id),
         CONSTRAINT bad_child_parent_fk FOREIGN KEY (parent_id) REFERENCES bad_parent (id))`,
    );
    try {
      expect(await violations()).toContain(
        'bad_child: foreign key bad_child_parent_fk must start with tenant_id',
      );
    } finally {
      await migrator.query('DROP TABLE IF EXISTS bad_child');
      await migrator.query('DROP TABLE IF EXISTS bad_parent');
    }
  });

  it('is clean again after the bad tables are removed', async () => {
    expect(await violations()).toEqual([]);
  });
});

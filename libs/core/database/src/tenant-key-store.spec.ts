import { createTenantContext } from '@gatemind/tenancy';
import {
  DEV_DATABASES,
  crossTenantScenarios,
  openConnection,
  readDevDatabaseConfig,
} from '@gatemind/tenancy-testing';
import type { Connection } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Database, createDatabase } from './connection';
import { mysqlErrno } from './db-errors';
import { OrganizationRepository } from './hierarchy/repositories';
import { runCoreMigrations } from './migrate';
import {
  ACTIVE_KEY_STATUS,
  type StoredTenantKey,
  TenantKeyRepository,
  TenantKeyStore,
  createTenantKeyStores,
} from './tenant-key-store';

/**
 * Story 1.5: storage of per-tenant wrapped data-encryption keys on MySQL (SEC-011), and the
 * cross-tenant harness on its repository (ARC-022, NFR2).
 */
const config = readDevDatabaseConfig();
const database = DEV_DATABASES.test;
const ER_NO_REFERENCED_ROW = 1452;
const tenantA = 'keys-tenant-a';
const tenantB = 'keys-tenant-b';
let migrator: Connection;
let app: Database;

async function wipe(): Promise<void> {
  for (const table of ['tenant_keys', 'environments', 'projects', 'workspaces', 'organizations']) {
    await migrator.query(`DELETE FROM ${table}`);
  }
}

const key = (version: number, overrides: Partial<StoredTenantKey> = {}): StoredTenantKey => ({
  version,
  wrappedKey: `wrapped-${version}`,
  masterKeyId: 'master-1',
  status: ACTIVE_KEY_STATUS,
  ...overrides,
});

beforeAll(async () => {
  migrator = await openConnection(config.migratorUrl(database));
  await runCoreMigrations({ url: config.migratorUrl(database) });
  app = createDatabase({ url: config.appUrl(database), connectionLimit: 8 });
  await wipe();
  const organizations = new OrganizationRepository(app.db);
  for (const id of [tenantA, tenantB]) {
    await organizations.insert({ id, name: id, region: 'local' });
  }
});

beforeEach(async () => {
  await migrator.query('DELETE FROM tenant_keys');
});

afterAll(async () => {
  await wipe();
  await app?.close();
  await migrator?.end();
});

describe('tenant key store on MySQL (Story 1.5)', () => {
  const storeOf = (tenant: string) => new TenantKeyStore(app.db, tenant);

  it('has no key for a tenant that has none', async () => {
    expect(await storeOf(tenantA).findActive()).toBeUndefined();
    expect(await storeOf(tenantA).findVersion(1)).toBeUndefined();
    expect(await storeOf(tenantA).listAll()).toEqual([]);
  });

  it('stores a key and reads it back by version and as the active key', async () => {
    expect(await storeOf(tenantA).insertIfAbsent(key(1))).toBe(true);

    expect(await storeOf(tenantA).findVersion(1)).toEqual(key(1));
    expect(await storeOf(tenantA).findActive()).toEqual(key(1));
  });

  it('stores a version once: a second insert returns false and keeps the first key', async () => {
    expect(await storeOf(tenantA).insertIfAbsent(key(1, { wrappedKey: 'first' }))).toBe(true);
    expect(await storeOf(tenantA).insertIfAbsent(key(1, { wrappedKey: 'second' }))).toBe(false);

    expect((await storeOf(tenantA).findVersion(1))?.wrappedKey).toBe('first');
    expect(await storeOf(tenantA).listAll()).toHaveLength(1);
  });

  it('lets exactly one of several parallel first inserts win', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        storeOf(tenantA).insertIfAbsent(key(1, { wrappedKey: `w${i}` })),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await storeOf(tenantA).listAll()).toHaveLength(1);
  });

  it('chooses the newest active key and never a retired one', async () => {
    await storeOf(tenantA).insertIfAbsent(key(1));
    await storeOf(tenantA).insertIfAbsent(key(2));
    await storeOf(tenantA).insertIfAbsent(key(3, { status: 'retired' }));

    expect((await storeOf(tenantA).findActive())?.version).toBe(2);
    expect((await storeOf(tenantA).findVersion(3))?.status).toBe('retired');
    expect((await storeOf(tenantA).listAll()).map((k) => k.version).sort()).toEqual([1, 2, 3]);
  });

  it('keeps the keys of each tenant apart', async () => {
    await storeOf(tenantA).insertIfAbsent(key(1, { wrappedKey: 'of-a' }));
    await storeOf(tenantB).insertIfAbsent(key(1, { wrappedKey: 'of-b' }));

    expect((await storeOf(tenantA).findVersion(1))?.wrappedKey).toBe('of-a');
    expect((await storeOf(tenantB).findVersion(1))?.wrappedKey).toBe('of-b');
    expect(await storeOf(tenantA).listAll()).toHaveLength(1);
  });

  it('replaces the wrapped form of a key and keeps its version', async () => {
    await storeOf(tenantA).insertIfAbsent(key(1));

    await storeOf(tenantA).replaceWrapped(1, 'rewrapped', 'master-2');

    expect(await storeOf(tenantA).findVersion(1)).toEqual(
      key(1, { wrappedKey: 'rewrapped', masterKeyId: 'master-2' }),
    );
  });

  it('refuses to replace a key that does not exist', async () => {
    await expect(storeOf(tenantA).replaceWrapped(7, 'x', 'master-2')).rejects.toThrow(
      'Tenant key version 7 was not found',
    );
  });

  it("does not replace another tenant's key", async () => {
    await storeOf(tenantB).insertIfAbsent(key(1, { wrappedKey: 'of-b' }));

    await expect(storeOf(tenantA).replaceWrapped(1, 'x', 'master-2')).rejects.toThrow();
    expect((await storeOf(tenantB).findVersion(1))?.wrappedKey).toBe('of-b');
  });

  it('refuses keys for a tenant that does not exist, with the foreign key error', async () => {
    const error = await storeOf('no-such-tenant')
      .insertIfAbsent(key(1))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(mysqlErrno(error)).toBe(ER_NO_REFERENCED_ROW);
  });

  it('lists the tenant ids that master key rotation walks through', async () => {
    const ids = await createTenantKeyStores(app.db).listTenantIds();
    expect(ids).toEqual(expect.arrayContaining([tenantA, tenantB]));
  });
});

describe('cross-tenant harness on the tenant key repository (ARC-022, NFR2)', () => {
  let nextVersion = 1;
  const markerOf = (row: unknown): string =>
    String((row as { wrappedKey: string }).wrappedKey).split('|')[0]!;
  const scenarios = crossTenantScenarios(
    {
      name: 'tenant keys',
      repositoryFor: (id: string) => new TenantKeyRepository(app.db, createTenantContext(id)),
      // The version is unique per tenant, so every row of a scenario gets its own.
      makeRow: (id: string, marker: string) => ({
        id,
        version: nextVersion++,
        wrappedKey: `${marker}|${id}`,
        masterKeyId: 'master-1',
      }),
      makePatch: (marker: string) => ({ wrappedKey: `${marker}|patch` }),
      markerOf,
    },
    { tenantA, tenantB },
  );

  for (const scenario of scenarios) {
    it(scenario.name, scenario.run);
  }
});

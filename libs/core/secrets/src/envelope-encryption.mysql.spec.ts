import { randomBytes } from 'node:crypto';
import {
  DEFAULT_ORGANIZATION_ID,
  type Database,
  TenantKeyRepository,
  createDatabase,
  createTenantKeyStores,
  ensureDefaultHierarchy,
  runCoreMigrations,
} from '@gatemind/database';
import type { SecretStore } from '@gatemind/ports';
import { createTenantContext } from '@gatemind/tenancy';
import { DEV_DATABASES, readDevDatabaseConfig } from '@gatemind/tenancy-testing';
import { Secret } from '@gatemind/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelopeEncryption } from './envelope-encryption';
import { EncryptionError } from './errors';
import type { TenantKeyDirectory } from './key-storage';
import {
  MASTER_KEY_NAME,
  PREVIOUS_MASTER_KEY_NAME,
  createLocalKeyManagement,
} from './local-key-management';
import { rotateMasterKey } from './master-key-rotation';

/**
 * Story 1.5 on the real development MySQL: the first key of a tenant is created once even when
 * many requests start together, and master key rotation works against the stored keys.
 * `core-secrets:test` runs after `core-database:test` (see project.json) because both use the
 * shared `gatemind_test` database.
 */
const config = readDevDatabaseConfig();
const database = DEV_DATABASES.test;
const tenant = DEFAULT_ORGANIZATION_ID;
const newKey = (): string => randomBytes(32).toString('base64');
let app: Database;

function storeWith(values: Record<string, string>): SecretStore {
  return {
    async get(name) {
      const value = values[name];
      return value === undefined ? undefined : new Secret(value);
    },
  };
}

const keyManagementFor = (current: string, previous?: string) =>
  createLocalKeyManagement(
    storeWith({
      [MASTER_KEY_NAME]: current,
      ...(previous === undefined ? {} : { [PREVIOUS_MASTER_KEY_NAME]: previous }),
    }),
  );

async function removeTenantKeys(): Promise<void> {
  const keys = new TenantKeyRepository(app.db, createTenantContext(tenant));
  for (const row of await keys.list()) await keys.delete(row.id);
}

beforeAll(async () => {
  await runCoreMigrations({ url: config.migratorUrl(database) });
  app = createDatabase({ url: config.appUrl(database), connectionLimit: 10 });
  await ensureDefaultHierarchy(app.db);
});

beforeEach(removeTenantKeys);

afterAll(async () => {
  await removeTenantKeys();
  await app?.close();
});

describe('envelope encryption on MySQL (Story 1.5)', () => {
  it('creates one key when many requests meet a tenant with no key yet', async () => {
    const keyStores = createTenantKeyStores(app.db);
    const envelope = createEnvelopeEncryption({
      keyManagement: await keyManagementFor(newKey()),
      keyStores,
    });

    const values = await Promise.all(
      Array.from({ length: 8 }, (_, i) => envelope.encrypt(tenant, new Secret(`value-${i}`))),
    );

    expect(await keyStores.forTenant(tenant).listAll()).toHaveLength(1);
    expect(values.every((value) => envelope.keyVersionOf(value) === 1)).toBe(true);
    const decrypted = await Promise.all(
      values.map((value) => envelope.withSecret(tenant, value, (secret) => secret.reveal())),
    );
    expect(decrypted).toEqual(Array.from({ length: 8 }, (_, i) => `value-${i}`));
  });

  it('stores the key only in wrapped form, bound to the master key that wrapped it', async () => {
    const keyStores = createTenantKeyStores(app.db);
    const keyManagement = await keyManagementFor(newKey());
    const envelope = createEnvelopeEncryption({ keyManagement, keyStores });

    await envelope.encrypt(tenant, new Secret('x'));

    const [stored] = await keyStores.forTenant(tenant).listAll();
    expect(stored?.version).toBe(1);
    expect(stored?.masterKeyId).toBe(keyManagement.currentKeyId);
    expect(stored?.wrappedKey.startsWith(`gmw1.${keyManagement.currentKeyId}.`)).toBe(true);
  });

  it('refuses a tenant that does not exist (the foreign key error becomes unknown_tenant)', async () => {
    const envelope = createEnvelopeEncryption({
      keyManagement: await keyManagementFor(newKey()),
      keyStores: createTenantKeyStores(app.db),
    });

    const error = await envelope.encrypt('no-such-tenant', new Secret('x')).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(EncryptionError);
    expect((error as EncryptionError).code).toBe('unknown_tenant');
  });

  it('rotates the master key: keys are re-wrapped in the database and earlier values still decrypt', async () => {
    const keyStores = createTenantKeyStores(app.db);
    const key1 = newKey();
    const key2 = newKey();
    const keys1 = await keyManagementFor(key1);
    const keys2 = await keyManagementFor(key2, key1);
    const before = createEnvelopeEncryption({ keyManagement: keys1, keyStores });
    const stored = await before.encrypt(tenant, new Secret('provider key'), {
      context: 'provider-connection:one',
    });

    // Only this test's tenant takes part, so keys left by other suites cannot interfere.
    const onlyThisTenant: TenantKeyDirectory = {
      forTenant: (id) => keyStores.forTenant(id),
      listTenantIds: async () => [tenant],
    };
    const first = await rotateMasterKey({ keyManagement: keys2, keyStores: onlyThisTenant });
    const second = await rotateMasterKey({ keyManagement: keys2, keyStores: onlyThisTenant });

    expect(first).toEqual({ tenants: 1, keys: 1, rewrapped: 1, alreadyCurrent: 0 });
    expect(second).toEqual({ tenants: 1, keys: 1, rewrapped: 0, alreadyCurrent: 1 });
    const [row] = await keyStores.forTenant(tenant).listAll();
    expect(row?.masterKeyId).toBe(keys2.currentKeyId);
    expect(row?.wrappedKey.startsWith(`gmw1.${keys2.currentKeyId}.`)).toBe(true);

    const onlyKey2 = createEnvelopeEncryption({
      keyManagement: await keyManagementFor(key2),
      keyStores,
    });
    expect(
      await onlyKey2.withSecret(tenant, stored, (secret) => secret.reveal(), {
        context: 'provider-connection:one',
      }),
    ).toBe('provider key');
  });
});

import { randomBytes } from 'node:crypto';
import type { SecretStore } from '@gatemind/ports';
import { Secret } from '@gatemind/types';
import { describe, expect, it } from 'vitest';
import { createEnvelopeEncryption } from './envelope-encryption';
import { EncryptionError } from './errors';
import type { TenantKeyDirectory } from './key-storage';
import {
  MASTER_KEY_NAME,
  PREVIOUS_MASTER_KEY_NAME,
  createLocalKeyManagement,
} from './local-key-management';
import { rotateMasterKey } from './master-key-rotation';
import { createMemoryTenantKeyDirectory } from './memory-key-store';

/**
 * Story 1.5, acceptance criterion 2: after a master key rotation the data-encryption keys are
 * re-wrapped without re-encrypting any data, and values encrypted before still decrypt.
 */
const newKey = (): string => randomBytes(32).toString('base64');
const TENANTS = ['tenant-a', 'tenant-b', 'tenant-empty'];

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

/** Two tenants with data encrypted under master key 1; the third tenant has no key yet. */
async function seed() {
  const key1 = newKey();
  const keyStores = createMemoryTenantKeyDirectory(TENANTS);
  const keys1 = await keyManagementFor(key1);
  const service1 = createEnvelopeEncryption({ keyManagement: keys1, keyStores });
  const values = {
    a: await service1.encrypt('tenant-a', new Secret('value of a'), { context: 'conn:a' }),
    b: await service1.encrypt('tenant-b', new Secret('value of b')),
  };
  return { key1, keys1, keyStores, values };
}

const readA = (service: ReturnType<typeof createEnvelopeEncryption>, value: string) =>
  service.withSecret('tenant-a', value, (secret) => secret.reveal(), { context: 'conn:a' });

describe('master key rotation', () => {
  it('re-wraps every data-encryption key and every earlier value still decrypts', async () => {
    const { key1, keys1, keyStores, values } = await seed();
    const key2 = newKey();
    const keys2 = await keyManagementFor(key2, key1);
    const service2 = createEnvelopeEncryption({ keyManagement: keys2, keyStores });

    // Before the procedure runs: values already work, because the previous key is configured.
    expect(await readA(service2, values.a)).toBe('value of a');
    expect((await keyStores.forTenant('tenant-a').listAll())[0]?.masterKeyId).toBe(
      keys1.currentKeyId,
    );

    const result = await rotateMasterKey({ keyManagement: keys2, keyStores });

    expect(result).toEqual({ tenants: 3, keys: 2, rewrapped: 2, alreadyCurrent: 0 });
    for (const tenant of ['tenant-a', 'tenant-b']) {
      const [stored] = await keyStores.forTenant(tenant).listAll();
      expect(stored?.masterKeyId).toBe(keys2.currentKeyId);
      expect(stored?.wrappedKey.startsWith(`gmw1.${keys2.currentKeyId}.`)).toBe(true);
    }

    // The previous key is no longer needed: the same stored envelopes decrypt with key 2 alone.
    const onlyKey2 = createEnvelopeEncryption({
      keyManagement: await keyManagementFor(key2),
      keyStores,
    });
    expect(await readA(onlyKey2, values.a)).toBe('value of a');
    expect(await onlyKey2.withSecret('tenant-b', values.b, (secret) => secret.reveal())).toBe(
      'value of b',
    );
  });

  it('does not re-encrypt data: the ciphertext envelopes and key versions stay as they were', async () => {
    const { key1, keyStores, values } = await seed();
    const keys2 = await keyManagementFor(newKey(), key1);
    const service2 = createEnvelopeEncryption({ keyManagement: keys2, keyStores });
    const versionBefore = service2.keyVersionOf(values.a);

    await rotateMasterKey({ keyManagement: keys2, keyStores });

    expect(service2.keyVersionOf(values.a)).toBe(versionBefore);
    expect(await readA(service2, values.a)).toBe('value of a');
    // New values use the same data-encryption key, now wrapped by the new master key.
    const fresh = await service2.encrypt('tenant-a', new Secret('after rotation'), {
      context: 'conn:a',
    });
    expect(service2.keyVersionOf(fresh)).toBe(versionBefore);
  });

  it('retires the old master key: on its own it can no longer unlock the rotated keys', async () => {
    const { key1, keyStores, values } = await seed();
    const keys2 = await keyManagementFor(newKey(), key1);
    await rotateMasterKey({ keyManagement: keys2, keyStores });

    const oldKeyOnly = createEnvelopeEncryption({
      keyManagement: await keyManagementFor(key1),
      keyStores,
    });

    await expect(readA(oldKeyOnly, values.a)).rejects.toMatchObject({ code: 'unknown_master_key' });
  });

  it('is safe to repeat: a second run changes nothing', async () => {
    const { key1, keyStores } = await seed();
    const keys2 = await keyManagementFor(newKey(), key1);

    await rotateMasterKey({ keyManagement: keys2, keyStores });
    const again = await rotateMasterKey({ keyManagement: keys2, keyStores });

    expect(again).toEqual({ tenants: 3, keys: 2, rewrapped: 0, alreadyCurrent: 2 });
  });

  it('stops with a clear error when the previous master key is not configured, and changes nothing', async () => {
    const { key1, keys1, keyStores } = await seed();
    const key2 = newKey();
    const withoutPrevious = await keyManagementFor(key2);

    const error = await rotateMasterKey({ keyManagement: withoutPrevious, keyStores }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(EncryptionError);
    expect((error as EncryptionError).code).toBe('unknown_master_key');
    expect((error as EncryptionError).message).toContain(`GATEMIND_${PREVIOUS_MASTER_KEY_NAME}`);
    expect((error as EncryptionError).message).not.toContain(key1);
    expect((error as EncryptionError).message).not.toContain(key2);
    for (const tenant of ['tenant-a', 'tenant-b']) {
      expect((await keyStores.forTenant(tenant).listAll())[0]?.masterKeyId).toBe(
        keys1.currentKeyId,
      );
    }
  });

  it('reports a key that is still wrapped by a master key older than the previous one', async () => {
    const { keyStores } = await seed(); // wrapped by master key 1
    const key2 = newKey();
    const key3 = newKey();
    const keys3 = await keyManagementFor(key3, key2); // key 1 was skipped in the chain

    const error = await rotateMasterKey({ keyManagement: keys3, keyStores }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect((error as EncryptionError).code).toBe('unknown_master_key');
  });

  it('can be resumed after it stopped half way', async () => {
    const { key1, keyStores } = await seed();
    const keys2 = await keyManagementFor(newKey(), key1);

    let writes = 0;
    const failingAfterOne: TenantKeyDirectory = {
      listTenantIds: () => keyStores.listTenantIds(),
      forTenant: (tenantId) => ({
        ...keyStores.forTenant(tenantId),
        async replaceWrapped(version, wrappedKey, masterKeyId) {
          writes += 1;
          if (writes > 1) throw new Error('the disk is full');
          await keyStores.forTenant(tenantId).replaceWrapped(version, wrappedKey, masterKeyId);
        },
      }),
    };

    await expect(
      rotateMasterKey({ keyManagement: keys2, keyStores: failingAfterOne }),
    ).rejects.toThrow('the disk is full');
    const resumed = await rotateMasterKey({ keyManagement: keys2, keyStores });

    expect(resumed).toEqual({ tenants: 3, keys: 2, rewrapped: 1, alreadyCurrent: 1 });
  });
});

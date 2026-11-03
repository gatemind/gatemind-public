import { ACTIVE_KEY_STATUS, type StoredTenantKey } from '@gatemind/database';
import type { TenantKeyDirectory, TenantKeyStorage } from './key-storage';

/** MySQL "cannot add or update a child row: a foreign key constraint fails". */
const ER_NO_REFERENCED_ROW = 1452;

/**
 * In-memory key storage for tests and single-process tools. Nothing is shared between processes,
 * so it is never used by the running product. It behaves like the database store: a version is
 * stored once, and a tenant that does not exist is refused the way the foreign key refuses it.
 */
export function createMemoryTenantKeyDirectory(tenantIds: readonly string[]): TenantKeyDirectory {
  const known = new Set(tenantIds);
  const keysByTenant = new Map<string, Map<number, StoredTenantKey>>();
  const copy = (key: StoredTenantKey): StoredTenantKey => ({ ...key });

  const keysOf = (tenantId: string): Map<number, StoredTenantKey> => {
    let keys = keysByTenant.get(tenantId);
    if (keys === undefined) {
      keys = new Map();
      keysByTenant.set(tenantId, keys);
    }
    return keys;
  };

  return {
    listTenantIds: async () => [...known],

    forTenant(tenantId: string): TenantKeyStorage {
      return {
        async findVersion(version) {
          const key = keysOf(tenantId).get(version);
          return key === undefined ? undefined : copy(key);
        },

        async findActive() {
          const active = [...keysOf(tenantId).values()]
            .filter((key) => key.status === ACTIVE_KEY_STATUS)
            .sort((a, b) => b.version - a.version)[0];
          return active === undefined ? undefined : copy(active);
        },

        async listAll() {
          return [...keysOf(tenantId).values()].map(copy);
        },

        async insertIfAbsent(key) {
          if (!known.has(tenantId)) {
            throw Object.assign(new Error('foreign key constraint fails'), {
              errno: ER_NO_REFERENCED_ROW,
            });
          }
          const keys = keysOf(tenantId);
          if (keys.has(key.version)) return false;
          keys.set(key.version, copy(key));
          return true;
        },

        async replaceWrapped(version, wrappedKey, masterKeyId) {
          const key = keysOf(tenantId).get(version);
          if (key === undefined) throw new Error(`Tenant key version ${version} was not found`);
          keysOf(tenantId).set(version, { ...key, wrappedKey, masterKeyId });
        },
      };
    },
  };
}

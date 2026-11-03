import type { StoredTenantKey } from '@gatemind/database';

/**
 * What envelope encryption needs from the storage of one tenant's wrapped data-encryption keys.
 * `TenantKeyStore` in `@gatemind/database` satisfies it; `createMemoryTenantKeyDirectory` is an
 * in-memory version for tests and single-process tools.
 */
export interface TenantKeyStorage {
  findVersion(version: number): Promise<StoredTenantKey | undefined>;
  /** The newest key whose status is `active`. */
  findActive(): Promise<StoredTenantKey | undefined>;
  listAll(): Promise<StoredTenantKey[]>;
  /** Returns false when this version already exists (another process stored it first). */
  insertIfAbsent(key: StoredTenantKey): Promise<boolean>;
  /** Replaces the wrapped form of a key. The plaintext key does not change. */
  replaceWrapped(version: number, wrappedKey: string, masterKeyId: string): Promise<void>;
}

/** Key storage for every tenant. `TenantKeyStores` in `@gatemind/database` satisfies it. */
export interface TenantKeyDirectory {
  forTenant(tenantId: string): TenantKeyStorage;
  listTenantIds(): Promise<string[]>;
}

import {
  type TenantContext,
  type TenantDb,
  TenantRepository,
  createTenantContext,
} from '@gatemind/tenancy';
import { desc, eq } from 'drizzle-orm';
import { isDuplicateKeyError } from './db-errors';
import { OrganizationRepository } from './hierarchy/repositories';
import { tenantKeys } from './schema/tenant-keys';

export const ACTIVE_KEY_STATUS = 'active';

/** One wrapped data-encryption key of a tenant. Never holds a plaintext key. */
export interface StoredTenantKey {
  readonly version: number;
  readonly wrappedKey: string;
  readonly masterKeyId: string;
  readonly status: string;
}

/** Id of the row that holds a given key version. */
export const tenantKeyId = (version: number): string => `dek-${version}`;

export class TenantKeyRepository extends TenantRepository<typeof tenantKeys> {
  constructor(db: TenantDb, tenant: TenantContext) {
    super(db, tenantKeys, tenant);
  }

  async findByVersion(version: number): Promise<StoredTenantKey | undefined> {
    const row = await this.findById(tenantKeyId(version));
    return row === undefined ? undefined : toStored(row);
  }

  /** The newest key whose status is `active`. */
  async findActive(): Promise<StoredTenantKey | undefined> {
    const rows = await this.db
      .select()
      .from(tenantKeys)
      .where(this.scope(eq(tenantKeys.status, ACTIVE_KEY_STATUS)))
      .orderBy(desc(tenantKeys.version))
      .limit(1);
    return rows[0] === undefined ? undefined : toStored(rows[0]);
  }

  async listAll(): Promise<StoredTenantKey[]> {
    return (await this.list()).map(toStored);
  }
}

function toStored(row: typeof tenantKeys.$inferSelect): StoredTenantKey {
  return {
    version: row.version,
    wrappedKey: row.wrappedKey,
    masterKeyId: row.masterKeyId,
    status: row.status,
  };
}

/** Key storage of one tenant, as the envelope encryption service uses it. */
export class TenantKeyStore {
  private readonly repository: TenantKeyRepository;

  constructor(db: TenantDb, tenantId: string) {
    this.repository = new TenantKeyRepository(db, createTenantContext(tenantId));
  }

  findVersion(version: number): Promise<StoredTenantKey | undefined> {
    return this.repository.findByVersion(version);
  }

  findActive(): Promise<StoredTenantKey | undefined> {
    return this.repository.findActive();
  }

  listAll(): Promise<StoredTenantKey[]> {
    return this.repository.listAll();
  }

  /** Returns false when another process stored this version first. */
  async insertIfAbsent(key: StoredTenantKey): Promise<boolean> {
    try {
      await this.repository.insert({
        id: tenantKeyId(key.version),
        version: key.version,
        wrappedKey: key.wrappedKey,
        masterKeyId: key.masterKeyId,
        status: key.status,
      });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  /** Replaces the wrapped form of a key (master key rotation). The plaintext key is unchanged. */
  async replaceWrapped(version: number, wrappedKey: string, masterKeyId: string): Promise<void> {
    const matched = await this.repository.update(tenantKeyId(version), {
      wrappedKey,
      masterKeyId,
      wrappedAt: new Date(),
    });
    if (matched !== 1) throw new Error(`Tenant key version ${version} was not found`);
  }
}

export interface TenantKeyStores {
  forTenant(tenantId: string): TenantKeyStore;
  listTenantIds(): Promise<string[]>;
}

export function createTenantKeyStores(db: TenantDb): TenantKeyStores {
  const organizations = new OrganizationRepository(db);
  return {
    forTenant: (tenantId) => new TenantKeyStore(db, tenantId),
    listTenantIds: () => organizations.listIds(),
  };
}

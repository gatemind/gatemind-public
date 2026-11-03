import { and, eq, type SQL } from 'drizzle-orm';
import type { AnyMySqlColumn, MySqlTable } from 'drizzle-orm/mysql-core';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { TenantIsolationError } from './errors';
import type { TenantContext } from './tenant-context';

export type TenantDb = MySql2Database<Record<string, unknown>>;

/**
 * A tenant-owned table: `tenant_id` and `id` columns are mandatory (ARC-021).
 * The primary key is `(tenant_id, id)`, so two tenants may use the same id value independently.
 */
export type TenantOwnedTable = MySqlTable & { tenantId: AnyMySqlColumn; id: AnyMySqlColumn };

export type TenantRow<T extends TenantOwnedTable> = T['$inferSelect'];
/** Values for a new row. `tenantId` is never supplied by the caller: the repository sets it. */
export type TenantNewRow<T extends TenantOwnedTable> = Omit<T['$inferInsert'], 'tenantId'>;
export type TenantPatch<T extends TenantOwnedTable> = Partial<
  Omit<T['$inferInsert'], 'tenantId' | 'id'>
>;

export const DEFAULT_LIST_LIMIT = 1000;

export interface ListOptions {
  /** Extra filter. It is always combined with the tenant filter using AND. */
  where?: SQL;
  limit?: number;
}

/**
 * The only sanctioned data-access path for tenant-owned tables (ARC-020, ADR 0001).
 * Every statement carries `tenant_id = <context tenant>`; callers cannot read, change or delete
 * another tenant's rows, and cannot move a row to another tenant.
 *
 * `update` and `delete` return the number of matching rows. The database connection must be
 * created with the FOUND_ROWS flag (see `createDatabase`) so an update that changes nothing
 * still counts as matched.
 */
export abstract class TenantRepository<TTable extends TenantOwnedTable> {
  protected constructor(
    protected readonly db: TenantDb,
    protected readonly table: TTable,
    protected readonly tenant: TenantContext,
  ) {}

  /** `tenant_id = <tenant>`, optionally AND-ed with a caller filter. Use it in every custom query. */
  protected scope(extra?: SQL): SQL {
    const own = eq(this.table.tenantId, this.tenant.tenantId);
    return extra === undefined ? own : (and(own, extra) as SQL);
  }

  async findById(id: string): Promise<TenantRow<TTable> | undefined> {
    const rows = await this.db
      .select()
      .from(this.table as MySqlTable)
      .where(this.scope(eq(this.table.id, id)))
      .limit(1);
    return rows[0] as TenantRow<TTable> | undefined;
  }

  async list(options: ListOptions = {}): Promise<TenantRow<TTable>[]> {
    const rows = await this.db
      .select()
      .from(this.table as MySqlTable)
      .where(this.scope(options.where))
      .limit(options.limit ?? DEFAULT_LIST_LIMIT);
    return rows as TenantRow<TTable>[];
  }

  async insert(values: TenantNewRow<TTable>): Promise<void> {
    this.assertNoForeignTenant(values);
    await this.db
      .insert(this.table as MySqlTable)
      .values({ ...values, tenantId: this.tenant.tenantId } as never);
  }

  async update(id: string, patch: TenantPatch<TTable>): Promise<number> {
    this.assertImmutableColumnsUntouched(patch);
    const [header] = await this.db
      .update(this.table as MySqlTable)
      .set(patch as never)
      .where(this.scope(eq(this.table.id, id)));
    return header.affectedRows;
  }

  async delete(id: string): Promise<number> {
    const [header] = await this.db
      .delete(this.table as MySqlTable)
      .where(this.scope(eq(this.table.id, id)));
    return header.affectedRows;
  }

  private assertNoForeignTenant(values: object): void {
    if (
      'tenantId' in values &&
      (values as { tenantId: unknown }).tenantId !== this.tenant.tenantId
    ) {
      throw new TenantIsolationError('A row cannot be written for another tenant');
    }
  }

  private assertImmutableColumnsUntouched(patch: object): void {
    if ('tenantId' in patch) {
      throw new TenantIsolationError('The tenant of a row cannot be changed');
    }
    if ('id' in patch) {
      throw new TenantIsolationError('The id of a row cannot be changed');
    }
  }
}

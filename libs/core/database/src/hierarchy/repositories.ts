import { type TenantContext, type TenantDb, TenantRepository } from '@gatemind/tenancy';
import { eq } from 'drizzle-orm';
import { environments } from '../schema/environments';
import { organizations } from '../schema/organizations';
import { projects } from '../schema/projects';
import { workspaces } from '../schema/workspaces';

export type OrganizationRow = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;

/**
 * Data access for the tenant root. An organization is not tenant-owned (its id is the tenant id,
 * ARC-024), so it cannot use `TenantRepository`. It is declared in NON_TENANT_TABLES and is only
 * written by instance-level code such as the first-start bootstrap.
 */
export class OrganizationRepository {
  constructor(private readonly db: TenantDb) {}

  async findById(id: string): Promise<OrganizationRow | undefined> {
    const rows = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    return rows[0];
  }

  async insert(values: NewOrganization): Promise<void> {
    await this.db.insert(organizations).values(values);
  }
}

export class WorkspaceRepository extends TenantRepository<typeof workspaces> {
  constructor(db: TenantDb, tenant: TenantContext) {
    super(db, workspaces, tenant);
  }
}

export class ProjectRepository extends TenantRepository<typeof projects> {
  constructor(db: TenantDb, tenant: TenantContext) {
    super(db, projects, tenant);
  }
}

export class EnvironmentRepository extends TenantRepository<typeof environments> {
  constructor(db: TenantDb, tenant: TenantContext) {
    super(db, environments, tenant);
  }
}

import {
  type ScopeContext,
  type TenantDb,
  createScopeContext,
  createTenantContext,
} from '@gatemind/tenancy';
import {
  EnvironmentRepository,
  OrganizationRepository,
  ProjectRepository,
  WorkspaceRepository,
} from './repositories';

/**
 * Fixed ids of the default hierarchy `[PROPOSED]`. They are fixed so that every start, and every
 * process that starts at the same time, targets the same rows (idempotent, ARC-032).
 */
export const DEFAULT_ORGANIZATION_ID = 'default';
export const DEFAULT_WORKSPACE_ID = 'default';
export const DEFAULT_PROJECT_ID = 'default';
export const DEFAULT_ENVIRONMENT_ID = 'default';

export const DEFAULT_ORGANIZATION_NAME = 'Default organization';
export const DEFAULT_WORKSPACE_NAME = 'Default workspace';
export const DEFAULT_PROJECT_NAME = 'Default project';
export const DEFAULT_ENVIRONMENT_NAME = 'Default environment';

/** Region of a single-instance install `[PROPOSED]`. The attribute exists from day one (ARC-059). */
export const DEFAULT_REGION = 'local';

const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ER_DUP_ENTRY = 1062;

export interface EnsureDefaultHierarchyOptions {
  /** 1 to 32 characters: lowercase letters, digits, "-". Ignored when the organization exists. */
  region?: string;
}

export interface DefaultHierarchy {
  readonly scope: ScopeContext;
  /** The region stored on the organization. It is never overwritten by a later start. */
  readonly region: string;
  /** True when this call created at least one row. Informational only (concurrent starts). */
  readonly created: boolean;
}

function errnoOf(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const { errno, cause } = current as { errno?: unknown; cause?: unknown };
    if (typeof errno === 'number') return errno;
    current = cause;
  }
  return undefined;
}

/**
 * Inserts a row unless it exists. Two processes that start together may both see "missing"; the
 * loser gets a duplicate-key error, finds the row on a second look and carries on. A duplicate
 * on another unique index (the same name under another id) still fails loudly.
 */
async function ensureRow(
  find: () => Promise<unknown>,
  insert: () => Promise<void>,
): Promise<boolean> {
  if ((await find()) !== undefined) return false;
  try {
    await insert();
    return true;
  } catch (error) {
    if (errnoOf(error) !== ER_DUP_ENTRY || (await find()) === undefined) throw error;
    return false;
  }
}

/**
 * Creates the default organization (the tenant), workspace, project and environment when they
 * are missing (FR-17, ARC-024, ARC-032). Safe to call on every start and from several processes
 * at once. Tenant-owned rows go through the tenant-scoped repositories (ARC-020).
 */
export async function ensureDefaultHierarchy(
  db: TenantDb,
  options: EnsureDefaultHierarchyOptions = {},
): Promise<DefaultHierarchy> {
  const requestedRegion = options.region ?? DEFAULT_REGION;
  if (!REGION_PATTERN.test(requestedRegion)) {
    throw new TypeError('Invalid region: use 1 to 32 lowercase letters, digits or "-"');
  }

  const tenant = createTenantContext(DEFAULT_ORGANIZATION_ID);
  const organizations = new OrganizationRepository(db);
  const workspaces = new WorkspaceRepository(db, tenant);
  const projects = new ProjectRepository(db, tenant);
  const environments = new EnvironmentRepository(db, tenant);

  const results = [
    await ensureRow(
      () => organizations.findById(DEFAULT_ORGANIZATION_ID),
      () =>
        organizations.insert({
          id: DEFAULT_ORGANIZATION_ID,
          name: DEFAULT_ORGANIZATION_NAME,
          region: requestedRegion,
        }),
    ),
    await ensureRow(
      () => workspaces.findById(DEFAULT_WORKSPACE_ID),
      () => workspaces.insert({ id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME }),
    ),
    await ensureRow(
      () => projects.findById(DEFAULT_PROJECT_ID),
      () =>
        projects.insert({
          id: DEFAULT_PROJECT_ID,
          workspaceId: DEFAULT_WORKSPACE_ID,
          name: DEFAULT_PROJECT_NAME,
        }),
    ),
    await ensureRow(
      () => environments.findById(DEFAULT_ENVIRONMENT_ID),
      () =>
        environments.insert({
          id: DEFAULT_ENVIRONMENT_ID,
          projectId: DEFAULT_PROJECT_ID,
          name: DEFAULT_ENVIRONMENT_NAME,
        }),
    ),
  ];

  const organization = await organizations.findById(DEFAULT_ORGANIZATION_ID);
  if (organization === undefined) {
    throw new Error('The default organization is missing after bootstrap');
  }
  return {
    scope: createScopeContext({
      tenantId: DEFAULT_ORGANIZATION_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      projectId: DEFAULT_PROJECT_ID,
      environmentId: DEFAULT_ENVIRONMENT_ID,
    }),
    region: organization.region,
    created: results.some(Boolean),
  };
}

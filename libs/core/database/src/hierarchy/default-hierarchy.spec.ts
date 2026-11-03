import { createTenantContext } from '@gatemind/tenancy';
import {
  DEV_DATABASES,
  crossTenantScenarios,
  openConnection,
  readDevDatabaseConfig,
} from '@gatemind/tenancy-testing';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Database, createDatabase } from '../connection';
import { runCoreMigrations } from '../migrate';
import { NON_TENANT_TABLES, coreSchema } from '../schema';
import {
  DEFAULT_ENVIRONMENT_ID,
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PROJECT_ID,
  DEFAULT_WORKSPACE_ID,
  ensureDefaultHierarchy,
} from './default-hierarchy';
import {
  EnvironmentRepository,
  OrganizationRepository,
  ProjectRepository,
  WorkspaceRepository,
} from './repositories';

/**
 * Story 1.4: the default organization, workspace, project and environment (ARC-024, ARC-032),
 * and the cross-tenant harness on the hierarchy repositories (ARC-022, NFR2).
 */
const config = readDevDatabaseConfig();
const database = DEV_DATABASES.test;
const ER_NO_REFERENCED_ROW = 1452;
let migrator: Connection;
let appConnection: Connection;
let app: Database;

async function wipeHierarchy(): Promise<void> {
  for (const table of ['environments', 'projects', 'workspaces', 'organizations']) {
    await migrator.query(`DELETE FROM ${table}`);
  }
}

async function count(table: string): Promise<number> {
  const [rows] = await migrator.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.['n']);
}

async function counts(): Promise<Record<string, number>> {
  return {
    organizations: await count('organizations'),
    workspaces: await count('workspaces'),
    projects: await count('projects'),
    environments: await count('environments'),
  };
}

beforeAll(async () => {
  migrator = await openConnection(config.migratorUrl(database));
  appConnection = await openConnection(config.appUrl(database));
  await runCoreMigrations({ url: config.migratorUrl(database) });
  app = createDatabase({ url: config.appUrl(database), connectionLimit: 8 });
});

afterAll(async () => {
  await wipeHierarchy();
  await app?.close();
  await Promise.all([migrator?.end(), appConnection?.end()]);
});

describe('default hierarchy on first start', () => {
  beforeEach(wipeHierarchy);

  it('creates one organization, workspace, project and environment with a region', async () => {
    const result = await ensureDefaultHierarchy(app.db);
    expect(result.created).toBe(true);
    expect(result.region).toBe('local');
    expect(result.scope).toEqual({
      tenantId: DEFAULT_ORGANIZATION_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      projectId: DEFAULT_PROJECT_ID,
      environmentId: DEFAULT_ENVIRONMENT_ID,
    });
    expect(await counts()).toEqual({
      organizations: 1,
      workspaces: 1,
      projects: 1,
      environments: 1,
    });
  });

  it('uses the region it is given on the first start', async () => {
    const result = await ensureDefaultHierarchy(app.db, { region: 'eu-west' });
    expect(result.region).toBe('eu-west');
  });

  it('rejects an invalid region before writing anything', async () => {
    await expect(ensureDefaultHierarchy(app.db, { region: 'Bad Region!' })).rejects.toThrow(
      TypeError,
    );
    expect((await counts())['organizations']).toBe(0);
  });

  it('creates no duplicates when the instance restarts', async () => {
    await ensureDefaultHierarchy(app.db);
    const again = await ensureDefaultHierarchy(app.db);
    expect(again.created).toBe(false);
    expect(await counts()).toEqual({
      organizations: 1,
      workspaces: 1,
      projects: 1,
      environments: 1,
    });
  });

  it('keeps the stored region when a later start asks for another one', async () => {
    await ensureDefaultHierarchy(app.db, { region: 'eu-west' });
    const again = await ensureDefaultHierarchy(app.db, { region: 'us-east' });
    expect(again.region).toBe('eu-west');
  });

  it('is safe when several processes start at the same time', async () => {
    const runs = await Promise.all(Array.from({ length: 6 }, () => ensureDefaultHierarchy(app.db)));
    expect(runs.every((r) => r.scope.tenantId === DEFAULT_ORGANIZATION_ID)).toBe(true);
    expect(await counts()).toEqual({
      organizations: 1,
      workspaces: 1,
      projects: 1,
      environments: 1,
    });
  });

  it('repairs a hierarchy that was only partly created', async () => {
    await ensureDefaultHierarchy(app.db);
    await migrator.query('DELETE FROM environments');
    await migrator.query('DELETE FROM projects');
    const result = await ensureDefaultHierarchy(app.db);
    expect(result.created).toBe(true);
    expect(await counts()).toEqual({
      organizations: 1,
      workspaces: 1,
      projects: 1,
      environments: 1,
    });
  });

  it('links each level to its parent inside the same tenant', async () => {
    await ensureDefaultHierarchy(app.db);
    const tenant = createTenantContext(DEFAULT_ORGANIZATION_ID);
    const project = await new ProjectRepository(app.db, tenant).findById(DEFAULT_PROJECT_ID);
    const environment = await new EnvironmentRepository(app.db, tenant).findById(
      DEFAULT_ENVIRONMENT_ID,
    );
    expect(project?.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(environment?.projectId).toBe(DEFAULT_PROJECT_ID);
  });

  it('refuses a project of another tenant that points at the default workspace', async () => {
    await ensureDefaultHierarchy(app.db);
    await new OrganizationRepository(app.db).insert({
      id: 'other-org',
      name: 'Other',
      region: 'local',
    });
    await expect(
      appConnection.query(
        'INSERT INTO projects (tenant_id, id, workspace_id, name) VALUES (?, ?, ?, ?)',
        ['other-org', 'p1', DEFAULT_WORKSPACE_ID, 'Sneaky'],
      ),
    ).rejects.toMatchObject({ errno: ER_NO_REFERENCED_ROW });
  });
});

describe('the organization is the only tenant boundary (ARC-024)', () => {
  it('declares only organizations as a non-tenant table', () => {
    expect(Object.keys(NON_TENANT_TABLES)).toEqual(['organizations']);
  });

  it('has workspaces, projects and environments in the core schema as tenant-owned tables', () => {
    expect(Object.keys(coreSchema).sort()).toEqual([
      'environments',
      'organizations',
      'projects',
      'workspaces',
    ]);
    for (const table of [coreSchema.workspaces, coreSchema.projects, coreSchema.environments]) {
      expect(Object.keys(table)).toContain('tenantId');
    }
  });
});

describe('cross-tenant harness on the hierarchy repositories (ARC-022, NFR2)', () => {
  const tenantA = 'harness-tenant-a';
  const tenantB = 'harness-tenant-b';
  const markerOf = (row: unknown): string => String((row as { name: string }).name).split('|')[0]!;
  const nameFor = (marker: string, id: string): string => `${marker}|${id}`;
  const tenant = (id: string) => createTenantContext(id);

  beforeAll(async () => {
    await wipeHierarchy();
    const organizations = new OrganizationRepository(app.db);
    for (const id of [tenantA, tenantB]) {
      await organizations.insert({ id, name: id, region: 'local' });
      await new WorkspaceRepository(app.db, tenant(id)).insert({
        id: 'ws-fixture',
        name: 'fixture',
      });
      await new ProjectRepository(app.db, tenant(id)).insert({
        id: 'proj-fixture',
        workspaceId: 'ws-fixture',
        name: 'fixture',
      });
    }
  });

  const subjects = [
    {
      name: 'workspaces',
      repositoryFor: (id: string) => new WorkspaceRepository(app.db, tenant(id)),
      makeRow: (id: string, marker: string) => ({ id, name: nameFor(marker, id) }),
    },
    {
      name: 'projects',
      repositoryFor: (id: string) => new ProjectRepository(app.db, tenant(id)),
      makeRow: (id: string, marker: string) => ({
        id,
        workspaceId: 'ws-fixture',
        name: nameFor(marker, id),
      }),
    },
    {
      name: 'environments',
      repositoryFor: (id: string) => new EnvironmentRepository(app.db, tenant(id)),
      makeRow: (id: string, marker: string) => ({
        id,
        projectId: 'proj-fixture',
        name: nameFor(marker, id),
      }),
    },
  ];

  for (const subject of subjects) {
    const scenarios = crossTenantScenarios(
      {
        ...subject,
        makePatch: (marker: string) => ({ name: `${marker}|patch` }),
        markerOf,
      },
      { tenantA, tenantB },
    );
    for (const scenario of scenarios) {
      it(scenario.name, scenario.run);
    }
  }
});

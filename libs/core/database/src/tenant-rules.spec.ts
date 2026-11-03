import { describe, expect, it } from 'vitest';
import type { NonTenantTable } from './schema';
import type { TableDescription } from './schema-description';
import { checkTenantRules } from './tenant-rules';

const nonTenantTables: Record<string, NonTenantTable> = {
  organizations: { kind: 'tenant-root', reason: 'tenant root' },
  model_capabilities: { kind: 'reference', reason: 'global reference data' },
};

const col = (name: string, nullable = false) => ({ name, nullable });
const index = (name: string, columns: string[], primary = false) => ({
  name,
  columns,
  primary,
  unique: primary,
});

/** A table that follows every rule; each test breaks exactly one thing. */
function goodTable(overrides: Partial<TableDescription> = {}): TableDescription {
  return {
    name: 'projects',
    columns: [col('tenant_id'), col('id'), col('name')],
    indexes: [index('PRIMARY', ['tenant_id', 'id'], true), index('by_name', ['tenant_id', 'name'])],
    foreignKeys: [
      {
        name: 'projects_org_fk',
        columns: ['tenant_id'],
        referencedTable: 'organizations',
        referencedColumns: ['id'],
      },
    ],
    ...overrides,
  };
}

const check = (tables: TableDescription[], ignoredTables?: string[]) =>
  checkTenantRules(tables, { nonTenantTables, ...(ignoredTables ? { ignoredTables } : {}) });

describe('checkTenantRules (ARC-021, ADR 0001 control 4)', () => {
  it('accepts a table that follows every rule', () => {
    expect(check([goodTable()])).toEqual([]);
  });

  it('skips the tenant root, declared reference tables and ignored journals', () => {
    const bare = (name: string): TableDescription => ({
      name,
      columns: [col('id')],
      indexes: [index('PRIMARY', ['id'], true)],
      foreignKeys: [],
    });
    expect(
      check([bare('organizations'), bare('model_capabilities'), bare('__journal')], ['__journal']),
    ).toEqual([]);
  });

  it('fails a table without tenant_id', () => {
    const table = goodTable({
      columns: [col('id'), col('name')],
      indexes: [index('PRIMARY', ['id'], true)],
      foreignKeys: [],
    });
    expect(check([table])).toContain('projects: missing the tenant_id column');
  });

  it('fails a nullable tenant_id', () => {
    const table = goodTable({ columns: [col('tenant_id', true), col('id')] });
    expect(check([table])).toContain('projects: tenant_id must be NOT NULL');
  });

  it('fails a table without a primary key', () => {
    const table = goodTable({ indexes: [index('by_name', ['tenant_id', 'name'])] });
    expect(check([table])).toContain('projects: no primary key');
  });

  it('fails an index or primary key that does not start with tenant_id', () => {
    const table = goodTable({
      indexes: [index('PRIMARY', ['id'], true), index('by_name', ['name', 'tenant_id'])],
    });
    const violations = check([table]);
    expect(violations).toContain(
      'projects: index PRIMARY must start with tenant_id (starts with id)',
    );
    expect(violations).toContain(
      'projects: index by_name must start with tenant_id (starts with name)',
    );
  });

  it('fails a foreign key that does not start with tenant_id', () => {
    const table = goodTable({
      foreignKeys: [
        {
          name: 'bad_fk',
          columns: ['owner_id'],
          referencedTable: 'users',
          referencedColumns: ['id'],
        },
      ],
    });
    expect(check([table])).toContain('projects: foreign key bad_fk must start with tenant_id');
  });

  it('requires a key to the tenant root to use only tenant_id', () => {
    const table = goodTable({
      foreignKeys: [
        {
          name: 'wide_fk',
          columns: ['tenant_id', 'id'],
          referencedTable: 'organizations',
          referencedColumns: ['id', 'id'],
        },
      ],
    });
    expect(check([table])).toContain(
      'projects: foreign key wide_fk to organizations must use only tenant_id',
    );
  });

  it('accepts a composite key to another tenant-owned table and rejects one that ignores the tenant there', () => {
    const child = (referencedColumns: string[]): TableDescription =>
      goodTable({
        name: 'environments',
        foreignKeys: [
          {
            name: 'env_project_fk',
            columns: ['tenant_id', 'project_id'],
            referencedTable: 'projects',
            referencedColumns,
          },
        ],
      });
    expect(check([child(['tenant_id', 'id'])])).toEqual([]);
    expect(check([child(['id', 'tenant_id'])])).toContain(
      'environments: foreign key env_project_fk must reference tenant_id of projects',
    );
  });

  it('allows a foreign key to a declared reference table', () => {
    const table = goodTable({
      foreignKeys: [
        {
          name: 'capability_fk',
          columns: ['capability_id'],
          referencedTable: 'model_capabilities',
          referencedColumns: ['id'],
        },
      ],
    });
    expect(check([table])).toEqual([]);
  });

  it('reports every problem of every table, not only the first', () => {
    const broken = goodTable({ name: 'a', columns: [col('id')], indexes: [] });
    const brokenToo = goodTable({ name: 'b', columns: [col('id')], indexes: [] });
    expect(
      check([broken, brokenToo]).filter((v) => v.includes('missing the tenant_id')),
    ).toHaveLength(2);
  });
});

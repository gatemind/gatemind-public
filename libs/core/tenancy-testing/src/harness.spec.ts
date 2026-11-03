import { TenantIsolationError } from '@gatemind/tenancy';
import { describe, expect, it } from 'vitest';
import {
  type CrossTenantSubject,
  type TenantRepositoryLike,
  crossTenantScenarios,
} from './harness';

interface Row {
  tenantId: string;
  id: string;
  label: string;
}

type Leak = 'read' | 'list' | 'update' | 'delete' | 'forge' | 'retarget' | 'global-id';

/**
 * An in-memory repository. With no `leak` it follows the tenant rules; each `leak` value breaks
 * exactly one rule, so the self-test can prove that the harness notices every kind of leak.
 */
class MemoryRepository implements TenantRepositoryLike {
  constructor(
    private readonly rows: Map<string, Row>,
    private readonly tenantId: string,
    private readonly leak?: Leak,
  ) {}

  private key(tenantId: string, id: string): string {
    return this.leak === 'global-id' ? id : `${tenantId}|${id}`;
  }

  async findById(id: string): Promise<unknown> {
    const own = this.rows.get(this.key(this.tenantId, id));
    if (own !== undefined) return own;
    if (this.leak !== 'read') return undefined;
    return [...this.rows.values()].find((r) => r.id === id);
  }

  async list(): Promise<readonly unknown[]> {
    return [...this.rows.values()].filter(
      (r) => this.leak === 'list' || r.tenantId === this.tenantId,
    );
  }

  async insert(values: never): Promise<void> {
    const row = values as unknown as Row & { tenantId?: string };
    if (row.tenantId !== undefined && row.tenantId !== this.tenantId && this.leak !== 'forge') {
      throw new TenantIsolationError('A row cannot be written for another tenant');
    }
    const tenantId = row.tenantId ?? this.tenantId;
    const key = this.key(tenantId, row.id);
    if (this.rows.has(key)) throw new Error('duplicate key');
    this.rows.set(key, { ...row, tenantId });
  }

  async update(id: string, patch: never): Promise<number> {
    const change = patch as unknown as Partial<Row>;
    if (('tenantId' in change || 'id' in change) && this.leak !== 'retarget') {
      throw new TenantIsolationError('The tenant or id of a row cannot be changed');
    }
    const target = [...this.rows.values()].find(
      (r) => r.id === id && (this.leak === 'update' || r.tenantId === this.tenantId),
    );
    if (target === undefined) return 0;
    Object.assign(target, change);
    return 1;
  }

  async delete(id: string): Promise<number> {
    const target = [...this.rows.entries()].find(
      ([, r]) => r.id === id && (this.leak === 'delete' || r.tenantId === this.tenantId),
    );
    if (target === undefined) return 0;
    this.rows.delete(target[0]);
    return 1;
  }
}

function subjectWith(leak?: Leak): CrossTenantSubject {
  const rows = new Map<string, Row>();
  return {
    name: leak === undefined ? 'memory' : `memory (leak: ${leak})`,
    repositoryFor: (tenantId) => new MemoryRepository(rows, tenantId, leak),
    makeRow: (id, marker) => ({ id, label: marker }),
    makePatch: (marker) => ({ label: marker }),
    markerOf: (row) => (row as Row).label,
  };
}

async function failures(subject: CrossTenantSubject): Promise<string[]> {
  const failed: string[] = [];
  for (const scenario of crossTenantScenarios(subject)) {
    try {
      await scenario.run();
    } catch {
      failed.push(scenario.name);
    }
  }
  return failed;
}

describe('cross-tenant harness', () => {
  it('passes every scenario for a repository that follows the tenant rules', async () => {
    expect(await failures(subjectWith())).toEqual([]);
  });

  it.each<Leak>(['read', 'list', 'update', 'delete', 'forge', 'retarget', 'global-id'])(
    'detects a seeded leak: %s',
    async (leak) => {
      expect((await failures(subjectWith(leak))).length).toBeGreaterThan(0);
    },
  );

  it('reports a repository that refuses everything, because the positive controls fail', async () => {
    const refusing: CrossTenantSubject = {
      ...subjectWith(),
      name: 'refuse-all',
      repositoryFor: () => ({
        findById: async () => undefined,
        list: async () => [],
        insert: async () => undefined,
        update: async () => 0,
        delete: async () => 0,
      }),
    };
    expect((await failures(refusing)).length).toBeGreaterThan(0);
  });

  it('names the table in every scenario so failures are traceable', () => {
    for (const scenario of crossTenantScenarios(subjectWith())) {
      expect(scenario.name.startsWith('memory: ')).toBe(true);
    }
  });
});

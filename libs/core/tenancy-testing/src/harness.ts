import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';

/**
 * What the harness needs from a repository. `TenantRepository` satisfies it; so does the
 * deliberately leaky fake that proves the harness detects leaks. Method syntax keeps parameter
 * checking bivariant, so a typed repository fits without casts.
 */
export interface TenantRepositoryLike {
  findById(id: string): Promise<unknown>;
  list(options?: { where?: SQL; limit?: number }): Promise<readonly unknown[]>;
  insert(values: never): Promise<void>;
  update(id: string, patch: never): Promise<number>;
  delete(id: string): Promise<number>;
}

/** One tenant-owned table, described just enough for the harness to attack it. */
export interface CrossTenantSubject {
  readonly name: string;
  /** A repository of the table under test, bound to the given tenant. */
  repositoryFor(tenantId: string): TenantRepositoryLike;
  /** Values for a new row, without `tenantId`. `marker` is a value the row can be recognised by. */
  makeRow(id: string, marker: string): Record<string, unknown>;
  /** A patch that sets a mutable column to `marker`. */
  makePatch(marker: string): Record<string, unknown>;
  /** Reads the marker back out of a row (the inverse of `makeRow` and `makePatch`). */
  markerOf(row: unknown): string;
}

export interface CrossTenantScenario {
  readonly name: string;
  run(): Promise<void>;
}

export interface CrossTenantOptions {
  tenantA?: string;
  tenantB?: string;
}

function idOf(row: unknown): string {
  return String((row as { id: unknown }).id);
}

async function rejectsWithTenantIsolation(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => (error as Error).name === 'TenantIsolationError',
  );
}

/**
 * The reusable cross-tenant harness (ARC-022, NFR2, SEC-003). It returns scenarios, each of
 * which attacks tenant B's rows through tenant A's repository (and the reverse where it matters)
 * and fails on any leak. A positive control in each scenario proves the repository works for the
 * tenant's own rows, so a repository that simply refuses everything cannot pass.
 *
 * Wire the scenarios into the test runner (`for (const s of scenarios) it(s.name, s.run)`); a
 * failing scenario fails the build.
 */
export function crossTenantScenarios(
  subject: CrossTenantSubject,
  options: CrossTenantOptions = {},
): CrossTenantScenario[] {
  const tenantA = options.tenantA ?? 'harness-tenant-a';
  const tenantB = options.tenantB ?? 'harness-tenant-b';

  /** Runs a scenario with fresh row ids and always removes whatever it created. */
  const scenario = (
    name: string,
    body: (ctx: {
      a: TenantRepositoryLike;
      b: TenantRepositoryLike;
      idA: string;
      idB: string;
    }) => Promise<void>,
  ): CrossTenantScenario => ({
    name: `${subject.name}: ${name}`,
    async run() {
      const a = subject.repositoryFor(tenantA);
      const b = subject.repositoryFor(tenantB);
      const suffix = randomUUID().slice(0, 8);
      const idA = `a-${suffix}`;
      const idB = `b-${suffix}`;
      try {
        await body({ a, b, idA, idB });
      } finally {
        await a.delete(idA);
        await b.delete(idB);
        await a.delete(idB);
        await b.delete(idA);
      }
    },
  });

  return [
    scenario(
      'a tenant reads its own row but not another tenant’s row by id',
      async ({ a, b, idA, idB }) => {
        await a.insert(subject.makeRow(idA, 'mine') as never);
        await b.insert(subject.makeRow(idB, 'theirs') as never);
        assert.equal(subject.markerOf(await a.findById(idA)), 'mine', 'own row must be readable');
        assert.equal(
          await a.findById(idB),
          undefined,
          'another tenant’s row leaked through findById',
        );
        assert.equal(
          await b.findById(idA),
          undefined,
          'the reverse direction leaked through findById',
        );
      },
    ),

    scenario(
      'listing never returns another tenant’s rows, even with a catch-all filter',
      async ({ a, b, idA, idB }) => {
        await a.insert(subject.makeRow(idA, 'mine') as never);
        await b.insert(subject.makeRow(idB, 'theirs') as never);
        for (const rows of [await a.list(), await a.list({ where: sql`1 = 1` })]) {
          const ids = rows.map(idOf);
          assert.ok(ids.includes(idA), 'own row must be listed');
          assert.ok(!ids.includes(idB), 'another tenant’s row leaked through list');
        }
      },
    ),

    scenario(
      'updating another tenant’s row changes nothing and matches nothing',
      async ({ a, b, idA, idB }) => {
        await a.insert(subject.makeRow(idA, 'mine') as never);
        await b.insert(subject.makeRow(idB, 'theirs') as never);
        assert.equal(
          await a.update(idA, subject.makePatch('mine-changed') as never),
          1,
          'own update must match',
        );
        assert.equal(
          await a.update(idB, subject.makePatch('hijacked') as never),
          0,
          'cross-tenant update matched a row',
        );
        assert.equal(
          subject.markerOf(await b.findById(idB)),
          'theirs',
          'another tenant’s row was modified',
        );
        assert.equal(subject.markerOf(await a.findById(idA)), 'mine-changed');
      },
    ),

    scenario('deleting another tenant’s row removes nothing', async ({ a, b, idA, idB }) => {
      await a.insert(subject.makeRow(idA, 'mine') as never);
      await b.insert(subject.makeRow(idB, 'theirs') as never);
      assert.equal(await a.delete(idB), 0, 'cross-tenant delete matched a row');
      assert.notEqual(await b.findById(idB), undefined, 'another tenant’s row was deleted');
      assert.equal(await a.delete(idA), 1, 'own delete must match');
      assert.equal(await a.findById(idA), undefined);
    }),

    scenario('a row cannot be written for another tenant', async ({ a, idA }) => {
      await rejectsWithTenantIsolation(() =>
        a.insert({ ...subject.makeRow(idA, 'forged'), tenantId: tenantB } as never),
      );
      assert.equal(
        await subject.repositoryFor(tenantB).findById(idA),
        undefined,
        'a forged row reached tenant B',
      );
    }),

    scenario('a row cannot be moved to another tenant or change its id', async ({ a, idA }) => {
      await a.insert(subject.makeRow(idA, 'mine') as never);
      await rejectsWithTenantIsolation(() => a.update(idA, { tenantId: tenantB } as never));
      await rejectsWithTenantIsolation(() => a.update(idA, { id: 'other-id' } as never));
      assert.equal(
        subject.markerOf(await a.findById(idA)),
        'mine',
        'row changed after a refused update',
      );
      assert.equal(
        await subject.repositoryFor(tenantB).findById(idA),
        undefined,
        'row moved to tenant B',
      );
    }),

    scenario(
      'two tenants can use the same id independently (composite key)',
      async ({ a, b, idA }) => {
        await a.insert(subject.makeRow(idA, 'from-a') as never);
        await b.insert(subject.makeRow(idA, 'from-b') as never);
        assert.equal(subject.markerOf(await a.findById(idA)), 'from-a');
        assert.equal(subject.markerOf(await b.findById(idA)), 'from-b');
        assert.equal(await a.delete(idA), 1);
        assert.equal(
          subject.markerOf(await b.findById(idA)),
          'from-b',
          'deleting A’s row removed B’s row',
        );
      },
    ),
  ];
}

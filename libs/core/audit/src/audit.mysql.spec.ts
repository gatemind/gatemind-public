import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  AuditLogStore,
  type Database,
  createDatabase,
  runAuditMigrations,
} from '@gatemind/database';
import { DEV_DATABASES, openConnection, readDevDatabaseConfig } from '@gatemind/tenancy-testing';
import type { Connection } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAuditSink } from './audit-sink';
import { verifyAuditChain } from './verify';
import { DATABASE_URL_NAME, EXIT_BROKEN, EXIT_OK, runAuditVerifyCli } from './verify-cli';

/**
 * Story 1.6 end to end on the real development MySQL, as the application user writes it and as
 * someone with direct database access could alter it. `core-audit:test` runs after
 * `core-database:test` (see project.json) because both use the `gatemind_audit_test` database.
 */
const config = readDevDatabaseConfig();
const database = DEV_DATABASES.auditTest;
const appUrl = config.appUrl(database);
const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const run = promisify(execFile);

let migrator: Connection;
let writerA: Database;
let writerB: Database;
const tenants: string[] = [];

const newTenant = (): string => {
  const id = `audit-${randomBytes(4).toString('hex')}`;
  tenants.push(id);
  return id;
};
const sinkOn = (db: Database) => createAuditSink({ storage: new AuditLogStore(db.db) });
const event = (tenantId: string, n: number) => ({
  tenantId,
  actor: 'user:alice',
  action: 'role.assign',
  target: `user:${n}`,
});

async function write(tenantId: string, count: number): Promise<void> {
  const sink = sinkOn(writerA);
  for (let i = 1; i <= count; i += 1) await sink.record(event(tenantId, i));
}

beforeAll(async () => {
  await runAuditMigrations({ url: config.migratorUrl(database) });
  migrator = await openConnection(config.migratorUrl(database));
  writerA = createDatabase({ url: appUrl, connectionLimit: 10 });
  writerB = createDatabase({ url: appUrl, connectionLimit: 10 });
});

afterEach(async () => {
  for (const tenantId of tenants.splice(0)) {
    await migrator.query('DELETE FROM audit_log WHERE tenant_id = ?', [tenantId]);
  }
});

afterAll(async () => {
  await Promise.all([migrator?.end(), writerA?.close(), writerB?.close()]);
});

describe('the chain on MySQL', () => {
  it('stores entries that link to each other and verifies OK with count and head hash', async () => {
    const tenantId = newTenant();
    await write(tenantId, 4);

    const store = new AuditLogStore(writerA.db);
    const result = await verifyAuditChain(store, { tenantId });
    expect(result).toMatchObject({ ok: true, entries: 4 });
    const head = await store.head(tenantId);
    expect(result.ok && result.tenants[0]?.headHash).toBe(head?.hash);
    expect(head?.seq).toBe(4);
  });

  it('writes many concurrent events from one process into one valid chain', async () => {
    const tenantId = newTenant();
    const sink = sinkOn(writerA);

    await Promise.all(Array.from({ length: 60 }, (_, i) => sink.record(event(tenantId, i))));

    expect(await verifyAuditChain(new AuditLogStore(writerA.db), { tenantId })).toMatchObject({
      ok: true,
      entries: 60,
    });
  });

  it('keeps one chain with no fork when two processes write at the same time', async () => {
    const tenantId = newTenant();
    const a = sinkOn(writerA);
    const b = sinkOn(writerB);

    await Promise.all([
      ...Array.from({ length: 25 }, (_, i) => a.record(event(tenantId, i))),
      ...Array.from({ length: 25 }, (_, i) => b.record(event(tenantId, 100 + i))),
    ]);

    const store = new AuditLogStore(writerA.db);
    expect(await verifyAuditChain(store, { tenantId })).toMatchObject({ ok: true, entries: 50 });
    const seqs = (await store.list(tenantId, { afterSeq: 0, limit: 100 })).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe('entries changed directly in the database (FR-5)', () => {
  it('names an altered entry', async () => {
    const tenantId = newTenant();
    await write(tenantId, 5);
    await migrator.query(
      "UPDATE audit_log SET actor = 'user:mallory' WHERE tenant_id = ? AND seq = 3",
      [tenantId],
    );

    expect(await verifyAuditChain(new AuditLogStore(writerA.db), { tenantId })).toMatchObject({
      ok: false,
      broken: { seq: 3, reason: 'content_altered' },
    });
  });

  it('names the entry after a deleted one', async () => {
    const tenantId = newTenant();
    await write(tenantId, 5);
    await migrator.query('DELETE FROM audit_log WHERE tenant_id = ? AND seq = 2', [tenantId]);

    expect(await verifyAuditChain(new AuditLogStore(writerA.db), { tenantId })).toMatchObject({
      ok: false,
      broken: { seq: 3, reason: 'missing_entry' },
    });
  });

  it('names the first entry out of place when two are reordered', async () => {
    const tenantId = newTenant();
    await write(tenantId, 5);
    for (const [from, to] of [
      [2, 99],
      [3, 2],
      [99, 3],
    ] as const) {
      await migrator.query('UPDATE audit_log SET seq = ? WHERE tenant_id = ? AND seq = ?', [
        to,
        tenantId,
        from,
      ]);
    }

    expect(await verifyAuditChain(new AuditLogStore(writerA.db), { tenantId })).toMatchObject({
      ok: false,
      broken: { seq: 2, reason: 'link_broken' },
    });
  });
});

describe('the verification tool', () => {
  it('reports through runAuditVerifyCli against the real database without printing the password', async () => {
    const tenantId = newTenant();
    await write(tenantId, 3);
    const out: string[] = [];
    const err: string[] = [];

    const code = await runAuditVerifyCli({
      argv: ['--tenant', tenantId],
      env: { [DATABASE_URL_NAME]: appUrl },
      openStorage: async (url) => {
        const db = createDatabase({ url, connectionLimit: 2 });
        return { storage: new AuditLogStore(db.db), close: () => db.close() };
      },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(EXIT_OK);
    expect(out.join('\n')).toContain(`${tenantId}: 3 entries, head `);
    const password = new URL(appUrl).password;
    expect(`${out.join('\n')}${err.join('\n')}`).not.toContain(password);
  });

  it('runs as `npm run audit:verify`: exit 0 when intact, non-zero naming the entry when altered', async () => {
    const tenantId = newTenant();
    await write(tenantId, 4);
    const env = { ...process.env, [DATABASE_URL_NAME]: appUrl };
    const command = [
      '--tsconfig',
      'tsconfig.base.json',
      'libs/core/audit/src/bin.ts',
      '--tenant',
      tenantId,
    ];
    const tsx = `${workspaceRoot}node_modules/.bin/tsx`;

    const intact = await run(tsx, command, { cwd: workspaceRoot, env });
    expect(intact.stdout).toContain('Audit chain OK: 4 entries in 1 tenant');

    await migrator.query(
      "UPDATE audit_log SET target = 'user:forged' WHERE tenant_id = ? AND seq = 2",
      [tenantId],
    );
    const broken = await run(tsx, command, { cwd: workspaceRoot, env }).then(
      () => undefined,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(broken?.code).toBe(EXIT_BROKEN);
    expect(broken?.stderr).toContain(`BROKEN at entry 2 of tenant ${tenantId}`);
  }, 60_000);
});

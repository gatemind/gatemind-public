import { DEV_DATABASES, openConnection, readDevDatabaseConfig } from '@gatemind/tenancy-testing';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAuditSchema } from '../check-schema';
import { type Database, createDatabase } from '../connection';
import { AuditLogStore, type AuditLogRow } from './audit-log-store';
import { runAuditMigrations } from './migrate-audit';

/**
 * Story 1.6 on the real development MySQL: the audit log's own database, and the rule that the
 * application user can add history but never change or remove it (SEC-070, ADR 0001 control 3).
 */
const config = readDevDatabaseConfig();
const database = DEV_DATABASES.auditTest;

// MySQL error number for "command denied to user for table".
const ER_TABLEACCESS_DENIED = 1142;

const zeros = '0'.repeat(64);
const hashOf = (n: number): string => n.toString(16).padStart(64, '0');
const tenantA = 'audit-store-a';
const tenantB = 'audit-store-b';

const entry = (
  tenantId: string,
  seq: number,
  overrides: Partial<AuditLogRow> = {},
): AuditLogRow => ({
  tenantId,
  seq,
  occurredAtMs: 1_700_000_000_000 + seq,
  actor: 'user:alice',
  action: 'project.create',
  target: `project:${seq}`,
  prevHash: seq === 1 ? zeros : hashOf(seq - 1),
  hash: hashOf(seq),
  ...overrides,
});

let migrator: Connection;
let appConnection: Connection;
let app: Database;
let store: AuditLogStore;

async function errnoOf(action: Promise<unknown>): Promise<number | undefined> {
  try {
    await action;
    return undefined;
  } catch (error) {
    return (error as { errno?: number }).errno;
  }
}

async function wipe(): Promise<void> {
  await migrator.query('DELETE FROM audit_log');
}

beforeAll(async () => {
  await runAuditMigrations({ url: config.migratorUrl(database) });
  migrator = await openConnection(config.migratorUrl(database));
  appConnection = await openConnection(config.appUrl(database));
  app = createDatabase({ url: config.appUrl(database), connectionLimit: 5 });
  store = new AuditLogStore(app.db);
  await wipe();
});

afterAll(async () => {
  await wipe();
  await Promise.all([migrator?.end(), appConnection?.end(), app?.close()]);
});

describe('the audit database schema', () => {
  it('follows the tenant rules and has no free-text column (SEC-050)', async () => {
    expect(await checkAuditSchema(migrator, database)).toEqual([]);

    const [columns] = await migrator.query<RowDataPacket[]>(
      'SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',
      [database, 'audit_log'],
    );
    expect(columns.map((c) => c['name'])).toEqual([
      'tenant_id',
      'seq',
      'occurred_at_ms',
      'actor',
      'action',
      'target',
      'prev_hash',
      'hash',
    ]);
    expect(columns.map((c) => c['type'])).not.toContain('text');
    expect(columns.map((c) => c['type'])).not.toContain('json');
  });

  it('has its own migration journal, apart from the core one', async () => {
    const [rows] = await migrator.query<RowDataPacket[]>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE '\\_\\_%'",
      [database],
    );
    expect(rows.map((r) => r['name'])).toEqual(['__audit_migrations']);
  });
});

describe('the application user and the audit table (SEC-070)', () => {
  it('is granted only SELECT and INSERT on the audit databases', async () => {
    const [rows] = await appConnection.query<RowDataPacket[]>('SHOW GRANTS FOR CURRENT_USER()');
    const audit = rows
      .map((row) => String(Object.values(row)[0]))
      .filter((line) => /`gatemind\\?_audit/.test(line));

    expect(audit.length).toBeGreaterThanOrEqual(1);
    for (const line of audit) {
      const privileges = /^GRANT (.+?) ON /
        .exec(line)?.[1]
        ?.split(',')
        .map((p) => p.trim());
      expect(privileges?.sort(), line).toEqual(['INSERT', 'SELECT']);
    }
  });

  it('can add and read entries', async () => {
    expect(await store.append(entry(tenantA, 1))).toBe(true);
    expect(await store.head(tenantA)).toMatchObject({ seq: 1, actor: 'user:alice' });
  });

  it('cannot UPDATE, DELETE, TRUNCATE, DROP or ALTER the audit table', async () => {
    await store.append(entry(tenantA, 1));
    const attempts = [
      "UPDATE audit_log SET actor = 'user:mallory' WHERE tenant_id = 'audit-store-a'",
      "DELETE FROM audit_log WHERE tenant_id = 'audit-store-a'",
      'TRUNCATE TABLE audit_log',
      'DROP TABLE audit_log',
      'ALTER TABLE audit_log ADD COLUMN note text',
    ];
    for (const sql of attempts) {
      expect(await errnoOf(appConnection.query(sql)), sql).toBe(ER_TABLEACCESS_DENIED);
    }
    expect(await store.head(tenantA)).toMatchObject({ actor: 'user:alice' });
  });

  it('proves the separation is real: the migration user, not the app user, can change rows', async () => {
    await store.append(entry(tenantA, 1));
    await migrator.query("UPDATE audit_log SET actor = 'user:changed' WHERE tenant_id = ?", [
      tenantA,
    ]);
    expect((await store.head(tenantA))?.actor).toBe('user:changed');
    await wipe();
  });
});

describe('AuditLogStore', () => {
  it('refuses a second entry for the same position or the same predecessor, so chains cannot fork', async () => {
    await wipe();
    expect(await store.append(entry(tenantA, 1))).toBe(true);
    expect(await store.append(entry(tenantA, 1, { hash: hashOf(900) }))).toBe(false);
    expect(await store.append(entry(tenantA, 2))).toBe(true);
    expect(await store.append(entry(tenantA, 3, { prevHash: hashOf(1), hash: hashOf(901) }))).toBe(
      false,
    );
  });

  it('reads one tenant in chain order and never returns another tenant', async () => {
    await wipe();
    for (const seq of [3, 1, 2]) await store.append(entry(tenantA, seq));
    await store.append(entry(tenantB, 1));

    const all = await store.list(tenantA, { afterSeq: 0, limit: 10 });
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all.every((e) => e.tenantId === tenantA)).toBe(true);
    expect((await store.list(tenantA, { afterSeq: 1, limit: 1 })).map((e) => e.seq)).toEqual([2]);
    expect((await store.head(tenantB))?.tenantId).toBe(tenantB);
    expect(await store.head('audit-store-none')).toBeUndefined();
    expect(await store.listTenantIds()).toEqual([tenantA, tenantB]);
  });
});

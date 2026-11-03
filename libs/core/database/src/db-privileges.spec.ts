import { DEV_DATABASES, openConnection, readDevDatabaseConfig } from '@gatemind/tenancy-testing';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCoreMigrations } from './migrate';

/**
 * ADR 0001 compensating control 3: the application database user has no DROP, no FILE, no
 * SUPER and cannot write outside its schemas; migrations run under a separate privileged user.
 * Checked twice: by reading the grants, and by actually attempting each forbidden action.
 */
const config = readDevDatabaseConfig();
const database = DEV_DATABASES.test;

// MySQL error numbers.
const ER_ACCESS_DENIED = 1045;
const ER_DBACCESS_DENIED = 1044;
const ER_TABLEACCESS_DENIED = 1142;
const ER_SPECIFIC_ACCESS_DENIED = 1227;

const APP_PRIVILEGES = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'USAGE']);
const MIGRATOR_PRIVILEGES = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'INDEX',
  'REFERENCES',
  'USAGE',
]);
const FORBIDDEN_FOR_BOTH = [
  'FILE',
  'SUPER',
  'ALL PRIVILEGES',
  'GRANT OPTION',
  'CREATE USER',
  'SHUTDOWN',
  'PROCESS',
];

let app: Connection;
let migrator: Connection;

async function grantsOf(
  connection: Connection,
): Promise<{ privileges: string[]; scope: string }[]> {
  const [rows] = await connection.query<RowDataPacket[]>('SHOW GRANTS FOR CURRENT_USER()');
  return rows.map((row) => {
    const line = String(Object.values(row)[0]);
    const match = /^GRANT (.+?) ON (.+?) TO /.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error('Unexpected grant line (role grants are not expected here)');
    }
    return { privileges: match[1].split(',').map((p) => p.trim().toUpperCase()), scope: match[2] };
  });
}

async function errnoOf(action: Promise<unknown>): Promise<number | undefined> {
  try {
    await action;
    return undefined;
  } catch (error) {
    return (error as { errno?: number }).errno;
  }
}

beforeAll(async () => {
  app = await openConnection(config.appUrl(database));
  migrator = await openConnection(config.migratorUrl(database));
  await runCoreMigrations({ url: config.migratorUrl(database) });
});

afterAll(async () => {
  await Promise.all([app?.end(), migrator?.end()]);
});

describe('the application user (runtime)', () => {
  it('is granted only data privileges, scoped to schemas and never globally', async () => {
    const grants = await grantsOf(app);
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      for (const privilege of grant.privileges) {
        expect(
          APP_PRIVILEGES.has(privilege),
          `unexpected privilege ${privilege} on ${grant.scope}`,
        ).toBe(true);
      }
      if (grant.scope === '*.*') expect(grant.privileges).toEqual(['USAGE']);
    }
  });

  it('has none of the dangerous privileges', async () => {
    const all = (await grantsOf(app)).flatMap((g) => g.privileges);
    for (const forbidden of [
      ...FORBIDDEN_FOR_BOTH,
      'DROP',
      'CREATE',
      'ALTER',
      'INDEX',
      'REFERENCES',
    ]) {
      expect(all).not.toContain(forbidden);
    }
  });

  it('can read and write data in its schema', async () => {
    await app.query(
      "INSERT INTO organizations (id, name, region) VALUES ('priv-check', 'Privilege check', 'local')",
    );
    const [rows] = await app.query<RowDataPacket[]>(
      "SELECT name FROM organizations WHERE id = 'priv-check'",
    );
    expect(rows[0]?.['name']).toBe('Privilege check');
    await app.query("DELETE FROM organizations WHERE id = 'priv-check'");
  });

  it('cannot DROP a table', async () => {
    expect(await errnoOf(app.query('DROP TABLE organizations'))).toBe(ER_TABLEACCESS_DENIED);
  });

  it('cannot change the schema at all (CREATE, ALTER, TRUNCATE)', async () => {
    expect(await errnoOf(app.query('CREATE TABLE sneaky (id INT)'))).toBe(ER_TABLEACCESS_DENIED);
    expect(await errnoOf(app.query('ALTER TABLE organizations ADD COLUMN sneaky INT'))).toBe(
      ER_TABLEACCESS_DENIED,
    );
    expect(await errnoOf(app.query('TRUNCATE TABLE organizations'))).toBe(ER_TABLEACCESS_DENIED);
  });

  it('cannot use the FILE privilege', async () => {
    const errno = await errnoOf(
      app.query("SELECT 'x' INTO OUTFILE '/tmp/gatemind-priv-check.txt'"),
    );
    expect([ER_ACCESS_DENIED, ER_SPECIFIC_ACCESS_DENIED]).toContain(errno);
  });

  it('cannot use SUPER-level administration', async () => {
    expect(await errnoOf(app.query('SET GLOBAL max_connections = 500'))).toBe(
      ER_SPECIFIC_ACCESS_DENIED,
    );
    expect(await errnoOf(app.query('CREATE USER intruder IDENTIFIED BY "x"'))).toBe(
      ER_SPECIFIC_ACCESS_DENIED,
    );
  });

  it('cannot write outside its schemas', async () => {
    expect(await errnoOf(app.query('CREATE DATABASE intruder_db'))).toBe(ER_DBACCESS_DENIED);
    expect(
      await errnoOf(app.query("INSERT INTO mysql.db (Host, Db, User) VALUES ('%', 'x', 'y')")),
    ).toBe(ER_TABLEACCESS_DENIED);
    expect(await errnoOf(app.query('SELECT user FROM mysql.user LIMIT 1'))).toBe(
      ER_TABLEACCESS_DENIED,
    );
  });
});

describe('the migration user (migration job only)', () => {
  it('is granted schema privileges but no FILE, SUPER, user administration or global rights', async () => {
    const grants = await grantsOf(migrator);
    const all = grants.flatMap((g) => g.privileges);
    for (const grant of grants) {
      for (const privilege of grant.privileges) {
        expect(
          MIGRATOR_PRIVILEGES.has(privilege),
          `unexpected privilege ${privilege} on ${grant.scope}`,
        ).toBe(true);
      }
      if (grant.scope === '*.*') expect(grant.privileges).toEqual(['USAGE']);
    }
    for (const forbidden of FORBIDDEN_FOR_BOTH) expect(all).not.toContain(forbidden);
  });

  it('can change the schema in its databases', async () => {
    await migrator.query('CREATE TABLE migrator_check (id INT)');
    await migrator.query('DROP TABLE migrator_check');
  });

  it('cannot administer the server', async () => {
    expect(await errnoOf(migrator.query('CREATE USER intruder IDENTIFIED BY "x"'))).toBe(
      ER_SPECIFIC_ACCESS_DENIED,
    );
    expect(await errnoOf(migrator.query('SET GLOBAL max_connections = 500'))).toBe(
      ER_SPECIFIC_ACCESS_DENIED,
    );
    expect(await errnoOf(migrator.query('CREATE DATABASE intruder_db'))).toBe(ER_DBACCESS_DENIED);
  });
});

describe('separation of duties', () => {
  it('uses two different database users', async () => {
    const [[appUser], [migratorUser]] = await Promise.all([
      app.query<RowDataPacket[]>('SELECT CURRENT_USER() AS u'),
      migrator.query<RowDataPacket[]>('SELECT CURRENT_USER() AS u'),
    ]);
    expect(appUser[0]?.['u']).toMatch(/^gatemind_app@/);
    expect(migratorUser[0]?.['u']).toMatch(/^gatemind_migrator@/);
  });
});

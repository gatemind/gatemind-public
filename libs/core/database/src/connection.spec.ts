import { DEV_DATABASES, readDevDatabaseConfig } from '@gatemind/tenancy-testing';
import { describe, expect, it } from 'vitest';
import { createDatabase, parseDatabaseUrl } from './connection';

describe('parseDatabaseUrl', () => {
  it('splits a connection URL and decodes the credentials', () => {
    expect(parseDatabaseUrl('mysql://app:p%40ss@db.internal:3307/gatemind')).toEqual({
      host: 'db.internal',
      port: 3307,
      user: 'app',
      password: 'p@ss',
      database: 'gatemind',
    });
  });

  it('defaults the port to 3306', () => {
    expect(parseDatabaseUrl('mysql://app:x@db/gatemind').port).toBe(3306);
  });

  it.each([
    ['not a url', 'not a valid URL'],
    ['postgres://u:p@h/db', 'must start with mysql://'],
    ['mysql://u:p@h/', 'needs a host, a user and a database name'],
    ['mysql://:p@h/db', 'needs a host, a user and a database name'],
  ])('rejects %s without echoing the URL', (url, message) => {
    let thrown: unknown;
    try {
      parseDatabaseUrl(url);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain(message);
    expect((thrown as Error).message).not.toContain(url);
  });

  it('never puts the password into an error message', () => {
    let thrown: unknown;
    try {
      parseDatabaseUrl('postgres://user:s3cret-value@host/db');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).not.toContain('s3cret-value');
  });
});

describe('Database.ping', () => {
  it('answers true when the database is reachable', async () => {
    const database = createDatabase({
      url: readDevDatabaseConfig().appUrl(DEV_DATABASES.test),
      connectionLimit: 1,
    });
    try {
      expect(await database.ping()).toBe(true);
      expect(await database.ping()).toBe(true);
    } finally {
      await database.close();
    }
  });

  it('answers false, without rejecting or echoing the URL, when nothing listens', async () => {
    const database = createDatabase({
      url: 'mysql://app:canary-password@127.0.0.1:1/gatemind',
      connectionLimit: 1,
    });
    try {
      const answer: unknown = await database.ping();
      expect(answer).toBe(false);
    } finally {
      await database.close();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { parseDatabaseUrl } from './connection';

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

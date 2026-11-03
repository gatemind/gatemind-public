import type { TenantDb } from '@gatemind/tenancy';
import { drizzle } from 'drizzle-orm/mysql2';
import { createPool, type PoolOptions } from 'mysql2/promise';

export interface DatabaseOptions {
  /** `mysql://user:password@host:port/database`. Treated as a secret: never logged. */
  url: string;
  connectionLimit?: number;
}

export interface Database {
  readonly db: TenantDb;
  /**
   * Can the database answer right now? Never rejects and never reveals why it cannot: used by the
   * readiness check (REL-001), whose response must not hold an address or an error text.
   */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Splits a connection URL. Error messages never include the URL, which holds a password. */
export function parseDatabaseUrl(url: string): PoolOptions & { database: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('The database URL is not a valid URL');
  }
  if (parsed.protocol !== 'mysql:') {
    throw new TypeError('The database URL must start with mysql://');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (parsed.hostname === '' || parsed.username === '' || database === '') {
    throw new TypeError('The database URL needs a host, a user and a database name');
  }
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 3306 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

/**
 * Creates the runtime connection pool for the application user.
 * FOUND_ROWS makes `update` report matched rows, which the tenant repository relies on.
 */
export function createDatabase(options: DatabaseOptions): Database {
  const pool = createPool({
    ...parseDatabaseUrl(options.url),
    connectionLimit: options.connectionLimit ?? 10,
    flags: ['+FOUND_ROWS'],
    timezone: 'Z',
  });
  return {
    db: drizzle(pool, { mode: 'default' }) as unknown as TenantDb,
    async ping() {
      try {
        const connection = await pool.getConnection();
        try {
          await connection.ping();
          return true;
        } finally {
          connection.release();
        }
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}

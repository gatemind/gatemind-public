import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createPool } from 'mysql2/promise';
import { parseDatabaseUrl } from '../connection';
import { AUDIT_MIGRATIONS_TABLE } from './audit-log-schema';

export interface RunAuditMigrationsOptions {
  /** Connection URL of the migration user, pointing at the audit database. */
  url: string;
  migrationsFolder?: string;
}

export const AUDIT_MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../audit-migrations', import.meta.url),
);

/** Applies the audit database migrations and records them in their own journal. Idempotent. */
export async function runAuditMigrations(options: RunAuditMigrationsOptions): Promise<void> {
  const pool = createPool({ ...parseDatabaseUrl(options.url), connectionLimit: 1 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: options.migrationsFolder ?? AUDIT_MIGRATIONS_FOLDER,
      migrationsTable: AUDIT_MIGRATIONS_TABLE,
    });
  } finally {
    await pool.end();
  }
}

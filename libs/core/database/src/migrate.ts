import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createPool } from 'mysql2/promise';
import { parseDatabaseUrl } from './connection';
import { CORE_MIGRATIONS_TABLE } from './schema';

export interface RunCoreMigrationsOptions {
  /** Connection URL of the migration user. Only the migration job uses this user (ADR 0001). */
  url: string;
  migrationsFolder?: string;
}

export const CORE_MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** Applies the core migrations and records them in the core journal (ARC-052). Idempotent. */
export async function runCoreMigrations(options: RunCoreMigrationsOptions): Promise<void> {
  const pool = createPool({ ...parseDatabaseUrl(options.url), connectionLimit: 1 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: options.migrationsFolder ?? CORE_MIGRATIONS_FOLDER,
      migrationsTable: CORE_MIGRATIONS_TABLE,
    });
  } finally {
    await pool.end();
  }
}

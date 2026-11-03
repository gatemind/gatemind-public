import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, type Connection } from 'mysql2/promise';

/** Databases created by `infrastructure/dev/mysql-init` (ADR 0001). */
export const DEV_DATABASES = {
  /** Core schema tests: migrations, journal, privileges and the tenant-rules check. */
  test: 'gatemind_test',
  /** Cross-tenant harness fixtures and deliberately bad tables. */
  probe: 'gatemind_probe',
} as const;

export interface DevDatabaseConfig {
  readonly host: string;
  readonly port: number;
  /** Connection URL of the runtime user (no DDL, no DROP, no FILE, no SUPER). Holds a password. */
  appUrl(database: string): string;
  /** Connection URL of the migration user. Holds a password. */
  migratorUrl(database: string): string;
}

function findWorkspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(resolve(dir, 'nx.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find the workspace root (nx.json)');
    dir = parent;
  }
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

/**
 * Reads the development and CI database settings: `infrastructure/dev/.env` (written by
 * `npm run db:up` with random passwords) overridden by environment variables of the same names.
 * No password is ever hard-coded, and no message names a value (SEC-080, SEC-087).
 */
export function readDevDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
  envFile: string = resolve(findWorkspaceRoot(), 'infrastructure', 'dev', '.env'),
): DevDatabaseConfig {
  const file = readEnvFile(envFile);
  const pick = (name: string): string | undefined => {
    const fromEnv = env[name];
    return fromEnv !== undefined && fromEnv !== '' ? fromEnv : file[name];
  };
  const appPassword = pick('GATEMIND_DB_APP_PASSWORD');
  const migratorPassword = pick('GATEMIND_DB_MIGRATOR_PASSWORD');
  if (appPassword === undefined || migratorPassword === undefined) {
    throw new Error(
      'The development database is not configured. Run "npm run db:up" first (it creates infrastructure/dev/.env).',
    );
  }
  const host = pick('GATEMIND_DB_HOST') ?? '127.0.0.1';
  const port = Number(pick('GATEMIND_DB_PORT') ?? '3307');
  const url = (user: string, password: string, database: string): string =>
    `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
  return {
    host,
    port,
    appUrl: (database) => url('gatemind_app', appPassword, database),
    migratorUrl: (database) => url('gatemind_migrator', migratorPassword, database),
  };
}

/** Opens one connection from a URL. The error never contains the URL, which holds a password. */
export async function openConnection(url: string): Promise<Connection> {
  const parsed = new URL(url);
  try {
    return await createConnection({
      host: parsed.hostname,
      port: Number(parsed.port),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.slice(1),
      multipleStatements: false,
    });
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'unknown';
    throw new Error(
      `Cannot connect to the development database (${code}). Run "npm run db:up" and try again.`,
      { cause: error },
    );
  }
}

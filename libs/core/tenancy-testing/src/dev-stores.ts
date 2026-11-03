import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test support: the development Valkey instances (`npm run db:up` starts them and writes
 * `infrastructure/dev/.env` with random passwords). Environment variables of the same names
 * override the file. Nothing here is a default credential, and no message names a value.
 */
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

export interface DevStoreUrls {
  readonly cacheUrl: string;
  readonly queueUrl: string;
}

export function readDevStoreUrls(env: NodeJS.ProcessEnv = process.env): DevStoreUrls {
  const file = readEnvFile(resolve(findWorkspaceRoot(), 'infrastructure', 'dev', '.env'));
  const pick = (name: string): string | undefined => {
    const fromEnv = env[name];
    return fromEnv !== undefined && fromEnv !== '' ? fromEnv : file[name];
  };
  const cachePassword = pick('GATEMIND_CACHE_PASSWORD');
  const queuePassword = pick('GATEMIND_QUEUE_PASSWORD');
  if (cachePassword === undefined || queuePassword === undefined) {
    throw new Error(
      'The development stores are not configured. Run "npm run db:up" first (it creates infrastructure/dev/.env).',
    );
  }
  const host = pick('GATEMIND_STORE_HOST') ?? '127.0.0.1';
  const cachePort = pick('GATEMIND_CACHE_PORT') ?? '6380';
  const queuePort = pick('GATEMIND_QUEUE_PORT') ?? '6381';
  const url = (password: string, port: string): string =>
    `redis://:${encodeURIComponent(password)}@${host}:${port}`;
  return { cacheUrl: url(cachePassword, cachePort), queueUrl: url(queuePassword, queuePort) };
}

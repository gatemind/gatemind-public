// Development and CI services helper: MySQL and the two Valkey instances (ADR 0001, ADR 0003).
//   node tools/dev-db/dev-db.mjs up      create or complete infrastructure/dev/.env, start the services, wait until healthy
//   node tools/dev-db/dev-db.mjs down    stop the services (data kept)
//   node tools/dev-db/dev-db.mjs reset   stop the services and delete their data and the generated .env
// Passwords are random hex generated on first run. Nothing here is a default credential (SEC-080).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const devDir = resolve(root, 'infrastructure', 'dev');
const envFile = resolve(devDir, '.env');
const composeFile = resolve(devDir, 'compose.db.yml');
const command = process.argv[2];

const hex = () => randomBytes(24).toString('hex');

// Every setting the compose file needs. Existing values are never changed, so a `.env` written by
// an earlier version of this helper is completed with the settings added by later stories.
const settings = [
  ['GATEMIND_DB_ROOT_PASSWORD', hex],
  ['GATEMIND_DB_APP_PASSWORD', hex],
  ['GATEMIND_DB_MIGRATOR_PASSWORD', hex],
  ['GATEMIND_DB_PORT', () => '3307'],
  ['GATEMIND_CACHE_PASSWORD', hex],
  ['GATEMIND_CACHE_PORT', () => '6380'],
  ['GATEMIND_QUEUE_PASSWORD', hex],
  ['GATEMIND_QUEUE_PORT', () => '6381'],
];

function ensureEnvFile() {
  const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const present = new Set(
    existing
      .split('\n')
      .map((line) => /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1])
      .filter(Boolean),
  );
  const missing = settings.filter(([name]) => !present.has(name));
  if (missing.length === 0) return;
  const lines = missing.map(([name, make]) => `${name}=${make()}`);
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(envFile, `${existing}${separator}${lines.join('\n')}\n`, { mode: 0o600 });
  console.log(
    existing === ''
      ? 'Created infrastructure/dev/.env with random passwords (not committed).'
      : `Added ${missing.length} missing setting(s) to infrastructure/dev/.env (not committed).`,
  );
}

function compose(...args) {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', envFile, '-f', composeFile, ...args],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (command === 'up') {
  ensureEnvFile();
  compose('up', '-d', '--wait');
  // The init script only runs for an empty data directory. It is idempotent, so run it again to
  // give an existing container the databases and grants added by later stories.
  compose('exec', '-T', 'mysql', 'sh', '/docker-entrypoint-initdb.d/10-users-and-databases.sh');
  console.log(
    'MySQL and the two Valkey instances are healthy on 127.0.0.1 ' +
      '(ports from GATEMIND_DB_PORT, GATEMIND_CACHE_PORT and GATEMIND_QUEUE_PORT).',
  );
} else if (command === 'down') {
  if (existsSync(envFile)) {
    ensureEnvFile();
    compose('down');
  }
} else if (command === 'reset') {
  if (existsSync(envFile)) {
    ensureEnvFile();
    compose('down', '-v');
  }
  rmSync(envFile, { force: true });
  console.log('Service data and generated .env removed.');
} else {
  console.error('Usage: node tools/dev-db/dev-db.mjs <up|down|reset>');
  process.exit(2);
}

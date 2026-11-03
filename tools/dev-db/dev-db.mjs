// Development and CI database helper.
//   node tools/dev-db/dev-db.mjs up      create infrastructure/dev/.env if missing, start MySQL, wait until healthy
//   node tools/dev-db/dev-db.mjs down    stop MySQL (data kept)
//   node tools/dev-db/dev-db.mjs reset   stop MySQL and delete its data and the generated .env
// Passwords are random hex generated on first run. Nothing here is a default credential (SEC-080).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const devDir = resolve(root, 'infrastructure', 'dev');
const envFile = resolve(devDir, '.env');
const composeFile = resolve(devDir, 'compose.db.yml');
const command = process.argv[2];

const hex = () => randomBytes(24).toString('hex');

function compose(...args) {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', envFile, '-f', composeFile, ...args],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (command === 'up') {
  if (!existsSync(envFile)) {
    writeFileSync(
      envFile,
      [
        `GATEMIND_DB_ROOT_PASSWORD=${hex()}`,
        `GATEMIND_DB_APP_PASSWORD=${hex()}`,
        `GATEMIND_DB_MIGRATOR_PASSWORD=${hex()}`,
        'GATEMIND_DB_PORT=3307',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    console.log('Created infrastructure/dev/.env with random passwords (not committed).');
  }
  compose('up', '-d', '--wait');
  // The init script only runs for an empty data directory. It is idempotent, so run it again to
  // give an existing container the databases and grants added by later stories.
  compose('exec', '-T', 'mysql', 'sh', '/docker-entrypoint-initdb.d/10-users-and-databases.sh');
  console.log('MySQL is healthy on 127.0.0.1 (port from GATEMIND_DB_PORT, default 3307).');
} else if (command === 'down') {
  if (existsSync(envFile)) compose('down');
} else if (command === 'reset') {
  if (existsSync(envFile)) compose('down', '-v');
  rmSync(envFile, { force: true });
  console.log('Database data and generated .env removed.');
} else {
  console.error('Usage: node tools/dev-db/dev-db.mjs <up|down|reset>');
  process.exit(2);
}

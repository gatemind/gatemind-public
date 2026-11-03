// Proves the Redis-client import rule actually fires (ARC-055, ADR 0003, Story 1.6a).
// Only libs/core/redis-store may import a Redis-compatible store client (ioredis, bullmq, ...).
// Everything else goes through CachePort, QueuePort or RateLimiterPort.
// The script writes deliberately illegal files into a lib that is NOT the store adapter, expects
// ESLint to report each one, expects a clean control file to stay clean, then always removes them.
// Exit code 0 means "every violation was caught and the control was not flagged".
// Scope: static `import` statements. The rule does not claim to catch `require()` or `import()`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const dir = 'libs/shared/types/src/__redis_import_violations__';
const RULES = new Set(['no-restricted-imports']);

const violations = {
  'ioredis-default.ts': "import Redis from 'ioredis';\nexport const r = Redis;\n",
  'ioredis-named.ts': "import { Redis } from 'ioredis';\nexport const r = Redis;\n",
  'ioredis-type.ts': "import type { Redis } from 'ioredis';\nexport type R = Redis;\n",
  'bullmq-queue.ts': "import { Queue } from 'bullmq';\nexport const q = Queue;\n",
  'bullmq-subpath.ts': "import { Queue } from 'bullmq/dist/esm';\nexport const q = Queue;\n",
  'redis-package.ts': "import { createClient } from 'redis';\nexport const c = createClient;\n",
  'redis-client-package.ts':
    "import { createClient } from '@redis/client';\nexport const c = createClient;\n",
  'iovalkey-package.ts': "import Valkey from 'iovalkey';\nexport const v = Valkey;\n",
  'valkey-glide.ts':
    "import { GlideClient } from '@valkey/valkey-glide';\nexport const g = GlideClient;\n",
};
// Legal code in the same lib: ordinary imports, and prose that merely names the libraries.
const controls = {
  'control-ok.ts': [
    "import { readFileSync } from 'node:fs';",
    'export const read = readFileSync;',
    "export const note = 'ioredis and bullmq are used only inside the redis-store library';",
    '',
  ].join('\n'),
};

let exitCode = 1;
try {
  mkdirSync(dir, { recursive: true });
  for (const [name, source] of Object.entries({ ...violations, ...controls })) {
    writeFileSync(`${dir}/${name}`, source);
  }
  const result = spawnSync('npx', ['eslint', '--no-cache', '--format', 'json', dir], {
    encoding: 'utf8',
    env: { ...process.env, NX_DAEMON: 'false', NX_CACHE_PROJECT_GRAPH: 'false' },
    maxBuffer: 20 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error('FAIL: ESLint did not return a report.');
    console.error(`${result.stdout}\n${result.stderr}`);
    process.exit(1);
  }
  const flagged = new Map(
    report.map((file) => [
      file.filePath.split('/').pop(),
      file.messages.filter((m) => RULES.has(m.ruleId)),
    ]),
  );
  const missed = Object.keys(violations).filter((name) => (flagged.get(name) ?? []).length === 0);
  const falsePositives = Object.keys(controls).filter(
    (name) => (flagged.get(name) ?? []).length > 0,
  );
  if (missed.length === 0 && falsePositives.length === 0) {
    console.log(
      `OK: all ${Object.keys(violations).length} Redis-client imports were caught; the control file stayed clean.`,
    );
    exitCode = 0;
  } else {
    if (missed.length > 0) console.error(`FAIL: NOT detected by lint: ${missed.join(', ')}`);
    if (falsePositives.length > 0)
      console.error(`FAIL: wrongly flagged: ${falsePositives.join(', ')}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);

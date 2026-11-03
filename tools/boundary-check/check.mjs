// Proves the module-boundary lint rule actually fires (ARC-030, ARC-056).
// It writes a deliberately illegal import into a shared util lib (shared -> backend port),
// expects ESLint to fail with @nx/enforce-module-boundaries, then always removes the file.
// Exit code 0 means "the rule caught the violation". Anything else means the guard is broken.
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

const file = 'libs/shared/types/src/__boundary_violation__.ts';
const source = [
  "import { systemClock } from '@gatemind/ports';",
  'export const violation = systemClock;',
  '',
].join('\n');

let exitCode = 1;
try {
  writeFileSync(file, source);
  const result = spawnSync('npx', ['eslint', '--no-cache', file], {
    encoding: 'utf8',
    env: { ...process.env, NX_DAEMON: 'false', NX_CACHE_PROJECT_GRAPH: 'false' },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0 && output.includes('@nx/enforce-module-boundaries')) {
    console.log('OK: boundary violation was detected by lint.');
    exitCode = 0;
  } else {
    console.error('FAIL: the deliberate boundary violation was NOT detected.');
    console.error(output);
  }
} finally {
  rmSync(file, { force: true });
}
process.exit(exitCode);

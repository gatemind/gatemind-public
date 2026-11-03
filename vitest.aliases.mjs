// Single source of truth for `@gatemind/*` imports in tests: it reads tsconfig.base.json paths,
// so the compiler and Vitest can never disagree about where a library lives.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const { compilerOptions } = JSON.parse(readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8'));

export const alias = Object.fromEntries(
  Object.entries(compilerOptions.paths).map(([name, [target]]) => [name, resolve(root, target)]),
);

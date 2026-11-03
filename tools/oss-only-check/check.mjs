// OSS-only proof (ARC-030, ARC-051, ARC-057, NFR9).
// The core repository must contain no commercial code, paths, tags or naming.
// Checks:
//   1. none of the commercial paths exist (libs/ee, apps-ee, ee schema)
//   2. no project is tagged edition:ee
//   3. no tracked text file mentions commercial-only naming
// Exit code 0 means the workspace is clean.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const forbiddenPaths = ['libs/ee', 'apps-ee', 'infrastructure/ee', 'tools/ee'];
const forbiddenWords = /\b(enterprise|commercial)\b/i;
const skipDirs = new Set(['node_modules', 'dist', '.nx', 'coverage', '.git']);
const skipFiles = new Set(['package-lock.json', 'tools/oss-only-check/check.mjs']);
const textExt = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|txt)$/;

const problems = [];

for (const p of forbiddenPaths) {
  if (existsSync(p)) problems.push(`forbidden path exists: ${p}`);
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const full = join(dir, name);
    const rel = relative('.', full).split('\\').join('/');
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (skipFiles.has(rel) || !textExt.test(name)) continue;
    const text = readFileSync(full, 'utf8');
    if (name === 'project.json' && /"edition:ee"/.test(text)) {
      problems.push(`${rel}: project tagged edition:ee`);
    }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (forbiddenWords.test(line)) problems.push(`${rel}:${i + 1}: commercial-only naming`);
    });
  }
}
walk('.');

if (problems.length > 0) {
  console.error(
    'FAIL: the core workspace is not OSS-clean:\n' + problems.map((p) => `  - ${p}`).join('\n'),
  );
  process.exit(1);
}
console.log('OK: no commercial paths, tags or naming found in the core workspace.');

// Every Nx project must carry the full tag taxonomy (ARC-056):
//   scope:*  type:*  edition:*
// The core repository may only contain edition:core projects (ARC-030, ARC-051).
// Exit code 0 means all projects are tagged correctly.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['apps', 'libs'];
const skip = new Set(['node_modules', 'dist', '.nx', 'coverage', '.git']);

function findProjectFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (skip.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) findProjectFiles(full, out);
    else if (name === 'project.json') out.push(full);
  }
  return out;
}

const problems = [];
const files = roots.flatMap((root) => findProjectFiles(root));

for (const file of files) {
  const project = JSON.parse(readFileSync(file, 'utf8'));
  const tags = Array.isArray(project.tags) ? project.tags : [];
  for (const prefix of ['scope:', 'type:', 'edition:']) {
    const count = tags.filter((t) => t.startsWith(prefix)).length;
    if (count !== 1) {
      problems.push(`${file}: expected exactly one "${prefix}*" tag, found ${count}`);
    }
  }
  if (!tags.includes('edition:core')) {
    problems.push(`${file}: core repository projects must be tagged "edition:core"`);
  }
}

if (problems.length > 0) {
  console.error('FAIL: tag taxonomy violations:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`OK: ${files.length} project(s) carry scope, type and edition:core tags.`);

// Proves the raw-SQL lint rule actually fires (ARC-020, ADR 0001 control 1).
// It writes deliberately illegal files into a lib that is NOT part of the data layer, expects
// ESLint to report each one, expects a clean control file to stay clean, then always removes them.
// Exit code 0 means "every violation was caught and the control was not flagged".
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const dir = 'libs/shared/types/src/__raw_sql_violations__';
const RULES = new Set(['no-restricted-imports', 'no-restricted-syntax']);

const violations = {
  'mysql2-import.ts':
    "import { createPool } from 'mysql2/promise';\nexport const p = createPool;\n",
  'drizzle-driver-import.ts':
    "import { drizzle } from 'drizzle-orm/mysql2';\nexport const d = drizzle;\n",
  'drizzle-table-import.ts':
    "import { mysqlTable } from 'drizzle-orm/mysql-core';\nexport const t = mysqlTable;\n",
  'sql-tag.ts': "import { sql } from 'drizzle-orm';\nexport const q = sql`1 = 1`;\n",
  'sql-string.ts': "export const q = 'SELECT * FROM users';\n",
  'sql-template.ts': 'export const q = `DELETE FROM users WHERE id = 1`;\n',
  'sql-update.ts': "export const q = 'update users set name = 1';\n",
  'raw-query-call.ts':
    "declare const db: { query(sql: string): unknown };\nexport const r = db.query('anything');\n",
  'raw-execute-call.ts':
    "declare const db: { execute(sql: string): unknown };\nexport const r = db.execute('anything');\n",
};
// Legal code in the same lib: filters built from helpers, prose that merely contains a keyword,
// and a client-style `.query()` call with an options object.
const controls = {
  'control-ok.ts': [
    "import { eq } from 'drizzle-orm';",
    'export const filter = eq;',
    "export const note = 'Select the tenant first, then update the settings.';",
    'declare const client: { query(options: object): unknown };',
    'export const r = client.query({ key: 1 });',
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
      `OK: all ${Object.keys(violations).length} raw-SQL violations were caught; the control file stayed clean.`,
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

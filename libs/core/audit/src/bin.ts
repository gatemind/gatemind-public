import { AuditLogStore, createDatabase } from '@gatemind/database';
import { runAuditVerifyCli } from './verify-cli';

// `npm run audit:verify`. Run through tsx until the Operator distribution (Story 1.8) packages it.
runAuditVerifyCli({
  argv: process.argv.slice(2),
  env: process.env,
  openStorage: async (url) => {
    const database = createDatabase({ url, connectionLimit: 2 });
    return { storage: new AuditLogStore(database.db), close: () => database.close() };
  },
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
}).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error('The audit verification failed unexpectedly');
    process.exitCode = 2;
  },
);

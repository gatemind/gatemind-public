import { alias } from '../../../vitest.aliases.mjs';

// The suites run against the development MySQL and Valkey instances (`npm run db:up`). Files run
// one at a time. `core-composition:test` runs after the database, secrets and audit suites (see
// project.json) because they share the `gatemind_test` and `gatemind_audit_test` databases.
export default { resolve: { alias }, test: { fileParallelism: false, testTimeout: 30000 } };

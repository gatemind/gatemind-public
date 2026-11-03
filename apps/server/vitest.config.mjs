import { alias } from '../../vitest.aliases.mjs';

// `server.spec.ts` uses fakes. `main.spec.ts` starts the real entrypoint as a child process against
// the development MySQL and Valkey instances (`npm run db:up`), so files run one at a time and
// after the composition suite, which shares the `gatemind_test` databases.
export default { resolve: { alias }, test: { fileParallelism: false, testTimeout: 60000 } };

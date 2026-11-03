import { alias } from '../../../vitest.aliases.mjs';

// These suites talk to the development MySQL (`npm run db:up`), so they get a longer timeout
// and run one file at a time against their shared database.
export default {
  resolve: { alias },
  test: { testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
};

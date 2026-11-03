import { alias } from '../../../vitest.aliases.mjs';

// The integration suite talks to the development MySQL (`npm run db:up`), so it gets a longer
// timeout and runs one file at a time against the shared database.
export default {
  resolve: { alias },
  test: { testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
};

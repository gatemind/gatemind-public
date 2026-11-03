import { alias } from '../../../vitest.aliases.mjs';

// The suites run against the development Valkey instances (`npm run db:up`), one for the cache
// and one for the queue. Files run one at a time so they never compete for the same instances.
export default { resolve: { alias }, test: { fileParallelism: false, testTimeout: 20000 } };

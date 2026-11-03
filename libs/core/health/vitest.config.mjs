import { alias } from '../../../vitest.aliases.mjs';

// Pure unit tests over a real local HTTP server on an ephemeral port. No database or store.
export default { resolve: { alias }, test: { testTimeout: 15000 } };

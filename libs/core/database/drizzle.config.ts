import { defineConfig } from 'drizzle-kit';

// Run from the workspace root: `npm run db:generate`. Paths are relative to the root.
// Generating migrations needs no database connection.
export default defineConfig({
  dialect: 'mysql',
  schema: './libs/core/database/src/schema/index.ts',
  out: './libs/core/database/migrations',
  migrations: { table: '__core_migrations' },
});

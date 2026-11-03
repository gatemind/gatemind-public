import { defineConfig } from 'drizzle-kit';

// Run from the workspace root: `npm run db:generate:audit`. The audit log has its own database,
// its own migrations and its own journal (SEC-070). Generating needs no database connection.
export default defineConfig({
  dialect: 'mysql',
  schema: './libs/core/database/src/audit/audit-log-schema.ts',
  out: './libs/core/database/audit-migrations',
  migrations: { table: '__audit_migrations' },
});

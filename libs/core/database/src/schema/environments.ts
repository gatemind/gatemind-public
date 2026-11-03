import { sql } from 'drizzle-orm';
import {
  foreignKey,
  mysqlTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { organizations } from './organizations';
import { projects } from './projects';

/**
 * An environment inside a project (ARC-024). The foreign key to the project includes
 * `tenant_id`, so an environment can never point at another tenant's project (ARC-021).
 */
export const environments = mysqlTable(
  'environments',
  {
    tenantId: varchar('tenant_id', { length: 64 }).notNull(),
    id: varchar('id', { length: 64 }).notNull(),
    projectId: varchar('project_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    primaryKey({ name: 'environments_pk', columns: [t.tenantId, t.id] }),
    foreignKey({
      name: 'environments_tenant_fk',
      columns: [t.tenantId],
      foreignColumns: [organizations.id],
    }),
    foreignKey({
      name: 'environments_project_fk',
      columns: [t.tenantId, t.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }),
    uniqueIndex('environments_tenant_project_name_uq').on(t.tenantId, t.projectId, t.name),
  ],
);

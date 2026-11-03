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
import { workspaces } from './workspaces';

/**
 * A project inside a workspace (ARC-024). Platform API keys are bound to a project and an
 * environment (Story 3.3). The foreign key to the workspace includes `tenant_id`, so a project
 * can never point at another tenant's workspace (ARC-021).
 */
export const projects = mysqlTable(
  'projects',
  {
    tenantId: varchar('tenant_id', { length: 64 }).notNull(),
    id: varchar('id', { length: 64 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    primaryKey({ name: 'projects_pk', columns: [t.tenantId, t.id] }),
    foreignKey({
      name: 'projects_tenant_fk',
      columns: [t.tenantId],
      foreignColumns: [organizations.id],
    }),
    foreignKey({
      name: 'projects_workspace_fk',
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
    }),
    uniqueIndex('projects_tenant_workspace_name_uq').on(t.tenantId, t.workspaceId, t.name),
  ],
);

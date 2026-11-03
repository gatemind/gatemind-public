export { checkCoreSchema } from './check-schema';
export {
  type Database,
  type DatabaseOptions,
  createDatabase,
  parseDatabaseUrl,
} from './connection';
export { isDuplicateKeyError, mysqlErrno } from './db-errors';
export { describeMysqlSchema } from './introspect';
export {
  ACTIVE_KEY_STATUS,
  type StoredTenantKey,
  TenantKeyRepository,
  TenantKeyStore,
  type TenantKeyStores,
  createTenantKeyStores,
  tenantKeyId,
} from './tenant-key-store';
export {
  DEFAULT_ENVIRONMENT_ID,
  DEFAULT_ENVIRONMENT_NAME,
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_NAME,
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  DEFAULT_REGION,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  type DefaultHierarchy,
  type EnsureDefaultHierarchyOptions,
  ensureDefaultHierarchy,
} from './hierarchy/default-hierarchy';
export {
  EnvironmentRepository,
  OrganizationRepository,
  ProjectRepository,
  WorkspaceRepository,
} from './hierarchy/repositories';
export {
  CORE_MIGRATIONS_FOLDER,
  type RunCoreMigrationsOptions,
  runCoreMigrations,
} from './migrate';
export {
  CORE_MIGRATIONS_TABLE,
  NON_TENANT_TABLES,
  type NonTenantTable,
  type NonTenantTableKind,
  coreSchema,
  environments,
  organizations,
  projects,
  tenantKeys,
  workspaces,
} from './schema';
export type {
  ColumnDescription,
  ForeignKeyDescription,
  IndexDescription,
  TableDescription,
} from './schema-description';
export { TENANT_COLUMN, type TenantRulesOptions, checkTenantRules } from './tenant-rules';

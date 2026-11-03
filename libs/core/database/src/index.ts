export { checkCoreSchema } from './check-schema';
export {
  type Database,
  type DatabaseOptions,
  createDatabase,
  parseDatabaseUrl,
} from './connection';
export { describeMysqlSchema } from './introspect';
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
  organizations,
} from './schema';
export type {
  ColumnDescription,
  ForeignKeyDescription,
  IndexDescription,
  TableDescription,
} from './schema-description';
export { TENANT_COLUMN, type TenantRulesOptions, checkTenantRules } from './tenant-rules';

import nx from '@nx/eslint-plugin';
import prettier from 'eslint-config-prettier';

// Tag taxonomy and constraints: master.md ARC-056 [PROPOSED], ARC-030.
// scope: backend | frontend | shared | tooling
// type:  app | feature | data-access | ui | util | port | adapter
// edition: core | ee   (the ee value is declared here only because the taxonomy needs it;
//                       no ee project ever exists in this repository)
export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  { ignores: ['**/dist', '**/node_modules', '**/.nx', '**/coverage'] },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            {
              sourceTag: 'scope:backend',
              onlyDependOnLibsWithTags: ['scope:backend', 'scope:shared'],
            },
            {
              sourceTag: 'scope:frontend',
              onlyDependOnLibsWithTags: ['scope:frontend', 'scope:shared'],
            },
            { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
            {
              sourceTag: 'scope:tooling',
              onlyDependOnLibsWithTags: [
                'scope:tooling',
                'scope:shared',
                'scope:backend',
                'scope:frontend',
              ],
            },

            { sourceTag: 'type:util', onlyDependOnLibsWithTags: ['type:util'] },
            { sourceTag: 'type:port', onlyDependOnLibsWithTags: ['type:port', 'type:util'] },
            { sourceTag: 'type:ui', onlyDependOnLibsWithTags: ['type:ui', 'type:util'] },
            {
              sourceTag: 'type:data-access',
              onlyDependOnLibsWithTags: ['type:data-access', 'type:port', 'type:util'],
            },
            {
              sourceTag: 'type:adapter',
              onlyDependOnLibsWithTags: [
                'type:adapter',
                'type:data-access',
                'type:port',
                'type:util',
              ],
            },
            {
              sourceTag: 'type:feature',
              onlyDependOnLibsWithTags: [
                'type:feature',
                'type:ui',
                'type:data-access',
                'type:adapter',
                'type:port',
                'type:util',
              ],
            },
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: [
                'type:app',
                'type:feature',
                'type:ui',
                'type:data-access',
                'type:adapter',
                'type:port',
                'type:util',
              ],
            },

            { sourceTag: 'edition:core', onlyDependOnLibsWithTags: ['edition:core'] },
          ],
        },
      ],
    },
  },
  {
    // ARC-020, ADR 0001 control 1: the tenant-scoped repository is the only data path. Outside
    // the data layer (below), code may not open a database connection, use the MySQL driver or
    // raw Drizzle table definitions, build raw SQL, or write SQL statements as strings.
    // `tools/raw-sql-check` proves this rule fires on a deliberate violation.
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'mysql2',
              message:
                'Raw database access is only allowed in the data layer (ARC-020). Use a tenant-scoped repository.',
            },
            {
              name: 'drizzle-orm',
              importNames: ['sql'],
              message:
                'Raw SQL is only allowed in the data layer (ARC-020). Use a tenant-scoped repository.',
            },
          ],
          patterns: [
            {
              group: [
                'mysql2/*',
                'drizzle-orm/mysql2',
                'drizzle-orm/mysql2/*',
                'drizzle-orm/mysql-core',
                'drizzle-orm/mysql-core/*',
              ],
              message:
                'Raw database access is only allowed in the data layer (ARC-020). Use a tenant-scoped repository.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "TaggedTemplateExpression[tag.name='sql']",
          message:
            'Raw SQL is only allowed in the data layer (ARC-020). Use a tenant-scoped repository.',
        },
        {
          selector:
            'CallExpression[callee.property.name=/^(query|execute)$/][arguments.0.type=/^(Literal|TemplateLiteral)$/]',
          message:
            'Raw SQL is only allowed in the data layer (ARC-020). Use a tenant-scoped repository.',
        },
        {
          selector:
            'Literal[value=/^\\s*(select\\s[^;]*\\sfrom\\s|insert\\s+into\\s|update\\s+\\w+\\s+set\\s|delete\\s+from\\s)/i]',
          message: 'SQL statements as strings are only allowed in the data layer (ARC-020).',
        },
        {
          selector:
            'TemplateElement[value.raw=/^\\s*(select\\s[^;]*\\sfrom\\s|insert\\s+into\\s|update\\s+\\w+\\s+set\\s|delete\\s+from\\s)/i]',
          message: 'SQL statements as strings are only allowed in the data layer (ARC-020).',
        },
      ],
    },
  },
  {
    // The data layer itself: the repository base, the database library (connection, migrations,
    // schema introspection) and the test support that attacks them against a real MySQL.
    files: ['libs/core/tenancy/**', 'libs/core/database/**', 'libs/core/tenancy-testing/**'],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    // Test runner config files import the shared alias helper from the workspace root.
    // They are tooling, not library code, so the boundary rule does not apply to them.
    files: ['**/vitest.config.mjs'],
    rules: { '@nx/enforce-module-boundaries': 'off' },
  },
  prettier,
];

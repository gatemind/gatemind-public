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
    // Test runner config files import the shared alias helper from the workspace root.
    // They are tooling, not library code, so the boundary rule does not apply to them.
    files: ['**/vitest.config.mjs'],
    rules: { '@nx/enforce-module-boundaries': 'off' },
  },
  prettier,
];

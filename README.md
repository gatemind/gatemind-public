# Gatemind

Gatemind is a multi-account AI API router. This repository holds the core workspace.

**Status: early development. All rights reserved, license pending.**

- No license is granted at this time.
- External contributions are not accepted yet.
- Nothing in this repository is a release, and no stability, support or availability promise is made.

## Development

Requires Node.js 22 or newer (`.nvmrc` pins the version used in CI).

```bash
npm ci
npm run db:up      # starts MySQL 9.7 in Docker (development only), creates a random-password .env
npm run verify
```

The data-layer tests run against a real MySQL, so Docker is needed. `npm run db:down` stops the
database and `npm run db:reset` deletes its data.

`npm run verify` runs the same checks as CI: format, lint, strict type check, tests, build, the
module-boundary guard, the project tag check, the raw-SQL lint guard and the OSS-only check.

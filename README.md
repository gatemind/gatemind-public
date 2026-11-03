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
npm run verify
```

`npm run verify` runs the same checks as CI: format, lint, strict type check, tests, build, the
module-boundary guard, the project tag check and the OSS-only check.

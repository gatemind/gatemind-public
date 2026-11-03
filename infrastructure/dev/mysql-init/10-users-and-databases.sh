#!/bin/sh
# Runs on first start of an empty data directory (ADR 0001 compensating control 3). It is safe to
# run again (every statement is idempotent): `npm run db:up` runs it on an existing container too,
# so grants added later reach databases that were created earlier.
#
#   gatemind_app       runtime user. Data access only: no DROP, no FILE, no SUPER, no DDL.
#   gatemind_migrator  used only by the migration job. Schema changes, no administration.
#
# Databases:
#   gatemind        development data
#   gatemind_test   core schema tests (migrations and the tenant-rules check)
#   gatemind_probe  cross-tenant harness fixtures
#   gatemind_audit       the tamper-evident audit log (SEC-070), development data
#   gatemind_audit_test  audit log tests
# The application user gets only SELECT and INSERT on the audit databases: it can add history but
# can never change or delete it. This is why the audit log has its own databases (Story 1.6).
set -eu

mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS gatemind CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS gatemind_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS gatemind_probe CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS gatemind_audit CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS gatemind_audit_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'gatemind_app'@'%' IDENTIFIED BY '${GATEMIND_DB_APP_PASSWORD}';
CREATE USER IF NOT EXISTS 'gatemind_migrator'@'%' IDENTIFIED BY '${GATEMIND_DB_MIGRATOR_PASSWORD}';

GRANT SELECT, INSERT, UPDATE, DELETE ON gatemind.* TO 'gatemind_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON gatemind_test.* TO 'gatemind_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON gatemind_probe.* TO 'gatemind_app'@'%';
GRANT SELECT, INSERT ON gatemind_audit.* TO 'gatemind_app'@'%';
GRANT SELECT, INSERT ON gatemind_audit_test.* TO 'gatemind_app'@'%';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON gatemind.* TO 'gatemind_migrator'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON gatemind_test.* TO 'gatemind_migrator'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON gatemind_probe.* TO 'gatemind_migrator'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON gatemind_audit.* TO 'gatemind_migrator'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON gatemind_audit_test.* TO 'gatemind_migrator'@'%';

FLUSH PRIVILEGES;
SQL

#!/bin/sh
# Runs once, on first start of an empty data directory (ADR 0001 compensating control 3).
#
#   gatemind_app       runtime user. Data access only: no DROP, no FILE, no SUPER, no DDL.
#   gatemind_migrator  used only by the migration job. Schema changes, no administration.
#
# Databases:
#   gatemind        development data
#   gatemind_test   core schema tests (migrations and the tenant-rules check)
#   gatemind_probe  cross-tenant harness fixtures
set -eu

mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS gatemind CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS gatemind_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS gatemind_probe CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'gatemind_app'@'%' IDENTIFIED BY '${GATEMIND_DB_APP_PASSWORD}';
CREATE USER IF NOT EXISTS 'gatemind_migrator'@'%' IDENTIFIED BY '${GATEMIND_DB_MIGRATOR_PASSWORD}';

GRANT SELECT, INSERT, UPDATE, DELETE ON gatemind.* TO 'gatemind_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON gatemind_test.* TO 'gatemind_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON gatemind_probe.* TO 'gatemind_app'@'%';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON gatemind.* TO 'gatemind_migrator'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON gatemind_test.* TO 'gatemind_migrator'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON gatemind_probe.* TO 'gatemind_migrator'@'%';

FLUSH PRIVILEGES;
SQL

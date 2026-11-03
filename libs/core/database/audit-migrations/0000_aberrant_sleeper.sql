CREATE TABLE `audit_log` (
	`tenant_id` varchar(64) NOT NULL,
	`seq` bigint unsigned NOT NULL,
	`occurred_at_ms` bigint NOT NULL,
	`actor` varchar(128) NOT NULL,
	`action` varchar(64) NOT NULL,
	`target` varchar(128) NOT NULL,
	`prev_hash` char(64) NOT NULL,
	`hash` char(64) NOT NULL,
	CONSTRAINT `audit_log_pk` PRIMARY KEY(`tenant_id`,`seq`),
	CONSTRAINT `audit_log_tenant_hash_uq` UNIQUE(`tenant_id`,`hash`),
	CONSTRAINT `audit_log_tenant_prev_hash_uq` UNIQUE(`tenant_id`,`prev_hash`)
);

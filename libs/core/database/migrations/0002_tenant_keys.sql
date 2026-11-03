CREATE TABLE `tenant_keys` (
	`tenant_id` varchar(64) NOT NULL,
	`id` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`wrapped_key` varchar(512) NOT NULL,
	`master_key_id` varchar(32) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`wrapped_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tenant_keys_pk` PRIMARY KEY(`tenant_id`,`id`),
	CONSTRAINT `tenant_keys_tenant_version_uq` UNIQUE(`tenant_id`,`version`)
);
--> statement-breakpoint
ALTER TABLE `tenant_keys` ADD CONSTRAINT `tenant_keys_tenant_fk` FOREIGN KEY (`tenant_id`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `tenant_keys_tenant_master_key_idx` ON `tenant_keys` (`tenant_id`,`master_key_id`);
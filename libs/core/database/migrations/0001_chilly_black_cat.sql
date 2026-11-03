CREATE TABLE `environments` (
	`tenant_id` varchar(64) NOT NULL,
	`id` varchar(64) NOT NULL,
	`project_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `environments_pk` PRIMARY KEY(`tenant_id`,`id`),
	CONSTRAINT `environments_tenant_project_name_uq` UNIQUE(`tenant_id`,`project_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`tenant_id` varchar(64) NOT NULL,
	`id` varchar(64) NOT NULL,
	`workspace_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `projects_pk` PRIMARY KEY(`tenant_id`,`id`),
	CONSTRAINT `projects_tenant_workspace_name_uq` UNIQUE(`tenant_id`,`workspace_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`tenant_id` varchar(64) NOT NULL,
	`id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `workspaces_pk` PRIMARY KEY(`tenant_id`,`id`),
	CONSTRAINT `workspaces_tenant_name_uq` UNIQUE(`tenant_id`,`name`)
);
--> statement-breakpoint
ALTER TABLE `environments` ADD CONSTRAINT `environments_tenant_fk` FOREIGN KEY (`tenant_id`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `environments` ADD CONSTRAINT `environments_project_fk` FOREIGN KEY (`tenant_id`,`project_id`) REFERENCES `projects`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_tenant_fk` FOREIGN KEY (`tenant_id`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_workspace_fk` FOREIGN KEY (`tenant_id`,`workspace_id`) REFERENCES `workspaces`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaces` ADD CONSTRAINT `workspaces_tenant_fk` FOREIGN KEY (`tenant_id`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;
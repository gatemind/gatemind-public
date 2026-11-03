CREATE TABLE `organizations` (
	`id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`region` varchar(32) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `organizations_id` PRIMARY KEY(`id`)
);

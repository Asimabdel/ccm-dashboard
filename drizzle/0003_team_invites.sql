CREATE TABLE `teamInvites` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(320) NOT NULL,
	`role` enum('admin','staff','provider','billing','front_desk','user') NOT NULL DEFAULT 'staff',
	`clinicLocation` varchar(255),
	`invitedByUserId` int,
	`status` enum('pending','accepted','revoked') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `teamInvites_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `teamInvites` ADD CONSTRAINT `teamInvites_invitedByUserId_users_id_fk` FOREIGN KEY (`invitedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;

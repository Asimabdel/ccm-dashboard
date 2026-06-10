CREATE TABLE `billingRecords` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ccmTaskId` int NOT NULL,
	`patientId` int NOT NULL,
	`month` varchar(7) NOT NULL,
	`timeThresholdMet` boolean DEFAULT false,
	`documentationComplete` boolean DEFAULT false,
	`providerAssociated` boolean DEFAULT false,
	`carePlanReviewed` boolean DEFAULT false,
	`noMissingFields` boolean DEFAULT false,
	`providerReviewCompleted` boolean DEFAULT false,
	`billingStatus` enum('not_started','in_progress','documentation_incomplete','provider_review_pending','ready_for_billing','billed','denied','needs_correction') DEFAULT 'not_started',
	`claimSubmittedDate` datetime,
	`claimDenialReason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billingRecords_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ccmNotes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ccmTaskId` int NOT NULL,
	`patientId` int NOT NULL,
	`staffId` int NOT NULL,
	`howFeeling` text,
	`newSymptoms` text,
	`medicationAdherence` text,
	`refillsNeeded` text,
	`erHospitalizationSince` text,
	`recentSpecialistVisits` text,
	`bloodPressureReading` varchar(20),
	`bloodSugarReading` varchar(20),
	`upcomingAppointments` text,
	`followUpNeeded` text,
	`patientConcerns` text,
	`generatedNote` text,
	`escalationReason` text,
	`escalationFlag` boolean DEFAULT false,
	`followUpActions` json DEFAULT ('[]'),
	`timeSpentMinutes` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ccmNotes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ccmTasks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`patientId` int NOT NULL,
	`month` varchar(7) NOT NULL,
	`assignedStaffId` int,
	`status` enum('not_started','assigned','called_no_answer','voicemail_left','wrong_number','needs_callback','in_progress','completed','needs_provider_review','needs_appointment','documentation_incomplete','ready_for_billing','billed','declined_ccm','inactive') DEFAULT 'not_started',
	`dateContacted` datetime,
	`timeSpentMinutes` int DEFAULT 0,
	`ccmNoteCompleted` boolean DEFAULT false,
	`providerReviewNeeded` boolean DEFAULT false,
	`followUpAppointmentNeeded` boolean DEFAULT false,
	`appointmentScheduled` boolean DEFAULT false,
	`labsReferralsPending` json DEFAULT ('[]'),
	`billingReady` boolean DEFAULT false,
	`comments` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ccmTasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `clinics` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`location` varchar(255) NOT NULL,
	`address` text,
	`phone` varchar(20),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `clinics_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `followUpItems` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ccmTaskId` int NOT NULL,
	`patientId` int NOT NULL,
	`type` enum('office_visit','telemedicine_visit','lab_work','medication_refill','referral','imaging','testing','rpm_enrollment','dexa','abi','pft','balance_test','vaccination','annual_wellness') NOT NULL,
	`status` enum('pending','scheduled','completed') DEFAULT 'pending',
	`scheduledDate` datetime,
	`completedDate` datetime,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `followUpItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`type` enum('urgent_symptom','escalation','missing_documentation','not_reached','billing_ready') NOT NULL,
	`title` varchar(255) NOT NULL,
	`content` text,
	`relatedPatientId` int,
	`relatedCCMTaskId` int,
	`read` boolean DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `patients` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`dateOfBirth` datetime,
	`phoneNumber` varchar(20) NOT NULL,
	`clinicId` int NOT NULL,
	`providerId` int NOT NULL,
	`preferredLanguage` varchar(50) DEFAULT 'English',
	`chronicConditions` json DEFAULT ('[]'),
	`insurance` text,
	`ccmEnrollmentStatus` enum('active','inactive','declined','transferred') DEFAULT 'active',
	`consentStatus` enum('consented','pending','declined') DEFAULT 'pending',
	`riskLevel` enum('high','medium','low') DEFAULT 'medium',
	`assignedStaffId` int,
	`lastOfficeVisit` datetime,
	`nextAppointment` datetime,
	`lastCCMDate` datetime,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `patients_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `productivityMetrics` (
	`id` int AUTO_INCREMENT NOT NULL,
	`month` varchar(7) NOT NULL,
	`staffId` int,
	`providerId` int,
	`clinicId` int,
	`totalCCMsCompleted` int DEFAULT 0,
	`totalCCMsAssigned` int DEFAULT 0,
	`totalTimeSpentMinutes` int DEFAULT 0,
	`patientsNotReached` int DEFAULT 0,
	`patientsNeedingReview` int DEFAULT 0,
	`patientsReadyForBilling` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `productivityMetrics_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `providerEscalations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ccmNoteId` int NOT NULL,
	`patientId` int NOT NULL,
	`providerId` int NOT NULL,
	`reason` text NOT NULL,
	`escalationStatus` enum('pending','reviewed','action_needed','completed') DEFAULT 'pending',
	`recommendedAction` text,
	`providerNotes` text,
	`reviewedAt` datetime,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `providerEscalations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int,
	`name` varchar(255) NOT NULL,
	`title` varchar(100),
	`clinicId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `providers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `role` enum('admin','staff','provider','billing','front_desk','user') NOT NULL DEFAULT 'user';--> statement-breakpoint
ALTER TABLE `users` ADD `clinicLocation` varchar(255);--> statement-breakpoint
ALTER TABLE `users` ADD `languagesSpoken` json DEFAULT ('[]');--> statement-breakpoint
ALTER TABLE `billingRecords` ADD CONSTRAINT `billingRecords_ccmTaskId_ccmTasks_id_fk` FOREIGN KEY (`ccmTaskId`) REFERENCES `ccmTasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billingRecords` ADD CONSTRAINT `billingRecords_patientId_patients_id_fk` FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ccmNotes` ADD CONSTRAINT `ccmNotes_ccmTaskId_ccmTasks_id_fk` FOREIGN KEY (`ccmTaskId`) REFERENCES `ccmTasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ccmNotes` ADD CONSTRAINT `ccmNotes_patientId_patients_id_fk` FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ccmNotes` ADD CONSTRAINT `ccmNotes_staffId_users_id_fk` FOREIGN KEY (`staffId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ccmTasks` ADD CONSTRAINT `ccmTasks_patientId_patients_id_fk` FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ccmTasks` ADD CONSTRAINT `ccmTasks_assignedStaffId_users_id_fk` FOREIGN KEY (`assignedStaffId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `followUpItems` ADD CONSTRAINT `followUpItems_ccmTaskId_ccmTasks_id_fk` FOREIGN KEY (`ccmTaskId`) REFERENCES `ccmTasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `followUpItems` ADD CONSTRAINT `followUpItems_patientId_patients_id_fk` FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_relatedPatientId_patients_id_fk` FOREIGN KEY (`relatedPatientId`) REFERENCES `patients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_relatedCCMTaskId_ccmTasks_id_fk` FOREIGN KEY (`relatedCCMTaskId`) REFERENCES `ccmTasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `patients` ADD CONSTRAINT `patients_clinicId_clinics_id_fk` FOREIGN KEY (`clinicId`) REFERENCES `clinics`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `patients` ADD CONSTRAINT `patients_providerId_providers_id_fk` FOREIGN KEY (`providerId`) REFERENCES `providers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `patients` ADD CONSTRAINT `patients_assignedStaffId_users_id_fk` FOREIGN KEY (`assignedStaffId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productivityMetrics` ADD CONSTRAINT `productivityMetrics_staffId_users_id_fk` FOREIGN KEY (`staffId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productivityMetrics` ADD CONSTRAINT `productivityMetrics_providerId_providers_id_fk` FOREIGN KEY (`providerId`) REFERENCES `providers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productivityMetrics` ADD CONSTRAINT `productivityMetrics_clinicId_clinics_id_fk` FOREIGN KEY (`clinicId`) REFERENCES `clinics`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `providerEscalations` ADD CONSTRAINT `providerEscalations_ccmNoteId_ccmNotes_id_fk` FOREIGN KEY (`ccmNoteId`) REFERENCES `ccmNotes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `providerEscalations` ADD CONSTRAINT `providerEscalations_patientId_patients_id_fk` FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `providerEscalations` ADD CONSTRAINT `providerEscalations_providerId_providers_id_fk` FOREIGN KEY (`providerId`) REFERENCES `providers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `providers` ADD CONSTRAINT `providers_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `providers` ADD CONSTRAINT `providers_clinicId_clinics_id_fk` FOREIGN KEY (`clinicId`) REFERENCES `clinics`(`id`) ON DELETE no action ON UPDATE no action;
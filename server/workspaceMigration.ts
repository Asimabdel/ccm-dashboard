// Workspace module schema — purely ADDITIVE and idempotent: creates 8 new tables
// (IF NOT EXISTS), appends values to the END of two existing enums (read live first,
// nothing removed or reordered), and seeds starter playbooks only when the
// playbooks table is empty. No existing column, row, or patient
// table is modified. Run from the CLI (server/migrateWorkspace.ts) or, since
// production RDS only accepts connections from the Lambda, by directly invoking
// the Lambda with {"__migrate":"workspace"} (see server/_core/lambda.ts).
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { DEFAULT_PLAYBOOKS } from "../shared/workspace";

// Values this module needs on two existing enum columns. The live definition is
// read first and these are only APPENDED after whatever is already there, so an
// existing value is never removed or reordered (see appendEnumValues).
const ENUM_ADDITIONS: { table: string; column: string; values: string[] }[] = [
  { table: "auditLogs", column: "action", values: ["create_task", "update_task", "view_schedule", "import_schedule", "update_appointment", "opportunity_action", "manage_playbook"] },
  { table: "notifications", column: "type", values: ["task"] },
  // Added 2026-09-25: tasks created from patient emails.
  { table: "workTasks", column: "category", values: ["patient_email"] },
  { table: "workTasks", column: "category", values: ["fax_filing"] },
  // Added 2026-09-28: office manager (admin for one office).
  { table: "users", column: "role", values: ["office_manager"] },
  { table: "teamInvites", column: "role", values: ["office_manager"] },
  // Added 2026-09-30: Documents.
  { table: "auditLogs", column: "action", values: ["view_document", "manage_document"] },
  // Added 2026-09-30: Square payments.
  { table: "auditLogs", column: "action", values: ["view_payments", "manage_payment"] },
  // Added 2026-10-01: in-office tests (Testing tab) can be marked scheduled.
  { table: "patientTests", column: "status", values: ["scheduled"] },
];

export const WORKSPACE_STATEMENTS: { label: string; sql: string }[] = [
  { label: "workTasks", sql: `CREATE TABLE IF NOT EXISTS \`workTasks\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`title\` varchar(255) NOT NULL,
    \`description\` text,
    \`patientId\` int,
    \`clinicId\` int,
    \`assignedUserId\` int,
    \`assignedRole\` varchar(40),
    \`priority\` ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
    \`status\` ENUM('open','in_progress','waiting','completed','cancelled') NOT NULL DEFAULT 'open',
    \`category\` ENUM('patient_call','referral','prior_auth','lab_followup','form','medication_request','care_management','rpm','front_desk','provider_request','administrative','other','patient_email','fax_filing') NOT NULL DEFAULT 'other',
    \`dueDate\` varchar(10),
    \`createdByUserId\` int NOT NULL,
    \`completedAt\` datetime,
    \`sourceType\` varchar(40),
    \`sourceRef\` varchar(64),
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`workTasks_assignee_status_idx\` (\`assignedUserId\`, \`status\`),
    INDEX \`workTasks_status_due_idx\` (\`status\`, \`dueDate\`),
    INDEX \`workTasks_patient_idx\` (\`patientId\`),
    CONSTRAINT \`workTasks_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`workTasks_clinicId_fk\` FOREIGN KEY (\`clinicId\`) REFERENCES \`clinics\`(\`id\`),
    CONSTRAINT \`workTasks_assignedUserId_fk\` FOREIGN KEY (\`assignedUserId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`workTasks_createdByUserId_fk\` FOREIGN KEY (\`createdByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "workTaskActivities", sql: `CREATE TABLE IF NOT EXISTS \`workTaskActivities\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`taskId\` int NOT NULL,
    \`userId\` int NOT NULL,
    \`type\` ENUM('created','status_changed','assigned','due_date_changed','priority_changed','comment') NOT NULL,
    \`body\` text,
    \`meta\` json,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    INDEX \`workTaskActivities_task_idx\` (\`taskId\`),
    CONSTRAINT \`workTaskActivities_taskId_fk\` FOREIGN KEY (\`taskId\`) REFERENCES \`workTasks\`(\`id\`),
    CONSTRAINT \`workTaskActivities_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "appointments", sql: `CREATE TABLE IF NOT EXISTS \`appointments\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`clinicId\` int,
    \`patientId\` int,
    \`patientName\` varchar(255) NOT NULL,
    \`dateOfBirth\` datetime,
    \`phoneNumber\` varchar(30),
    \`providerId\` int,
    \`providerName\` varchar(255),
    \`date\` varchar(10) NOT NULL,
    \`startsAt\` datetime NOT NULL,
    \`durationMin\` int NOT NULL DEFAULT 20,
    \`visitType\` varchar(120),
    \`reason\` varchar(255),
    \`status\` ENUM('scheduled','arrived','checked_in','roomed','with_provider','checkout','completed','no_show','cancelled') NOT NULL DEFAULT 'scheduled',
    \`room\` varchar(40),
    \`arrivedAt\` datetime,
    \`checkedInAt\` datetime,
    \`roomedAt\` datetime,
    \`withProviderAt\` datetime,
    \`checkoutAt\` datetime,
    \`completedAt\` datetime,
    \`externalKey\` varchar(64) NOT NULL,
    \`importId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`appointments_externalKey_unique\` (\`externalKey\`),
    INDEX \`appointments_clinic_date_idx\` (\`clinicId\`, \`date\`),
    INDEX \`appointments_patient_idx\` (\`patientId\`),
    INDEX \`appointments_date_status_idx\` (\`date\`, \`status\`),
    CONSTRAINT \`appointments_clinicId_fk\` FOREIGN KEY (\`clinicId\`) REFERENCES \`clinics\`(\`id\`),
    CONSTRAINT \`appointments_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`appointments_providerId_fk\` FOREIGN KEY (\`providerId\`) REFERENCES \`providers\`(\`id\`))` },
  { label: "appointmentStatusEvents", sql: `CREATE TABLE IF NOT EXISTS \`appointmentStatusEvents\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`appointmentId\` int NOT NULL,
    \`fromStatus\` varchar(20) NOT NULL,
    \`toStatus\` varchar(20) NOT NULL,
    \`changedByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    INDEX \`appointmentStatusEvents_appt_idx\` (\`appointmentId\`),
    CONSTRAINT \`appointmentStatusEvents_appointmentId_fk\` FOREIGN KEY (\`appointmentId\`) REFERENCES \`appointments\`(\`id\`),
    CONSTRAINT \`appointmentStatusEvents_changedByUserId_fk\` FOREIGN KEY (\`changedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "scheduleImports", sql: `CREATE TABLE IF NOT EXISTS \`scheduleImports\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`fileName\` varchar(255),
    \`importedByUserId\` int NOT NULL,
    \`firstDate\` varchar(10),
    \`lastDate\` varchar(10),
    \`rowCount\` int NOT NULL DEFAULT 0,
    \`createdCount\` int NOT NULL DEFAULT 0,
    \`updatedCount\` int NOT NULL DEFAULT 0,
    \`linkedCount\` int NOT NULL DEFAULT 0,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    CONSTRAINT \`scheduleImports_importedByUserId_fk\` FOREIGN KEY (\`importedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "opportunityActions", sql: `CREATE TABLE IF NOT EXISTS \`opportunityActions\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`patientId\` int,
    \`subjectKey\` varchar(120),
    \`category\` varchar(40) NOT NULL,
    \`action\` ENUM('reviewed','task_created','dismissed') NOT NULL,
    \`userId\` int NOT NULL,
    \`taskId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    INDEX \`opportunityActions_patient_cat_idx\` (\`patientId\`, \`category\`),
    INDEX \`opportunityActions_subject_cat_idx\` (\`subjectKey\`, \`category\`),
    CONSTRAINT \`opportunityActions_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`opportunityActions_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "playbooks", sql: `CREATE TABLE IF NOT EXISTS \`playbooks\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`slug\` varchar(120) NOT NULL,
    \`title\` varchar(255) NOT NULL,
    \`category\` varchar(80) NOT NULL,
    \`description\` text,
    \`ownerUserId\` int,
    \`currentVersion\` int NOT NULL DEFAULT 1,
    \`archived\` boolean NOT NULL DEFAULT false,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`playbooks_slug_unique\` (\`slug\`),
    CONSTRAINT \`playbooks_ownerUserId_fk\` FOREIGN KEY (\`ownerUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "playbookVersions", sql: `CREATE TABLE IF NOT EXISTS \`playbookVersions\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`playbookId\` int NOT NULL,
    \`version\` int NOT NULL,
    \`steps\` json NOT NULL,
    \`changeNote\` varchar(255),
    \`createdByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    INDEX \`playbookVersions_playbook_idx\` (\`playbookId\`),
    CONSTRAINT \`playbookVersions_playbookId_fk\` FOREIGN KEY (\`playbookId\`) REFERENCES \`playbooks\`(\`id\`),
    CONSTRAINT \`playbookVersions_createdByUserId_fk\` FOREIGN KEY (\`createdByUserId\`) REFERENCES \`users\`(\`id\`))` },
  // Added 2026-09-25: testing & screenings.
  { label: "patientTests", sql: `CREATE TABLE IF NOT EXISTS \`patientTests\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`subjectKey\` varchar(120) NOT NULL,
    \`patientId\` int,
    \`testKey\` varchar(40) NOT NULL,
    \`method\` varchar(40),
    \`performedOn\` varchar(10) NOT NULL,
    \`status\` ENUM('done','not_applicable','declined') NOT NULL DEFAULT 'done',
    \`result\` varchar(120),
    \`note\` text,
    \`source\` varchar(20) NOT NULL,
    \`createdByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    INDEX \`patientTests_subject_idx\` (\`subjectKey\`),
    UNIQUE KEY \`patientTests_one_record\` (\`subjectKey\`, \`testKey\`, \`performedOn\`, \`status\`),
    CONSTRAINT \`patientTests_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`patientTests_createdByUserId_fk\` FOREIGN KEY (\`createdByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "personDemographics", sql: `CREATE TABLE IF NOT EXISTS \`personDemographics\` (
    \`subjectKey\` varchar(120) PRIMARY KEY,
    \`patientId\` int,
    \`sex\` ENUM('F','M','X'),
    \`source\` varchar(20) NOT NULL,
    \`updatedByUserId\` int,
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT \`personDemographics_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`personDemographics_updatedByUserId_fk\` FOREIGN KEY (\`updatedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  // Added 2026-09-25: the practice mailbox (Gmail) — processed emails + known addresses.
  { label: "emailMessages", sql: `CREATE TABLE IF NOT EXISTS \`emailMessages\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`gmailId\` varchar(64) NOT NULL,
    \`threadId\` varchar(64),
    \`messageIdHeader\` varchar(255),
    \`fromEmail\` varchar(320),
    \`fromName\` varchar(255),
    \`subject\` varchar(255),
    \`preview\` text,
    \`receivedAt\` datetime NOT NULL,
    \`patientId\` int,
    \`subjectKey\` varchar(120),
    \`patientName\` varchar(255),
    \`matchMethod\` varchar(20),
    \`status\` ENUM('assigned','needs_patient','ignored') NOT NULL,
    \`taskId\` int,
    \`assignedUserId\` int,
    \`historical\` boolean NOT NULL DEFAULT false,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    UNIQUE KEY \`emailMessages_gmailId_unique\` (\`gmailId\`),
    INDEX \`emailMessages_status_idx\` (\`status\`, \`receivedAt\`),
    INDEX \`emailMessages_from_idx\` (\`fromEmail\`),
    CONSTRAINT \`emailMessages_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`emailMessages_assignedUserId_fk\` FOREIGN KEY (\`assignedUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "bookingRequests", sql: `CREATE TABLE IF NOT EXISTS \`bookingRequests\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`receivedAt\` datetime NOT NULL,
    \`source\` varchar(20) NOT NULL,
    \`name\` varchar(120) NOT NULL,
    \`phone\` varchar(30) NOT NULL,
    \`phoneKey\` varchar(10),
    \`location\` varchar(60),
    \`clinicId\` int,
    \`provider\` varchar(80),
    \`visitType\` varchar(80),
    \`preferred\` varchar(100),
    \`preferredDate\` varchar(10),
    \`spanish\` boolean NOT NULL DEFAULT false,
    \`status\` ENUM('new','no_answer','scheduled','not_booked','spam','earlier') NOT NULL,
    \`attempts\` int NOT NULL DEFAULT 0,
    \`subjectKey\` varchar(120),
    \`patientId\` int,
    \`patientName\` varchar(255),
    \`taskId\` int,
    \`assignedUserId\` int,
    \`firstContactAt\` datetime,
    \`handledByUserId\` int,
    \`handledAt\` datetime,
    \`note\` text,
    \`gmailId\` varchar(64),
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    UNIQUE KEY \`bookingRequests_gmailId_unique\` (\`gmailId\`),
    INDEX \`bookingRequests_status_idx\` (\`status\`, \`receivedAt\`),
    CONSTRAINT \`bookingRequests_clinicId_fk\` FOREIGN KEY (\`clinicId\`) REFERENCES \`clinics\`(\`id\`),
    CONSTRAINT \`bookingRequests_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`))` },
  { label: "intakeDocuments", sql: `CREATE TABLE IF NOT EXISTS \`intakeDocuments\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`title\` json NOT NULL,
    \`body\` json NOT NULL,
    \`version\` int NOT NULL DEFAULT 1,
    \`active\` boolean NOT NULL DEFAULT true,
    \`sortOrder\` int NOT NULL DEFAULT 0,
    \`updatedByUserId\` int,
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    CONSTRAINT \`intakeDocuments_updatedByUserId_fk\` FOREIGN KEY (\`updatedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "intakePackets", sql: `CREATE TABLE IF NOT EXISTS \`intakePackets\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`tokenHash\` varchar(64) NOT NULL,
    \`tokenSealed\` text NOT NULL,
    \`subjectKey\` varchar(120),
    \`patientId\` int,
    \`name\` varchar(255) NOT NULL,
    \`dob\` varchar(10) NOT NULL,
    \`phone\` varchar(30),
    \`email\` varchar(320),
    \`language\` varchar(2) NOT NULL DEFAULT 'en',
    \`forms\` json NOT NULL,
    \`clinicId\` int,
    \`status\` ENUM('waiting','opened','in_progress','completed','filed','cancelled') NOT NULL DEFAULT 'waiting',
    \`sentVia\` varchar(10),
    \`sentAt\` datetime,
    \`sendCount\` int NOT NULL DEFAULT 0,
    \`openedAt\` datetime,
    \`completedAt\` datetime,
    \`expiresAt\` datetime NOT NULL,
    \`failedDobAttempts\` int NOT NULL DEFAULT 0,
    \`lockedUntil\` datetime,
    \`answers\` json,
    \`taskId\` int,
    \`bookingRequestId\` int,
    \`filedAt\` datetime,
    \`filedByUserId\` int,
    \`createdByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`intakePackets_tokenHash_unique\` (\`tokenHash\`),
    INDEX \`intakePackets_status_idx\` (\`status\`, \`createdAt\`),
    INDEX \`intakePackets_subject_idx\` (\`subjectKey\`),
    CONSTRAINT \`intakePackets_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`intakePackets_clinicId_fk\` FOREIGN KEY (\`clinicId\`) REFERENCES \`clinics\`(\`id\`),
    CONSTRAINT \`intakePackets_filedByUserId_fk\` FOREIGN KEY (\`filedByUserId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`intakePackets_createdByUserId_fk\` FOREIGN KEY (\`createdByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "intakeSignatures", sql: `CREATE TABLE IF NOT EXISTS \`intakeSignatures\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`packetId\` int NOT NULL,
    \`formKey\` varchar(40) NOT NULL,
    \`formTitle\` varchar(255) NOT NULL,
    \`language\` varchar(2) NOT NULL,
    \`formVersion\` int NOT NULL,
    \`snapshot\` mediumtext NOT NULL,
    \`textHash\` varchar(64) NOT NULL,
    \`signerName\` varchar(160) NOT NULL,
    \`signerRelation\` varchar(20) NOT NULL,
    \`method\` varchar(10) NOT NULL,
    \`signatureFileId\` int,
    \`signedAt\` datetime NOT NULL,
    \`ip\` varchar(64),
    \`userAgent\` varchar(255),
    \`docHash\` varchar(64) NOT NULL,
    UNIQUE KEY \`intakeSignatures_packet_form_unique\` (\`packetId\`, \`formKey\`),
    CONSTRAINT \`intakeSignatures_packetId_fk\` FOREIGN KEY (\`packetId\`) REFERENCES \`intakePackets\`(\`id\`))` },
  { label: "intakeFiles", sql: `CREATE TABLE IF NOT EXISTS \`intakeFiles\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`packetId\` int NOT NULL,
    \`kind\` varchar(30) NOT NULL,
    \`mime\` varchar(40) NOT NULL,
    \`data\` mediumtext NOT NULL,
    \`size\` int NOT NULL,
    \`sha256\` varchar(64) NOT NULL,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    INDEX \`intakeFiles_packet_idx\` (\`packetId\`),
    CONSTRAINT \`intakeFiles_packetId_fk\` FOREIGN KEY (\`packetId\`) REFERENCES \`intakePackets\`(\`id\`))` },
  { label: "intakeEvents", sql: `CREATE TABLE IF NOT EXISTS \`intakeEvents\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`packetId\` int NOT NULL,
    \`at\` datetime NOT NULL,
    \`type\` varchar(30) NOT NULL,
    \`userId\` int,
    \`ip\` varchar(64),
    \`userAgent\` varchar(255),
    \`detail\` varchar(255),
    INDEX \`intakeEvents_packet_idx\` (\`packetId\`, \`at\`),
    CONSTRAINT \`intakeEvents_packetId_fk\` FOREIGN KEY (\`packetId\`) REFERENCES \`intakePackets\`(\`id\`),
    CONSTRAINT \`intakeEvents_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "consentEnrollments", sql: `CREATE TABLE IF NOT EXISTS \`consentEnrollments\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`subjectKey\` varchar(120),
    \`patientId\` int,
    \`name\` varchar(255) NOT NULL,
    \`dob\` varchar(10),
    \`program\` varchar(10) NOT NULL,
    \`status\` varchar(12) NOT NULL DEFAULT 'waiting',
    \`packetId\` int,
    \`consentedAt\` datetime NOT NULL,
    \`enrolledAt\` datetime,
    \`lastCheckedAt\` datetime,
    \`note\` varchar(255),
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`consentEnrollments_status_idx\` (\`status\`),
    INDEX \`consentEnrollments_subject_idx\` (\`subjectKey\`),
    CONSTRAINT \`consentEnrollments_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`consentEnrollments_packetId_fk\` FOREIGN KEY (\`packetId\`) REFERENCES \`intakePackets\`(\`id\`))` },
  // Documents (our own DocuSign), added 2026-09-30.
  { label: "documents", sql: `CREATE TABLE IF NOT EXISTS \`documents\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`title\` varchar(255) NOT NULL,
    \`isTemplate\` boolean NOT NULL DEFAULT false,
    \`templateId\` int,
    \`status\` varchar(12) NOT NULL DEFAULT 'draft',
    \`fileKey\` varchar(255),
    \`fileName\` varchar(255),
    \`fileSize\` int,
    \`fileSha256\` varchar(64),
    \`pages\` json,
    \`fields\` json,
    \`finalKey\` varchar(255),
    \`finalSha256\` varchar(64),
    \`subjectKey\` varchar(120),
    \`patientId\` int,
    \`clinicId\` int,
    \`message\` varchar(1000),
    \`createdByUserId\` int NOT NULL,
    \`updatedByUserId\` int,
    \`sentAt\` datetime,
    \`completedAt\` datetime,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`documents_status_idx\` (\`status\`, \`updatedAt\`),
    INDEX \`documents_creator_idx\` (\`createdByUserId\`, \`status\`),
    INDEX \`documents_subject_idx\` (\`subjectKey\`),
    CONSTRAINT \`documents_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`documents_clinicId_fk\` FOREIGN KEY (\`clinicId\`) REFERENCES \`clinics\`(\`id\`),
    CONSTRAINT \`documents_createdByUserId_fk\` FOREIGN KEY (\`createdByUserId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`documents_updatedByUserId_fk\` FOREIGN KEY (\`updatedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "documentSigners", sql: `CREATE TABLE IF NOT EXISTS \`documentSigners\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`documentId\` int NOT NULL,
    \`userId\` int NOT NULL,
    \`sortOrder\` int NOT NULL DEFAULT 0,
    \`status\` varchar(10) NOT NULL DEFAULT 'pending',
    \`taskId\` int,
    \`signedAt\` datetime,
    \`ip\` varchar(64),
    \`userAgent\` varchar(255),
    INDEX \`documentSigners_user_idx\` (\`userId\`, \`status\`),
    INDEX \`documentSigners_doc_idx\` (\`documentId\`),
    CONSTRAINT \`documentSigners_documentId_fk\` FOREIGN KEY (\`documentId\`) REFERENCES \`documents\`(\`id\`),
    CONSTRAINT \`documentSigners_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "documentSignatures", sql: `CREATE TABLE IF NOT EXISTS \`documentSignatures\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`documentId\` int NOT NULL,
    \`fieldId\` varchar(40) NOT NULL,
    \`userId\` int NOT NULL,
    \`kind\` varchar(10) NOT NULL,
    \`png\` mediumtext NOT NULL,
    \`sha256\` varchar(64) NOT NULL,
    \`signedAt\` datetime NOT NULL,
    \`ip\` varchar(64),
    \`userAgent\` varchar(255),
    INDEX \`documentSignatures_doc_idx\` (\`documentId\`),
    CONSTRAINT \`documentSignatures_documentId_fk\` FOREIGN KEY (\`documentId\`) REFERENCES \`documents\`(\`id\`),
    CONSTRAINT \`documentSignatures_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "documentEvents", sql: `CREATE TABLE IF NOT EXISTS \`documentEvents\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`documentId\` int NOT NULL,
    \`at\` datetime NOT NULL,
    \`type\` varchar(30) NOT NULL,
    \`userId\` int,
    \`ip\` varchar(64),
    \`userAgent\` varchar(255),
    \`detail\` varchar(255),
    INDEX \`documentEvents_doc_idx\` (\`documentId\`, \`at\`),
    CONSTRAINT \`documentEvents_documentId_fk\` FOREIGN KEY (\`documentId\`) REFERENCES \`documents\`(\`id\`),
    CONSTRAINT \`documentEvents_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "userSignatures", sql: `CREATE TABLE IF NOT EXISTS \`userSignatures\` (
    \`userId\` int NOT NULL PRIMARY KEY,
    \`signaturePng\` mediumtext,
    \`initialsPng\` mediumtext,
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT \`userSignatures_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`))` },
  // Provider signatures staff may apply with the provider's approval, added 2026-09-30.
  { label: "providerSignatures", sql: `CREATE TABLE IF NOT EXISTS \`providerSignatures\` (
    \`providerUserId\` int NOT NULL PRIMARY KEY,
    \`signaturePng\` mediumtext,
    \`initialsPng\` mediumtext,
    \`enabled\` boolean NOT NULL DEFAULT true,
    \`updatedByUserId\` int,
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT \`providerSignatures_providerUserId_fk\` FOREIGN KEY (\`providerUserId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`providerSignatures_updatedByUserId_fk\` FOREIGN KEY (\`updatedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "providerSignatureDelegates", sql: `CREATE TABLE IF NOT EXISTS \`providerSignatureDelegates\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`providerUserId\` int NOT NULL,
    \`delegateUserId\` int NOT NULL,
    \`createdByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    UNIQUE KEY \`providerSignatureDelegates_pair_unique\` (\`providerUserId\`, \`delegateUserId\`),
    INDEX \`providerSignatureDelegates_delegate_idx\` (\`delegateUserId\`),
    CONSTRAINT \`providerSignatureDelegates_providerUserId_fk\` FOREIGN KEY (\`providerUserId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`providerSignatureDelegates_delegateUserId_fk\` FOREIGN KEY (\`delegateUserId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`providerSignatureDelegates_createdByUserId_fk\` FOREIGN KEY (\`createdByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "coverageOnFile", sql: `CREATE TABLE IF NOT EXISTS \`coverageOnFile\` (
    \`subjectKey\` varchar(120) NOT NULL PRIMARY KEY,
    \`patientId\` int,
    \`payerId\` varchar(40) NOT NULL,
    \`payerName\` varchar(160),
    \`memberId\` varchar(60) NOT NULL,
    \`groupNumber\` varchar(60),
    \`source\` varchar(20) NOT NULL,
    \`updatedByUserId\` int,
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT \`coverageOnFile_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`coverageOnFile_updatedByUserId_fk\` FOREIGN KEY (\`updatedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "eligibilityChecks", sql: `CREATE TABLE IF NOT EXISTS \`eligibilityChecks\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`subjectKey\` varchar(120) NOT NULL,
    \`patientId\` int,
    \`patientName\` varchar(255),
    \`payerId\` varchar(40) NOT NULL,
    \`payerName\` varchar(160),
    \`memberId\` varchar(60) NOT NULL,
    \`asOfDate\` varchar(10) NOT NULL,
    \`trigger\` varchar(10) NOT NULL,
    \`mode\` varchar(12) NOT NULL,
    \`clinicId\` int,
    \`availityId\` varchar(64),
    \`status\` ENUM('pending','complete','error') NOT NULL DEFAULT 'pending',
    \`statusCode\` varchar(4),
    \`summary\` json,
    \`raw\` mediumtext,
    \`error\` varchar(500),
    \`requestedByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`eligibilityChecks_subject_idx\` (\`subjectKey\`, \`createdAt\`),
    INDEX \`eligibilityChecks_date_idx\` (\`asOfDate\`, \`trigger\`),
    INDEX \`eligibilityChecks_status_idx\` (\`status\`, \`createdAt\`),
    CONSTRAINT \`eligibilityChecks_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`eligibilityChecks_clinicId_fk\` FOREIGN KEY (\`clinicId\`) REFERENCES \`clinics\`(\`id\`),
    CONSTRAINT \`eligibilityChecks_requestedByUserId_fk\` FOREIGN KEY (\`requestedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "fhirPatients", sql: `CREATE TABLE IF NOT EXISTS \`fhirPatients\` (
    \`fhirId\` varchar(128) NOT NULL PRIMARY KEY,
    \`subjectKey\` varchar(120) NOT NULL,
    \`patientId\` int,
    \`name\` varchar(255),
    \`dob\` varchar(10),
    \`sex\` ENUM('F','M','X'),
    \`phone\` varchar(40),
    \`email\` varchar(320),
    \`address\` varchar(255),
    \`mrn\` varchar(64),
    \`syncedAt\` datetime NOT NULL,
    INDEX \`fhirPatients_subject_idx\` (\`subjectKey\`),
    INDEX \`fhirPatients_name_idx\` (\`name\`),
    CONSTRAINT \`fhirPatients_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`))` },
  { label: "fhirResources", sql: `CREATE TABLE IF NOT EXISTS \`fhirResources\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`resourceType\` varchar(40) NOT NULL,
    \`section\` varchar(60) NOT NULL,
    \`fhirId\` varchar(128) NOT NULL,
    \`patientFhirId\` varchar(128),
    \`subjectKey\` varchar(120),
    \`title\` varchar(255),
    \`value\` varchar(255),
    \`status\` varchar(40),
    \`date\` varchar(10),
    \`code\` varchar(80),
    \`raw\` mediumtext,
    \`lastUpdated\` datetime,
    \`syncedAt\` datetime NOT NULL,
    UNIQUE KEY \`fhirResources_type_id_unique\` (\`resourceType\`, \`fhirId\`),
    INDEX \`fhirResources_subject_idx\` (\`subjectKey\`, \`section\`, \`date\`),
    INDEX \`fhirResources_synced_idx\` (\`syncedAt\`),
    INDEX \`fhirResources_section_idx\` (\`section\`, \`subjectKey\`))` },
  { label: "faxes", sql: `CREATE TABLE IF NOT EXISTS \`faxes\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`mailbox\` varchar(10) NOT NULL,
    \`gmailId\` varchar(64) NOT NULL,
    \`threadId\` varchar(64),
    \`messageIdHeader\` varchar(255),
    \`fromEmail\` varchar(320),
    \`fromName\` varchar(255),
    \`fromNumber\` varchar(20),
    \`subject\` varchar(255),
    \`receivedAt\` datetime NOT NULL,
    \`attachmentId\` text,
    \`filename\` varchar(255),
    \`mimeType\` varchar(80),
    \`sizeBytes\` int,
    \`pages\` int,
    \`status\` ENUM('new','needs_patient','to_file','filed','not_patient') NOT NULL,
    \`docType\` varchar(30),
    \`aiPatientName\` varchar(255),
    \`aiDob\` varchar(10),
    \`aiSender\` varchar(255),
    \`aiSummary\` varchar(255),
    \`aiError\` varchar(255),
    \`aiAt\` datetime,
    \`suggestedKey\` varchar(120),
    \`suggestedName\` varchar(255),
    \`subjectKey\` varchar(120),
    \`patientId\` int,
    \`patientName\` varchar(255),
    \`matchMethod\` varchar(20),
    \`taskId\` int,
    \`filedByUserId\` int,
    \`filedAt\` datetime,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    UNIQUE KEY \`faxes_gmailId_unique\` (\`gmailId\`),
    INDEX \`faxes_status_idx\` (\`status\`, \`receivedAt\`),
    CONSTRAINT \`faxes_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`faxes_filedByUserId_fk\` FOREIGN KEY (\`filedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "rcCallStats", sql: `CREATE TABLE IF NOT EXISTS \`rcCallStats\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`rcId\` varchar(120) NOT NULL,
    \`startedAt\` datetime NOT NULL,
    \`workDate\` varchar(10) NOT NULL,
    \`direction\` ENUM('outbound','inbound') NOT NULL,
    \`durationSec\` int NOT NULL DEFAULT 0,
    \`result\` varchar(60),
    \`answered\` boolean NOT NULL DEFAULT false,
    \`missed\` boolean NOT NULL DEFAULT false,
    \`extensionId\` varchar(40),
    \`extensionName\` varchar(120),
    \`extensionEmail\` varchar(320),
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    UNIQUE KEY \`rcCallStats_rcId_unique\` (\`rcId\`),
    INDEX \`rcCallStats_date_idx\` (\`workDate\`),
    INDEX \`rcCallStats_ext_date_idx\` (\`extensionId\`, \`workDate\`))` },
  { label: "emailContacts", sql: `CREATE TABLE IF NOT EXISTS \`emailContacts\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`email\` varchar(320) NOT NULL,
    \`kind\` ENUM('patient','ignore') NOT NULL,
    \`patientId\` int,
    \`subjectKey\` varchar(120),
    \`name\` varchar(255),
    \`source\` varchar(20) NOT NULL,
    \`createdByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    UNIQUE KEY \`emailContacts_email_unique\` (\`email\`),
    CONSTRAINT \`emailContacts_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`emailContacts_createdByUserId_fk\` FOREIGN KEY (\`createdByUserId\`) REFERENCES \`users\`(\`id\`))` },
  // Added 2026-09-25: RingCentral connection settings + the call log.
  { label: "appSettings", sql: `CREATE TABLE IF NOT EXISTS \`appSettings\` (
    \`key\` varchar(80) PRIMARY KEY,
    \`value\` json NOT NULL,
    \`updatedByUserId\` int,
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT \`appSettings_updatedByUserId_fk\` FOREIGN KEY (\`updatedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "phoneCalls", sql: `CREATE TABLE IF NOT EXISTS \`phoneCalls\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`userId\` int NOT NULL,
    \`direction\` ENUM('outbound','inbound') NOT NULL,
    \`phoneNumber\` varchar(20) NOT NULL,
    \`patientId\` int,
    \`subjectKey\` varchar(120),
    \`contactName\` varchar(255),
    \`startedAt\` datetime NOT NULL,
    \`durationSec\` int NOT NULL DEFAULT 0,
    \`result\` varchar(60),
    \`outcome\` varchar(30),
    \`note\` text,
    \`source\` varchar(40),
    \`rcSessionId\` varchar(120),
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    UNIQUE KEY \`phoneCalls_rcSessionId_unique\` (\`rcSessionId\`),
    INDEX \`phoneCalls_phone_idx\` (\`phoneNumber\`),
    INDEX \`phoneCalls_patient_idx\` (\`patientId\`),
    INDEX \`phoneCalls_subject_idx\` (\`subjectKey\`),
    CONSTRAINT \`phoneCalls_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`phoneCalls_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`))` },
  // Patient folders (added 2026-09-30): files staff put in a patient's folder.
  { label: "patientFiles", sql: `CREATE TABLE IF NOT EXISTS \`patientFiles\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`subjectKey\` varchar(120) NOT NULL,
    \`patientId\` int,
    \`clinicId\` int,
    \`fileType\` varchar(24) NOT NULL,
    \`title\` varchar(255) NOT NULL,
    \`note\` varchar(500),
    \`storageKey\` varchar(200) NOT NULL,
    \`fileName\` varchar(255),
    \`mimeType\` varchar(80) NOT NULL,
    \`sizeBytes\` int,
    \`status\` varchar(12) NOT NULL DEFAULT 'uploading',
    \`uploadedByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`removedAt\` datetime,
    \`removedByUserId\` int,
    INDEX \`patientFiles_subject_idx\` (\`subjectKey\`, \`createdAt\`),
    INDEX \`patientFiles_patient_idx\` (\`patientId\`),
    CONSTRAINT \`patientFiles_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`patientFiles_clinicId_fk\` FOREIGN KEY (\`clinicId\`) REFERENCES \`clinics\`(\`id\`),
    CONSTRAINT \`patientFiles_uploadedByUserId_fk\` FOREIGN KEY (\`uploadedByUserId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`patientFiles_removedByUserId_fk\` FOREIGN KEY (\`removedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  // Program suggestions from diagnoses, waiting for an approver (added 2026-10-01).
  { label: "programSuggestions", sql: `CREATE TABLE IF NOT EXISTS \`programSuggestions\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`subjectKey\` varchar(120) NOT NULL,
    \`patientId\` int,
    \`name\` varchar(255) NOT NULL,
    \`dob\` varchar(10),
    \`clinicId\` int,
    \`program\` varchar(10) NOT NULL,
    \`status\` varchar(12) NOT NULL DEFAULT 'pending',
    \`reason\` varchar(500) NOT NULL,
    \`diagnoses\` json,
    \`fingerprint\` varchar(255) NOT NULL,
    \`lastVisit\` varchar(10),
    \`decidedByUserId\` int,
    \`decidedAt\` datetime,
    \`decisionNote\` varchar(255),
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`programSuggestions_status_idx\` (\`status\`, \`clinicId\`),
    INDEX \`programSuggestions_subject_idx\` (\`subjectKey\`, \`program\`),
    CONSTRAINT \`programSuggestions_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`programSuggestions_clinicId_fk\` FOREIGN KEY (\`clinicId\`) REFERENCES \`clinics\`(\`id\`),
    CONSTRAINT \`programSuggestions_decidedByUserId_fk\` FOREIGN KEY (\`decidedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  // Latest smoking status and BMI per Practice Fusion chart (added 2026-10-01, Testing tab).
  { label: "chartFacts", sql: `CREATE TABLE IF NOT EXISTS \`chartFacts\` (
    \`patientFhirId\` varchar(128) NOT NULL PRIMARY KEY,
    \`smokingValue\` varchar(160),
    \`smokingDate\` varchar(10),
    \`bmiValue\` varchar(60),
    \`bmiDate\` varchar(10),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP)` },
  // Provider teams (added 2026-09-30): who gets a provider's patient emails.
  { label: "providerTeamMembers", sql: `CREATE TABLE IF NOT EXISTS \`providerTeamMembers\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`providerId\` int NOT NULL,
    \`userId\` int NOT NULL,
    \`createdByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    UNIQUE KEY \`providerTeamMembers_pair_unique\` (\`providerId\`, \`userId\`),
    INDEX \`providerTeamMembers_user_idx\` (\`userId\`),
    CONSTRAINT \`providerTeamMembers_providerId_fk\` FOREIGN KEY (\`providerId\`) REFERENCES \`providers\`(\`id\`),
    CONSTRAINT \`providerTeamMembers_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`providerTeamMembers_createdByUserId_fk\` FOREIGN KEY (\`createdByUserId\`) REFERENCES \`users\`(\`id\`))` },
  // Square payments (added 2026-09-30).
  { label: "squareCustomers", sql: `CREATE TABLE IF NOT EXISTS \`squareCustomers\` (
    \`id\` varchar(64) NOT NULL PRIMARY KEY,
    \`givenName\` varchar(120),
    \`familyName\` varchar(120),
    \`phone\` varchar(40),
    \`email\` varchar(320),
    \`subjectKey\` varchar(120),
    \`patientName\` varchar(255),
    \`matchedBy\` varchar(12),
    \`suggestKey\` varchar(120),
    \`suggestName\` varchar(255),
    \`syncedAt\` datetime NOT NULL,
    INDEX \`squareCustomers_subject_idx\` (\`subjectKey\`))` },
  { label: "squarePayments", sql: `CREATE TABLE IF NOT EXISTS \`squarePayments\` (
    \`id\` varchar(64) NOT NULL PRIMARY KEY,
    \`createdAt\` datetime NOT NULL,
    \`updatedAtSq\` datetime,
    \`status\` varchar(20) NOT NULL,
    \`sourceType\` varchar(30),
    \`amountCents\` int NOT NULL DEFAULT 0,
    \`tipCents\` int NOT NULL DEFAULT 0,
    \`totalCents\` int NOT NULL DEFAULT 0,
    \`refundedCents\` int NOT NULL DEFAULT 0,
    \`feeCents\` int NOT NULL DEFAULT 0,
    \`cardBrand\` varchar(30),
    \`cardLast4\` varchar(4),
    \`customerId\` varchar(64),
    \`orderId\` varchar(64),
    \`locationId\` varchar(64),
    \`deviceId\` varchar(64),
    \`deviceName\` varchar(120),
    \`teamMemberId\` varchar(64),
    \`items\` varchar(500),
    \`note\` varchar(500),
    \`receiptUrl\` varchar(500),
    \`receiptNumber\` varchar(20),
    \`category\` varchar(20),
    \`categorySource\` varchar(10),
    \`subjectKey\` varchar(120),
    \`patientId\` int,
    \`patientName\` varchar(255),
    \`matchSource\` varchar(10),
    \`clinicId\` int,
    \`clinicSource\` varchar(10),
    \`requestId\` int,
    \`memo\` varchar(500),
    \`linkedByUserId\` int,
    \`linkedAt\` datetime,
    \`syncedAt\` datetime NOT NULL,
    INDEX \`squarePayments_created_idx\` (\`createdAt\`),
    INDEX \`squarePayments_subject_idx\` (\`subjectKey\`, \`createdAt\`),
    INDEX \`squarePayments_customer_idx\` (\`customerId\`),
    INDEX \`squarePayments_order_idx\` (\`orderId\`),
    INDEX \`squarePayments_clinic_idx\` (\`clinicId\`, \`createdAt\`),
    INDEX \`squarePayments_device_idx\` (\`deviceId\`),
    CONSTRAINT \`squarePayments_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`squarePayments_clinicId_fk\` FOREIGN KEY (\`clinicId\`) REFERENCES \`clinics\`(\`id\`),
    CONSTRAINT \`squarePayments_linkedByUserId_fk\` FOREIGN KEY (\`linkedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "squareRefunds", sql: `CREATE TABLE IF NOT EXISTS \`squareRefunds\` (
    \`id\` varchar(64) NOT NULL PRIMARY KEY,
    \`paymentId\` varchar(64) NOT NULL,
    \`status\` varchar(20) NOT NULL,
    \`amountCents\` int NOT NULL DEFAULT 0,
    \`reason\` varchar(255),
    \`createdAt\` datetime NOT NULL,
    \`syncedAt\` datetime NOT NULL,
    INDEX \`squareRefunds_payment_idx\` (\`paymentId\`),
    INDEX \`squareRefunds_created_idx\` (\`createdAt\`))` },
  { label: "squareRequests", sql: `CREATE TABLE IF NOT EXISTS \`squareRequests\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`kind\` ENUM('link','terminal') NOT NULL,
    \`squareId\` varchar(64),
    \`orderId\` varchar(64),
    \`url\` varchar(500),
    \`amountCents\` int NOT NULL,
    \`category\` varchar(20) NOT NULL,
    \`purpose\` varchar(255),
    \`subjectKey\` varchar(120),
    \`patientId\` int,
    \`patientName\` varchar(255),
    \`clinicId\` int,
    \`deviceId\` varchar(64),
    \`status\` varchar(12) NOT NULL DEFAULT 'open',
    \`squareStatus\` varchar(24),
    \`paymentId\` varchar(64),
    \`sentVia\` varchar(8),
    \`sentTo\` varchar(64),
    \`createdByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    \`paidAt\` datetime,
    INDEX \`squareRequests_subject_idx\` (\`subjectKey\`, \`createdAt\`),
    INDEX \`squareRequests_status_idx\` (\`status\`, \`createdAt\`),
    INDEX \`squareRequests_order_idx\` (\`orderId\`),
    INDEX \`squareRequests_square_idx\` (\`squareId\`),
    CONSTRAINT \`squareRequests_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`squareRequests_clinicId_fk\` FOREIGN KEY (\`clinicId\`) REFERENCES \`clinics\`(\`id\`),
    CONSTRAINT \`squareRequests_createdByUserId_fk\` FOREIGN KEY (\`createdByUserId\`) REFERENCES \`users\`(\`id\`))` },
  // Condition library, CCM care plans and patient education (added 2026-10-01).
  { label: "conditionContent", sql: `CREATE TABLE IF NOT EXISTS \`conditionContent\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`conditionKey\` varchar(40) NOT NULL,
    \`content\` json NOT NULL,
    \`status\` varchar(12) NOT NULL DEFAULT 'draft',
    \`version\` int NOT NULL DEFAULT 1,
    \`approvedByUserId\` int,
    \`approvedByName\` varchar(255),
    \`approvedAt\` datetime,
    \`updatedByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`conditionContent_conditionKey_unique\` (\`conditionKey\`),
    CONSTRAINT \`conditionContent_approvedByUserId_fk\` FOREIGN KEY (\`approvedByUserId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`conditionContent_updatedByUserId_fk\` FOREIGN KEY (\`updatedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "conditionContentHistory", sql: `CREATE TABLE IF NOT EXISTS \`conditionContentHistory\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`conditionKey\` varchar(40) NOT NULL,
    \`version\` int NOT NULL,
    \`content\` json NOT NULL,
    \`approvedByUserId\` int,
    \`approvedByName\` varchar(255),
    \`approvedAt\` datetime NOT NULL,
    INDEX \`conditionContentHistory_key_idx\` (\`conditionKey\`, \`version\`),
    CONSTRAINT \`conditionContentHistory_approvedByUserId_fk\` FOREIGN KEY (\`approvedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "patientCarePlans", sql: `CREATE TABLE IF NOT EXISTS \`patientCarePlans\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`patientId\` int NOT NULL,
    \`problems\` json NOT NULL,
    \`general\` json NOT NULL,
    \`version\` int NOT NULL DEFAULT 1,
    \`signedVersion\` int,
    \`signedByUserId\` int,
    \`signedByName\` varchar(255),
    \`signedAt\` datetime,
    \`lastReviewedAt\` datetime,
    \`lastReviewedByUserId\` int,
    \`lastReviewedMonth\` varchar(7),
    \`createdByUserId\` int,
    \`updatedByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`patientCarePlans_patientId_unique\` (\`patientId\`),
    CONSTRAINT \`patientCarePlans_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`patientCarePlans_signedByUserId_fk\` FOREIGN KEY (\`signedByUserId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`patientCarePlans_lastReviewedByUserId_fk\` FOREIGN KEY (\`lastReviewedByUserId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`patientCarePlans_createdByUserId_fk\` FOREIGN KEY (\`createdByUserId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`patientCarePlans_updatedByUserId_fk\` FOREIGN KEY (\`updatedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "patientCarePlanSignatures", sql: `CREATE TABLE IF NOT EXISTS \`patientCarePlanSignatures\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`planId\` int NOT NULL,
    \`patientId\` int NOT NULL,
    \`version\` int NOT NULL,
    \`snapshot\` json NOT NULL,
    \`signedByUserId\` int NOT NULL,
    \`signedByName\` varchar(255) NOT NULL,
    \`signedAt\` datetime NOT NULL,
    INDEX \`patientCarePlanSignatures_plan_idx\` (\`planId\`),
    CONSTRAINT \`patientCarePlanSignatures_planId_fk\` FOREIGN KEY (\`planId\`) REFERENCES \`patientCarePlans\`(\`id\`),
    CONSTRAINT \`patientCarePlanSignatures_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`patientCarePlanSignatures_signedByUserId_fk\` FOREIGN KEY (\`signedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "educationSends", sql: `CREATE TABLE IF NOT EXISTS \`educationSends\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`code\` varchar(16),
    \`subjectKey\` varchar(120) NOT NULL,
    \`patientId\` int,
    \`conditionKeys\` json NOT NULL,
    \`versions\` json,
    \`language\` varchar(5) NOT NULL DEFAULT 'en',
    \`channel\` varchar(8) NOT NULL,
    \`ccmTaskId\` int,
    \`sentByUserId\` int,
    \`openedAt\` datetime,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    UNIQUE KEY \`educationSends_code_unique\` (\`code\`),
    INDEX \`educationSends_subject_idx\` (\`subjectKey\`, \`createdAt\`),
    CONSTRAINT \`educationSends_patientId_fk\` FOREIGN KEY (\`patientId\`) REFERENCES \`patients\`(\`id\`),
    CONSTRAINT \`educationSends_ccmTaskId_fk\` FOREIGN KEY (\`ccmTaskId\`) REFERENCES \`ccmTasks\`(\`id\`),
    CONSTRAINT \`educationSends_sentByUserId_fk\` FOREIGN KEY (\`sentByUserId\`) REFERENCES \`users\`(\`id\`))` },
  // Staff set their usual week; later changes are requests (added 2026-10-02).
  { label: "scheduleRequests", sql: `CREATE TABLE IF NOT EXISTS \`scheduleRequests\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`userId\` int NOT NULL,
    \`pattern\` json NOT NULL,
    \`effectiveFrom\` varchar(10) NOT NULL,
    \`kind\` varchar(8) NOT NULL,
    \`status\` varchar(10) NOT NULL,
    \`note\` varchar(500),
    \`approverUserId\` int,
    \`managerNote\` varchar(500),
    \`decidedByUserId\` int,
    \`decidedAt\` datetime,
    \`shiftsRemoved\` int,
    \`shiftsAdded\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`scheduleRequests_user_idx\` (\`userId\`, \`createdAt\`),
    INDEX \`scheduleRequests_status_idx\` (\`status\`),
    CONSTRAINT \`scheduleRequests_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`scheduleRequests_approverUserId_fk\` FOREIGN KEY (\`approverUserId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`scheduleRequests_decidedByUserId_fk\` FOREIGN KEY (\`decidedByUserId\`) REFERENCES \`users\`(\`id\`))` },
];

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function rows<T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> {
  const [r] = (await db.execute(query)) as unknown as [T[]];
  return r ?? [];
}

/** Parse "enum('a','b')" into ["a","b"]. */
export function parseEnum(columnType: string): string[] {
  const inner = columnType.replace(/^enum\(/i, "").replace(/\)$/, "");
  return Array.from(inner.matchAll(/'((?:[^']|'')*)'/g)).map((m) => m[1]!.replace(/''/g, "'"));
}

/**
 * Append missing values to the END of a live enum column, keeping every existing
 * value, its order, nullability and default. Appending is a metadata-only change
 * in MySQL 8 (ALGORITHM=INSTANT), so the table is not rebuilt or locked.
 */
async function appendEnumValues(db: Db, table: string, column: string, add: string[]): Promise<string | null> {
  const [col] = await rows<{ t: string; n: string; d: string | null }>(
    db,
    sql`SELECT COLUMN_TYPE AS t, IS_NULLABLE AS n, COLUMN_DEFAULT AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND COLUMN_NAME = ${column}`,
  );
  if (!col) throw new Error(`${table}.${column} not found`);
  const existing = parseEnum(col.t);
  const missing = add.filter((v) => !existing.includes(v));
  if (!missing.length) return null;
  const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const def = `ENUM(${[...existing, ...missing].map(quote).join(",")}) ${col.n === "YES" ? "NULL" : "NOT NULL"}${col.d != null ? ` DEFAULT ${quote(col.d)}` : ""}`;
  const base = `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${def}`;
  try {
    await db.execute(sql.raw(`${base}, ALGORITHM=INSTANT`));
  } catch {
    await db.execute(sql.raw(`${base}, ALGORITHM=INPLACE, LOCK=NONE`));
  }
  return `${table}.${column} += ${missing.join(", ")}`;
}

/**
 * Opportunity actions can now point at people who are only on the imported schedule
 * (not the CCM roster): patientId becomes optional and a subjectKey identifies them.
 * Each step runs only if still needed.
 */
async function upgradeOpportunityActions(db: Db): Promise<string[]> {
  const done: string[] = [];
  const cols = await rows<{ c: string; n: string }>(db, sql`SELECT COLUMN_NAME AS c, IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'opportunityActions'`);
  if (!cols.some((c) => c.c === "subjectKey")) {
    await db.execute(sql.raw("ALTER TABLE `opportunityActions` ADD COLUMN `subjectKey` varchar(120) NULL AFTER `patientId`"));
    done.push("opportunityActions.subjectKey added");
  }
  if (cols.find((c) => c.c === "patientId")?.n === "NO") {
    await db.execute(sql.raw("ALTER TABLE `opportunityActions` MODIFY COLUMN `patientId` int NULL"));
    done.push("opportunityActions.patientId now optional");
  }
  const idx = await rows<{ i: string }>(db, sql`SELECT INDEX_NAME AS i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'opportunityActions' AND INDEX_NAME = 'opportunityActions_subject_cat_idx'`);
  if (!idx.length) {
    await db.execute(sql.raw("CREATE INDEX `opportunityActions_subject_cat_idx` ON `opportunityActions` (`subjectKey`, `category`)"));
    done.push("opportunityActions subject index added");
  }
  return done;
}

/** Call-log sync: calls may belong to no MyPCP user, and keep the RingCentral extension name (added 2026-09-25). */
async function upgradePhoneCalls(db: Db): Promise<string[]> {
  const cols = await rows<{ c: string; n: string }>(db, sql`SELECT COLUMN_NAME AS c, IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'phoneCalls'`);
  if (!cols.length) return [];
  const applied: string[] = [];
  if (cols.find((c) => c.c === "userId")?.n === "NO") {
    await db.execute(sql.raw("ALTER TABLE `phoneCalls` MODIFY COLUMN `userId` int NULL"));
    applied.push("phoneCalls.userId now nullable");
  }
  if (!cols.some((c) => c.c === "rcExtensionName")) {
    await db.execute(sql.raw("ALTER TABLE `phoneCalls` ADD COLUMN `rcExtensionName` varchar(120) NULL AFTER `rcSessionId`"));
    applied.push("phoneCalls.rcExtensionName added");
  }
  return applied;
}

/** Practice mailbox: emails loaded from before the mailbox was connected (added 2026-09-25). */
async function upgradeEmailMessages(db: Db): Promise<string[]> {
  const cols = await rows<{ c: string }>(db, sql`SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'emailMessages'`);
  if (!cols.length || cols.some((c) => c.c === "historical")) return [];
  await db.execute(sql.raw("ALTER TABLE `emailMessages` ADD COLUMN `historical` boolean NOT NULL DEFAULT false AFTER `assignedUserId`"));
  return ["emailMessages.historical added"];
}

/**
 * Patient forms, consents (added 2026-09-29): consents can be declined and are recorded by kind,
 * someone signing for a patient states their legal authority, and a form can have an open
 * website link. Each column is added only if missing.
 */
const INTAKE_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "intakeDocuments", column: "consentKind", ddl: "`consentKind` varchar(20) NULL AFTER `sortOrder`" },
  { table: "intakeDocuments", column: "publicSlug", ddl: "`publicSlug` varchar(40) NULL AFTER `consentKind`, ADD UNIQUE KEY `intakeDocuments_publicSlug_unique` (`publicSlug`)" },
  { table: "intakePackets", column: "source", ddl: "`source` varchar(10) NOT NULL DEFAULT 'staff' AFTER `bookingRequestId`" },
  { table: "intakeSignatures", column: "signerAuthority", ddl: "`signerAuthority` varchar(20) NULL AFTER `signerRelation`" },
  { table: "intakeSignatures", column: "authorityNote", ddl: "`authorityNote` varchar(160) NULL AFTER `signerAuthority`" },
  { table: "intakeSignatures", column: "decision", ddl: "`decision` varchar(10) NOT NULL DEFAULT 'signed' AFTER `authorityNote`" },
  { table: "intakeSignatures", column: "consentKind", ddl: "`consentKind` varchar(20) NULL AFTER `decision`" },
  // Added 2026-09-30: Yes/No program consents in one form, and automatic enrollment.
  { table: "intakeDocuments", column: "choices", ddl: "`choices` json NULL AFTER `publicSlug`" },
  { table: "intakeSignatures", column: "choices", ddl: "`choices` json NULL AFTER `consentKind`" },
  { table: "patients", column: "ccmConsentDate", ddl: "`ccmConsentDate` datetime NULL AFTER `consentStatus`" },
  { table: "patients", column: "rpmConsentStatus", ddl: "`rpmConsentStatus` ENUM('consented','pending','declined') DEFAULT 'pending' AFTER `rpmDeviceType`" },
  { table: "patients", column: "rpmConsentDate", ddl: "`rpmConsentDate` datetime NULL AFTER `rpmConsentStatus`" },
  // Added 2026-09-30: a provider's signature applied by staff with the provider's approval.
  { table: "documentSignatures", column: "onBehalfOfUserId", ddl: "`onBehalfOfUserId` int NULL AFTER `sha256`" },
  { table: "documentSignatures", column: "approvalMethod", ddl: "`approvalMethod` varchar(20) NULL AFTER `onBehalfOfUserId`" },
  // Added 2026-10-01: patients enrolled from a program approval bill CCM only with signed consent.
  { table: "patients", column: "ccmConsentRequired", ddl: "`ccmConsentRequired` boolean DEFAULT false AFTER `rpmConsentDate`" },
  { table: "documentSignatures", column: "approvalNote", ddl: "`approvalNote` varchar(255) NULL AFTER `approvalMethod`" },
  // Added 2026-10-01: CCM call: care plan reviewed, and which conditions' teaching points were covered.
  // (carePlanReviewed may already exist from the archived June care plan; then it's left as is.)
  { table: "ccmNotes", column: "carePlanReviewed", ddl: "`carePlanReviewed` boolean DEFAULT false AFTER `bhiRiskFlag`" },
  { table: "ccmNotes", column: "educationCovered", ddl: "`educationCovered` json NULL AFTER `carePlanReviewed`" },
];
async function upgradeIntake(db: Db): Promise<string[]> {
  const applied: string[] = [];
  for (const c of INTAKE_COLUMNS) {
    const have = await rows<{ c: string }>(db, sql`SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${c.table} AND COLUMN_NAME = ${c.column}`);
    if (have.length) continue;
    await db.execute(sql.raw("ALTER TABLE `" + c.table + "` ADD COLUMN " + c.ddl));
    applied.push(`${c.table}.${c.column} added`);
  }
  return applied;
}

/** Indexes behind the top-bar "My progress" counts (added 2026-09-26). */
const METRIC_INDEXES: { table: string; name: string; cols: string }[] = [
  { table: "phoneCalls", name: "phoneCalls_user_started_idx", cols: "`userId`, `startedAt`" },
  { table: "phoneCalls", name: "phoneCalls_started_idx", cols: "`startedAt`" },
  { table: "appointmentStatusEvents", name: "appointmentStatusEvents_user_idx", cols: "`changedByUserId`, `createdAt`" },
  { table: "workTaskActivities", name: "workTaskActivities_user_idx", cols: "`userId`, `createdAt`" },
  { table: "ccmTasks", name: "ccmTasks_completedBy_idx", cols: "`completedByStaffId`, `completedAt`" },
];
async function ensureMetricIndexes(db: Db): Promise<string[]> {
  const applied: string[] = [];
  for (const ix of METRIC_INDEXES) {
    const t = await rows<{ t: string }>(db, sql`SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${ix.table}`);
    if (!t.length) continue;
    const have = await rows<{ i: string }>(db, sql`SELECT INDEX_NAME AS i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${ix.table} AND INDEX_NAME = ${ix.name}`);
    if (have.length) continue;
    await db.execute(sql.raw("CREATE INDEX `" + ix.name + "` ON `" + ix.table + "` (" + ix.cols + ")"));
    applied.push(`${ix.table} index ${ix.name} added`);
  }
  return applied;
}

/** Remote shifts: a shift may have no clinic (added 2026-09-25). */
async function upgradeShifts(db: Db): Promise<string[]> {
  const cols = await rows<{ n: string }>(db, sql`SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shifts' AND COLUMN_NAME = 'clinicId'`);
  if (!cols.length || cols[0].n === "YES") return [];
  await db.execute(sql.raw("ALTER TABLE `shifts` MODIFY COLUMN `clinicId` int NULL"));
  return ["shifts.clinicId now nullable (remote shifts)"];
}

/** Time clock: hourly staff are marked on their profile (added 2026-09-24). */
async function upgradeStaffProfiles(db: Db): Promise<string[]> {
  const cols = await rows<{ c: string }>(db, sql`SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staffProfiles'`);
  if (!cols.length) return [];
  const has = (name: string) => cols.some((c) => c.c === name);
  const applied: string[] = [];
  if (!has("usesTimeClock")) {
    await db.execute(sql.raw("ALTER TABLE `staffProfiles` ADD COLUMN `usesTimeClock` boolean NOT NULL DEFAULT false AFTER `canFloat`"));
    applied.push("staffProfiles.usesTimeClock added");
  }
  // Added 2026-09-25: the date attendance tracking starts for an hourly employee.
  if (!has("clockStartDate")) {
    await db.execute(sql.raw("ALTER TABLE `staffProfiles` ADD COLUMN `clockStartDate` varchar(10) NULL AFTER `usesTimeClock`"));
    applied.push("staffProfiles.clockStartDate added");
  }
  return applied;
}

/** Tasks about patients who aren't on the CCM roster (added 2026-10-01). */
async function upgradeWorkTasks(db: Db): Promise<string[]> {
  const cols = await rows<{ c: string }>(db, sql`SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workTasks'`);
  if (!cols.length) return [];
  const applied: string[] = [];
  if (!cols.some((c) => c.c === "subjectKey")) {
    await db.execute(sql.raw("ALTER TABLE `workTasks` ADD COLUMN `subjectKey` varchar(120) NULL AFTER `patientId`, ADD COLUMN `subjectName` varchar(255) NULL AFTER `subjectKey`, ADD INDEX `workTasks_subject_idx` (`subjectKey`)"));
    applied.push("workTasks.subjectKey + subjectName added");
  }
  return applied;
}

const NEW_TABLES = ["workTasks", "workTaskActivities", "appointments", "appointmentStatusEvents", "scheduleImports", "opportunityActions", "playbooks", "playbookVersions"];
const WATCHED_TABLES = ["users", "patients", "clinics", "providers", "ccmTasks", "ccmNotes", "billingRecords", "followUpItems", "providerEscalations", "refillRequests", "reachOutContacts", "notifications", "auditLogs"];

/** Read-only snapshot for before/after checks: enum definitions, which new tables exist, row counts. */
export async function inspectWorkspace() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const enums: Record<string, string> = {};
  for (const e of ENUM_ADDITIONS) {
    const [c] = await rows<{ t: string }>(db, sql`SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${e.table} AND COLUMN_NAME = ${e.column}`);
    enums[`${e.table}.${e.column}`] = c?.t ?? "(missing)";
  }
  const present = await rows<{ t: string }>(db, sql`SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`);
  // Case-insensitive: local Windows MySQL lowercases table names, RDS (Linux) keeps them.
  const names = new Set(present.map((r) => r.t.toLowerCase()));
  const has = (t: string) => names.has(t.toLowerCase());
  const newTables = Object.fromEntries(NEW_TABLES.map((t) => [t, has(t)]));
  const counts: Record<string, number> = {};
  for (const t of [...WATCHED_TABLES, ...NEW_TABLES]) {
    if (!has(t)) continue;
    const [r] = await rows<{ n: number }>(db, sql.raw(`SELECT COUNT(*) AS n FROM \`${t}\``));
    counts[t] = Number(r?.n ?? 0);
  }
  const oppCols = await rows<{ c: string; n: string }>(db, sql`SELECT COLUMN_NAME AS c, IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'opportunityActions' AND COLUMN_NAME IN ('patientId', 'subjectKey')`);
  const opportunityActionsColumns = Object.fromEntries(oppCols.map((c) => [c.c, c.n === "YES" ? "nullable" : "required"]));
  return { enums, newTables, opportunityActionsColumns, counts };
}

/** Insert the starter playbooks, but only into an empty table (never overwrites edits). */
async function seedPlaybooksIfEmpty(db: Db): Promise<string | null> {
  const [count] = await rows<{ n: number }>(db, sql.raw("SELECT COUNT(*) AS n FROM `playbooks`"));
  if (Number(count?.n ?? 0) > 0) return null;
  for (const pb of DEFAULT_PLAYBOOKS) {
    await db.execute(
      sql`INSERT INTO \`playbooks\` (\`slug\`, \`title\`, \`category\`, \`description\`) VALUES (${pb.slug}, ${pb.title}, ${pb.category}, ${pb.description})`,
    );
    await db.execute(
      sql`INSERT INTO \`playbookVersions\` (\`playbookId\`, \`version\`, \`steps\`, \`changeNote\`) SELECT \`id\`, 1, ${JSON.stringify(pb.steps)}, 'Starter version' FROM \`playbooks\` WHERE \`slug\` = ${pb.slug}`,
    );
  }
  return `seeded ${DEFAULT_PLAYBOOKS.length} starter playbooks`;
}

export async function runWorkspaceMigration(): Promise<string[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const applied: string[] = [];
  for (const e of ENUM_ADDITIONS) {
    const done = await appendEnumValues(db, e.table, e.column, e.values);
    if (done) applied.push(done);
  }
  for (const s of WORKSPACE_STATEMENTS) {
    await db.execute(sql.raw(s.sql));
    applied.push(s.label);
  }
  applied.push(...(await upgradeOpportunityActions(db)));
  applied.push(...(await upgradeWorkTasks(db)));
  applied.push(...(await upgradeStaffProfiles(db)));
  applied.push(...(await upgradeShifts(db)));
  applied.push(...(await upgradePhoneCalls(db)));
  applied.push(...(await upgradeEmailMessages(db)));
  applied.push(...(await upgradeIntake(db)));
  applied.push(...(await ensureMetricIndexes(db)));
  const seeded = await seedPlaybooksIfEmpty(db);
  if (seeded) applied.push(seeded);
  return applied;
}

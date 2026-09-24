// Workforce module schema — purely ADDITIVE and idempotent: creates 8 new tables
// and appends one value to three existing enums. No existing column, row, or
// patient table is modified. Run from the CLI (server/migrateWorkforce.ts) or,
// since production RDS only accepts connections from the Lambda, by directly
// invoking the Lambda with {"__migrate":"workforce"} (see server/_core/lambda.ts).
import { sql } from "drizzle-orm";
import { getDb } from "./db";

const ROLE_ENUM = "ENUM('admin','staff','provider','billing','front_desk','user','medical_assistant')";

export const WORKFORCE_STATEMENTS: { label: string; sql: string }[] = [
  // Appending to the END of an enum is an in-place metadata change in MySQL 8.
  { label: "users.role += medical_assistant", sql: `ALTER TABLE \`users\` MODIFY COLUMN \`role\` ${ROLE_ENUM} NOT NULL DEFAULT 'user'` },
  { label: "teamInvites.role += medical_assistant", sql: `ALTER TABLE \`teamInvites\` MODIFY COLUMN \`role\` ${ROLE_ENUM} NOT NULL DEFAULT 'staff'` },
  { label: "notifications.type += workforce", sql: "ALTER TABLE `notifications` MODIFY COLUMN `type` ENUM('urgent_symptom','escalation','missing_documentation','not_reached','billing_ready','refill_request','refill_decision','workforce') NOT NULL" },
  { label: "jobRoles", sql: `CREATE TABLE IF NOT EXISTS \`jobRoles\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`name\` varchar(120) NOT NULL,
    \`summary\` text,
    \`active\` boolean NOT NULL DEFAULT true,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP)` },
  { label: "jobDuties", sql: `CREATE TABLE IF NOT EXISTS \`jobDuties\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`jobRoleId\` int NOT NULL,
    \`category\` varchar(80) NOT NULL DEFAULT 'General',
    \`title\` varchar(255) NOT NULL,
    \`detail\` text,
    \`frequency\` ENUM('daily','weekly','monthly','as_needed') NOT NULL DEFAULT 'daily',
    \`sortOrder\` int NOT NULL DEFAULT 0,
    \`active\` boolean NOT NULL DEFAULT true,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    INDEX \`jobDuties_role_idx\` (\`jobRoleId\`),
    CONSTRAINT \`jobDuties_jobRoleId_fk\` FOREIGN KEY (\`jobRoleId\`) REFERENCES \`jobRoles\`(\`id\`))` },
  { label: "staffProfiles", sql: `CREATE TABLE IF NOT EXISTS \`staffProfiles\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`userId\` int NOT NULL UNIQUE,
    \`jobRoleId\` int,
    \`homeClinicId\` int,
    \`canFloat\` boolean NOT NULL DEFAULT false,
    \`hoursPerWeek\` int DEFAULT 40,
    \`hireDate\` varchar(10),
    \`active\` boolean NOT NULL DEFAULT true,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT \`staffProfiles_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`staffProfiles_jobRoleId_fk\` FOREIGN KEY (\`jobRoleId\`) REFERENCES \`jobRoles\`(\`id\`),
    CONSTRAINT \`staffProfiles_homeClinicId_fk\` FOREIGN KEY (\`homeClinicId\`) REFERENCES \`clinics\`(\`id\`))` },
  { label: "shifts", sql: `CREATE TABLE IF NOT EXISTS \`shifts\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`userId\` int NOT NULL,
    \`clinicId\` int NOT NULL,
    \`date\` varchar(10) NOT NULL,
    \`startTime\` varchar(5) NOT NULL,
    \`endTime\` varchar(5) NOT NULL,
    \`status\` ENUM('scheduled','called_out') NOT NULL DEFAULT 'scheduled',
    \`coversShiftId\` int,
    \`note\` text,
    \`createdByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`shifts_date_idx\` (\`date\`),
    INDEX \`shifts_user_date_idx\` (\`userId\`, \`date\`),
    CONSTRAINT \`shifts_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`shifts_clinicId_fk\` FOREIGN KEY (\`clinicId\`) REFERENCES \`clinics\`(\`id\`),
    CONSTRAINT \`shifts_createdByUserId_fk\` FOREIGN KEY (\`createdByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "timeOffRequests", sql: `CREATE TABLE IF NOT EXISTS \`timeOffRequests\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`userId\` int NOT NULL,
    \`startDate\` varchar(10) NOT NULL,
    \`endDate\` varchar(10) NOT NULL,
    \`type\` ENUM('pto','sick','unpaid','other') NOT NULL DEFAULT 'pto',
    \`reason\` text,
    \`status\` ENUM('pending','approved','denied','cancelled') NOT NULL DEFAULT 'pending',
    \`managerNote\` text,
    \`decidedByUserId\` int,
    \`decidedAt\` datetime,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`timeOff_user_idx\` (\`userId\`),
    INDEX \`timeOff_status_idx\` (\`status\`),
    CONSTRAINT \`timeOff_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`timeOff_decidedByUserId_fk\` FOREIGN KEY (\`decidedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "timePunches", sql: `CREATE TABLE IF NOT EXISTS \`timePunches\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`userId\` int NOT NULL,
    \`clinicId\` int,
    \`shiftId\` int,
    \`workDate\` varchar(10) NOT NULL,
    \`clockInAt\` datetime NOT NULL,
    \`clockOutAt\` datetime,
    \`minutesLate\` int NOT NULL DEFAULT 0,
    \`note\` text,
    \`editedByUserId\` int,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`timePunches_user_date_idx\` (\`userId\`, \`workDate\`),
    INDEX \`timePunches_date_idx\` (\`workDate\`),
    CONSTRAINT \`timePunches_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`timePunches_clinicId_fk\` FOREIGN KEY (\`clinicId\`) REFERENCES \`clinics\`(\`id\`),
    CONSTRAINT \`timePunches_shiftId_fk\` FOREIGN KEY (\`shiftId\`) REFERENCES \`shifts\`(\`id\`),
    CONSTRAINT \`timePunches_editedByUserId_fk\` FOREIGN KEY (\`editedByUserId\`) REFERENCES \`users\`(\`id\`))` },
  { label: "dutyCompletions", sql: `CREATE TABLE IF NOT EXISTS \`dutyCompletions\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`userId\` int NOT NULL,
    \`dutyId\` int NOT NULL,
    \`periodKey\` varchar(10) NOT NULL,
    \`completedAt\` timestamp NOT NULL DEFAULT (now()),
    INDEX \`dutyCompletions_user_period_idx\` (\`userId\`, \`periodKey\`),
    CONSTRAINT \`dutyCompletions_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`dutyCompletions_dutyId_fk\` FOREIGN KEY (\`dutyId\`) REFERENCES \`jobDuties\`(\`id\`))` },
  { label: "performanceNotes", sql: `CREATE TABLE IF NOT EXISTS \`performanceNotes\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`userId\` int NOT NULL,
    \`authorUserId\` int,
    \`kind\` ENUM('kudos','coaching','review') NOT NULL DEFAULT 'review',
    \`rating\` int,
    \`note\` text NOT NULL,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    INDEX \`performanceNotes_user_idx\` (\`userId\`),
    CONSTRAINT \`performanceNotes_userId_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`),
    CONSTRAINT \`performanceNotes_authorUserId_fk\` FOREIGN KEY (\`authorUserId\`) REFERENCES \`users\`(\`id\`))` },
];

export async function runWorkforceMigration(): Promise<string[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const applied: string[] = [];
  for (const s of WORKFORCE_STATEMENTS) {
    await db.execute(sql.raw(s.sql));
    applied.push(s.label);
  }
  return applied;
}

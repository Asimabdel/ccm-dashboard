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
    \`category\` ENUM('patient_call','referral','prior_auth','lab_followup','form','medication_request','care_management','rpm','front_desk','provider_request','administrative','other') NOT NULL DEFAULT 'other',
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
  applied.push(...(await upgradeStaffProfiles(db)));
  applied.push(...(await upgradeShifts(db)));
  applied.push(...(await upgradePhoneCalls(db)));
  applied.push(...(await upgradeEmailMessages(db)));
  applied.push(...(await ensureMetricIndexes(db)));
  const seeded = await seedPlaybooksIfEmpty(db);
  if (seeded) applied.push(seeded);
  return applied;
}

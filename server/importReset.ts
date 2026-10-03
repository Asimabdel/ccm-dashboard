// Recent CCM roster imports: a counts-only report (to find a batch), and a reset that makes an
// imported batch "new" — this month's CCM task back to not started, no completion, no last-CCM
// date — for files whose status column said Completed (bulkInsertPatients copies it onto the task).
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { getDb, recomputeBilling } from "./db";
import { auditLogs, billingRecords, ccmNotes, ccmTasks, patients, providers, users } from "../drizzle/schema";
import { currentMonth } from "./seed";

const FRESH = ["not_started", "assigned"];

/** Imports in the last `sinceHours` and the patients they created, by provider + care coordinator (counts only). */
export async function recentImportReport(sinceHours = 48) {
  const db = await getDb();
  if (!db) return null;
  const since = new Date(Date.now() - sinceHours * 3600_000);
  const month = currentMonth();
  const imports = await db
    .select({ at: auditLogs.createdAt, by: auditLogs.userName, what: auditLogs.description })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "bulk_import_patients"), gte(auditLogs.createdAt, since)));
  const staff = alias(users, "importStaff");
  const rows = await db
    .select({
      id: patients.id, createdAt: patients.createdAt, providerId: patients.providerId, providerName: providers.name,
      staffId: patients.assignedStaffId, staffName: staff.name,
      enrollment: patients.ccmEnrollmentStatus, lastCCMDate: patients.lastCCMDate, lastCalledAt: patients.lastCalledAt,
    })
    .from(patients)
    .leftJoin(providers, eq(patients.providerId, providers.id))
    .leftJoin(staff, eq(patients.assignedStaffId, staff.id))
    .where(gte(patients.createdAt, since));
  const ids = rows.map((r) => r.id);
  const tasks = ids.length
    ? await db.select({ id: ccmTasks.id, patientId: ccmTasks.patientId, program: ccmTasks.program, status: ccmTasks.status, completedAt: ccmTasks.completedAt, minutes: ccmTasks.timeSpentMinutes })
      .from(ccmTasks).where(and(inArray(ccmTasks.patientId, ids), eq(ccmTasks.month, month)))
    : [];
  const bills = ids.length
    ? await db.select({ patientId: billingRecords.patientId, program: billingRecords.program, status: billingRecords.billingStatus })
      .from(billingRecords).where(and(inArray(billingRecords.patientId, ids), eq(billingRecords.month, month)))
    : [];
  const count = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const batches = new Map<string, any>();
  for (const r of rows) {
    const key = `${r.providerId ?? "none"}|${r.staffId ?? "none"}|${new Date(r.createdAt).toISOString().slice(0, 15)}`; // provider + coordinator + 10-minute window
    const b = batches.get(key) ?? { providerId: r.providerId, provider: r.providerName ?? "(none)", staffId: r.staffId, staff: r.staffName ?? "(none)", createdAround: new Date(r.createdAt).toISOString().slice(0, 16), patients: 0, enrollment: {}, lastCcmDateSet: 0, lastCalledSet: 0, ccmTaskStatus: {}, ccmTaskCompletedAt: 0, ccmMinutesLogged: 0, apcmTaskStatus: {}, billing: {} };
    b.patients++;
    count(b.enrollment, String(r.enrollment));
    if (r.lastCCMDate) b.lastCcmDateSet++;
    if (r.lastCalledAt) b.lastCalledSet++;
    for (const t of tasks.filter((t) => t.patientId === r.id)) {
      if (t.program === "ccm") { count(b.ccmTaskStatus, String(t.status)); if (t.completedAt) b.ccmTaskCompletedAt++; if ((t.minutes ?? 0) > 0) b.ccmMinutesLogged++; }
      if (t.program === "apcm") count(b.apcmTaskStatus, String(t.status));
    }
    for (const x of bills.filter((x) => x.patientId === r.id)) count(b.billing, `${x.program}:${x.status}`);
    batches.set(key, b);
  }
  return { month, since: since.toISOString(), imports, batches: Array.from(batches.values()).sort((a, b) => a.createdAround.localeCompare(b.createdAround)) };
}

/**
 * Make an imported batch "new": for patients of `providerId` and/or care coordinator `staffId`
 * created between `from` and `to`,
 * this month's CCM task goes back to not started / assigned (no contact, completion or credit)
 * and the patient's last-CCM date is cleared. Tasks with real work since the import (minutes,
 * a finished note, or a CCM note) are left alone and counted. `dryRun` changes nothing.
 */
export async function resetImportedAsNew(opts: { providerId?: number; staffId?: number; from: string; to?: string; clearLastCalled?: boolean; dryRun?: boolean }) {
  const db = await getDb();
  if (!db) return null;
  const month = currentMonth();
  const from = new Date(opts.from);
  const to = opts.to ? new Date(opts.to) : new Date();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error("Bad from/to date");
  if (!opts.providerId && !opts.staffId) throw new Error("Give providerId or staffId");
  const batch = await db
    .select({ id: patients.id, assignedStaffId: patients.assignedStaffId, lastCCMDate: patients.lastCCMDate, lastCalledAt: patients.lastCalledAt })
    .from(patients)
    .where(and(
      opts.providerId ? eq(patients.providerId, opts.providerId) : undefined,
      opts.staffId ? eq(patients.assignedStaffId, opts.staffId) : undefined,
      gte(patients.createdAt, from), lte(patients.createdAt, to),
    ));
  const ids = batch.map((p) => p.id);
  const out = { month, patients: ids.length, tasksReset: 0, alreadyNew: 0, skippedRealWork: 0, lastCcmDateCleared: 0, lastCalledCleared: 0, noTask: 0, dryRun: !!opts.dryRun };
  if (!ids.length) return out;
  const tasks = await db.select().from(ccmTasks).where(and(inArray(ccmTasks.patientId, ids), eq(ccmTasks.month, month), eq(ccmTasks.program, "ccm")));
  const noteRows = tasks.length
    ? await db.select({ taskId: ccmNotes.ccmTaskId, n: sql<number>`COUNT(*)` }).from(ccmNotes).where(inArray(ccmNotes.ccmTaskId, tasks.map((t) => t.id))).groupBy(ccmNotes.ccmTaskId)
    : [];
  const hasNote = new Set(noteRows.filter((r) => Number(r.n) > 0).map((r) => r.taskId));
  const staffOf = new Map(batch.map((p) => [p.id, p.assignedStaffId]));
  out.noTask = ids.filter((id) => !tasks.some((t) => t.patientId === id)).length;
  for (const t of tasks) {
    const untouched = FRESH.includes(String(t.status)) && !t.completedAt && !t.dateContacted && !(t.noAnswerCount ?? 0);
    if (untouched) { out.alreadyNew++; continue; }
    if ((t.timeSpentMinutes ?? 0) > 0 || t.ccmNoteCompleted || hasNote.has(t.id)) { out.skippedRealWork++; continue; }
    out.tasksReset++;
    if (opts.dryRun) continue;
    await db.update(ccmTasks).set({
      status: staffOf.get(t.patientId) ? "assigned" : "not_started",
      dateContacted: null, completedAt: null, completedByStaffId: null, noAnswerCount: 0, billingReady: false, updatedAt: new Date(),
    }).where(eq(ccmTasks.id, t.id));
    // Billing goes back to not started, and APCM comes back for the month if the import had suppressed it.
    await recomputeBilling(t.id, month);
  }
  for (const p of batch) {
    if (p.lastCCMDate) out.lastCcmDateCleared++;
    if (opts.clearLastCalled && p.lastCalledAt) out.lastCalledCleared++;
  }
  if (!opts.dryRun) {
    await db.update(patients).set({ lastCCMDate: null, updatedAt: new Date() }).where(and(inArray(patients.id, ids), sql`${patients.lastCCMDate} IS NOT NULL`));
    if (opts.clearLastCalled) await db.update(patients).set({ lastCalledAt: null, updatedAt: new Date() }).where(and(inArray(patients.id, ids), sql`${patients.lastCalledAt} IS NOT NULL`));
  }
  return out;
}

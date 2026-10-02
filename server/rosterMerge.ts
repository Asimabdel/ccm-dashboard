// Merge duplicate CCM-roster records (the same person on the roster twice: typically a name-only record
// with the CCM history, and a second record from a later import that got linked to Practice Fusion).
// The practice's choice (2026-10-01): one record per person. The copy with the CCM history is kept;
// the other copy's enrollments, conditions, Practice Fusion chart, visits, tasks, forms, messages and
// payments move onto it. The extra copy is never deleted: it is renamed "… (merged into #N)", switched
// off in every program, and keeps anything that couldn't move (a monthly CCM item for a month the kept
// record already has). A pair billed for the same program in the same month on both copies gets a
// billing-review task.
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { billingRecords, ccmNotes, ccmTasks, patients, users } from "../drizzle/schema";
import { classifyDiagnosis } from "../shared/programRules";
import { localDateStr } from "../shared/workforce";
import { clearDirectoryCache } from "./directoryDb";
import { WorkspaceError, audit, createTask, clearScheduleCache, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export const MERGED_RE = /\(merged into #\d+\)\s*$/;

type P = typeof patients.$inferSelect;

/** Tables that point at a patient by id (and by "p:<id>" key where they have one). Care-management tables are handled separately. */
const BY_ID: { table: string; column: string; key?: boolean }[] = [
  { table: "providerEscalations", column: "patientId" }, { table: "followUpItems", column: "patientId" }, { table: "refillRequests", column: "patientId" },
  { table: "notifications", column: "relatedPatientId" }, { table: "workTasks", column: "patientId" }, { table: "appointments", column: "patientId" },
  { table: "opportunityActions", column: "patientId", key: true }, { table: "emailMessages", column: "patientId", key: true }, { table: "emailContacts", column: "patientId", key: true },
  { table: "patientTests", column: "patientId", key: true }, { table: "personDemographics", column: "patientId", key: true }, { table: "phoneCalls", column: "patientId", key: true },
  { table: "faxes", column: "patientId", key: true }, { table: "fhirPatients", column: "patientId", key: true }, { table: "programSuggestions", column: "patientId", key: true },
  { table: "bookingRequests", column: "patientId", key: true }, { table: "intakePackets", column: "patientId", key: true }, { table: "consentEnrollments", column: "patientId", key: true },
  { table: "documents", column: "patientId", key: true }, { table: "coverageOnFile", column: "patientId", key: true }, { table: "eligibilityChecks", column: "patientId", key: true },
  { table: "squarePayments", column: "patientId", key: true }, { table: "squareRequests", column: "patientId", key: true }, { table: "patientFiles", column: "patientId", key: true },
];
/** Tables keyed only by "p:<id>". */
const BY_KEY_ONLY = ["fhirResources", "squareCustomers"];

const rank = (s: string | null | undefined, order: string[]) => { const i = order.indexOf(s ?? ""); return i < 0 ? order.length : i; };
/** The "strongest" of two statuses (e.g. active beats inactive beats not_enrolled). */
const best = <T extends string | null>(a: T, b: T, order: string[]): T => (rank(a, order) <= rank(b, order) ? a : b);
const ENROLL = ["active", "enrolled", "eligible", "inactive", "transferred", "declined", "not_enrolled"];
const CONSENT = ["consented", "declined", "pending"];
const earliest = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a < b ? a : b);
const latest = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

/** One list of conditions, without a condition twice under different names. */
function unionConditions(a: string[] | null, b: string[] | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...(a ?? []), ...(b ?? [])]) {
    if (!t) continue;
    const k = classifyDiagnosis({ title: t })?.category ?? t.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Which copy to keep: the CCM-active one; else the one with more CCM history; else the one with a birthday; else the older. */
export function pickKeep(a: P, b: P, history: Map<number, number>): [P, P] {
  const aAct = a.ccmEnrollmentStatus === "active", bAct = b.ccmEnrollmentStatus === "active";
  if (aAct !== bAct) return aAct ? [a, b] : [b, a];
  const ha = history.get(a.id) ?? 0, hb = history.get(b.id) ?? 0;
  if (ha !== hb) return ha > hb ? [a, b] : [b, a];
  if (!!a.dateOfBirth !== !!b.dateOfBirth) return a.dateOfBirth ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

/** The kept record's fields after taking what the other copy adds. */
function mergedFields(k: P, o: P) {
  return {
    dateOfBirth: k.dateOfBirth ?? o.dateOfBirth,
    phoneNumber: k.phoneNumber?.replace(/\D/g, "").length ? k.phoneNumber : o.phoneNumber,
    clinicId: k.clinicId ?? o.clinicId,
    providerId: k.providerId ?? o.providerId,
    insurance: k.insurance ?? o.insurance,
    assignedStaffId: k.assignedStaffId ?? o.assignedStaffId,
    chronicConditions: unionConditions(k.chronicConditions as string[] | null, o.chronicConditions as string[] | null),
    bhiConditions: unionConditions(k.bhiConditions as string[] | null, o.bhiConditions as string[] | null),
    ccmEnrollmentStatus: best(k.ccmEnrollmentStatus, o.ccmEnrollmentStatus, ENROLL) as P["ccmEnrollmentStatus"],
    consentStatus: best(k.consentStatus, o.consentStatus, CONSENT) as P["consentStatus"],
    ccmConsentDate: earliest(k.ccmConsentDate, o.ccmConsentDate),
    bhiEnrollmentStatus: best(k.bhiEnrollmentStatus, o.bhiEnrollmentStatus, ENROLL) as P["bhiEnrollmentStatus"],
    bhiConsentStatus: best(k.bhiConsentStatus, o.bhiConsentStatus, CONSENT) as P["bhiConsentStatus"],
    bhiConsentDate: earliest(k.bhiConsentDate, o.bhiConsentDate),
    bhiInitiatingVisitDate: latest(k.bhiInitiatingVisitDate, o.bhiInitiatingVisitDate),
    bhiCarePlan: k.bhiCarePlan || o.bhiCarePlan,
    apcmEnrollmentStatus: best(k.apcmEnrollmentStatus, o.apcmEnrollmentStatus, ENROLL) as P["apcmEnrollmentStatus"],
    apcmConsentStatus: best(k.apcmConsentStatus, o.apcmConsentStatus, CONSENT) as P["apcmConsentStatus"],
    apcmConsentDate: earliest(k.apcmConsentDate, o.apcmConsentDate),
    apcmInitiatingVisitDate: latest(k.apcmInitiatingVisitDate, o.apcmInitiatingVisitDate),
    apcmCarePlan: k.apcmCarePlan || o.apcmCarePlan,
    isQMB: !!(k.isQMB || o.isQMB),
    rpmEnrolled: !!(k.rpmEnrolled || o.rpmEnrolled),
    rpmStatus: best(k.rpmStatus, o.rpmStatus, ENROLL) as P["rpmStatus"],
    rpmDeviceType: k.rpmDeviceType ?? o.rpmDeviceType,
    rpmConsentStatus: best(k.rpmConsentStatus, o.rpmConsentStatus, CONSENT) as P["rpmConsentStatus"],
    rpmConsentDate: earliest(k.rpmConsentDate, o.rpmConsentDate),
    lastOfficeVisit: latest(k.lastOfficeVisit, o.lastOfficeVisit),
    nextAppointment: k.nextAppointment ?? o.nextAppointment,
    lastCCMDate: latest(k.lastCCMDate, o.lastCCMDate),
    lastCalledAt: latest(k.lastCalledAt, o.lastCalledAt),
    notes: [k.notes, o.notes].filter(Boolean).join("\n\n") || null,
    updatedAt: new Date(),
  };
}

/**
 * Merge one pair. Returns what couldn't move (monthly items for a month the kept record already has).
 * `nameFromId`: the record whose spelling of the name is kept (the one linked to Practice Fusion).
 */
export async function mergePair(actor: WorkspaceActor, aId: number, bId: number, history: Map<number, number>, opts: { nameFromId?: number } = {}) {
  const d = await db();
  const rows = await d.select().from(patients).where(inArray(patients.id, [aId, bId]));
  const a = rows.find((r) => r.id === aId), b = rows.find((r) => r.id === bId);
  if (!a || !b) return { skipped: "missing" as const };
  if (MERGED_RE.test(a.name) || MERGED_RE.test(b.name)) return { skipped: "already merged" as const };
  const [keep, drop] = pickKeep(a, b, history);

  // Monthly care-management items: the kept record keeps its own; the other copy's move unless the kept record already has that month + program.
  const keepTasks = await d.select({ month: ccmTasks.month, program: ccmTasks.program }).from(ccmTasks).where(eq(ccmTasks.patientId, keep.id));
  const has = new Set(keepTasks.map((t) => `${t.month}|${t.program}`));
  const dropTasks = await d.select({ id: ccmTasks.id, month: ccmTasks.month, program: ccmTasks.program, status: ccmTasks.status }).from(ccmTasks).where(eq(ccmTasks.patientId, drop.id));
  const movable = dropTasks.filter((t) => !has.has(`${t.month}|${t.program}`)).map((t) => t.id);
  const stuck = dropTasks.filter((t) => has.has(`${t.month}|${t.program}`));
  // Both copies billed the same program for the same month: a possible duplicate claim for billing to look at.
  const claims = await d.select({ pid: billingRecords.patientId, month: billingRecords.month, program: billingRecords.program, status: billingRecords.billingStatus })
    .from(billingRecords).where(inArray(billingRecords.patientId, [keep.id, drop.id]));
  const billedKeep = new Set(claims.filter((c) => c.pid === keep.id && (c.status === "billed" || c.status === "ready_for_billing")).map((c) => `${c.month}|${c.program}`));
  const doubled = claims.filter((c) => c.pid === drop.id && (c.status === "billed" || c.status === "ready_for_billing") && billedKeep.has(`${c.month}|${c.program}`));

  await d.transaction(async (tx) => {
    const nameFrom = opts.nameFromId === drop.id ? drop : null;
    await tx.update(patients).set({ ...mergedFields(keep, drop), ...(nameFrom ? { name: nameFrom.name.replace(MERGED_RE, "").trim() } : {}) }).where(eq(patients.id, keep.id));
    if (movable.length) {
      await tx.update(ccmTasks).set({ patientId: keep.id }).where(inArray(ccmTasks.id, movable));
      await tx.update(ccmNotes).set({ patientId: keep.id }).where(inArray(ccmNotes.ccmTaskId, movable));
      await tx.update(billingRecords).set({ patientId: keep.id }).where(inArray(billingRecords.ccmTaskId, movable));
    }
    // Items that stay with the retired copy come off the worklists unless they're already finished.
    const open = stuck.filter((t) => !["completed", "ready_for_billing", "billed"].includes(t.status as string)).map((t) => t.id);
    if (open.length) await tx.update(ccmTasks).set({ status: "inactive" }).where(inArray(ccmTasks.id, open));
    const oldKey = `p:${drop.id}`, newKey = `p:${keep.id}`;
    for (const t of BY_ID) {
      await tx.execute(t.key
        ? sql`UPDATE IGNORE ${sql.raw(`\`${t.table}\``)} SET ${sql.raw(`\`${t.column}\``)} = ${keep.id}, \`subjectKey\` = IF(\`subjectKey\` = ${oldKey}, ${newKey}, \`subjectKey\`) WHERE ${sql.raw(`\`${t.column}\``)} = ${drop.id} OR \`subjectKey\` = ${oldKey}`
        : sql`UPDATE IGNORE ${sql.raw(`\`${t.table}\``)} SET ${sql.raw(`\`${t.column}\``)} = ${keep.id} WHERE ${sql.raw(`\`${t.column}\``)} = ${drop.id}`);
    }
    for (const table of BY_KEY_ONLY) await tx.execute(sql`UPDATE IGNORE ${sql.raw(`\`${table}\``)} SET \`subjectKey\` = ${newKey} WHERE \`subjectKey\` = ${oldKey}`);
    // The retired copy: kept for history, off every program, named so nobody picks it by mistake.
    await tx.update(patients).set({
      name: `${drop.name.replace(MERGED_RE, "").trim()} (merged into #${keep.id})`.slice(0, 255),
      ccmEnrollmentStatus: "inactive",
      bhiEnrollmentStatus: drop.bhiEnrollmentStatus === "active" ? "inactive" : drop.bhiEnrollmentStatus,
      apcmEnrollmentStatus: drop.apcmEnrollmentStatus === "active" ? "inactive" : drop.apcmEnrollmentStatus,
      rpmStatus: drop.rpmStatus === "enrolled" || drop.rpmStatus === "active" ? "inactive" : drop.rpmStatus,
      rpmEnrolled: false,
      notes: [drop.notes, `Duplicate record: merged into patient #${keep.id} on ${localDateStr()}.`].filter(Boolean).join("\n\n"),
      updatedAt: new Date(),
    }).where(eq(patients.id, drop.id));
  });

  let billingTask = false;
  if (doubled.length) {
    await createTask(actor, {
      title: `Possible duplicate claim: ${keep.name}`.slice(0, 250),
      description: [
        `This patient was on the CCM roster twice. The two records were merged into #${keep.id} (the other is #${drop.id}, now marked merged).`,
        "Both records have a claim for the same program and month:",
        ...doubled.map((c) => `• ${c.program.toUpperCase()} ${c.month}`),
        "",
        "Please check whether one claim should be voided. The duplicate's claim stays on record #" + drop.id + ".",
      ].join("\n"),
      patientId: keep.id, assignedRole: "billing", priority: "high", category: "administrative", dueDate: localDateStr(), sourceType: "duplicate_claim", sourceRef: String(drop.id),
    });
    billingTask = true;
  }
  return { keep: keep.id, drop: drop.id, movedItems: movable.length, stayedItems: stuck.length, billingTask };
}

/** Who automatic merges are recorded under (the first admin, named for what it is). */
export async function mergeActor(): Promise<WorkspaceActor> {
  const [a] = await (await db()).select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  if (!a) throw new Error("No admin user to record the merge under.");
  return { id: a.id, name: "Duplicate merge", role: "admin", clinicIds: null };
}

/** Merge every duplicate pair the record matcher found (dry run unless apply). Counts only. */
export async function mergeDuplicates(actor: WorkspaceActor, opts: { apply: boolean; deadline: number }) {
  const { duplicatePairs } = await import("./rosterMatch");
  const pairs = await duplicatePairs();
  const history = await ccmHistory(Array.from(new Set(pairs.flat())));
  if (!opts.apply) return { pairs: pairs.length, merged: 0, done: true };
  let merged = 0, moved = 0, stayed = 0, billingTasks = 0, skipped = 0, done = true;
  const used = new Set<number>();
  for (const [a, b] of pairs) {
    if (Date.now() > opts.deadline) { done = false; break; }
    if (used.has(a) || used.has(b)) { done = false; continue; } // a third copy: next run
    const r = await mergePair(actor, a, b, history, { nameFromId: b });
    if ("skipped" in r) { skipped++; continue; }
    used.add(a); used.add(b);
    merged++; moved += r.movedItems; stayed += r.stayedItems; if (r.billingTask) billingTasks++;
  }
  clearDirectoryCache();
  clearScheduleCache();
  const summary = { pairs: pairs.length, merged, monthlyItemsMoved: moved, monthlyItemsKeptOnRetiredCopy: stayed, billingTasks, skipped, done };
  console.log(`[merge-duplicates] ${JSON.stringify(summary)}`);
  return summary;
}

/** Completed CCM months per patient (the copy with more history is the one kept). */
async function ccmHistory(ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const hist = await (await db()).select({ pid: ccmTasks.patientId, n: sql<number>`count(*)` }).from(ccmTasks)
    .where(and(inArray(ccmTasks.patientId, ids), inArray(ccmTasks.status, ["completed", "ready_for_billing", "billed"]))).groupBy(ccmTasks.patientId);
  return new Map(hist.map((h) => [h.pid, Number(h.n)]));
}

/**
 * An admin confirms on Record matching that an unlinked roster record is the same person as a roster
 * patient already linked to Practice Fusion (e.g. the name was misspelled): merge them, keeping the
 * linked record's spelling.
 */
export async function mergeIntoLinked(actor: WorkspaceActor, rosterId: number, intoId: number) {
  if (rosterId === intoId) throw new WorkspaceError("Pick two different records.");
  const { linkedRosterIds } = await import("./rosterMatch");
  const linked = await linkedRosterIds();
  if (linked.has(rosterId)) throw new WorkspaceError("This record is already linked to Practice Fusion.");
  if (!linked.has(intoId)) throw new WorkspaceError("The other record isn't linked to Practice Fusion.");
  const r = await mergePair(actor, rosterId, intoId, await ccmHistory([rosterId, intoId]), { nameFromId: intoId });
  if ("skipped" in r) throw new WorkspaceError(r.skipped === "missing" ? "Record not found." : "One of these records was already merged.");
  clearDirectoryCache();
  clearScheduleCache();
  await audit(actor, "update_patient", { entityType: "patient", entityId: r.keep, description: `Duplicate roster record #${r.drop} merged into #${r.keep} (confirmed on Record matching)` });
  return r;
}

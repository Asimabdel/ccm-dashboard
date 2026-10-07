// Move one provider's active CCM patients to one care coordinator (2026-10-07, the practice's choice: all of
// Yilian's patients → Fatima Ali). The roster assignment moves (next months' worklists follow it), this month's
// open CCM / APCM worklist tasks move with their status and call history, and tasks already done this month
// (completed, ready to bill, billed, or reached and waiting on review / paperwork) stay completed and stay with
// the coordinator who did them. BHI tasks are left alone. IAM-only job "coordinator-transfer"; a dry run (counts)
// unless apply is true; apply returns what each row was before (ids only) so it can be undone.
import { and, eq, inArray, ne, or, isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { ccmTasks, patients, providers, users } from "../drizzle/schema";

/** This month's work that's done (or reached and only waiting on review / paperwork): stays as it is. */
export const DONE_STATUSES = ["completed", "ready_for_billing", "billed", "needs_provider_review", "documentation_incomplete", "needs_appointment", "declined_ccm"];
/** Not work any more: left alone. */
const CLOSED_STATUSES = ["cancelled", "inactive"];

export async function transferCoordinator(input: { provider: string; to: string; month: string; apply?: boolean }) {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  const provs = (await d.select({ id: providers.id, name: providers.name }).from(providers)).filter((p) => p.name.toLowerCase().includes(input.provider.trim().toLowerCase()));
  if (provs.length !== 1) return { problem: `provider "${input.provider}": ${provs.length ? `matches ${provs.map((p) => p.name).join(", ")}` : "none"}` };
  const people = await d.select({ id: users.id, name: users.name, role: users.role }).from(users);
  const targets = people.filter((u) => (u.name ?? "").toLowerCase() === input.to.trim().toLowerCase());
  if (targets.length !== 1) return { problem: `coordinator "${input.to}": ${targets.length} accounts with that exact name` };
  const target = targets[0]!;
  if (target.role !== "staff") return { problem: `${target.name} is ${target.role}, not a care coordinator` };
  const nameOf = new Map(people.map((u) => [u.id, u.name ?? `User #${u.id}`]));
  const label = (id: number | null) => (id ? nameOf.get(id) ?? `User #${id}` : "(unassigned)");

  const pats = await d.select({ id: patients.id, staffId: patients.assignedStaffId }).from(patients)
    .where(and(eq(patients.providerId, provs[0]!.id), eq(patients.ccmEnrollmentStatus, "active"), sql`${patients.name} NOT LIKE '%(merged into #%'`));
  const ids = pats.map((p) => p.id);
  const toMove = pats.filter((p) => p.staffId !== target.id);
  const tasks = ids.length ? await d.select({ id: ccmTasks.id, patientId: ccmTasks.patientId, program: ccmTasks.program, staffId: ccmTasks.assignedStaffId, status: ccmTasks.status })
    .from(ccmTasks).where(and(inArray(ccmTasks.patientId, ids), eq(ccmTasks.month, input.month), inArray(ccmTasks.program, ["ccm", "apcm"]), or(isNull(ccmTasks.assignedStaffId), ne(ccmTasks.assignedStaffId, target.id)))) : [];
  const moveTasks = tasks.filter((t) => !DONE_STATUSES.includes(t.status as string) && !CLOSED_STATUSES.includes(t.status as string));
  const keepTasks = tasks.filter((t) => DONE_STATUSES.includes(t.status as string));
  const bhiTasks = ids.length ? await d.select({ staffId: ccmTasks.assignedStaffId, n: sql<number>`COUNT(*)` }).from(ccmTasks)
    .where(and(inArray(ccmTasks.patientId, ids), eq(ccmTasks.month, input.month), eq(ccmTasks.program, "bhi"))).groupBy(ccmTasks.assignedStaffId) : [];

  const tally = <T,>(rows: T[], key: (r: T) => string) => rows.reduce<Record<string, number>>((m, r) => { const k = key(r); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const summary = {
    provider: provs[0]!.name, to: target.name, month: input.month,
    activeCcmPatients: pats.length, alreadyWithTarget: pats.length - toMove.length,
    patientsMovingFrom: tally(toMove, (p) => label(p.staffId)),
    tasksMoving: { total: moveTasks.length, byProgram: tally(moveTasks, (t) => t.program), byStatus: tally(moveTasks, (t) => t.status as string), from: tally(moveTasks, (t) => label(t.staffId)) },
    doneThisMonthStaying: { total: keepTasks.length, byStatus: tally(keepTasks, (t) => t.status as string), with: tally(keepTasks.filter((t) => t.program === "ccm"), (t) => label(t.staffId)) },
    bhiTasksLeftAlone: Object.fromEntries(bhiTasks.map((b) => [label(b.staffId), Number(b.n)])),
  };
  if (!input.apply) return { dryRun: true, ...summary };

  const now = new Date();
  for (let i = 0; i < toMove.length; i += 200) {
    await d.update(patients).set({ assignedStaffId: target.id, updatedAt: now }).where(inArray(patients.id, toMove.slice(i, i + 200).map((p) => p.id)));
  }
  for (let i = 0; i < moveTasks.length; i += 200) {
    const chunk = moveTasks.slice(i, i + 200).map((t) => t.id);
    await d.update(ccmTasks).set({ assignedStaffId: target.id, updatedAt: now }).where(inArray(ccmTasks.id, chunk));
    await d.update(ccmTasks).set({ status: "assigned" }).where(and(inArray(ccmTasks.id, chunk), eq(ccmTasks.status, "not_started")));
  }
  return {
    applied: true, ...summary,
    undo: { patients: toMove.map((p) => [p.id, p.staffId]), tasks: moveTasks.map((t) => [t.id, t.staffId, t.status]) },
  };
}

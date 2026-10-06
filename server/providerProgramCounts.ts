// IAM-only check (2026-10-06): how many patients each provider has in each program — CCM, BHI and APCM
// active — so questions like "how many active CCM patients are Yilian's?" get a number. Counts only:
// provider names and numbers, no patient names or ids. Retired duplicate copies ("(merged into #N)") don't count.
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { ccmTasks, patients, providers, users } from "../drizzle/schema";

export async function providerProgramCounts() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  const active = (col: typeof patients.ccmEnrollmentStatus | typeof patients.bhiEnrollmentStatus | typeof patients.apcmEnrollmentStatus) =>
    sql<number>`SUM(CASE WHEN ${col} = 'active' THEN 1 ELSE 0 END)`;
  const rows = await d.select({
    providerId: patients.providerId, providerName: providers.name,
    ccm: active(patients.ccmEnrollmentStatus), bhi: active(patients.bhiEnrollmentStatus), apcm: active(patients.apcmEnrollmentStatus),
  }).from(patients).leftJoin(providers, eq(providers.id, patients.providerId))
    .where(sql`${patients.name} NOT LIKE '%(merged into #%'`)
    .groupBy(patients.providerId, providers.name);
  const list = rows.map((r) => ({ provider: r.providerName ?? "(no provider)", ccm: Number(r.ccm ?? 0), bhi: Number(r.bhi ?? 0), apcm: Number(r.apcm ?? 0) }))
    .filter((r) => r.ccm || r.bhi || r.apcm)
    .sort((a, b) => b.ccm - a.ccm);
  return { byProvider: list, totals: list.reduce((t, r) => ({ ccm: t.ccm + r.ccm, bhi: t.bhi + r.bhi, apcm: t.apcm + r.apcm }), { ccm: 0, bhi: 0, apcm: 0 }) };
}

/**
 * Each care coordinator's list (2026-10-06): active CCM patients assigned to them on the roster, and this
 * month's CCM and BHI worklist (assigned / done / still to do). Optionally only one provider's patients
 * (by provider name). Counts and staff names only.
 */
export async function coordinatorListCounts(month: string, providerName?: string) {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  let providerId: number | null = null;
  if (providerName) {
    const all = await d.select({ id: providers.id, name: providers.name }).from(providers);
    const hits = all.filter((p) => p.name.toLowerCase().includes(providerName.trim().toLowerCase()));
    if (hits.length !== 1) return { month, provider: providerName, problem: hits.length ? `matches ${hits.map((h) => h.name).join(", ")}` : "no provider by that name" };
    providerId = hits[0]!.id;
  }
  const notMerged = providerId
    ? and(sql`${patients.name} NOT LIKE '%(merged into #%'`, eq(patients.providerId, providerId))!
    : sql`${patients.name} NOT LIKE '%(merged into #%'`;
  const done = sql`${ccmTasks.status} IN ('completed', 'ready_for_billing', 'billed')`;
  const [roster, work, people] = await Promise.all([
    d.select({ staffId: patients.assignedStaffId, n: sql<number>`COUNT(*)` }).from(patients)
      .where(and(eq(patients.ccmEnrollmentStatus, "active"), notMerged)).groupBy(patients.assignedStaffId),
    d.select({ staffId: ccmTasks.assignedStaffId, program: ccmTasks.program, n: sql<number>`COUNT(*)`, done: sql<number>`SUM(CASE WHEN ${done} THEN 1 ELSE 0 END)` })
      .from(ccmTasks).innerJoin(patients, eq(patients.id, ccmTasks.patientId))
      .where(and(eq(ccmTasks.month, month), inArray(ccmTasks.program, ["ccm", "bhi"]), notMerged)).groupBy(ccmTasks.assignedStaffId, ccmTasks.program),
    d.select({ id: users.id, name: users.name, role: users.role }).from(users),
  ]);
  const ids = new Set<number | null>([...roster.map((r) => r.staffId), ...work.map((w) => w.staffId)]);
  const who = new Map(people.map((p) => [p.id, p]));
  const list = Array.from(ids).map((staffId) => {
    const p = staffId ? who.get(staffId) : undefined;
    const w = (program: "ccm" | "bhi") => {
      const r = work.find((x) => x.staffId === staffId && x.program === program);
      const n = Number(r?.n ?? 0), dn = Number(r?.done ?? 0);
      return { assigned: n, done: dn, toDo: n - dn };
    };
    return { coordinator: staffId ? p?.name ?? `User #${staffId}` : "(unassigned)", role: p?.role ?? null, activeCcmOnRoster: Number(roster.find((r) => r.staffId === staffId)?.n ?? 0), ccmWorklist: w("ccm"), bhiWorklist: w("bhi") };
  }).filter((r) => r.activeCcmOnRoster || r.ccmWorklist.assigned || r.bhiWorklist.assigned)
    .sort((a, b) => (a.coordinator === "(unassigned)" ? 1 : b.coordinator === "(unassigned)" ? -1 : b.ccmWorklist.assigned - a.ccmWorklist.assigned || b.activeCcmOnRoster - a.activeCcmOnRoster));
  return { month, provider: providerName ?? "all", byCoordinator: list };
}

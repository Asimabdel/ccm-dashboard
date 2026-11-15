// Payroll in Master Billing (owner only, 2026-11-12): each person's estimated gross pay for a month or
// a pay period, from time-clock hours (server/workforceDb.ts getTimesheet) and the pay rates the owner
// enters here. For the month / period in progress it also projects the total from the shifts still
// on the schedule. Rates are only ever read and written through the Master Billing router.
import { and, asc, eq, gt, gte, inArray, lt, lte } from "drizzle-orm";
import { getDb } from "./db";
import { appointments, ccmTasks, clinics, jobRoles, payRates, providers, shifts, staffProfiles, users } from "../drizzle/schema";
import { getTimesheet } from "./workforceDb";
import { paySettings } from "./payPeriodsDb";
import { audit, WorkspaceError, type WorkspaceActor } from "./workspaceDb";
import { estimatePay, rateLabel, type PayBasis, type PayRateInput, type PayType } from "../shared/payroll";
import { payPeriodOf, recentPayPeriods } from "../shared/payPeriods";
import { addDays, isValidDateStr, localDateStr, shiftMinutes, weekStart } from "../shared/workforce";
import { LUNCH_EXPECTED_AFTER } from "../shared/attendance";
import { SUGGESTED_LUNCH_MINUTES } from "../shared/punchFixes";
import { SEEN_STATUSES, nameKey } from "../shared/workspace";
import { WORKED_DAY_MIN, dayKind } from "../shared/providerReport";

/** Care calls that count as completed (the Reports page's completion count). */
const CCM_COMPLETED = ["completed", "ready_for_billing", "billed"] as const;

/**
 * Days worked by providers paid per day, keyed by their user account: past days with 3+ patients seen on the
 * schedule (the provider report's rule; a person seen twice in a day counts once), plus days from today on
 * with 3+ visits still booked (for "on track for").
 */
async function providerWorkDays(userIds: number[], from: string, to: string, today: string) {
  const out = new Map<number, { worked: Set<string>; ahead: Set<string> }>();
  if (!userIds.length) return out;
  const d = await db();
  const links = await d.select({ id: providers.id, userId: providers.userId }).from(providers).where(inArray(providers.userId, userIds));
  if (!links.length) return out;
  const userOf = new Map(links.map((l) => [l.id, l.userId!]));
  const visits = await d.select({ providerId: appointments.providerId, patientId: appointments.patientId, name: appointments.patientName, dob: appointments.dateOfBirth, status: appointments.status, date: appointments.date })
    .from(appointments).where(and(inArray(appointments.providerId, links.map((l) => l.id)), gte(appointments.date, from), lte(appointments.date, to)));
  const cells = new Map<string, { userId: number; date: string; seen: Set<string>; booked: number; stillScheduled: number }>();
  for (const v of visits) {
    const userId = v.providerId ? userOf.get(v.providerId) : undefined;
    if (!userId || v.status === "cancelled") continue;
    const k = `${userId}|${v.date}`;
    const c = cells.get(k) ?? { userId, date: v.date, seen: new Set<string>(), booked: 0, stillScheduled: 0 };
    cells.set(k, c);
    c.booked++;
    if ((SEEN_STATUSES as string[]).includes(v.status)) c.seen.add(v.patientId ? `p:${v.patientId}` : `n:${nameKey(v.name)}|${v.dob ? new Date(v.dob).toISOString().slice(0, 10) : ""}`);
    else if (v.status === "scheduled" && v.date < today) c.stillScheduled++;
  }
  for (const c of Array.from(cells.values())) {
    const days = out.get(c.userId) ?? { worked: new Set<string>(), ahead: new Set<string>() };
    out.set(c.userId, days);
    if (dayKind({ date: c.date, seen: c.seen.size, stillScheduled: c.stillScheduled }, today) === "worked") days.worked.add(c.date);
    else if (c.date >= today && c.booked >= WORKED_DAY_MIN) days.ahead.add(c.date);
  }
  return out;
}

/** Care calls each person completed per (clinic-local) day, for people paid per CCM. */
async function ccmsByDay(userIds: number[], from: string, to: string) {
  const out = new Map<number, Map<string, number>>();
  if (!userIds.length) return out;
  const d = await db();
  // A day of slack each side of the UTC range; days are then read in clinic time.
  const rows = await d.select({ userId: ccmTasks.completedByStaffId, at: ccmTasks.completedAt }).from(ccmTasks)
    .where(and(inArray(ccmTasks.completedByStaffId, userIds), inArray(ccmTasks.status, [...CCM_COMPLETED]),
      gte(ccmTasks.completedAt, new Date(`${addDays(from, -1)}T00:00:00Z`)), lt(ccmTasks.completedAt, new Date(`${addDays(to, 2)}T00:00:00Z`))));
  for (const r of rows) {
    if (!r.userId || !r.at) continue;
    const day = localDateStr(new Date(r.at));
    const m = out.get(r.userId) ?? new Map<string, number>();
    out.set(r.userId, m);
    m.set(day, (m.get(day) ?? 0) + 1);
  }
  return out;
}

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

/** The first month with time-clock hours (clock history starts Oct 5, 2026). */
const FIRST_MONTH = "2026-10";
const monthEnd = (m: string) => addDays(`${addMonth(m)}-01`, -1);
function addMonth(m: string, n = 1): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

export type PayrollInput = { view: "month"; month: string } | { view: "period"; start: string };

/** Estimated pay for everyone on the time clock (and anyone with a pay rate) for a month or pay period. */
export async function payroll(actor: WorkspaceActor, input: PayrollInput) {
  const d = await db();
  const today = localDateStr();
  const settings = await paySettings();
  let from: string, to: string, basis: PayBasis;
  if (input.view === "month") {
    if (!/^\d{4}-\d{2}$/.test(input.month)) throw new WorkspaceError("Pick a month.");
    from = `${input.month}-01`; to = monthEnd(input.month); basis = "month";
  } else {
    if (!isValidDateStr(input.start)) throw new WorkspaceError("Pick a pay period.");
    const p = payPeriodOf(input.start, settings.anchor);
    from = p.start; to = p.through; basis = "period";
  }
  const workedTo = to < today ? to : today;
  // Whole Monday–Sunday weeks around the range, so overtime in a week that crosses its edge lands right.
  const weekFrom = weekStart(from), weekTo = addDays(weekStart(to), 6);
  const sheet = from <= today ? await getTimesheet(weekFrom, weekTo < today ? weekTo : today) : { people: [] as Awaited<ReturnType<typeof getTimesheet>>["people"] };
  // Shifts still to come (for the projection), with the usual lunch taken out.
  const future = to > today
    ? await d.select({ userId: shifts.userId, date: shifts.date, startTime: shifts.startTime, endTime: shifts.endTime }).from(shifts)
      .where(and(gt(shifts.date, today), lte(shifts.date, weekTo), eq(shifts.status, "scheduled")))
    : [];
  const rateRows = await d.select().from(payRates).orderBy(asc(payRates.startDate), asc(payRates.id));
  const ratesBy = new Map<number, (typeof rateRows)[number][]>();
  for (const r of rateRows) ratesBy.set(r.userId, [...(ratesBy.get(r.userId) ?? []), r]);
  const paidBy = (t: PayType) => Array.from(ratesBy.entries()).filter(([, rs]) => rs.some((r) => r.payType === t)).map(([id]) => id);
  const [provDays, ccmDays] = await Promise.all([providerWorkDays(paidBy("per_day"), from, to, today), ccmsByDay(paidBy("per_ccm"), from, to)]);

  // People: everyone the timesheet shows, plus anyone with a pay rate (e.g. salaried staff off the clock).
  const fromSheet = new Map(sheet.people.filter((p) => p.usesTimeClock || p.totalMinutes > 0).map((p) => [p.userId, p]));
  const extraIds = Array.from(ratesBy.keys()).filter((id) => !fromSheet.has(id));
  const extra = extraIds.length
    ? await d.select({ userId: users.id, name: users.name, jobRoleName: jobRoles.name, homeClinicName: clinics.name }).from(users)
      .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id)).leftJoin(jobRoles, eq(jobRoles.id, staffProfiles.jobRoleId)).leftJoin(clinics, eq(clinics.id, staffProfiles.homeClinicId))
      .where(inArray(users.id, extraIds))
    : [];

  const rows = [...Array.from(fromSheet.values()).map((p) => ({ userId: p.userId, name: p.name, jobRoleName: p.jobRoleName, homeClinicName: p.homeClinicName, punches: p.punches })),
    ...extra.map((p) => ({ userId: p.userId, name: p.name ?? "Unknown", jobRoleName: p.jobRoleName, homeClinicName: p.homeClinicName, punches: [] as { workDate: string; minutes: number; clockOutAt: Date | null }[] }))]
    .map((p) => {
      const rates: PayRateInput[] = (ratesBy.get(p.userId) ?? []).map((r) => ({ payType: r.payType as PayType, amountCents: r.amountCents, overtime: r.overtime, startDate: r.startDate }));
      const worked = new Map<string, number>();
      for (const x of p.punches) worked.set(x.workDate, (worked.get(x.workDate) ?? 0) + x.minutes);
      // Providers paid per day: their days come from the schedule, not the time clock.
      const prov = provDays.get(p.userId);
      const ccmsPerDay = ccmDays.get(p.userId);
      const soFar = estimatePay({ from, to: workedTo, dayMinutes: worked, rates, basis, workedDays: prov?.worked, ccmsPerDay });
      let projected: ReturnType<typeof estimatePay> | null = null;
      if (to > today) {
        const withShifts = new Map(worked);
        for (const s of future.filter((x) => x.userId === p.userId)) {
          const m = shiftMinutes(s.startTime, s.endTime);
          withShifts.set(s.date, (withShifts.get(s.date) ?? 0) + m - (m > LUNCH_EXPECTED_AFTER ? SUGGESTED_LUNCH_MINUTES : 0));
        }
        projected = estimatePay({ from, to, dayMinutes: withShifts, rates, basis, workedDays: prov ? new Set([...Array.from(prov.worked), ...Array.from(prov.ahead)]) : undefined, ccmsPerDay });
      }
      const current = rates.length ? rates.filter((r) => r.startDate <= workedTo).at(-1) ?? rates[0]! : null;
      return {
        userId: p.userId, name: p.name, jobRoleName: p.jobRoleName, homeClinicName: p.homeClinicName,
        rate: current ? { ...current, label: rateLabel(current) } : null,
        rateChanges: rates.filter((r) => r.startDate > from && r.startDate <= to).length,
        soFar, projected,
        daysWorked: prov ? soFar.paidDays : new Set(p.punches.filter((x) => x.workDate >= from && x.workDate <= workedTo && x.minutes > 0).map((x) => x.workDate)).size,
        missedClockOuts: p.punches.filter((x) => x.workDate >= from && x.workDate <= workedTo && !x.clockOutAt && x.workDate < today).length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const months: string[] = [];
  for (let m = today.slice(0, 7); m >= FIRST_MONTH; m = addMonth(m, -1)) months.push(m);
  await audit(actor, "view_payroll", { entityType: "payroll", description: `Payroll ${input.view === "month" ? input.month : `pay period ${from}`}` });
  return {
    view: input.view, from, to, today, inProgress: to >= today, basis,
    months, periods: recentPayPeriods(today, settings.anchor, 8),
    rows,
    totals: {
      soFar: { totalCents: sum((r) => r.soFar.totalCents), overtimeCents: sum((r) => r.soFar.overtimeCents), regularMinutes: sum((r) => r.soFar.regularMinutes), overtimeMinutes: sum((r) => r.soFar.overtimeMinutes) },
      projectedCents: to > today ? sum((r) => (r.projected ?? r.soFar).totalCents) : null,
      missingRates: rows.filter((r) => !r.rate || r.soFar.unpricedDays > 0).length,
      missedClockOuts: sum((r) => r.missedClockOuts),
    },
  };
}

/** One person's pay rates, newest first. */
export async function payRateHistory(userId: number) {
  const d = await db();
  const rows = await d.select({ r: payRates, by: users.name }).from(payRates).leftJoin(users, eq(users.id, payRates.createdByUserId))
    .where(eq(payRates.userId, userId)).orderBy(asc(payRates.startDate), asc(payRates.id));
  return rows.map(({ r, by }) => ({ id: r.id, payType: r.payType as PayType, amountCents: r.amountCents, overtime: r.overtime, startDate: r.startDate, note: r.note, label: rateLabel({ payType: r.payType as PayType, amountCents: r.amountCents }), createdAt: r.createdAt, createdBy: by })).reverse();
}

/** Everyone who can be given a pay rate: staff with a Workforce profile (active). */
export async function payrollPeople() {
  const d = await db();
  return d.select({ userId: users.id, name: users.name, jobRoleName: jobRoles.name }).from(staffProfiles)
    .innerJoin(users, eq(users.id, staffProfiles.userId)).leftJoin(jobRoles, eq(jobRoles.id, staffProfiles.jobRoleId))
    .where(eq(staffProfiles.active, true)).orderBy(asc(users.name));
}

/** A pay rate from a start date on (a raise is a new rate; earlier months keep the old one). */
export async function setPayRate(actor: WorkspaceActor, input: { userId: number; payType: PayType; amountCents: number; overtime: boolean; startDate: string; note?: string | null }) {
  if (!isValidDateStr(input.startDate)) throw new WorkspaceError("Pick the date the rate starts.");
  if (input.amountCents <= 0) throw new WorkspaceError("Enter the pay amount.");
  if (input.payType === "hourly" && input.amountCents > 100_000) throw new WorkspaceError("That hourly rate looks too high. Salaries go in as a yearly amount.");
  if (input.payType === "per_day" && input.amountCents > 1_000_000) throw new WorkspaceError("That day rate looks too high. Salaries go in as a yearly amount.");
  if (input.payType === "per_ccm" && input.amountCents > 100_000) throw new WorkspaceError("That amount per CCM looks too high.");
  const d = await db();
  const [u] = await d.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, input.userId)).limit(1);
  if (!u) throw new WorkspaceError("That person wasn't found.", "NOT_FOUND");
  // Same person, same start date: the new one replaces it (fixing a typo).
  await d.delete(payRates).where(and(eq(payRates.userId, input.userId), eq(payRates.startDate, input.startDate)));
  await d.insert(payRates).values({
    userId: input.userId, payType: input.payType, amountCents: input.amountCents, overtime: input.payType === "hourly" ? input.overtime : false,
    startDate: input.startDate, note: input.note?.trim() ? input.note.trim().slice(0, 255) : null, createdByUserId: actor.id,
  });
  await audit(actor, "set_pay_rate", { entityType: "payRate", entityId: input.userId, description: `Set a pay rate for ${u.name ?? `user ${u.id}`} from ${input.startDate}` });
  return { ok: true };
}

/** Remove a rate entered by mistake. */
export async function removePayRate(actor: WorkspaceActor, id: number) {
  const d = await db();
  const [r] = await d.select({ id: payRates.id, userId: payRates.userId, startDate: payRates.startDate, name: users.name }).from(payRates).innerJoin(users, eq(users.id, payRates.userId)).where(eq(payRates.id, id)).limit(1);
  if (!r) throw new WorkspaceError("That rate wasn't found.", "NOT_FOUND");
  await d.delete(payRates).where(eq(payRates.id, id));
  await audit(actor, "set_pay_rate", { entityType: "payRate", entityId: r.userId, description: `Removed the pay rate for ${r.name ?? `user ${r.userId}`} from ${r.startDate}` });
  return { ok: true };
}

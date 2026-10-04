// Pay period sign-off (2026-10-04): every 2 weeks; staff confirm their hours, their manager approves, an
// admin closes the period (punches in it can't change any more) and downloads the QuickBooks sheet.
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, payPeriodSignoffs, punchRequests, users } from "../drizzle/schema";
import { getTimesheet } from "./workforceDb";
import { DEFAULT_PAY_ANCHOR, isMonday, payPeriodOf, recentPayPeriods } from "../shared/payPeriods";
import { addDays, localDateStr } from "../shared/workforce";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export class PayPeriodError extends Error {}
interface PaySettings { anchor: string; locked: string[] }
const KEY = "pay_periods";

export async function paySettings(): Promise<PaySettings> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
  const v = (row?.value ?? {}) as Partial<PaySettings>;
  return { anchor: v.anchor && isMonday(v.anchor) ? v.anchor : DEFAULT_PAY_ANCHOR, locked: Array.isArray(v.locked) ? v.locked : [] };
}
async function savePaySettings(s: PaySettings, userId: number) {
  await (await db()).insert(appSettings).values({ key: KEY, value: s, updatedByUserId: userId }).onDuplicateKeyUpdate({ set: { value: s, updatedByUserId: userId } });
}

/** Punches on a date in a closed pay period can't be added, changed or removed. */
export async function assertOpenDate(date: string) {
  const s = await paySettings();
  if (s.locked.includes(payPeriodOf(date, s.anchor).start)) throw new PayPeriodError("That pay period is closed for payroll. An admin reopens it (Workforce → Timesheets → Pay periods) to change hours.");
}

export async function setAnchor(userId: number, anchor: string) {
  if (!isMonday(anchor)) throw new PayPeriodError("Pay periods start on a Monday.");
  const s = await paySettings();
  if (s.locked.length) throw new PayPeriodError("Pay periods have already been closed, so the start day can't change.");
  await savePaySettings({ ...s, anchor }, userId);
}

export async function setLocked(userId: number, start: string, locked: boolean) {
  const s = await paySettings();
  const period = payPeriodOf(start, s.anchor);
  if (period.start !== start) throw new PayPeriodError("That isn't the first day of a pay period.");
  // Closing waits for the Sunday after (its hours count in this period) so a weekend shift isn't frozen out.
  if (locked && period.through >= localDateStr()) throw new PayPeriodError("A pay period can be closed from the Monday after it ends.");
  const set = new Set(s.locked);
  if (locked) set.add(start); else set.delete(start);
  await savePaySettings({ ...s, locked: Array.from(set).sort() }, userId);
}

/** Everyone's hours in a period with where their sign-off stands (managers: their office's staff). */
export async function periodSummary(start: string, scope: (userId: number) => boolean) {
  const s = await paySettings();
  const period = payPeriodOf(start, s.anchor);
  const sheet = await getTimesheet(period.start, period.through);
  const people = sheet.people.filter((p) => p.usesTimeClock || p.totalMinutes > 0).filter((p) => scope(p.userId));
  const d = await db();
  const ids = people.map((p) => p.userId);
  const [signoffs, pending, approvers] = await Promise.all([
    ids.length ? d.select().from(payPeriodSignoffs).where(and(inArray(payPeriodSignoffs.userId, ids), eq(payPeriodSignoffs.periodStart, period.start))) : [],
    ids.length ? d.select({ userId: punchRequests.userId }).from(punchRequests).where(and(inArray(punchRequests.userId, ids), eq(punchRequests.status, "pending"), gte(punchRequests.workDate, period.start), lte(punchRequests.workDate, period.through))) : [],
    d.select({ id: users.id, name: users.name }).from(users),
  ]);
  const nameOf = new Map(approvers.map((u) => [u.id, u.name]));
  return {
    period, locked: s.locked.includes(period.start), ended: period.end < localDateStr(), closable: period.through < localDateStr(), anchor: s.anchor,
    periods: recentPayPeriods(localDateStr(), s.anchor, 8).map((p) => ({ ...p, locked: s.locked.includes(p.start) })),
    people: people.map((p) => {
      const so = signoffs.find((x) => x.userId === p.userId);
      return {
        userId: p.userId, name: p.name, jobRoleName: p.jobRoleName, homeClinicName: p.homeClinicName,
        regularMinutes: p.regularMinutes, overtimeMinutes: p.overtimeMinutes, totalMinutes: p.totalMinutes, daysWorked: p.daysWorked,
        missedClockOuts: p.missedClockOuts, pendingFixes: pending.filter((x) => x.userId === p.userId).length,
        confirmedAt: so?.confirmedAt ?? null, confirmedChanged: !!so?.confirmedAt && so.confirmedMinutes !== p.totalMinutes,
        approvedAt: so?.approvedAt ?? null, approvedBy: so?.approvedByUserId ? nameOf.get(so.approvedByUserId) ?? null : null,
        approvedChanged: !!so?.approvedAt && so.approvedMinutes !== p.totalMinutes,
        punches: p.punches,
      };
    }),
  };
}

async function personTotals(userId: number, period: { start: string; through: string }) {
  const sheet = await getTimesheet(period.start, period.through);
  return sheet.people.find((p) => p.userId === userId) ?? null;
}

/** My Schedule: the current and last pay period, my hours by day and my confirmation. */
export async function myPayPeriods(userId: number) {
  const s = await paySettings();
  const today = localDateStr();
  const [cur, prev] = recentPayPeriods(today, s.anchor, 2);
  const d = await db();
  const out = [];
  for (const period of [prev!, cur!]) {
    const t = await personTotals(userId, period);
    const [so] = await d.select().from(payPeriodSignoffs).where(and(eq(payPeriodSignoffs.userId, userId), eq(payPeriodSignoffs.periodStart, period.start))).limit(1);
    const byDay = new Map<string, number>();
    for (const p of t?.punches ?? []) byDay.set(p.workDate, (byDay.get(p.workDate) ?? 0) + p.minutes);
    out.push({
      ...period, current: period.start === cur!.start, ended: period.end < today, locked: s.locked.includes(period.start),
      totalMinutes: t?.totalMinutes ?? 0, regularMinutes: t?.regularMinutes ?? 0, overtimeMinutes: t?.overtimeMinutes ?? 0, missedClockOuts: t?.missedClockOuts ?? 0,
      days: Array.from({ length: 14 }, (_, i) => addDays(period.start, i)).map((date) => ({ date, minutes: byDay.get(date) ?? 0 })).filter((x) => x.minutes > 0),
      confirmedAt: so?.confirmedAt ?? null, confirmedChanged: !!so?.confirmedAt && so.confirmedMinutes !== (t?.totalMinutes ?? 0), approvedAt: so?.approvedAt ?? null,
    });
  }
  return out;
}

/** "My hours are right" — once the period has ended and nothing is missing. */
export async function confirmMyHours(userId: number, start: string) {
  const s = await paySettings();
  const period = payPeriodOf(start, s.anchor);
  if (period.start !== start) throw new PayPeriodError("That isn't a pay period.");
  if (period.end >= localDateStr()) throw new PayPeriodError("You can confirm your hours once the pay period has ended.");
  const t = await personTotals(userId, period);
  if (t?.missedClockOuts) throw new PayPeriodError("A day is missing its clock-out. Use Fix a punch first.");
  const d = await db();
  const pending = await d.select({ id: punchRequests.id }).from(punchRequests).where(and(eq(punchRequests.userId, userId), eq(punchRequests.status, "pending"), gte(punchRequests.workDate, period.start), lte(punchRequests.workDate, period.through))).limit(1);
  if (pending.length) throw new PayPeriodError("A punch fix is still waiting for your manager. Confirm once it's decided.");
  const minutes = t?.totalMinutes ?? 0;
  await d.insert(payPeriodSignoffs).values({ userId, periodStart: start, confirmedAt: new Date(), confirmedMinutes: minutes })
    .onDuplicateKeyUpdate({ set: { confirmedAt: new Date(), confirmedMinutes: minutes } });
  return { minutes };
}

/** The manager approves someone's hours for a period. */
export async function approveHours(managerId: number, userId: number, start: string) {
  const s = await paySettings();
  const period = payPeriodOf(start, s.anchor);
  if (period.start !== start) throw new PayPeriodError("That isn't a pay period.");
  if (period.end >= localDateStr()) throw new PayPeriodError("Hours can be approved once the pay period has ended.");
  if (s.locked.includes(start)) throw new PayPeriodError("This pay period is already closed.");
  if (managerId === userId) throw new PayPeriodError("You can't approve your own hours.");
  const t = await personTotals(userId, period);
  if (t?.missedClockOuts) throw new PayPeriodError("They have a day with no clock-out. Fix it on the timesheet first.");
  const minutes = t?.totalMinutes ?? 0;
  await (await db()).insert(payPeriodSignoffs).values({ userId, periodStart: start, approvedByUserId: managerId, approvedAt: new Date(), approvedMinutes: minutes })
    .onDuplicateKeyUpdate({ set: { approvedByUserId: managerId, approvedAt: new Date(), approvedMinutes: minutes } });
  return { minutes };
}

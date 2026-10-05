// Fixing clock-in / clock-out times (2026-10-05): the "Needs fixing" list, the day view, "Looks right" /
// "Wasn't in" marks, closing the matching manager alert tasks once a day is fixed, and the automatic
// clock-out for people who forget (shared/punchFixes has the rules).
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { getDb } from "./db";
import { clinics, jobRoles, punchRequests, shifts, staffProfiles, timeClockReviews, timeOffRequests, timePunches, users, workTaskActivities, workTasks } from "../drizzle/schema";
import { addDays, attendanceTracked, localDateStr, localMinutes } from "../shared/workforce";
import { clinicHhmm, clinicInstant } from "../shared/attendance";
import { TASK_REFS_FOR, autoClockOutAt, findPunchProblems, shiftForPunch, type FixPerson, type PunchProblem } from "../shared/punchFixes";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export class PunchFixError extends Error {}
type Scope = (userId: number) => boolean;
/** How far back the Needs fixing list looks. */
export const FIX_LOOKBACK_DAYS = [14, 30, 60] as const;

/** Everyone on the time clock (plus anyone who punched) with their shifts, punches, time off and reviews in [from, to]. */
async function load(from: string, to: string, scope: Scope, onlyUserId?: number) {
  const d = await db();
  const [profiles, punchRows] = await Promise.all([
    d.select({ userId: users.id, name: users.name, usesTimeClock: staffProfiles.usesTimeClock, active: staffProfiles.active, clockStartDate: staffProfiles.clockStartDate, jobRoleName: jobRoles.name, homeClinicName: clinics.name })
      .from(staffProfiles).innerJoin(users, eq(users.id, staffProfiles.userId))
      .leftJoin(jobRoles, eq(jobRoles.id, staffProfiles.jobRoleId))
      .leftJoin(clinics, eq(clinics.id, staffProfiles.homeClinicId)),
    d.select({ p: timePunches, clinicName: clinics.name, userName: users.name }).from(timePunches)
      .innerJoin(users, eq(users.id, timePunches.userId)).leftJoin(clinics, eq(clinics.id, timePunches.clinicId))
      .where(and(gte(timePunches.workDate, from), lte(timePunches.workDate, to), onlyUserId ? eq(timePunches.userId, onlyUserId) : undefined)),
  ]);
  const ids = new Set<number>();
  for (const r of profiles) if (r.usesTimeClock && r.active) ids.add(r.userId);
  for (const r of punchRows) ids.add(r.p.userId);
  const userIds = Array.from(ids).filter((id) => scope(id) && (!onlyUserId || id === onlyUserId));
  if (!userIds.length) return { people: [], profiles, punchRows: [], shiftRows: [] };
  const [shiftRows, offRows, reviewRows] = await Promise.all([
    d.select({ s: shifts, clinicName: clinics.name }).from(shifts).leftJoin(clinics, eq(clinics.id, shifts.clinicId))
      .where(and(inArray(shifts.userId, userIds), gte(shifts.date, from), lte(shifts.date, to))),
    d.select().from(timeOffRequests).where(and(inArray(timeOffRequests.userId, userIds), eq(timeOffRequests.status, "approved"), lte(timeOffRequests.startDate, to), gte(timeOffRequests.endDate, from))),
    d.select().from(timeClockReviews).where(and(inArray(timeClockReviews.userId, userIds), gte(timeClockReviews.date, from), lte(timeClockReviews.date, to))),
  ]);
  const profileBy = new Map(profiles.map((p) => [p.userId, p]));
  const people: (FixPerson & { jobRoleName: string | null; homeClinicName: string | null; usesTimeClock: boolean })[] = userIds.map((userId) => {
    const pr = profileBy.get(userId);
    const offDates = new Set<string>();
    for (const o of offRows.filter((x) => x.userId === userId)) {
      for (let day = o.startDate < from ? from : o.startDate; day <= o.endDate && day <= to; day = addDays(day, 1)) offDates.add(day);
    }
    return {
      userId,
      name: pr?.name ?? punchRows.find((r) => r.p.userId === userId)?.userName ?? "Unknown",
      jobRoleName: pr?.jobRoleName ?? null,
      homeClinicName: pr?.homeClinicName ?? null,
      usesTimeClock: !!pr?.usesTimeClock,
      tracked: (date: string) => attendanceTracked(pr, date) && !!pr?.active,
      shifts: shiftRows.filter((r) => r.s.userId === userId).map((r) => ({ id: r.s.id, date: r.s.date, startTime: r.s.startTime, endTime: r.s.endTime, status: r.s.status })),
      punches: punchRows.filter((r) => r.p.userId === userId).map((r) => r.p),
      offDates,
      reviewed: new Set(reviewRows.filter((r) => r.userId === userId).map((r) => `${r.date}|${r.ref}`)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { people, profiles, punchRows, shiftRows };
}

function problemsFor(people: FixPerson[], from: string, now = new Date()): PunchProblem[] {
  return findPunchProblems(people, { from, today: localDateStr(now), nowMinutes: localMinutes(now), now });
}

/** Workforce → Timesheets → Needs fixing: every punch problem plus the fix-my-punch requests waiting. */
export async function needsFixing(scope: Scope, days = 14) {
  const today = localDateStr();
  const from = addDays(today, -days);
  const { people } = await load(from, today, scope);
  const problems = problemsFor(people, from);
  const d = await db();
  const pending = await d.select({ r: punchRequests, userName: users.name }).from(punchRequests).innerJoin(users, eq(users.id, punchRequests.userId))
    .where(eq(punchRequests.status, "pending"));
  const punchIds = pending.map((x) => x.r.punchId).filter((x): x is number => !!x);
  const current = punchIds.length ? await d.select().from(timePunches).where(inArray(timePunches.id, punchIds)) : [];
  const requests = pending.filter((x) => scope(x.r.userId)).map(({ r, userName }) => {
    const p = current.find((c) => c.id === r.punchId);
    return {
      id: r.id, userId: r.userId, name: userName ?? "Unknown", date: r.workDate, reason: r.reason, createdAt: r.createdAt,
      current: p ? { clockIn: clinicHhmm(p.clockInAt), clockOut: p.clockOutAt ? clinicHhmm(p.clockOutAt) : null } : null,
      requested: { clockIn: r.clockInAt ? clinicHhmm(r.clockInAt) : null, clockOut: r.clockOutAt ? clinicHhmm(r.clockOutAt) : null },
    };
  }).sort((a, b) => b.date.localeCompare(a.date));
  return { from, today, problems, requests, fixCount: problems.filter((p) => p.severity === "fix").length + requests.length, checkCount: problems.filter((p) => p.severity === "check").length };
}

/** Workforce → Timesheets → Day: everyone's punches next to their schedule for one date. */
export async function dayView(date: string, scope: Scope) {
  const today = localDateStr();
  if (date > today) throw new PunchFixError("Pick today or an earlier day.");
  const { people, punchRows, shiftRows } = await load(date, date, scope);
  const problems = problemsFor(people, date);
  const rows = people.map((p) => {
    const myShifts = shiftRows.filter((r) => r.s.userId === p.userId)
      .map((r) => ({ id: r.s.id, startTime: r.s.startTime, endTime: r.s.endTime, status: r.s.status, clinicName: r.clinicName }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    const myPunches = punchRows.filter((r) => r.p.userId === p.userId).sort((a, b) => +a.p.clockInAt - +b.p.clockInAt).map(({ p: x, clinicName }) => {
      const s = shiftForPunch(x, p.shifts);
      return {
        id: x.id, clockInAt: x.clockInAt, clockOutAt: x.clockOutAt, clockIn: clinicHhmm(x.clockInAt), clockOut: x.clockOutAt ? clinicHhmm(x.clockOutAt) : null,
        minutes: x.clockOutAt ? Math.max(0, Math.round((+x.clockOutAt - +x.clockInAt) / 60000)) : 0, minutesLate: x.minutesLate,
        lunch: x.outReason === "lunch", auto: x.outReason === "auto", note: x.note, edited: !!x.editedByUserId, clinicName,
        shift: s ? { startTime: s.startTime, endTime: s.endTime } : null,
      };
    });
    return {
      userId: p.userId, name: p.name, jobRoleName: p.jobRoleName, homeClinicName: p.homeClinicName, usesTimeClock: p.usesTimeClock,
      off: p.offDates.has(date), shifts: myShifts, punches: myPunches,
      workedMinutes: myPunches.reduce((s, x) => s + x.minutes, 0),
      onTheClock: date === today && myPunches.some((x) => !x.clockOutAt),
      problems: problems.filter((x) => x.userId === p.userId),
    };
  }).filter((r) => r.usesTimeClock || r.punches.length || r.shifts.length);
  return { date, today, rows };
}

/** "Looks right" on an automatic clock-out. */
export async function confirmAutoOut(punchId: number, byUserId: number) {
  const d = await db();
  const [p] = await d.select().from(timePunches).where(eq(timePunches.id, punchId)).limit(1);
  if (!p) throw new PunchFixError("Punch not found.");
  if (p.outReason !== "auto") return { userId: p.userId, date: p.workDate };
  await d.update(timePunches).set({ outReason: "auto_ok", editedByUserId: byUserId }).where(eq(timePunches.id, punchId));
  return { userId: p.userId, date: p.workDate };
}

/** "Wasn't in" / "Looks right" / "Keep" / "They left at lunch": the problem stops showing. */
export async function dismissProblem(input: { userId: number; date: string; ref: string }, byUserId: number) {
  await (await db()).insert(timeClockReviews).ignore().values({ userId: input.userId, date: input.date, ref: input.ref.slice(0, 40), reviewedByUserId: byUserId });
}

/** Once a person's day has no problems of a kind left, close the matching manager alert tasks (late / no-show …). */
export async function resolveAlertTasks(userId: number, date: string, byUserId: number) {
  const d = await db();
  const open = await d.select({ id: workTasks.id, sourceRef: workTasks.sourceRef }).from(workTasks)
    .where(and(eq(workTasks.sourceType, "attendance"), inArray(workTasks.status, ["open", "in_progress", "waiting"])));
  const mine = open.filter((t) => (t.sourceRef ?? "").startsWith(`${userId}:${date}:`));
  if (!mine.length) return 0;
  const { people } = await load(date, date, (id) => id === userId, userId);
  const left = new Set(problemsFor(people, date).flatMap((p) => TASK_REFS_FOR[p.kind]));
  const answerable = new Set(Object.values(TASK_REFS_FOR).flat());
  let closed = 0;
  for (const t of mine) {
    const kind = (t.sourceRef ?? "").split(":")[2] ?? "";
    if (!answerable.has(kind) || left.has(kind)) continue;
    await d.update(workTasks).set({ status: "completed", completedAt: new Date() }).where(eq(workTasks.id, t.id));
    await d.insert(workTaskActivities).values([
      { taskId: t.id, userId: byUserId, type: "status_changed" as const, meta: { to: "completed" } },
      { taskId: t.id, userId: byUserId, type: "comment" as const, body: "Fixed on the timesheet." },
    ]);
    closed++;
  }
  return closed;
}

/**
 * Every 5 minutes (from the workforce alerts job): open punches from today or yesterday whose shift ended
 * 2+ hours ago get clocked out at the scheduled end; with no shift, after 12 hours on the clock. Skips
 * closed pay periods. Returns what it closed (for the reminder to the person and the manager's task).
 */
export async function autoClockOuts(now: Date = new Date()) {
  const d = await db();
  const today = localDateStr(now);
  const open = await d.select().from(timePunches).where(and(isNull(timePunches.clockOutAt), gte(timePunches.workDate, addDays(today, -1))));
  if (!open.length) return [];
  const dayShifts = await d.select().from(shifts).where(and(inArray(shifts.userId, Array.from(new Set(open.map((p) => p.userId)))), gte(shifts.date, addDays(today, -1)), lte(shifts.date, today)));
  const { assertOpenDate } = await import("./payPeriodsDb");
  const closed: { punchId: number; userId: number; date: string; clockOut: string; byShift: boolean }[] = [];
  for (const p of open) {
    const s = shiftForPunch(p, dayShifts.filter((x) => x.userId === p.userId));
    const at = autoClockOutAt({ clockInAt: p.clockInAt, shift: s, now });
    if (!at) continue;
    if (await assertOpenDate(p.workDate).then(() => false, () => true)) continue;
    const res = await d.update(timePunches).set({ clockOutAt: at, outReason: "auto", note: p.note ?? "Clocked out automatically" })
      .where(and(eq(timePunches.id, p.id), isNull(timePunches.clockOutAt)));
    if (!Number((res as unknown as [{ affectedRows?: number }])[0]?.affectedRows)) continue;
    const byShift = !!s && clinicInstant(s.date, s.endTime).getTime() > +p.clockInAt;
    closed.push({ punchId: p.id, userId: p.userId, date: p.workDate, clockOut: clinicHhmm(at), byShift });
  }
  return closed;
}

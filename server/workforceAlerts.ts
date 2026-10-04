// The time clock's reminders and manager alerts, every 5 minutes (2026-10-04, the practice's choices).
// For people on the time clock with a shift today:
//   • clock-in reminder at the start, a second nudge 15 minutes late (and their office manager is told),
//     "still on lunch?" after an hour, "you're still clocked in" 15 minutes after the shift ends;
//   • an hour after the shift: no-show, didn't clock out, didn't come back from lunch, worked 6+ hours with
//     no break — each a task for their office manager (else the time-off approver, else the admins);
//   • once a week, a heads-up when someone is on course for more than 40 hours.
// Reminders go to the person in MyPCP (notification; the page shows a banner and pop-up) and, if they turned
// it on with their own cell, by text from the practice number. Every reminder / alert goes once (workforceAlerts).
// Mondays after 8 AM: a perfect-attendance shout-out for last week in the Everyone channel (names only).
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, clinics, shifts, staffProfiles, timeOffRequests, timePunches, users, workforceAlerts } from "../drizzle/schema";
import { REMOTE_LABEL, notify } from "./workforceDb";
import { approverFor } from "./scheduleRequestsDb";
import { addDays, attendanceTracked, fmtDay, fmtTime, localDateStr, localMinutes, timeToMinutes, weekStart } from "../shared/workforce";
import {
  END_OF_DAY_AFTER, LATE_ALERT_AFTER, LUNCH_EXPECTED_AFTER, WEEKLY_REGULAR_MINUTES, clockNudge, dayWork, perfectWeek, shortStaffName, type PunchLike,
} from "../shared/attendance";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

type Person = { userId: number; name: string; homeClinicId: number | null; usesTimeClock: boolean; clockStartDate: string | null; mobilePhone: string | null; textReminders: boolean };
type ShiftRow = typeof shifts.$inferSelect;
type PunchRow = typeof timePunches.$inferSelect;

/** Claim a reminder / alert (false = already sent, by this run or an overlapping one). */
async function claim(userId: number, date: string, ref: string): Promise<boolean> {
  const res = await (await db()).insert(workforceAlerts).ignore().values({ userId, date, ref });
  return Number((res as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0) > 0;
}

async function remind(p: Person, text: string, counts: { reminders: number; texts: number }) {
  await notify([p.userId], "Time clock", text);
  counts.reminders++;
  if (p.textReminders && p.mobilePhone) {
    const { sendStaffText } = await import("./textsDb");
    const r = await sendStaffText(p.mobilePhone, `MyPCP: ${text} Reply STOP to stop these texts.`);
    if (r.sent) counts.texts++;
  }
}

/** A task for the person's office manager (else the time-off approver, else the admins). */
async function managerAlert(counts: { byKind: Record<string, number> }, p: Person, a: { date: string; ref: string; title: string; detail: string; priority: "low" | "normal" | "high"; notifyNow?: boolean }) {
  const kind = a.ref.split(":")[0]!;
  counts.byKind[kind] = (counts.byKind[kind] ?? 0) + 1;
  const d = await db();
  const approver = await approverFor(p.userId);
  const [admin] = await d.select({ id: users.id }).from(users).where(eq(users.role, "admin")).orderBy(asc(users.id)).limit(1);
  const actorId = approver.assignedUserId ?? admin?.id;
  if (!actorId) return;
  const { createTask } = await import("./workspaceDb");
  const task = await createTask({ id: actorId, name: "MyPCP", role: "admin", clinicIds: null }, {
    title: a.title,
    description: `${a.detail}\n\nFrom the time clock. Fix any punch on Workforce → Timesheets, or ask ${p.name.split(" ")[0]} to send a "Fix my punch" request.`,
    assignedUserId: approver.assignedUserId,
    assignedRole: approver.assignedUserId ? null : "admin",
    priority: a.priority,
    category: "administrative",
    dueDate: localDateStr(),
    sourceType: "attendance",
    sourceRef: `${p.userId}:${a.date}:${a.ref}`.slice(0, 60),
  }).catch(() => null);
  const taskId = task && typeof task === "object" && "id" in task ? Number((task as { id: number }).id) : null;
  if (taskId) await d.update(workforceAlerts).set({ taskId }).where(and(eq(workforceAlerts.userId, p.userId), eq(workforceAlerts.date, a.date), eq(workforceAlerts.ref, a.ref)));
  if (a.notifyNow) await notify(approver.userIds, a.title, a.detail);
}

/** Which of today's punches belong to a shift (punches attach to the shift they were made for). */
function punchesFor(s: ShiftRow, mine: PunchRow[], shiftCount: number): PunchRow[] {
  if (shiftCount === 1) return mine;
  return mine.filter((x) => x.shiftId === s.id);
}

export async function runWorkforceAlerts(now: Date = new Date()) {
  const d = await db();
  const today = localDateStr(now);
  const nowMin = localMinutes(now);
  const counts = { reminders: 0, texts: 0, alerts: 0, shoutout: false, byKind: {} as Record<string, number> };
  const people: Person[] = (await d.select({
    userId: staffProfiles.userId, name: users.name, homeClinicId: staffProfiles.homeClinicId, usesTimeClock: staffProfiles.usesTimeClock,
    clockStartDate: staffProfiles.clockStartDate, mobilePhone: staffProfiles.mobilePhone, textReminders: staffProfiles.textReminders,
  }).from(staffProfiles).innerJoin(users, eq(users.id, staffProfiles.userId))
    .where(and(eq(staffProfiles.usesTimeClock, true), eq(staffProfiles.active, true)))).map((r) => ({ ...r, name: r.name ?? "Employee" }));
  const tracked = people.filter((p) => attendanceTracked(p, today));
  if (!tracked.length) return counts;
  const ids = tracked.map((p) => p.userId);
  const monday = weekStart(today);
  const [todays, weekShifts, punches, weekPunches, off, clinicRows] = await Promise.all([
    d.select().from(shifts).where(and(inArray(shifts.userId, ids), eq(shifts.date, today), eq(shifts.status, "scheduled"))).orderBy(asc(shifts.startTime)),
    d.select().from(shifts).where(and(inArray(shifts.userId, ids), gte(shifts.date, monday), lte(shifts.date, addDays(monday, 6)), eq(shifts.status, "scheduled"))),
    d.select().from(timePunches).where(and(inArray(timePunches.userId, ids), eq(timePunches.workDate, today))),
    d.select().from(timePunches).where(and(inArray(timePunches.userId, ids), gte(timePunches.workDate, monday), lte(timePunches.workDate, today))),
    d.select({ userId: timeOffRequests.userId }).from(timeOffRequests).where(and(eq(timeOffRequests.status, "approved"), lte(timeOffRequests.startDate, today), gte(timeOffRequests.endDate, today))),
    d.select({ id: clinics.id, name: clinics.name }).from(clinics),
  ]);
  const offToday = new Set(off.map((o) => o.userId));
  const clinicName = new Map(clinicRows.map((c) => [c.id, c.name]));
  const where = (s: ShiftRow) => (s.clinicId ? `at ${clinicName.get(s.clinicId) ?? "the clinic"}` : `(${REMOTE_LABEL.toLowerCase()})`);

  for (const p of tracked) {
    const mine = todays.filter((s) => s.userId === p.userId);
    const myPunches = punches.filter((x) => x.userId === p.userId);
    if (mine.length && !offToday.has(p.userId)) {
      for (const s of mine) {
        const start = timeToMinutes(s.startTime), end = timeToMinutes(s.endTime);
        const sp = punchesFor(s, myPunches, mine.length);
        const nudge = clockNudge({ shift: s, punches: sp as PunchLike[], nowMinutes: nowMin, now });
        const first = p.name.split(" ")[0];
        if ((nudge === "clock_in" || nudge === "late") && nowMin < start + LATE_ALERT_AFTER && await claim(p.userId, today, `in:${s.id}`)) {
          await remind(p, `Your shift ${where(s)} ${nowMin >= start ? "started" : "starts"} at ${fmtTime(s.startTime)}. Clock in at mypcpcare.com.`, counts);
        }
        if (!sp.length && nowMin >= start + LATE_ALERT_AFTER && nowMin < end && await claim(p.userId, today, `late:${s.id}`)) {
          await remind(p, `You're not clocked in yet for your ${fmtTime(s.startTime)} shift ${where(s)}. Clock in, or let your manager know.`, counts);
          await managerAlert(counts, p, { date: today, ref: `late:${s.id}`, priority: "normal", notifyNow: true,
            title: `Late: ${p.name} hasn't clocked in (${fmtTime(s.startTime)} shift ${where(s)})`,
            detail: `${p.name} was scheduled ${fmtTime(s.startTime)}–${fmtTime(s.endTime)} ${where(s)} today and isn't clocked in ${LATE_ALERT_AFTER} minutes after the start.` });
          counts.alerts++;
        }
        if (nudge === "end_lunch" && await claim(p.userId, today, `lunch:${s.id}`)) {
          await remind(p, `You've been on lunch for an hour. Tap End lunch when you're back.`, counts);
        }
        if (nudge === "clock_out" && await claim(p.userId, today, `out:${s.id}`)) {
          await remind(p, `Your shift ended at ${fmtTime(s.endTime)} and you're still clocked in. Clock out if you've left.`, counts);
        }
        if (nowMin >= end + END_OF_DAY_AFTER) {
          const open = sp.some((x) => !x.clockOutAt);
          const last = sp.slice().sort((a, b) => +a.clockInAt - +b.clockInAt).at(-1);
          if (!sp.length && await claim(p.userId, today, `noshow:${s.id}`)) {
            await managerAlert(counts, p, { date: today, ref: `noshow:${s.id}`, priority: "high", notifyNow: true,
              title: `No-show: ${p.name} (${fmtTime(s.startTime)}–${fmtTime(s.endTime)} ${where(s)})`,
              detail: `${p.name} was scheduled today and never clocked in. If they called out or had time off, mark the shift called out on Workforce → Schedule.` });
            counts.alerts++;
          } else if (open && await claim(p.userId, today, `missedout:${s.id}`)) {
            await managerAlert(counts, p, { date: today, ref: `missedout:${s.id}`, priority: "normal",
              title: `Didn't clock out: ${p.name}, ${fmtDay(today)}`,
              detail: `${p.name}'s shift ended at ${fmtTime(s.endTime)} and they're still clocked in. Until it's fixed, the day counts 0 hours.` });
            counts.alerts++;
          } else if (last?.clockOutAt && last.outReason === "lunch" && await claim(p.userId, today, `lunchback:${s.id}`)) {
            await managerAlert(counts, p, { date: today, ref: `lunchback:${s.id}`, priority: "normal",
              title: `Didn't clock back in after lunch: ${p.name}, ${fmtDay(today)}`,
              detail: `${p.name} started lunch and never clocked back in. If they worked the afternoon, add the missing time.` });
            counts.alerts++;
          }
        }
      }
      // After the day's last shift: 6+ hours worked with no break.
      const lastEnd = Math.max(...mine.map((s) => timeToMinutes(s.endTime)));
      if (nowMin >= lastEnd + END_OF_DAY_AFTER && myPunches.every((x) => x.clockOutAt)) {
        const w = dayWork(myPunches as PunchLike[], now);
        if (w.workedMinutes >= LUNCH_EXPECTED_AFTER && !w.tookBreak && await claim(p.userId, today, "nolunch")) {
          await managerAlert(counts, p, { date: today, ref: "nolunch", priority: "low",
            title: `No lunch break: ${p.name}, ${fmtDay(today)}`,
            detail: `${p.name} worked ${Math.floor(w.workedMinutes / 60)}h ${w.workedMinutes % 60}m today without a break on the clock.` });
          counts.alerts++;
        }
      }
    }
    // Heading into overtime this week (once a week): hours so far + the rest of this week's shifts.
    const worked = weekPunches.filter((x) => x.userId === p.userId).reduce((sum, x) => sum + Math.max(0, Math.round(((x.clockOutAt ? +x.clockOutAt : +now) - +x.clockInAt) / 60000)), 0);
    const ahead = weekShifts.filter((s) => s.userId === p.userId && (s.date > today || (s.date === today && timeToMinutes(s.endTime) > nowMin)))
      .reduce((sum, s) => sum + Math.max(0, timeToMinutes(s.endTime) - Math.max(s.date === today ? nowMin : 0, timeToMinutes(s.startTime))), 0);
    if (worked + ahead > WEEKLY_REGULAR_MINUTES + 30 && await claim(p.userId, monday, "ot")) {
      const hours = Math.round((worked + ahead) / 60);
      const done = ahead === 0; // no more shifts this week: it's overtime already worked
      await managerAlert(counts, p, { date: monday, ref: "ot", priority: "normal",
        title: done ? `Overtime, week of ${fmtDay(monday, { month: "short", day: "numeric" })}: ${p.name} (about ${hours}h)` : `Heading into overtime: ${p.name} (about ${hours}h this week)`,
        detail: done
          ? `${p.name} worked ${Math.floor(worked / 60)}h ${worked % 60}m in the week of ${fmtDay(monday)}, over 40 hours, so overtime pay applies. Check the punches on Workforce → Timesheets (lunch breaks weren't on the clock before Oct 5).`
          : `${p.name} has worked ${Math.floor(worked / 60)}h ${worked % 60}m so far this week (since ${fmtDay(monday)}) and is scheduled for about ${Math.round(ahead / 60)}h more, over 40 hours. Adjust the schedule now if overtime isn't approved.` });
      counts.alerts++;
    }
  }

  counts.shoutout = await mondayShoutout(now, people);
  return counts;
}

/** Mondays after 8 AM: last week's perfect attendance in the Everyone channel (names only; nobody else is mentioned). */
async function mondayShoutout(now: Date, people: Person[]): Promise<boolean> {
  const today = localDateStr(now);
  if (today !== weekStart(today) || localMinutes(now) < 8 * 60) return false;
  const d = await db();
  const [done] = await d.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "attendance_shoutout")).limit(1);
  if ((done?.value as { week?: string } | undefined)?.week === today) return false;
  await d.insert(appSettings).values({ key: "attendance_shoutout", value: { week: today } }).onDuplicateKeyUpdate({ set: { value: { week: today } } });
  const from = addDays(today, -7), to = addDays(today, -1);
  const ids = people.map((p) => p.userId);
  if (!ids.length) return false;
  const [weekShifts, weekPunches] = await Promise.all([
    d.select().from(shifts).where(and(inArray(shifts.userId, ids), gte(shifts.date, from), lte(shifts.date, to), eq(shifts.status, "scheduled"))),
    d.select().from(timePunches).where(and(inArray(timePunches.userId, ids), gte(timePunches.workDate, from), lte(timePunches.workDate, to))),
  ]);
  const winners = people.filter((p) => {
    const mine = weekShifts.filter((s) => s.userId === p.userId && attendanceTracked(p, s.date));
    const myPunches = weekPunches.filter((x) => x.userId === p.userId);
    const missedOut = myPunches.some((x) => !x.clockOutAt);
    return perfectWeek(mine.map((s) => {
      const first = myPunches.filter((x) => x.shiftId === s.id).sort((a, b) => +a.clockInAt - +b.clockInAt)[0];
      return { firstPunchLate: first ? first.minutesLate : null, missedClockOut: missedOut };
    }));
  }).map((p) => shortStaffName(p.name)).sort();
  if (!winners.length) return false;
  const { postBotMessage } = await import("./chatDb");
  await postBotMessage("everyone", `🎉 Perfect attendance last week (${fmtDay(from, { month: "short", day: "numeric" })} – ${fmtDay(to, { month: "short", day: "numeric" })}), on time for every shift: ${winners.join(", ")}${winners.at(-1)!.endsWith(".") ? "" : "."} Thank you!`);
  return true;
}

// One-time clock history reset (2026-10-05, the practice's choice: "we are starting fresh with October 5").
// Removes every punch, fix-my-punch request, reminder / manager alert record, "Time clock" notification,
// attendance / punch-fix task and punch review from before the cutoff, and starts attendance tracking (late /
// no-show) on the cutoff for everyone. Schedules (shifts) stay. IAM-only job "clock-reset"; a dry run returns
// the counts and the old punches (for an offline copy) unless apply is true. Take an RDS snapshot first.
import { and, eq, inArray, isNull, like, lt, or } from "drizzle-orm";
import { getDb } from "./db";
import {
  chatMessages, notifications, payPeriodSignoffs, punchRequests, staffProfiles, timeClockReviews, timePunches, users, workTaskActivities, workTasks, workforceAlerts,
} from "../drizzle/schema";
import { clinicHhmm, clinicInstant } from "../shared/attendance";
import { isValidDateStr } from "../shared/workforce";

export async function resetClockHistory(input: { before: string; apply?: boolean }) {
  if (!isValidDateStr(input.before)) throw new Error("before must be YYYY-MM-DD");
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  const before = input.before;
  const cutoff = clinicInstant(before, "00:00");

  const punches = await d.select({ p: timePunches, name: users.name }).from(timePunches).innerJoin(users, eq(users.id, timePunches.userId))
    .where(lt(timePunches.workDate, before)).orderBy(timePunches.workDate, timePunches.clockInAt);
  const requests = await d.select({ id: punchRequests.id }).from(punchRequests).where(lt(punchRequests.workDate, before));
  const requestIds = new Set(requests.map((r) => String(r.id)));
  const clockTasks = await d.select({ id: workTasks.id, sourceType: workTasks.sourceType, sourceRef: workTasks.sourceRef }).from(workTasks)
    .where(inArray(workTasks.sourceType, ["attendance", "punch_fix"]));
  // Attendance tasks are keyed `${userId}:${date}:${kind}`; punch-fix tasks by request id.
  const taskIds = clockTasks.filter((t) => t.sourceType === "punch_fix" ? requestIds.has(t.sourceRef ?? "") : ((t.sourceRef ?? "").split(":")[1] ?? "9999") < before).map((t) => t.id);
  const alerts = await d.select({ id: workforceAlerts.id }).from(workforceAlerts).where(lt(workforceAlerts.date, before));
  const reviews = await d.select({ id: timeClockReviews.id }).from(timeClockReviews).where(lt(timeClockReviews.date, before));
  const signoffs = await d.select({ id: payPeriodSignoffs.id }).from(payPeriodSignoffs).where(lt(payPeriodSignoffs.periodStart, before));
  const clockNotes = await d.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.type, "workforce"), lt(notifications.createdAt, cutoff),
    or(eq(notifications.title, "Time clock"), like(notifications.title, "Late:%"), like(notifications.title, "No-show:%"))));
  const profiles = await d.select({ userId: staffProfiles.userId }).from(staffProfiles)
    .where(and(eq(staffProfiles.usesTimeClock, true), or(isNull(staffProfiles.clockStartDate), lt(staffProfiles.clockStartDate, before))));
  const shoutouts = await d.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.kind, "bot"), like(chatMessages.body, "%Perfect attendance last week%"), lt(chatMessages.createdAt, clinicInstant(before, "23:59"))));

  const counts = {
    punches: punches.length, people: new Set(punches.map((x) => x.p.userId)).size, fixRequests: requests.length, tasks: taskIds.length,
    alertRecords: alerts.length, notifications: clockNotes.length, reviews: reviews.length, paySignoffs: signoffs.length,
    clockStartMovedFor: profiles.length, shoutoutMessages: shoutouts.length,
  };
  if (!input.apply) {
    // For the offline copy (staff names and times only).
    const rows = punches.map(({ p, name }) => ({
      employee: name ?? "Unknown", date: p.workDate, clockIn: clinicHhmm(p.clockInAt), clockOut: p.clockOutAt ? clinicHhmm(p.clockOutAt) : "",
      minutes: p.clockOutAt ? Math.round((+p.clockOutAt - +p.clockInAt) / 60000) : 0, minutesLate: p.minutesLate, outReason: p.outReason ?? "", note: p.note ?? "",
    }));
    return { dryRun: true, before, counts, rows };
  }

  if (taskIds.length) {
    await d.delete(workTaskActivities).where(inArray(workTaskActivities.taskId, taskIds));
    await d.delete(workTasks).where(inArray(workTasks.id, taskIds));
  }
  if (requests.length) await d.delete(punchRequests).where(inArray(punchRequests.id, requests.map((r) => r.id)));
  if (punches.length) await d.delete(timePunches).where(lt(timePunches.workDate, before));
  if (alerts.length) await d.delete(workforceAlerts).where(lt(workforceAlerts.date, before));
  if (reviews.length) await d.delete(timeClockReviews).where(lt(timeClockReviews.date, before));
  if (signoffs.length) await d.delete(payPeriodSignoffs).where(lt(payPeriodSignoffs.periodStart, before));
  if (clockNotes.length) await d.delete(notifications).where(inArray(notifications.id, clockNotes.map((n) => n.id)));
  if (profiles.length) await d.update(staffProfiles).set({ clockStartDate: before }).where(inArray(staffProfiles.userId, profiles.map((p) => p.userId)));
  return { applied: true, before, counts };
}

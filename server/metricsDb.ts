// "My progress" numbers for the top bar: today's counts for the signed-in employee, picked by
// role (see shared/metrics.ts). Counts only — nothing here returns patient details.
import { and, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  appSettings, appointmentStatusEvents, appointments, ccmTasks, monthlyGoals, phoneCalls, providerEscalations,
  providers, refillRequests, staffProfiles, timePunches, workTaskActivities, workTasks,
} from "../drizzle/schema";
import { clinicLocalToUtc, nameKey, OPEN_TASK_STATUSES } from "../shared/workspace";
import { addDays, localDateStr } from "../shared/workforce";
import {
  GOAL_METRICS, ROLE_GOAL_KEYS, fmtMinutes, orderMetrics, usualPerDay, weekdaysLeftInMonth,
  type DailyGoals, type Metric, type MetricKey, type MyMetrics,
} from "../shared/metrics";

const GOALS_KEY = "daily_goals";
const CCM_DONE = ["completed", "ready_for_billing", "billed"] as const;
const PHONE_ROLES = ["staff", "front_desk"];

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export async function getDailyGoals(): Promise<DailyGoals> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, GOALS_KEY)).limit(1);
  return (row?.value as DailyGoals | undefined) ?? {};
}

export async function setDailyGoals(userId: number, goals: DailyGoals) {
  // Keep only known roles/metrics with sensible numbers.
  const clean: DailyGoals = {};
  for (const [role, keys] of Object.entries(ROLE_GOAL_KEYS)) {
    for (const k of keys) {
      const v = goals[role]?.[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000 && k in GOAL_METRICS) (clean[role] ??= {})[k] = Math.round(v);
    }
  }
  await (await db()).insert(appSettings).values({ key: GOALS_KEY, value: clean, updatedByUserId: userId })
    .onDuplicateKeyUpdate({ set: { value: clean, updatedByUserId: userId } });
  return clean;
}

/** Group instants by clinic-local day and count them. */
function byDay(dates: (Date | null)[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of dates) if (d) { const k = localDateStr(new Date(d)); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}

/** Calls that count as "made": every outbound attempt, plus inbound calls that were answered. */
const counts = (c: { direction: string; durationSec: number }) => c.direction === "outbound" || c.durationSec > 0;

export async function myMetrics(user: { id: number; name: string | null; role: string }): Promise<MyMetrics> {
  const d = await db();
  const today = localDateStr();
  const start = clinicLocalToUtc(today, "00:00");
  const end = clinicLocalToUtc(addDays(today, 1), "00:00");
  const since = clinicLocalToUtc(addDays(today, -30), "00:00");
  const month = today.slice(0, 7);
  const role = user.role;
  const goals = (await getDailyGoals())[role] ?? {};
  const out: Metric[] = [];
  const add = (m: Metric) => out.push({ ...m, goal: m.goal ?? goals[m.key] ?? null });

  // ---- Phone: my calls (click-to-call and the RingCentral call-log sync) ----
  // Synced calls whose RingCentral extension isn't linked to a login still count when the extension name is mine.
  const myKey = user.name ? nameKey(user.name) : "";
  const extNames = myKey
    ? (await d.selectDistinct({ n: phoneCalls.rcExtensionName }).from(phoneCalls).where(and(isNull(phoneCalls.userId), gte(phoneCalls.startedAt, since))))
      .map((r) => r.n).filter((n): n is string => !!n && nameKey(n) === myKey)
    : [];
  const mine = extNames.length
    ? sql`(${phoneCalls.userId} = ${user.id} OR (${phoneCalls.userId} IS NULL AND ${inArray(phoneCalls.rcExtensionName, extNames)}))`
    : eq(phoneCalls.userId, user.id);
  const calls = await d.select({ startedAt: phoneCalls.startedAt, direction: phoneCalls.direction, durationSec: phoneCalls.durationSec, outcome: phoneCalls.outcome })
    .from(phoneCalls).where(and(mine, gte(phoneCalls.startedAt, since)));
  if (PHONE_ROLES.includes(role) || calls.length) {
    const made = calls.filter(counts);
    const todayCalls = made.filter((c) => c.startedAt >= start && c.startedAt < end);
    const booked = calls.filter((c) => c.outcome === "booked");
    add({ key: "calls", label: "Calls today", value: todayCalls.length, usual: usualPerDay(byDay(made.map((c) => c.startedAt)), today), href: "/opportunities?tab=fill" });
    add({ key: "booked", label: "Appointments booked", value: booked.filter((c) => c.startedAt >= start && c.startedAt < end).length, usual: usualPerDay(byDay(booked.map((c) => c.startedAt)), today) });
    const talkMin = Math.round(todayCalls.reduce((s, c) => s + c.durationSec, 0) / 60);
    add({ key: "talk", label: "Time on the phone", value: talkMin, display: fmtMinutes(talkMin) });
  }

  // ---- Care coordinators: care calls completed (today and this month vs goal) ----
  if (role === "staff") {
    const done = await d.select({ completedAt: ccmTasks.completedAt }).from(ccmTasks)
      .where(and(eq(ccmTasks.completedByStaffId, user.id), gte(ccmTasks.completedAt, since)));
    const perDay = byDay(done.map((r) => r.completedAt));
    add({ key: "care_calls", label: "Care calls completed", value: perDay.get(today) ?? 0, usual: usualPerDay(perDay, today), href: "/worklist" });
    const [m] = await d.select({ n: sql<number>`count(*)` }).from(ccmTasks)
      .where(and(eq(ccmTasks.assignedStaffId, user.id), eq(ccmTasks.month, month), inArray(ccmTasks.status, [...CCM_DONE])));
    const [g] = await d.select({ goal: monthlyGoals.goal }).from(monthlyGoals).where(and(eq(monthlyGoals.userId, user.id), eq(monthlyGoals.month, month))).limit(1);
    const value = Number(m?.n ?? 0);
    const goal = g?.goal ?? 0;
    const left = weekdaysLeftInMonth(today);
    add({
      key: "ccm_month", label: "Care calls this month", value, goal: goal || null, goalLabel: "monthly goal",
      hint: goal > value ? `About ${Math.ceil((goal - value) / Math.max(1, left))} a day to reach your goal (${left} workdays left)` : goal ? "Monthly goal reached" : "No monthly goal set yet",
      href: "/coordinator",
    });
  }

  // ---- Front desk / MAs: patients checked in or roomed (Patient Flow) ----
  if (role === "front_desk" || role === "medical_assistant") {
    const targets = role === "front_desk" ? ["arrived", "checked_in"] : ["roomed"];
    const ev = await d.select({ appointmentId: appointmentStatusEvents.appointmentId, createdAt: appointmentStatusEvents.createdAt }).from(appointmentStatusEvents)
      .where(and(eq(appointmentStatusEvents.changedByUserId, user.id), inArray(appointmentStatusEvents.toStatus, targets), gte(appointmentStatusEvents.createdAt, since)));
    // One per visit per day (arrived → checked in is still one patient).
    const seen = new Set<string>();
    const unique = ev.filter((e) => { const k = `${e.appointmentId}|${localDateStr(new Date(e.createdAt))}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const perDay = byDay(unique.map((e) => e.createdAt));
    add(role === "front_desk"
      ? { key: "checkins", label: "Patients checked in", value: perDay.get(today) ?? 0, usual: usualPerDay(perDay, today), href: "/patient-flow" }
      : { key: "roomed", label: "Patients roomed", value: perDay.get(today) ?? 0, usual: usualPerDay(perDay, today), href: "/patient-flow" });
  }

  // ---- Providers: today's schedule seen, and what's waiting on them ----
  if (role === "provider") {
    const provIds = (await d.select({ id: providers.id }).from(providers).where(eq(providers.userId, user.id))).map((p) => p.id);
    if (provIds.length) {
      const appts = await d.select({ status: appointments.status }).from(appointments).where(and(inArray(appointments.providerId, provIds), eq(appointments.date, today)));
      const booked = appts.filter((a) => a.status !== "cancelled" && a.status !== "no_show");
      add({ key: "seen", label: "Patients seen today", value: booked.filter((a) => a.status === "completed" || a.status === "checkout").length, goal: booked.length || null, goalLabel: "on your schedule", href: "/patient-flow" });
      const [rf] = await d.select({ n: sql<number>`count(*)` }).from(refillRequests).where(and(inArray(refillRequests.providerId, provIds), eq(refillRequests.status, "pending")));
      const [es] = await d.select({ n: sql<number>`count(*)` }).from(providerEscalations).where(and(inArray(providerEscalations.providerId, provIds), inArray(providerEscalations.escalationStatus, ["pending", "action_needed"])));
      const r = Number(rf?.n ?? 0), e = Number(es?.n ?? 0);
      add({ key: "waiting", label: "Waiting on you", value: r + e, hint: `${r} refill request${r === 1 ? "" : "s"}, ${e} escalation${e === 1 ? "" : "s"}`, href: r >= e ? "/refill-requests" : "/escalations" });
    }
  }

  // ---- Billing: this month's care-management claims ----
  if (role === "billing") {
    const rows = await d.select({ status: ccmTasks.status, n: sql<number>`count(*)` }).from(ccmTasks)
      .where(and(eq(ccmTasks.month, month), inArray(ccmTasks.status, ["ready_for_billing", "billed"]))).groupBy(ccmTasks.status);
    const n = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    add({ key: "ready_to_bill", label: "Ready to bill", value: n("ready_for_billing"), hint: "Care-management claims this month waiting to be billed", href: "/billing" });
    add({ key: "billed_month", label: "Billed this month", value: n("billed"), goal: n("billed") + n("ready_for_billing") || null, goalLabel: "ready + billed", href: "/billing" });
  }

  // ---- Admins: the practice today ----
  if (role === "admin") {
    const appts = await d.select({ status: appointments.status }).from(appointments).where(eq(appointments.date, today));
    const booked = appts.filter((a) => a.status !== "cancelled" && a.status !== "no_show");
    add({ key: "practice_visits", label: "Visits done (all clinics)", value: booked.filter((a) => a.status === "completed" || a.status === "checkout").length, goal: booked.length || null, goalLabel: "scheduled today", href: "/patient-flow" });
    const all = await d.select({ direction: phoneCalls.direction, durationSec: phoneCalls.durationSec, outcome: phoneCalls.outcome }).from(phoneCalls)
      .where(and(gte(phoneCalls.startedAt, start), lt(phoneCalls.startedAt, end)));
    const made = all.filter(counts);
    add({ key: "practice_calls", label: "Practice calls today", value: made.length, hint: `${all.filter((c) => c.outcome === "booked").length} booked an appointment` });
    const [cm] = await d.select({ n: sql<number>`count(*)` }).from(ccmTasks).where(and(eq(ccmTasks.month, month), inArray(ccmTasks.status, [...CCM_DONE])));
    const [cg] = await d.select({ n: sql<number>`coalesce(sum(${monthlyGoals.goal}), 0)` }).from(monthlyGoals).where(eq(monthlyGoals.month, month));
    add({ key: "practice_ccm", label: "Care calls this month (practice)", value: Number(cm?.n ?? 0), goal: Number(cg?.n ?? 0) || null, goalLabel: "team goals", href: "/admin" });
  }

  // ---- Everyone: My Work ----
  const acts = await d.select({ taskId: workTaskActivities.taskId, meta: workTaskActivities.meta, createdAt: workTaskActivities.createdAt }).from(workTaskActivities)
    .where(and(eq(workTaskActivities.userId, user.id), eq(workTaskActivities.type, "status_changed"), gte(workTaskActivities.createdAt, since)));
  const seenTask = new Set<string>();
  const doneAt = acts.filter((a) => a.meta?.to === "completed").filter((a) => { const k = `${a.taskId}|${localDateStr(new Date(a.createdAt))}`; if (seenTask.has(k)) return false; seenTask.add(k); return true; }).map((a) => a.createdAt);
  const donePerDay = byDay(doneAt);
  const [left] = await d.select({ n: sql<number>`count(*)` }).from(workTasks)
    .where(and(eq(workTasks.assignedUserId, user.id), inArray(workTasks.status, [...OPEN_TASK_STATUSES]), lte(workTasks.dueDate, today)));
  const leftN = Number(left?.n ?? 0);
  add({ key: "tasks_done", label: "Tasks done", value: donePerDay.get(today) ?? 0, usual: usualPerDay(donePerDay, today), href: "/my-work" });
  add({ key: "tasks_left", label: "Tasks due today or overdue", value: leftN, hint: leftN ? "Still open in My Work" : "All caught up", href: "/my-work" });

  // ---- Hours on the clock (people who use the time clock) ----
  const [prof] = await d.select({ uses: staffProfiles.usesTimeClock }).from(staffProfiles).where(eq(staffProfiles.userId, user.id)).limit(1);
  const punches = await d.select({ clockInAt: timePunches.clockInAt, clockOutAt: timePunches.clockOutAt }).from(timePunches)
    .where(and(eq(timePunches.userId, user.id), eq(timePunches.workDate, today)));
  if (prof?.uses || punches.length) {
    const now = Date.now();
    const mins = Math.round(punches.reduce((s, p) => s + Math.max(0, (p.clockOutAt ? new Date(p.clockOutAt).getTime() : now) - new Date(p.clockInAt).getTime()), 0) / 60000);
    const open = punches.some((p) => !p.clockOutAt);
    add({ key: "hours", label: "On the clock today", value: mins, display: fmtMinutes(mins), hint: open ? "Clocked in" : punches.length ? "Clocked out" : "Not clocked in yet", href: "/my-day" });
  }

  return { date: today, role, metrics: orderMetrics(role, out), goalKeys: (ROLE_GOAL_KEYS[role] ?? []) as MetricKey[] };
}

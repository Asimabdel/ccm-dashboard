// "My progress" numbers: a day's counts for one employee, picked by role (see shared/metrics.ts),
// and the same numbers for the whole team (admin "Team progress"). Counts only — nothing here
// returns patient details.
//
// Calls come from RingCentral's company call log (rcCallStats: every outside call, patient or
// not, credited to the extension that made or answered it), plus calls placed in MyPCP that the
// 10-minute sync hasn't reached yet. Without RingCentral connected, MyPCP's own call log is used.
import { and, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  appSettings, appointmentStatusEvents, appointments, ccmTasks, monthlyGoals, phoneCalls, providerEscalations,
  providers, rcCallStats, refillRequests, staffProfiles, timePunches, users, workTaskActivities, workTasks,
} from "../drizzle/schema";
import { clinicLocalToUtc, nameKey, OPEN_TASK_STATUSES } from "../shared/workspace";
import { addDays, localDateStr } from "../shared/workforce";
import {
  GOAL_METRICS, ROLE_GOAL_KEYS, fmtMinutes, orderMetrics, usualPerDay, weekdaysLeftInMonth,
  type DailyGoals, type Metric, type MetricKey, type MyMetrics,
} from "../shared/metrics";

const GOALS_KEY = "daily_goals";
const RC_STATE_KEY = "ringcentral_sync_state";
const CCM_DONE = ["completed", "ready_for_billing", "billed"] as const;
const PHONE_ROLES = ["staff", "front_desk"];
const TEAM_ROLES = ["admin", "office_manager", "staff", "provider", "billing", "front_desk", "medical_assistant"] as const;

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

async function readSetting<T>(key: string): Promise<T | null> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}

export async function getDailyGoals(): Promise<DailyGoals> {
  return (await readSetting<DailyGoals>(GOALS_KEY)) ?? {};
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

/** A call "made or taken": every outbound attempt, plus inbound calls someone answered. */
const madeOrTaken = (c: { direction: string; durationSec: number; answered?: boolean }) =>
  c.direction === "outbound" || (c.answered ?? c.durationSec > 0);

// ---- Shared context (computed once per request; the team view reuses it for everyone) ----

interface MetricsContext {
  goals: DailyGoals;
  /** RingCentral extension id → MyPCP user id (by email, else by name). */
  extToUser: Map<string, number>;
  /** Everything up to this instant has been read from RingCentral's call log. */
  rcCursor: Date | null;
  rcActive: boolean;
  rcLastSuccessAt: string | null;
}

async function loadContext(date: string): Promise<MetricsContext> {
  const d = await db();
  const goals = await getDailyGoals();
  const state = await readSetting<{ cursor?: string | null; lastSuccessAt?: string | null }>(RC_STATE_KEY);
  const [any] = await d.select({ id: rcCallStats.id }).from(rcCallStats).limit(1);
  const exts = await d.selectDistinct({ id: rcCallStats.extensionId, name: rcCallStats.extensionName, email: rcCallStats.extensionEmail })
    .from(rcCallStats).where(gte(rcCallStats.workDate, addDays(date, -45)));
  const people = await d.select({ id: users.id, name: users.name, email: users.email }).from(users).where(ne(users.role, "user"));
  const byEmail = new Map(people.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p.id]));
  const nameCount = new Map<string, number[]>();
  for (const p of people) if (p.name) { const k = nameKey(p.name); nameCount.set(k, [...(nameCount.get(k) ?? []), p.id]); }
  const extToUser = new Map<string, number>();
  for (const e of exts) {
    if (!e.id) continue;
    const byName = e.name ? nameCount.get(nameKey(e.name)) : undefined;
    const uid = (e.email ? byEmail.get(e.email.toLowerCase()) : undefined) ?? (byName?.length === 1 ? byName[0] : undefined);
    if (uid) extToUser.set(e.id, uid);
  }
  return { goals, extToUser, rcCursor: state?.cursor ? new Date(state.cursor) : null, rcActive: !!any, rcLastSuccessAt: state?.lastSuccessAt ?? null };
}

// ---- One person's phone (their own RingCentral line, plus calls placed in MyPCP) ----

type Person = { id: number; name: string | null; role: string };

/** A person's calls for a day, and per day over the 30 days before it. Counts only. */
async function phoneStats(user: Person, date: string, ctx: MetricsContext) {
  const d = await db();
  const start = clinicLocalToUtc(date, "00:00");
  const end = clinicLocalToUtc(addDays(date, 1), "00:00");
  const since = clinicLocalToUtc(addDays(date, -30), "00:00");
  const from = addDays(date, -30);
  const myExts = Array.from(ctx.extToUser.entries()).filter(([, u]) => u === user.id).map(([e]) => e);
  const rc = myExts.length
    ? await d.select({ workDate: rcCallStats.workDate, direction: rcCallStats.direction, durationSec: rcCallStats.durationSec, answered: rcCallStats.answered, missed: rcCallStats.missed })
      .from(rcCallStats).where(and(inArray(rcCallStats.extensionId, myExts), gte(rcCallStats.workDate, from), lte(rcCallStats.workDate, date)))
    : [];
  // MyPCP's call log: outcomes ("booked"), and calls the RingCentral sync hasn't covered yet.
  const myKey = user.name ? nameKey(user.name) : "";
  const extNames = myKey
    ? (await d.selectDistinct({ n: phoneCalls.rcExtensionName }).from(phoneCalls).where(and(isNull(phoneCalls.userId), gte(phoneCalls.startedAt, since))))
      .map((r) => r.n).filter((n): n is string => !!n && nameKey(n) === myKey)
    : [];
  const mine = extNames.length
    ? sql`(${phoneCalls.userId} = ${user.id} OR (${phoneCalls.userId} IS NULL AND ${inArray(phoneCalls.rcExtensionName, extNames)}))`
    : eq(phoneCalls.userId, user.id);
  const app = await d.select({ startedAt: phoneCalls.startedAt, direction: phoneCalls.direction, durationSec: phoneCalls.durationSec, outcome: phoneCalls.outcome, source: phoneCalls.source, rcSessionId: phoneCalls.rcSessionId })
    .from(phoneCalls).where(and(mine, gte(phoneCalls.startedAt, since), sql`${phoneCalls.startedAt} < ${end}`));
  const notYetSynced = ctx.rcActive
    ? app.filter((c) => c.source !== "ringcentral" && !c.rcSessionId && (!ctx.rcCursor || c.startedAt > ctx.rcCursor))
    : app;
  const perDay = new Map<string, number>();
  const missedPerDay = new Map<string, number>();
  for (const c of rc) {
    if (madeOrTaken(c)) perDay.set(c.workDate, (perDay.get(c.workDate) ?? 0) + 1);
    if (c.missed) missedPerDay.set(c.workDate, (missedPerDay.get(c.workDate) ?? 0) + 1);
  }
  for (const c of notYetSynced) if (madeOrTaken(c)) { const k = localDateStr(c.startedAt); perDay.set(k, (perDay.get(k) ?? 0) + 1); }
  const rcDay = rc.filter((c) => c.workDate === date);
  const appDay = notYetSynced.filter((c) => c.startedAt >= start && c.startedAt < end);
  const booked = app.filter((c) => c.outcome === "booked");
  return {
    /** Has a RingCentral line linked to their login, or has made calls in MyPCP. */
    hasPhone: myExts.length > 0 || app.length > 0,
    linked: myExts.length > 0,
    perDay,
    missedPerDay,
    made: rcDay.filter((c) => c.direction === "outbound").length + appDay.filter((c) => c.direction === "outbound").length,
    answered: rcDay.filter((c) => c.direction === "inbound" && c.answered).length + appDay.filter((c) => c.direction === "inbound" && c.durationSec > 0).length,
    missed: rcDay.filter((c) => c.missed).length,
    talkMin: Math.round((rcDay.filter(madeOrTaken).reduce((s, c) => s + c.durationSec, 0) + appDay.reduce((s, c) => s + c.durationSec, 0)) / 60),
    booked: booked.filter((c) => c.startedAt >= start && c.startedAt < end).length,
    bookedPerDay: byDay(booked.map((c) => c.startedAt)),
  };
}

// ---- One person's day ----

async function metricsFor(user: Person, date: string, ctx: MetricsContext): Promise<MyMetrics> {
  const d = await db();
  const isToday = date === localDateStr();
  const end = clinicLocalToUtc(addDays(date, 1), "00:00");
  const since = clinicLocalToUtc(addDays(date, -30), "00:00");
  const month = date.slice(0, 7);
  // An office manager works the front desk: same numbers (calls, bookings, check-ins, tasks).
  const role = user.role === "office_manager" ? "front_desk" : user.role;
  const goals = ctx.goals[role] ?? {};
  const out: Metric[] = [];
  const add = (m: Metric) => out.push({ ...m, goal: m.goal ?? goals[m.key] ?? null });
  const dayWord = isToday ? "today" : "that day";

  // ---- Phone (anyone with a RingCentral line, and the phone roles) ----
  const ph = await phoneStats(user, date, ctx);
  if (PHONE_ROLES.includes(role) || ph.hasPhone || ph.perDay.size) {
    add({
      key: "calls", label: `Calls ${dayWord}`, value: ph.perDay.get(date) ?? 0, usual: usualPerDay(ph.perDay, date),
      hint: `${ph.made} made · ${ph.answered} answered${ctx.rcActive ? ` · ${ph.missed} missed` : ""}`, href: "/my-work",
    });
    add({ key: "booked", label: "Appointments booked", value: ph.booked, usual: usualPerDay(ph.bookedPerDay, date) });
    add({ key: "talk", label: "Time on the phone", value: ph.talkMin, display: fmtMinutes(ph.talkMin) });
    if (ctx.rcActive) add({ key: "missed", label: "Missed calls", value: ph.missed, hint: "Rang this person's line and nobody picked up (includes voicemails)" });
  }

  // ---- Care coordinators: care calls completed (the day, and the month vs goal) ----
  if (role === "staff") {
    const done = await d.select({ completedAt: ccmTasks.completedAt }).from(ccmTasks)
      .where(and(eq(ccmTasks.completedByStaffId, user.id), gte(ccmTasks.completedAt, since), sql`${ccmTasks.completedAt} < ${end}`));
    const perDay = byDay(done.map((r) => r.completedAt));
    add({ key: "care_calls", label: "Care calls completed", value: perDay.get(date) ?? 0, usual: usualPerDay(perDay, date), href: "/worklist" });
    const [m] = await d.select({ n: sql<number>`count(*)` }).from(ccmTasks)
      .where(and(eq(ccmTasks.assignedStaffId, user.id), eq(ccmTasks.month, month), inArray(ccmTasks.status, [...CCM_DONE])));
    const [g] = await d.select({ goal: monthlyGoals.goal }).from(monthlyGoals).where(and(eq(monthlyGoals.userId, user.id), eq(monthlyGoals.month, month))).limit(1);
    const value = Number(m?.n ?? 0);
    const goal = g?.goal ?? 0;
    const left = weekdaysLeftInMonth(date);
    add({
      key: "ccm_month", label: "Care calls this month", value, goal: goal || null, goalLabel: "monthly goal",
      hint: goal > value ? `About ${Math.ceil((goal - value) / Math.max(1, left))} a day to reach the goal (${left} workdays left)` : goal ? "Monthly goal reached" : "No monthly goal set yet",
      href: "/coordinator",
    });
  }

  // ---- Front desk / MAs: patients checked in or roomed (Patient Flow) ----
  if (role === "front_desk" || role === "medical_assistant") {
    const targets = role === "front_desk" ? ["arrived", "checked_in"] : ["roomed"];
    const ev = await d.select({ appointmentId: appointmentStatusEvents.appointmentId, createdAt: appointmentStatusEvents.createdAt }).from(appointmentStatusEvents)
      .where(and(eq(appointmentStatusEvents.changedByUserId, user.id), inArray(appointmentStatusEvents.toStatus, targets), gte(appointmentStatusEvents.createdAt, since), sql`${appointmentStatusEvents.createdAt} < ${end}`));
    // One per visit per day (arrived → checked in is still one patient).
    const seen = new Set<string>();
    const unique = ev.filter((e) => { const k = `${e.appointmentId}|${localDateStr(new Date(e.createdAt))}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const perDay = byDay(unique.map((e) => e.createdAt));
    add(role === "front_desk"
      ? { key: "checkins", label: "Patients checked in", value: perDay.get(date) ?? 0, usual: usualPerDay(perDay, date), href: "/patient-flow" }
      : { key: "roomed", label: "Patients roomed", value: perDay.get(date) ?? 0, usual: usualPerDay(perDay, date), href: "/patient-flow" });
  }

  // ---- Providers: the day's schedule seen, and what's waiting on them ----
  if (role === "provider") {
    const provIds = (await d.select({ id: providers.id }).from(providers).where(eq(providers.userId, user.id))).map((p) => p.id);
    if (provIds.length) {
      const appts = await d.select({ status: appointments.status }).from(appointments).where(and(inArray(appointments.providerId, provIds), eq(appointments.date, date)));
      const booked = appts.filter((a) => a.status !== "cancelled" && a.status !== "no_show");
      add({ key: "seen", label: `Patients seen ${dayWord}`, value: booked.filter((a) => a.status === "completed" || a.status === "checkout").length, goal: booked.length || null, goalLabel: "on the schedule", href: "/patient-flow" });
      const [rf] = await d.select({ n: sql<number>`count(*)` }).from(refillRequests).where(and(inArray(refillRequests.providerId, provIds), eq(refillRequests.status, "pending")));
      const [es] = await d.select({ n: sql<number>`count(*)` }).from(providerEscalations).where(and(inArray(providerEscalations.providerId, provIds), inArray(providerEscalations.escalationStatus, ["pending", "action_needed"])));
      const r = Number(rf?.n ?? 0), e = Number(es?.n ?? 0);
      add({ key: "waiting", label: "Waiting on them now", value: r + e, hint: `${r} refill request${r === 1 ? "" : "s"}, ${e} escalation${e === 1 ? "" : "s"}`, href: r >= e ? "/refill-requests" : "/escalations" });
    }
  }

  // ---- Billing: the month's care-management claims ----
  if (role === "billing") {
    const rows = await d.select({ status: ccmTasks.status, n: sql<number>`count(*)` }).from(ccmTasks)
      .where(and(eq(ccmTasks.month, month), inArray(ccmTasks.status, ["ready_for_billing", "billed"]))).groupBy(ccmTasks.status);
    const n = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    add({ key: "ready_to_bill", label: "Ready to bill", value: n("ready_for_billing"), hint: "Care-management claims this month waiting to be billed", href: "/billing" });
    add({ key: "billed_month", label: "Billed this month", value: n("billed"), goal: n("billed") + n("ready_for_billing") || null, goalLabel: "ready + billed", href: "/billing" });
  }

  // ---- Admins: the practice ----
  if (role === "admin") {
    const appts = await d.select({ status: appointments.status }).from(appointments).where(eq(appointments.date, date));
    const booked = appts.filter((a) => a.status !== "cancelled" && a.status !== "no_show");
    add({ key: "practice_visits", label: "Visits done (all clinics)", value: booked.filter((a) => a.status === "completed" || a.status === "checkout").length, goal: booked.length || null, goalLabel: "scheduled", href: "/patient-flow" });
    const p = await practiceCalls(date, ctx);
    add({ key: "practice_calls", label: `Practice calls ${dayWord}`, value: p.calls, hint: `${p.made} made · ${p.answered} answered${ctx.rcActive ? ` · ${p.missed} missed` : ""} · ${p.booked} booked an appointment`, href: "/team-progress" });
    const [cm] = await d.select({ n: sql<number>`count(*)` }).from(ccmTasks).where(and(eq(ccmTasks.month, month), inArray(ccmTasks.status, [...CCM_DONE])));
    const [cg] = await d.select({ n: sql<number>`coalesce(sum(${monthlyGoals.goal}), 0)` }).from(monthlyGoals).where(eq(monthlyGoals.month, month));
    add({ key: "practice_ccm", label: "Care calls this month (practice)", value: Number(cm?.n ?? 0), goal: Number(cg?.n ?? 0) || null, goalLabel: "team goals", href: "/admin" });
  }

  // ---- Everyone: My Work ----
  const acts = await d.select({ taskId: workTaskActivities.taskId, meta: workTaskActivities.meta, createdAt: workTaskActivities.createdAt }).from(workTaskActivities)
    .where(and(eq(workTaskActivities.userId, user.id), eq(workTaskActivities.type, "status_changed"), gte(workTaskActivities.createdAt, since), sql`${workTaskActivities.createdAt} < ${end}`));
  const seenTask = new Set<string>();
  const doneAt = acts.filter((a) => a.meta?.to === "completed").filter((a) => { const k = `${a.taskId}|${localDateStr(new Date(a.createdAt))}`; if (seenTask.has(k)) return false; seenTask.add(k); return true; }).map((a) => a.createdAt);
  const donePerDay = byDay(doneAt);
  add({ key: "tasks_done", label: "Tasks done", value: donePerDay.get(date) ?? 0, usual: usualPerDay(donePerDay, date), href: "/my-work" });
  if (isToday) {
    const [left] = await d.select({ n: sql<number>`count(*)` }).from(workTasks)
      .where(and(eq(workTasks.assignedUserId, user.id), inArray(workTasks.status, [...OPEN_TASK_STATUSES]), lte(workTasks.dueDate, date)));
    const leftN = Number(left?.n ?? 0);
    add({ key: "tasks_left", label: "Tasks due today or overdue", value: leftN, hint: leftN ? "Still open in My Work" : "All caught up", href: "/my-work" });
  }

  // ---- Hours on the clock (people who use the time clock) ----
  const [prof] = await d.select({ uses: staffProfiles.usesTimeClock }).from(staffProfiles).where(eq(staffProfiles.userId, user.id)).limit(1);
  const punches = await d.select({ clockInAt: timePunches.clockInAt, clockOutAt: timePunches.clockOutAt }).from(timePunches)
    .where(and(eq(timePunches.userId, user.id), eq(timePunches.workDate, date)));
  if (prof?.uses || punches.length) {
    const now = Date.now();
    const mins = Math.round(punches.reduce((s, p) => s + Math.max(0, (p.clockOutAt ? new Date(p.clockOutAt).getTime() : isToday ? now : new Date(p.clockInAt).getTime()) - new Date(p.clockInAt).getTime()), 0) / 60000);
    const open = punches.some((p) => !p.clockOutAt);
    add({ key: "hours", label: `On the clock ${dayWord}`, value: mins, display: fmtMinutes(mins), hint: open ? (isToday ? "Clocked in" : "Never clocked out") : punches.length ? "Clocked out" : "Not clocked in", href: "/my-day" });
  }

  return { date, role, metrics: orderMetrics(role, out), goalKeys: (ROLE_GOAL_KEYS[role] ?? []) as MetricKey[] };
}

/** Whole-practice call numbers for a day. */
async function practiceCalls(date: string, ctx: MetricsContext) {
  const d = await db();
  const start = clinicLocalToUtc(date, "00:00");
  const end = clinicLocalToUtc(addDays(date, 1), "00:00");
  const app = await d.select({ direction: phoneCalls.direction, durationSec: phoneCalls.durationSec, outcome: phoneCalls.outcome, source: phoneCalls.source, rcSessionId: phoneCalls.rcSessionId, startedAt: phoneCalls.startedAt })
    .from(phoneCalls).where(and(gte(phoneCalls.startedAt, start), sql`${phoneCalls.startedAt} < ${end}`));
  const booked = app.filter((c) => c.outcome === "booked").length;
  if (!ctx.rcActive) {
    return { calls: app.filter(madeOrTaken).length, made: app.filter((c) => c.direction === "outbound").length, answered: app.filter((c) => c.direction === "inbound" && c.durationSec > 0).length, missed: 0, talkMin: Math.round(app.reduce((s, c) => s + c.durationSec, 0) / 60), booked };
  }
  const rc = await d.select({ direction: rcCallStats.direction, durationSec: rcCallStats.durationSec, answered: rcCallStats.answered, missed: rcCallStats.missed })
    .from(rcCallStats).where(eq(rcCallStats.workDate, date));
  const pending = app.filter((c) => c.source !== "ringcentral" && !c.rcSessionId && (!ctx.rcCursor || c.startedAt > ctx.rcCursor));
  const made = rc.filter((c) => c.direction === "outbound").length + pending.filter((c) => c.direction === "outbound").length;
  const answered = rc.filter((c) => c.direction === "inbound" && c.answered).length + pending.filter((c) => c.direction === "inbound" && c.durationSec > 0).length;
  const talk = rc.filter(madeOrTaken).reduce((s, c) => s + c.durationSec, 0) + pending.reduce((s, c) => s + c.durationSec, 0);
  return { calls: made + answered, made, answered, missed: rc.filter((c) => c.missed).length, talkMin: Math.round(talk / 60), booked };
}

export async function myMetrics(user: Person): Promise<MyMetrics> {
  const today = localDateStr();
  return metricsFor(user, today, await loadContext(today));
}

/** My Work → My calls: one person's own phone numbers for a day, plus each of the 6 days before. Counts only. */
export async function myCalls(user: Person, date: string) {
  const ctx = await loadContext(date);
  const ph = await phoneStats(user, date, ctx);
  const days = Array.from({ length: 7 }, (_, i) => addDays(date, i - 6)).map((day) => ({
    date: day, calls: ph.perDay.get(day) ?? 0, missed: ph.missedPerDay.get(day) ?? 0,
  }));
  return {
    date,
    show: PHONE_ROLES.includes(user.role === "office_manager" ? "front_desk" : user.role) || ph.hasPhone || ph.perDay.size > 0,
    linked: ph.linked,
    ringCentral: ctx.rcActive,
    lastSyncAt: ctx.rcLastSuccessAt,
    calls: ph.perDay.get(date) ?? 0,
    made: ph.made,
    answered: ph.answered,
    missed: ph.missed,
    talkMin: ph.talkMin,
    booked: ph.booked,
    usual: usualPerDay(ph.perDay, date),
    days,
  };
}

// ---- Team progress (admins): everyone's numbers for a day ----

/** Everyone's numbers for a day. `onlyUserIds` (an office manager's office) leaves out everyone else and the practice-wide totals. */
export async function teamMetrics(date: string, onlyUserIds?: Set<number> | null) {
  const d = await db();
  const ctx = await loadContext(date);
  const people = (await d.select({ id: users.id, name: users.name, role: users.role }).from(users).where(inArray(users.role, [...TEAM_ROLES])))
    .filter((p) => !onlyUserIds || onlyUserIds.has(p.id))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const results: { id: number; name: string; role: string; metrics: Metric[] }[] = [];
  for (let i = 0; i < people.length; i += 5) {
    const batch = await Promise.all(people.slice(i, i + 5).map(async (p) => ({ id: p.id, name: p.name ?? "Unnamed", role: p.role, metrics: (await metricsFor(p, date, ctx)).metrics })));
    results.push(...batch);
  }
  // RingCentral lines that aren't one person's login (shared desk phones, queues, extensions without a MyPCP account).
  const lineRows = ctx.rcActive
    ? await d.select({ id: rcCallStats.extensionId, name: rcCallStats.extensionName, direction: rcCallStats.direction, durationSec: rcCallStats.durationSec, answered: rcCallStats.answered, missed: rcCallStats.missed })
      .from(rcCallStats).where(eq(rcCallStats.workDate, date))
    : [];
  const lines = new Map<string, { name: string; made: number; answered: number; missed: number; talkSec: number }>();
  for (const r of lineRows) {
    if (r.id && ctx.extToUser.has(r.id)) continue;
    const k = r.id ?? "none";
    const cur = lines.get(k) ?? { name: r.name ?? (r.id ? `Extension ${r.id}` : "No extension (main number / IVR)"), made: 0, answered: 0, missed: 0, talkSec: 0 };
    if (r.direction === "outbound") cur.made++;
    if (r.direction === "inbound" && r.answered) cur.answered++;
    if (r.missed) cur.missed++;
    if (madeOrTaken(r)) cur.talkSec += r.durationSec;
    lines.set(k, cur);
  }
  if (onlyUserIds) {
    return { date, totals: null, ringcentral: { active: ctx.rcActive, lastSuccessAt: ctx.rcLastSuccessAt, linkedExtensions: ctx.extToUser.size }, people: results, lines: [] };
  }
  return {
    date,
    totals: await practiceCalls(date, ctx),
    ringcentral: { active: ctx.rcActive, lastSuccessAt: ctx.rcLastSuccessAt, linkedExtensions: ctx.extToUser.size },
    people: results,
    lines: Array.from(lines.values()).map((l) => ({ ...l, talkMin: Math.round(l.talkSec / 60) })).sort((a, b) => (b.made + b.answered + b.missed) - (a.made + a.answered + a.missed)),
  };
}

// Staff set their own usual week (2026-10-02, the practice's choices): staff — not providers or
// admins — set it once themselves and it fills in their future shifts right away (their office manager,
// or the time-off approver, is notified). After that every change is a request: a task with Approve /
// Deny for the office manager of their home clinic, else the time-off approver (Asim), else the admins.
// Applying a week replaces their future scheduled shifts from the chosen date; called-out shifts and
// coverage shifts they picked up are kept.
import { and, asc, desc, eq, gte, inArray, isNull, lte, max } from "drizzle-orm";
import { getDb } from "./db";
import { clinics, scheduleRequests, shifts, staffProfiles, users, workTaskActivities, workTasks } from "../drizzle/schema";
import {
  WEEKDAYS, canSelfSchedule, describePattern, patternFromShifts, patternProblem, shiftsFromPattern, type WeekPattern,
} from "../shared/schedulePattern";
import { addDays, localDateStr } from "../shared/workforce";
import { REMOTE_LABEL, adminIds, getTimeOffApprover, notify } from "./workforceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

type Request = typeof scheduleRequests.$inferSelect;
export class ScheduleError extends Error {}

async function clinicNames(): Promise<Map<number, string>> {
  return new Map((await (await db()).select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));
}
const nameFor = (names: Map<number, string>) => (id: number | null) => (id ? names.get(id) ?? "clinic" : REMOTE_LABEL);

/** Who approves this person's changes: their home clinic's office manager (not themselves), else the time-off approver, else the admins. */
async function approverFor(userId: number): Promise<{ userIds: number[]; assignedUserId: number | null }> {
  const d = await db();
  const [p] = await d.select({ clinicId: staffProfiles.homeClinicId }).from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
  if (p?.clinicId) {
    const managers = await d.select({ id: users.id }).from(users).innerJoin(staffProfiles, eq(staffProfiles.userId, users.id))
      .where(and(eq(users.role, "office_manager"), eq(staffProfiles.homeClinicId, p.clinicId), eq(staffProfiles.active, true)));
    const m = managers.find((x) => x.id !== userId);
    if (m) return { userIds: [m.id], assignedUserId: m.id };
  }
  const a = await getTimeOffApprover();
  if (a && a.userId !== userId) return { userIds: [a.userId], assignedUserId: a.userId };
  return { userIds: await adminIds(), assignedUserId: null };
}

/** Their upcoming shifts (for the "current week" shown next to a request). */
async function upcomingShifts(userId: number, from: string, days = 56) {
  return (await db()).select({ date: shifts.date, startTime: shifts.startTime, endTime: shifts.endTime, clinicId: shifts.clinicId })
    .from(shifts).where(and(eq(shifts.userId, userId), gte(shifts.date, from), lte(shifts.date, addDays(from, days)), eq(shifts.status, "scheduled"), isNull(shifts.coversShiftId)))
    .orderBy(asc(shifts.date));
}

/** The week in effect now: the last one applied, else what their upcoming shifts show. */
async function currentPattern(userId: number): Promise<WeekPattern | null> {
  const d = await db();
  const [last] = await d.select({ pattern: scheduleRequests.pattern }).from(scheduleRequests)
    .where(and(eq(scheduleRequests.userId, userId), inArray(scheduleRequests.status, ["applied", "approved"]))).orderBy(desc(scheduleRequests.decidedAt), desc(scheduleRequests.id)).limit(1);
  if (last) return last.pattern as WeekPattern;
  return patternFromShifts(await upcomingShifts(userId, localDateStr()));
}

/**
 * Put a week into effect: from `from` through the later of their last scheduled shift and 12 weeks
 * out (at most 26 weeks), replace their scheduled shifts with the week's. Called-out shifts and
 * coverage shifts stay, and no new shift is added on those dates.
 */
async function applyPattern(userId: number, pattern: WeekPattern, from: string, byUserId: number) {
  const d = await db();
  const [{ last } = { last: null }] = await d.select({ last: max(shifts.date) }).from(shifts).where(eq(shifts.userId, userId));
  const min = addDays(from, 7 * 12 - 1);
  const cap = addDays(from, 7 * 26 - 1);
  const to = last && last > min ? (last > cap ? cap : last) : min;
  const existing = await d.select({ id: shifts.id, date: shifts.date, status: shifts.status, coversShiftId: shifts.coversShiftId })
    .from(shifts).where(and(eq(shifts.userId, userId), gte(shifts.date, from), lte(shifts.date, to)));
  const keep = existing.filter((s) => s.status !== "scheduled" || s.coversShiftId != null);
  const keepDates = new Set(keep.map((s) => s.date));
  const remove = existing.filter((s) => s.status === "scheduled" && s.coversShiftId == null).map((s) => s.id);
  const add = shiftsFromPattern(pattern, from, to).filter((s) => !keepDates.has(s.date));
  await d.transaction(async (tx) => {
    for (let i = 0; i < remove.length; i += 500) await tx.delete(shifts).where(inArray(shifts.id, remove.slice(i, i + 500)));
    for (let i = 0; i < add.length; i += 200) {
      await tx.insert(shifts).values(add.slice(i, i + 200).map((s) => ({ userId, clinicId: s.clinicId, date: s.date, startTime: s.startTime, endTime: s.endTime, createdByUserId: byUserId, note: "From their usual week" })));
    }
  });
  return { removed: remove.length, added: add.length, through: to };
}

function check(pattern: WeekPattern, effectiveFrom: string) {
  const problem = patternProblem(pattern);
  if (problem) throw new ScheduleError(problem);
  if (effectiveFrom <= localDateStr()) throw new ScheduleError("Pick a start date from tomorrow on.");
  if (effectiveFrom > addDays(localDateStr(), 180)) throw new ScheduleError("Pick a start date within the next 6 months.");
}

/** My Schedule → "My usual week". */
export async function myWeek(userId: number, role: string) {
  const d = await db();
  const names = await clinicNames();
  const history = await d.select().from(scheduleRequests).where(eq(scheduleRequests.userId, userId)).orderBy(desc(scheduleRequests.createdAt)).limit(10);
  const submitted = history.some((r) => r.kind === "first");
  const [profile] = await d.select({ homeClinicId: staffProfiles.homeClinicId }).from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
  return {
    eligible: canSelfSchedule(role),
    /** Their home clinic (where a new week starts out). */
    homeClinicId: profile?.homeClinicId ?? null,
    submitted,
    current: await currentPattern(userId),
    pending: history.find((r) => r.status === "pending") ?? null,
    history: history.map((r) => ({ id: r.id, kind: r.kind, status: r.status, effectiveFrom: r.effectiveFrom, createdAt: r.createdAt, decidedAt: r.decidedAt, managerNote: r.managerNote, summary: describePattern(r.pattern as WeekPattern, nameFor(names)) })),
    clinics: Array.from(names.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function requestTask(req: Request, who: { name: string | null; role: string }, approver: { assignedUserId: number | null }) {
  const names = await clinicNames();
  const current = await currentPattern(req.userId);
  const { createTask } = await import("./workspaceDb");
  await createTask({ id: req.userId, name: who.name, role: who.role, clinicIds: null }, {
    title: `Schedule change request: ${who.name ?? "Employee"}, from ${req.effectiveFrom}`,
    description: [
      `Requested usual week, starting ${req.effectiveFrom}:`, ...describePattern(req.pattern as WeekPattern, nameFor(names)).map((l) => `• ${l}`),
      ...(current ? ["", "Current:", ...describePattern(current, nameFor(names)).map((l) => `• ${l}`)] : []),
      ...(req.note ? ["", `Note: ${req.note}`] : []),
      "", "Approve or deny it here.",
    ].join("\n"),
    assignedUserId: approver.assignedUserId,
    assignedRole: approver.assignedUserId ? null : "admin",
    priority: "normal",
    category: "administrative",
    dueDate: addDays(req.effectiveFrom, -1) > localDateStr() ? addDays(req.effectiveFrom, -1) : localDateStr(),
    sourceType: "schedule_change",
    sourceRef: String(req.id),
  });
}

async function closeTask(requestId: number, how: "completed" | "cancelled", byUserId: number, note: string) {
  const d = await db();
  const open = await d.select({ id: workTasks.id }).from(workTasks)
    .where(and(eq(workTasks.sourceType, "schedule_change"), eq(workTasks.sourceRef, String(requestId)), inArray(workTasks.status, ["open", "in_progress", "waiting"])));
  for (const t of open) {
    await d.update(workTasks).set({ status: how, completedAt: how === "completed" ? new Date() : null }).where(eq(workTasks.id, t.id));
    await d.insert(workTaskActivities).values([
      { taskId: t.id, userId: byUserId, type: "status_changed" as const, meta: { to: how } },
      { taskId: t.id, userId: byUserId, type: "comment" as const, body: note },
    ]);
  }
}

/**
 * Save my usual week. The first time it takes effect right away (the approver is notified); after
 * that it's a request (a newer request replaces a pending one).
 */
export async function submitWeek(user: { id: number; name: string | null; role: string }, input: { pattern: WeekPattern; effectiveFrom: string; note?: string | null }) {
  if (!canSelfSchedule(user.role)) throw new ScheduleError("Your schedule is set by an admin.");
  check(input.pattern, input.effectiveFrom);
  const d = await db();
  const pattern = Object.fromEntries(WEEKDAYS.map((k) => [k, input.pattern[k]])) as WeekPattern;
  const note = input.note?.trim().slice(0, 500) || null;
  const first = !(await d.select({ id: scheduleRequests.id }).from(scheduleRequests).where(and(eq(scheduleRequests.userId, user.id), eq(scheduleRequests.kind, "first"))).limit(1)).length;
  const approver = await approverFor(user.id);
  const names = await clinicNames();
  if (first) {
    const r = await applyPattern(user.id, pattern, input.effectiveFrom, user.id);
    await d.insert(scheduleRequests).values({ userId: user.id, pattern, effectiveFrom: input.effectiveFrom, kind: "first", status: "applied", note, approverUserId: approver.assignedUserId, decidedAt: new Date(), shiftsRemoved: r.removed, shiftsAdded: r.added });
    await notify(approver.userIds, `${user.name ?? "An employee"} set their schedule`, `Starting ${input.effectiveFrom}: ${describePattern(pattern, nameFor(names)).join("; ")}. Later changes will come to you for approval.`);
    return { applied: true as const, ...r };
  }
  // A newer request replaces one still waiting.
  const waiting = await d.select({ id: scheduleRequests.id }).from(scheduleRequests).where(and(eq(scheduleRequests.userId, user.id), eq(scheduleRequests.status, "pending")));
  for (const w of waiting) {
    await d.update(scheduleRequests).set({ status: "cancelled" }).where(eq(scheduleRequests.id, w.id));
    await closeTask(w.id, "cancelled", user.id, "Replaced by a newer request.");
  }
  const res = await d.insert(scheduleRequests).values({ userId: user.id, pattern, effectiveFrom: input.effectiveFrom, kind: "change", status: "pending", note, approverUserId: approver.assignedUserId });
  const id = Number((res as unknown as [{ insertId: number }])[0]?.insertId);
  const [req] = await d.select().from(scheduleRequests).where(eq(scheduleRequests.id, id)).limit(1);
  await requestTask(req!, user, approver);
  return { applied: false as const, requestId: id };
}

export async function cancelRequest(userId: number, id: number) {
  const d = await db();
  const [r] = await d.select().from(scheduleRequests).where(and(eq(scheduleRequests.id, id), eq(scheduleRequests.userId, userId))).limit(1);
  if (!r || r.status !== "pending") throw new ScheduleError("That request isn't waiting anymore.");
  await d.update(scheduleRequests).set({ status: "cancelled" }).where(eq(scheduleRequests.id, id));
  await closeTask(id, "cancelled", userId, "The employee cancelled this request.");
}

/** One request, for the Approve / Deny box on its task. */
export async function getRequest(id: number) {
  const d = await db();
  const [r] = await d.select().from(scheduleRequests).where(eq(scheduleRequests.id, id)).limit(1);
  if (!r) return null;
  const [u] = await d.select({ name: users.name }).from(users).where(eq(users.id, r.userId)).limit(1);
  const names = await clinicNames();
  const current = await currentPattern(r.userId);
  return {
    id: r.id, userId: r.userId, userName: u?.name ?? null, status: r.status, effectiveFrom: r.effectiveFrom, note: r.note,
    requested: describePattern(r.pattern as WeekPattern, nameFor(names)), current: current ? describePattern(current, nameFor(names)) : null,
  };
}

/** A manager approves (the week takes effect from its start date) or denies. */
export async function decideRequest(input: { id: number; approve: boolean; managerNote?: string | null; decidedBy: { id: number; name: string | null } }) {
  const d = await db();
  const [r] = await d.select().from(scheduleRequests).where(eq(scheduleRequests.id, input.id)).limit(1);
  if (!r) throw new ScheduleError("Request not found.");
  if (r.status !== "pending") throw new ScheduleError(`This request was already ${r.status}.`);
  if (r.userId === input.decidedBy.id) throw new ScheduleError("You can't approve your own schedule change.");
  const note = input.managerNote?.trim().slice(0, 500) || null;
  let applied: { removed: number; added: number } | null = null;
  if (input.approve) {
    // A start date that has passed while it waited starts tomorrow instead.
    const from = r.effectiveFrom > localDateStr() ? r.effectiveFrom : addDays(localDateStr(), 1);
    applied = await applyPattern(r.userId, r.pattern as WeekPattern, from, input.decidedBy.id);
  }
  await d.update(scheduleRequests).set({
    status: input.approve ? "approved" : "denied", managerNote: note, decidedByUserId: input.decidedBy.id, decidedAt: new Date(),
    shiftsRemoved: applied?.removed ?? null, shiftsAdded: applied?.added ?? null,
  }).where(eq(scheduleRequests.id, r.id));
  await notify([r.userId], `Schedule change ${input.approve ? "approved" : "denied"}`, `${input.approve ? `Your new usual week starts ${r.effectiveFrom > localDateStr() ? r.effectiveFrom : "tomorrow"}.` : "Your schedule stays the same."}${note ? ` ${input.decidedBy.name ?? "Your manager"}: ${note}` : ""}`);
  await closeTask(r.id, "completed", input.decidedBy.id, `${input.approve ? "Approved" : "Denied"} by ${input.decidedBy.name ?? "a manager"}${note ? `: ${note}` : ""}. The employee was notified.`);
  return { approved: input.approve, ...(applied ?? {}) };
}

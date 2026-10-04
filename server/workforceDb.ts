// Workforce data layer — job roles, staff profiles, shifts, time off, time clock,
// duty check-offs and performance scorecards. Kept out of db.ts because nothing
// here touches patient data.
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { getDb } from "./db";
import {
  users, clinics, notifications, jobRoles, jobDuties, staffProfiles, shifts,
  timeOffRequests, timePunches, dutyCompletions, performanceNotes, providers,
  appSettings, workTasks, workTaskActivities,
} from "../drizzle/schema";
import {
  LATE_GRACE_MINUTES, MA_ROLE_TEMPLATE, addDays, attendanceTracked, localDateStr, localMinutes,
  periodKey, shiftMinutes, timeToMinutes, weekStart, type DutyFrequency,
} from "../shared/workforce";

/** Shifts without a clinic are remote (e.g. a care coordinator working from home). */
export const REMOTE_LABEL = "Remote";

async function clinicLabel(db: Awaited<ReturnType<typeof requireDb>>, clinicId: number | null) {
  if (!clinicId) return REMOTE_LABEL;
  const [clinic] = await db.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, clinicId));
  return clinic?.name ?? "clinic";
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db;
}

// ---- Notifications ----

export async function notify(userIds: number[], title: string, content?: string) {
  const db = await getDb();
  const ids = Array.from(new Set(userIds)).filter(Boolean);
  if (!db || !ids.length) return;
  await db.insert(notifications).values(ids.map((userId) => ({ userId, type: "workforce" as const, title, content })));
}

export async function adminIds(): Promise<number[]> {
  const db = await requireDb();
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
  return rows.map((r) => r.id);
}

// ---- Job roles & duties ----

export async function listJobRoles() {
  const db = await requireDb();
  const [roles, duties, counts] = await Promise.all([
    db.select().from(jobRoles).where(eq(jobRoles.active, true)).orderBy(asc(jobRoles.name)),
    db.select().from(jobDuties).where(eq(jobDuties.active, true)).orderBy(asc(jobDuties.sortOrder), asc(jobDuties.id)),
    db.select({ jobRoleId: staffProfiles.jobRoleId, n: sql<number>`count(*)` })
      .from(staffProfiles).where(eq(staffProfiles.active, true)).groupBy(staffProfiles.jobRoleId),
  ]);
  return roles.map((r) => ({
    ...r,
    duties: duties.filter((d) => d.jobRoleId === r.id),
    headcount: Number(counts.find((c) => c.jobRoleId === r.id)?.n ?? 0),
  }));
}

export async function saveJobRole(input: { id?: number; name: string; summary?: string | null }) {
  const db = await requireDb();
  if (input.id) {
    await db.update(jobRoles).set({ name: input.name, summary: input.summary ?? null }).where(eq(jobRoles.id, input.id));
    return { id: input.id };
  }
  const res = await db.insert(jobRoles).values({ name: input.name, summary: input.summary ?? null });
  return { id: res?.[0]?.insertId as number };
}

export async function archiveJobRole(id: number) {
  const db = await requireDb();
  await db.update(jobRoles).set({ active: false }).where(eq(jobRoles.id, id));
}

export async function saveDuty(input: {
  id?: number; jobRoleId: number; category: string; title: string; detail?: string | null;
  frequency: DutyFrequency; sortOrder?: number;
}) {
  const db = await requireDb();
  const values = {
    jobRoleId: input.jobRoleId, category: input.category, title: input.title,
    detail: input.detail ?? null, frequency: input.frequency,
  };
  if (input.id) {
    await db.update(jobDuties).set({ ...values, ...(input.sortOrder != null ? { sortOrder: input.sortOrder } : {}) }).where(eq(jobDuties.id, input.id));
    return { id: input.id };
  }
  // New duties go to the end of the role's list.
  const [max] = await db.select({ m: sql<number>`coalesce(max(${jobDuties.sortOrder}), 0)` }).from(jobDuties).where(eq(jobDuties.jobRoleId, input.jobRoleId));
  const res = await db.insert(jobDuties).values({ ...values, sortOrder: input.sortOrder ?? Number(max?.m ?? 0) + 10 });
  return { id: res?.[0]?.insertId as number };
}

export async function archiveDuty(id: number) {
  const db = await requireDb();
  await db.update(jobDuties).set({ active: false }).where(eq(jobDuties.id, id));
}

/** Create the starter Medical Assistant role once; a no-op if it already exists. */
export async function seedMaTemplate() {
  const db = await requireDb();
  const existing = await db.select().from(jobRoles).where(and(eq(jobRoles.name, MA_ROLE_TEMPLATE.name), eq(jobRoles.active, true))).limit(1);
  if (existing.length) return { created: false, id: existing[0].id };
  const res = await db.insert(jobRoles).values({ name: MA_ROLE_TEMPLATE.name, summary: MA_ROLE_TEMPLATE.summary });
  const id = res?.[0]?.insertId as number;
  await db.insert(jobDuties).values(MA_ROLE_TEMPLATE.duties.map((d, i) => ({
    jobRoleId: id, category: d.category, title: d.title, detail: d.detail ?? null, frequency: d.frequency, sortOrder: (i + 1) * 10,
  })));
  return { created: true, id };
}

// ---- People ----

/** Every login, plus roster-only employees (no login yet), with their employment profile. */
export async function listPeople() {
  const db = await requireDb();
  return db
    .select({
      userId: users.id, name: users.name, email: users.email, accessRole: users.role,
      profileId: staffProfiles.id, jobRoleId: staffProfiles.jobRoleId, jobRoleName: jobRoles.name,
      homeClinicId: staffProfiles.homeClinicId, homeClinicName: clinics.name,
      canFloat: staffProfiles.canFloat, usesTimeClock: staffProfiles.usesTimeClock, clockStartDate: staffProfiles.clockStartDate,
      hoursPerWeek: staffProfiles.hoursPerWeek, hireDate: staffProfiles.hireDate, active: staffProfiles.active,
    })
    .from(users)
    .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .leftJoin(jobRoles, eq(jobRoles.id, staffProfiles.jobRoleId))
    .leftJoin(clinics, eq(clinics.id, staffProfiles.homeClinicId))
    .where(or(ne(users.role, "user"), isNotNull(staffProfiles.id)))
    .orderBy(asc(users.name));
}

export async function saveProfile(input: {
  userId: number; jobRoleId: number | null; homeClinicId: number | null; canFloat: boolean; usesTimeClock?: boolean;
  /** Attendance is judged from this date; defaults to today when the clock is first turned on. */
  clockStartDate?: string | null;
  hoursPerWeek?: number | null; hireDate?: string | null; active: boolean;
  /** When the home clinic changes, also move their upcoming shifts at the old clinic. */
  moveUpcomingShifts?: boolean;
}): Promise<{ movedShifts: number }> {
  const db = await requireDb();
  const values = {
    jobRoleId: input.jobRoleId, homeClinicId: input.homeClinicId, canFloat: input.canFloat,
    ...(input.usesTimeClock !== undefined ? { usesTimeClock: input.usesTimeClock } : {}),
    hoursPerWeek: input.hoursPerWeek ?? 40, hireDate: input.hireDate ?? null, active: input.active,
  };
  const existing = await db.select({ id: staffProfiles.id, homeClinicId: staffProfiles.homeClinicId, usesTimeClock: staffProfiles.usesTimeClock }).from(staffProfiles).where(eq(staffProfiles.userId, input.userId)).limit(1);
  if (input.clockStartDate !== undefined) Object.assign(values, { clockStartDate: input.clockStartDate });
  else if (input.usesTimeClock && !existing[0]?.usesTimeClock) Object.assign(values, { clockStartDate: localDateStr() });
  if (existing.length) await db.update(staffProfiles).set(values).where(eq(staffProfiles.userId, input.userId));
  else await db.insert(staffProfiles).values({ userId: input.userId, ...values });

  const oldClinicId = existing[0]?.homeClinicId ?? null;
  if (!input.moveUpcomingShifts || input.homeClinicId === oldClinicId) return { movedShifts: 0 };
  // Coverage shifts stay where the gap was. No home clinic (remote) moves their remote shifts,
  // or every upcoming shift if they were never placed anywhere.
  const conds = [eq(shifts.userId, input.userId), gte(shifts.date, localDateStr()), eq(shifts.status, "scheduled"), isNull(shifts.coversShiftId)];
  if (oldClinicId) conds.push(eq(shifts.clinicId, oldClinicId));
  else if (existing.length) conds.push(isNull(shifts.clinicId));
  const [res] = await db.update(shifts).set({ clinicId: input.homeClinicId }).where(and(...conds));
  return { movedShifts: (res as { affectedRows?: number })?.affectedRows ?? 0 };
}

// ---- Schedule ----

export async function getShiftById(id: number) {
  const db = await requireDb();
  const rows = await db.select().from(shifts).where(eq(shifts.id, id)).limit(1);
  return rows[0];
}

export async function getPunchById(id: number) {
  const db = await requireDb();
  return (await db.select().from(timePunches).where(eq(timePunches.id, id)).limit(1))[0];
}

export async function getTimeOffById(id: number) {
  const db = await requireDb();
  return (await db.select().from(timeOffRequests).where(eq(timeOffRequests.id, id)).limit(1))[0];
}

/** Shifts (with names) and approved/pending time off overlapping a date range. */
export async function getSchedule(from: string, to: string, clinicId?: number) {
  const db = await requireDb();
  const conds = [gte(shifts.date, from), lte(shifts.date, to)];
  if (clinicId) conds.push(eq(shifts.clinicId, clinicId));
  const [shiftRows, timeOff] = await Promise.all([
    db.select({ shift: shifts, userName: users.name, clinicName: clinics.name })
      .from(shifts)
      .innerJoin(users, eq(users.id, shifts.userId))
      .leftJoin(clinics, eq(clinics.id, shifts.clinicId))
      .where(and(...conds))
      .orderBy(asc(shifts.date), asc(shifts.startTime)),
    db.select().from(timeOffRequests).where(and(
      inArray(timeOffRequests.status, ["approved", "pending"]),
      lte(timeOffRequests.startDate, to), gte(timeOffRequests.endDate, from),
    )),
  ]);
  const coveredIds = new Set(shiftRows.map((r) => r.shift.coversShiftId).filter(Boolean) as number[]);
  return {
    shifts: shiftRows.map((r) => ({ ...r.shift, userName: r.userName, clinicName: r.clinicName ?? REMOTE_LABEL, covered: coveredIds.has(r.shift.id) })),
    timeOff,
  };
}

/** A person can't hold two overlapping shifts on the same day. */
async function findOverlap(userId: number, date: string, startTime: string, endTime: string, ignoreShiftId?: number) {
  const db = await requireDb();
  const sameDay = await db.select().from(shifts).where(and(eq(shifts.userId, userId), eq(shifts.date, date), eq(shifts.status, "scheduled")));
  const s = timeToMinutes(startTime), e = timeToMinutes(endTime);
  return sameDay.find((x) => x.id !== ignoreShiftId && timeToMinutes(x.startTime) < e && s < timeToMinutes(x.endTime));
}

export async function saveShift(input: {
  id?: number; userId: number; clinicId: number | null; date: string; startTime: string; endTime: string;
  note?: string | null; createdByUserId: number;
}): Promise<{ id: number } | { error: string }> {
  const db = await requireDb();
  if (timeToMinutes(input.endTime) <= timeToMinutes(input.startTime)) return { error: "The shift must end after it starts." };
  if (await findOverlap(input.userId, input.date, input.startTime, input.endTime, input.id)) {
    return { error: "This person already has a shift that overlaps those hours." };
  }
  const values = {
    userId: input.userId, clinicId: input.clinicId, date: input.date,
    startTime: input.startTime, endTime: input.endTime, note: input.note ?? null,
  };
  if (input.id) {
    await db.update(shifts).set(values).where(eq(shifts.id, input.id));
    return { id: input.id };
  }
  const res = await db.insert(shifts).values({ ...values, createdByUserId: input.createdByUserId });
  return { id: res?.[0]?.insertId as number };
}

export async function deleteShift(id: number) {
  const db = await requireDb();
  // Keep time-clock history: detach punches rather than deleting them.
  await db.update(timePunches).set({ shiftId: null }).where(eq(timePunches.shiftId, id));
  await db.update(shifts).set({ coversShiftId: null }).where(eq(shifts.coversShiftId, id));
  await db.delete(shifts).where(eq(shifts.id, id));
}

/** Copy every scheduled shift from one week into another, skipping clashes. */
export async function copyWeek(fromWeekStart: string, toWeekStart: string, clinicId: number | undefined, createdByUserId: number) {
  const db = await requireDb();
  const conds = [gte(shifts.date, fromWeekStart), lte(shifts.date, addDays(fromWeekStart, 6)), eq(shifts.status, "scheduled"), isNull(shifts.coversShiftId)];
  if (clinicId) conds.push(eq(shifts.clinicId, clinicId));
  const source = await db.select().from(shifts).where(and(...conds));
  let copied = 0, skipped = 0;
  for (const s of source) {
    const offset = Math.round((+new Date(`${s.date}T12:00:00Z`) - +new Date(`${fromWeekStart}T12:00:00Z`)) / 86400000);
    const date = addDays(toWeekStart, offset);
    if (await findOverlap(s.userId, date, s.startTime, s.endTime)) { skipped++; continue; }
    await db.insert(shifts).values({ userId: s.userId, clinicId: s.clinicId, date, startTime: s.startTime, endTime: s.endTime, note: s.note, createdByUserId });
    copied++;
  }
  return { copied, skipped };
}

export async function markCalledOut(shiftId: number, note: string | null, actorName: string | null) {
  const db = await requireDb();
  const shift = await getShiftById(shiftId);
  if (!shift) return null;
  await db.update(shifts).set({ status: "called_out", note: note ?? shift.note }).where(eq(shifts.id, shiftId));
  const [who] = await db.select({ name: users.name }).from(users).where(eq(users.id, shift.userId));
  await notify(await adminIds(), `Call-out: ${who?.name ?? "Employee"} — ${await clinicLabel(db, shift.clinicId)}`,
    `${shift.date} ${shift.startTime}–${shift.endTime} needs coverage${actorName ? ` (logged by ${actorName})` : ""}.`);
  return shift;
}

export async function undoCallOut(shiftId: number) {
  const db = await requireDb();
  await db.update(shifts).set({ status: "scheduled" }).where(eq(shifts.id, shiftId));
}

/**
 * Who could cover a called-out shift: active staff holding the same job role who
 * aren't already working those hours and aren't on approved time off. Home-clinic
 * staff rank first, then floaters; non-floaters at other clinics are listed last.
 */
export async function coverageCandidates(shiftId: number) {
  const db = await requireDb();
  const shift = await getShiftById(shiftId);
  if (!shift) return [];
  const [absent] = await db.select().from(staffProfiles).where(eq(staffProfiles.userId, shift.userId)).limit(1);
  const conds = [eq(staffProfiles.active, true), ne(staffProfiles.userId, shift.userId)];
  if (absent?.jobRoleId) conds.push(eq(staffProfiles.jobRoleId, absent.jobRoleId));
  const people = await db
    .select({ userId: users.id, name: users.name, homeClinicId: staffProfiles.homeClinicId, homeClinicName: clinics.name, canFloat: staffProfiles.canFloat, hoursPerWeek: staffProfiles.hoursPerWeek })
    .from(staffProfiles)
    .innerJoin(users, eq(users.id, staffProfiles.userId))
    .leftJoin(clinics, eq(clinics.id, staffProfiles.homeClinicId))
    .where(and(...conds));
  if (!people.length) return [];
  const ids = people.map((p) => p.userId);
  const monday = addDays(shift.date, -((new Date(`${shift.date}T12:00:00Z`).getUTCDay() + 6) % 7));
  const [weekShifts, off] = await Promise.all([
    db.select().from(shifts).where(and(inArray(shifts.userId, ids), gte(shifts.date, monday), lte(shifts.date, addDays(monday, 6)), eq(shifts.status, "scheduled"))),
    db.select().from(timeOffRequests).where(and(inArray(timeOffRequests.userId, ids), eq(timeOffRequests.status, "approved"), lte(timeOffRequests.startDate, shift.date), gte(timeOffRequests.endDate, shift.date))),
  ]);
  const s = timeToMinutes(shift.startTime), e = timeToMinutes(shift.endTime);
  return people
    .map((p) => {
      const mine = weekShifts.filter((x) => x.userId === p.userId);
      const busy = mine.some((x) => x.date === shift.date && timeToMinutes(x.startTime) < e && s < timeToMinutes(x.endTime));
      const onLeave = off.some((o) => o.userId === p.userId);
      const weekMinutes = mine.reduce((sum, x) => sum + shiftMinutes(x.startTime, x.endTime), 0);
      const sameClinic = p.homeClinicId === shift.clinicId;
      return { ...p, busy, onLeave, weekMinutes, sameClinic, available: !busy && !onLeave };
    })
    .filter((p) => p.available)
    .sort((a, b) => Number(b.sameClinic) - Number(a.sameClinic) || Number(b.canFloat) - Number(a.canFloat) || a.weekMinutes - b.weekMinutes);
}

export async function assignCoverage(shiftId: number, coverUserId: number, createdByUserId: number): Promise<{ id: number } | { error: string }> {
  const db = await requireDb();
  const shift = await getShiftById(shiftId);
  if (!shift) return { error: "Shift not found." };
  if (await findOverlap(coverUserId, shift.date, shift.startTime, shift.endTime)) return { error: "That person is already working those hours." };
  const res = await db.insert(shifts).values({
    userId: coverUserId, clinicId: shift.clinicId, date: shift.date, startTime: shift.startTime, endTime: shift.endTime,
    coversShiftId: shift.id, note: "Coverage", createdByUserId,
  });
  const where = shift.clinicId ? `at ${await clinicLabel(db, shift.clinicId)}` : "(remote)";
  await notify([coverUserId], `You're covering a shift ${where}`, `${shift.date}, ${shift.startTime}–${shift.endTime}.`);
  return { id: res?.[0]?.insertId as number };
}

// ---- Time off ----

export async function listTimeOff(filter: { status?: string; userId?: number; id?: number } = {}) {
  const db = await requireDb();
  const conds = [];
  if (filter.status) conds.push(eq(timeOffRequests.status, filter.status as any));
  if (filter.userId) conds.push(eq(timeOffRequests.userId, filter.userId));
  if (filter.id) conds.push(eq(timeOffRequests.id, filter.id));
  const rows = await db
    .select({ r: timeOffRequests, userName: users.name })
    .from(timeOffRequests)
    .innerJoin(users, eq(users.id, timeOffRequests.userId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(timeOffRequests.createdAt))
    .limit(200);
  return rows.map((x) => ({ ...x.r, userName: x.userName }));
}

// ---- Who decides time off: every request becomes a task for the approver (an admin) ----

const APPROVER_KEY = "time_off_approver";
const TIME_OFF_LABEL: Record<string, string> = { pto: "PTO", sick: "Sick", unpaid: "Unpaid", other: "Other" };
const shortDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export async function listAdmins() {
  const db = await requireDb();
  return db.select({ id: users.id, name: users.name }).from(users).where(eq(users.role, "admin")).orderBy(asc(users.name));
}

/**
 * IAM-only Lambda job: make one admin (found by name) the person every time-off request goes to,
 * and give still-pending requests their task. Dry run unless apply.
 */
export async function timeOffApproverJob(input: { name: string; apply: boolean }) {
  const needle = input.name.trim().toLowerCase();
  const admins = (await listAdmins()).filter((a) => needle && (a.name ?? "").toLowerCase().includes(needle));
  if (admins.length !== 1) return { matches: admins.map((a) => a.name), note: admins.length ? "More than one admin matches: be more specific." : "No admin matches that name." };
  const pending = (await listTimeOff({ status: "pending" })).length;
  if (!input.apply) return { wouldSet: admins[0]!.name, pendingRequests: pending, current: (await getTimeOffApprover())?.name ?? null };
  const r = await setTimeOffApprover(admins[0]!.id, admins[0]!.id);
  return { set: r.approver?.name ?? null, tasksCreatedForPending: r.created, pendingRequests: pending };
}

/** The admin every time-off request goes to (null = not set: the admins' shared queue). */
export async function getTimeOffApprover(): Promise<{ userId: number; name: string | null } | null> {
  const db = await requireDb();
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, APPROVER_KEY)).limit(1);
  const id = Number((row?.value as { userId?: number } | undefined)?.userId ?? 0);
  if (!id) return null;
  const [u] = await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.id, id)).limit(1);
  return u && u.role === "admin" ? { userId: u.id, name: u.name } : null;
}

export async function setTimeOffApprover(userId: number | null, byUserId: number) {
  const db = await requireDb();
  if (userId) {
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (u?.role !== "admin") throw new Error("Time-off requests can only go to an admin.");
  }
  const value = { userId };
  await db.insert(appSettings).values({ key: APPROVER_KEY, value, updatedByUserId: byUserId }).onDuplicateKeyUpdate({ set: { value, updatedByUserId: byUserId } });
  // Open requests follow the new approver.
  const approver = await getTimeOffApprover();
  await db.update(workTasks).set({ assignedUserId: approver?.userId ?? null, assignedRole: approver ? null : "admin" })
    .where(and(eq(workTasks.sourceType, "time_off"), inArray(workTasks.status, ["open", "in_progress", "waiting"])));
  return { approver, created: await ensureTimeOffTasks() };
}

/** Put a pending request in front of the approver: a task in their My Work (Approve / Deny right there). */
async function timeOffTask(req: typeof timeOffRequests.$inferSelect) {
  const db = await requireDb();
  const [who] = await db.select({ name: users.name, role: users.role }).from(users).where(eq(users.id, req.userId)).limit(1);
  const approver = await getTimeOffApprover();
  const dates = `${shortDay(req.startDate)}${req.endDate !== req.startDate ? ` – ${shortDay(req.endDate)}` : ""}`;
  const { createTask } = await import("./workspaceDb");
  const today = localDateStr();
  await createTask({ id: req.userId, name: who?.name ?? null, role: who?.role ?? "staff", clinicIds: null }, {
    title: `Time off request: ${who?.name ?? "Employee"}, ${dates}`,
    description: `${TIME_OFF_LABEL[req.type] ?? req.type}: ${dates}${req.reason ? `\nReason: ${req.reason}` : ""}\n\nApprove or deny it here, or in Workforce → Time off.`,
    assignedUserId: approver?.userId ?? null,
    assignedRole: approver ? null : "admin",
    priority: "high",
    category: "administrative",
    dueDate: req.startDate > today ? req.startDate : today,
    sourceType: "time_off",
    sourceRef: String(req.id),
  });
  return approver;
}

/** Pending requests that don't have a task yet (e.g. made before this existed) get one. */
export async function ensureTimeOffTasks() {
  const db = await requireDb();
  const pending = await db.select().from(timeOffRequests).where(eq(timeOffRequests.status, "pending"));
  if (!pending.length) return 0;
  const have = new Set((await db.select({ ref: workTasks.sourceRef }).from(workTasks).where(eq(workTasks.sourceType, "time_off"))).map((t) => t.ref));
  let n = 0;
  for (const r of pending) if (!have.has(String(r.id))) { await timeOffTask(r); n++; }
  return n;
}

/** Close the request's task once it's decided or cancelled, so nothing is left hanging. */
async function closeTimeOffTask(requestId: number, how: "completed" | "cancelled", byUserId: number, note: string) {
  const db = await requireDb();
  const open = await db.select({ id: workTasks.id }).from(workTasks)
    .where(and(eq(workTasks.sourceType, "time_off"), eq(workTasks.sourceRef, String(requestId)), inArray(workTasks.status, ["open", "in_progress", "waiting"])));
  for (const t of open) {
    await db.update(workTasks).set({ status: how, completedAt: how === "completed" ? new Date() : null }).where(eq(workTasks.id, t.id));
    await db.insert(workTaskActivities).values([
      { taskId: t.id, userId: byUserId, type: "status_changed" as const, meta: { to: how } },
      { taskId: t.id, userId: byUserId, type: "comment" as const, body: note },
    ]);
  }
}

export async function requestTimeOff(input: { userId: number; userName: string | null; startDate: string; endDate: string; type: "pto" | "sick" | "unpaid" | "other"; reason?: string | null }) {
  const db = await requireDb();
  const res = await db.insert(timeOffRequests).values({
    userId: input.userId, startDate: input.startDate, endDate: input.endDate, type: input.type, reason: input.reason ?? null,
  });
  const id = res?.[0]?.insertId as number;
  const [req] = await db.select().from(timeOffRequests).where(eq(timeOffRequests.id, id)).limit(1);
  const approver = req ? await timeOffTask(req) : null;
  // The task tells the approver; with no approver set, every admin hears about it.
  if (!approver) {
    await notify(await adminIds(), `Time-off request: ${input.userName ?? "Employee"}`,
      `${input.type.toUpperCase()} ${input.startDate}${input.endDate !== input.startDate ? ` → ${input.endDate}` : ""}`);
  }
  return { id };
}

export async function cancelTimeOff(id: number, userId: number) {
  const db = await requireDb();
  await db.update(timeOffRequests).set({ status: "cancelled" })
    .where(and(eq(timeOffRequests.id, id), eq(timeOffRequests.userId, userId), inArray(timeOffRequests.status, ["pending", "approved"])));
  await closeTimeOffTask(id, "cancelled", userId, "The employee cancelled this request.");
}

/** Approve/deny. Returns the shifts that now conflict with an approved request. */
export async function decideTimeOff(input: { id: number; status: "approved" | "denied"; managerNote?: string | null; decidedByUserId: number }) {
  const db = await requireDb();
  const rows = await db.select().from(timeOffRequests).where(eq(timeOffRequests.id, input.id)).limit(1);
  const req = rows[0];
  if (!req) return null;
  await db.update(timeOffRequests).set({
    status: input.status, managerNote: input.managerNote ?? null, decidedByUserId: input.decidedByUserId, decidedAt: new Date(),
  }).where(eq(timeOffRequests.id, input.id));
  await notify([req.userId], `Time off ${input.status}`, `${req.startDate}${req.endDate !== req.startDate ? ` → ${req.endDate}` : ""}${input.managerNote ? ` — ${input.managerNote}` : ""}`);
  const [by] = await db.select({ name: users.name }).from(users).where(eq(users.id, input.decidedByUserId)).limit(1);
  await closeTimeOffTask(req.id, "completed", input.decidedByUserId, `${input.status === "approved" ? "Approved" : "Denied"} by ${by?.name ?? "a manager"}${input.managerNote ? `: ${input.managerNote}` : ""}. The employee was notified.`);
  const conflicts = input.status === "approved"
    ? await db.select().from(shifts).where(and(eq(shifts.userId, req.userId), gte(shifts.date, req.startDate), lte(shifts.date, req.endDate), eq(shifts.status, "scheduled")))
    : [];
  return { conflicts };
}

// ---- Time clock ----

/**
 * Today's open punch. Open punches from earlier days are forgotten clock-outs: they
 * don't block clocking in again, and managers fix them on the Timesheets tab.
 */
export async function getOpenPunch(userId: number) {
  const db = await requireDb();
  const rows = await db.select().from(timePunches)
    .where(and(eq(timePunches.userId, userId), isNull(timePunches.clockOutAt), eq(timePunches.workDate, localDateStr())))
    .orderBy(desc(timePunches.clockInAt)).limit(1);
  return rows[0];
}

/** Forgotten clock-outs from the last 30 days (open punches before today). */
async function missedClockOuts(userId: number) {
  const db = await requireDb();
  const today = localDateStr();
  return db.select({ id: timePunches.id, workDate: timePunches.workDate, clockInAt: timePunches.clockInAt }).from(timePunches)
    .where(and(eq(timePunches.userId, userId), isNull(timePunches.clockOutAt), lt(timePunches.workDate, today), gte(timePunches.workDate, addDays(today, -30))))
    .orderBy(asc(timePunches.workDate));
}

export async function clockIn(userId: number): Promise<{ id: number; minutesLate: number } | { error: string }> {
  const db = await requireDb();
  const [clockProfile] = await db.select({ usesTimeClock: staffProfiles.usesTimeClock, active: staffProfiles.active }).from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
  if (!clockProfile?.usesTimeClock || !clockProfile.active) {
    return { error: "The time clock isn't turned on for you. If you're paid hourly, ask your manager to turn it on (Workforce → People)." };
  }
  if (await getOpenPunch(userId)) return { error: "You're already clocked in." };
  const now = new Date();
  const today = localDateStr(now);
  const nowMin = localMinutes(now);
  // Attach to today's shift that hasn't ended yet (the earliest one if several).
  const todays = await db.select().from(shifts).where(and(eq(shifts.userId, userId), eq(shifts.date, today), eq(shifts.status, "scheduled"))).orderBy(asc(shifts.startTime));
  const shift = todays.find((s) => timeToMinutes(s.endTime) > nowMin) ?? todays[todays.length - 1];
  const [profile] = await db.select().from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
  // Lateness counts only for the first punch of a shift (not the return from lunch).
  let minutesLate = 0;
  if (shift && attendanceTracked(profile, today)) {
    const prior = await db.select({ id: timePunches.id }).from(timePunches).where(eq(timePunches.shiftId, shift.id)).limit(1);
    const late = nowMin - timeToMinutes(shift.startTime);
    if (!prior.length && late > LATE_GRACE_MINUTES) minutesLate = late;
  }
  const res = await db.insert(timePunches).values({
    userId, clinicId: shift?.clinicId ?? profile?.homeClinicId ?? null, shiftId: shift?.id ?? null,
    workDate: today, clockInAt: now, minutesLate,
  });
  return { id: res?.[0]?.insertId as number, minutesLate };
}

/** Clock out, or start lunch (the punch ends as "lunch"; End lunch clocks back in and isn't counted late). */
export async function clockOut(userId: number, reason: "lunch" | null = null): Promise<{ success: true } | { error: string }> {
  const db = await requireDb();
  const open = await getOpenPunch(userId);
  if (!open) return { error: "You're not clocked in." };
  await db.update(timePunches).set({ clockOutAt: new Date(), outReason: reason }).where(eq(timePunches.id, open.id));
  return { success: true };
}

/** My shift reminder texts: my own cell and whether I want them (staff turn this on themselves). */
export async function getMyReminders(userId: number) {
  const db = await requireDb();
  const [p] = await db.select({ mobilePhone: staffProfiles.mobilePhone, textReminders: staffProfiles.textReminders, usesTimeClock: staffProfiles.usesTimeClock }).from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
  return { mobilePhone: p?.mobilePhone ?? null, textReminders: !!p?.textReminders, usesTimeClock: !!p?.usesTimeClock, hasProfile: !!p };
}

export async function saveMyReminders(userId: number, input: { mobilePhone: string | null; textReminders: boolean }): Promise<{ success: true } | { error: string }> {
  const db = await requireDb();
  const digits = (input.mobilePhone ?? "").replace(/\D/g, "");
  const phone = digits.length >= 10 ? digits.slice(-10) : null;
  if (input.textReminders && !phone) return { error: "Enter your cell number (10 digits) to get reminder texts." };
  const [p] = await db.select({ id: staffProfiles.id }).from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
  if (!p) return { error: "Your workforce profile isn't set up yet. Ask your manager." };
  await db.update(staffProfiles).set({ mobilePhone: phone, textReminders: input.textReminders && !!phone }).where(eq(staffProfiles.id, p.id));
  return { success: true };
}

/** Everyone's cell numbers on file (so reminder texts never show up in the patient texts inbox). */
export async function staffMobilePhones(): Promise<Set<string>> {
  const db = await requireDb();
  return new Set((await db.select({ phone: staffProfiles.mobilePhone }).from(staffProfiles).where(isNotNull(staffProfiles.mobilePhone))).map((r) => r.phone!).filter(Boolean));
}

/** On time this week and last week (shifts whose start has passed; called-out shifts don't count). */
export async function getMyAttendance(userId: number) {
  const db = await requireDb();
  const today = localDateStr();
  const nowMin = localMinutes();
  const thisWeek = weekStart(today), lastWeek = addDays(thisWeek, -7);
  const [profile] = await db.select().from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
  if (!profile?.usesTimeClock) return null;
  const myShifts = await db.select().from(shifts).where(and(eq(shifts.userId, userId), gte(shifts.date, lastWeek), lte(shifts.date, today), eq(shifts.status, "scheduled")));
  const punches = await db.select().from(timePunches).where(and(eq(timePunches.userId, userId), gte(timePunches.workDate, lastWeek), lte(timePunches.workDate, today)));
  const week = (from: string, to: string) => {
    const due = myShifts.filter((s) => s.date >= from && s.date <= to && attendanceTracked(profile, s.date) && (s.date < today || timeToMinutes(s.startTime) + LATE_GRACE_MINUTES < nowMin));
    let onTime = 0;
    for (const s of due) {
      const first = punches.filter((p) => p.shiftId === s.id).sort((a, b) => +a.clockInAt - +b.clockInAt)[0];
      if (first && first.minutesLate === 0) onTime++;
    }
    return { onTime, due: due.length };
  };
  return { thisWeek: week(thisWeek, today), lastWeek: week(lastWeek, addDays(thisWeek, -1)) };
}

export async function listPunches(from: string, to: string, userId?: number) {
  const db = await requireDb();
  const conds = [gte(timePunches.workDate, from), lte(timePunches.workDate, to)];
  if (userId) conds.push(eq(timePunches.userId, userId));
  const rows = await db
    .select({ p: timePunches, userName: users.name, clinicName: clinics.name })
    .from(timePunches)
    .innerJoin(users, eq(users.id, timePunches.userId))
    .leftJoin(clinics, eq(clinics.id, timePunches.clinicId))
    .where(and(...conds))
    .orderBy(desc(timePunches.clockInAt))
    .limit(500);
  return rows.map((x) => ({ ...x.p, userName: x.userName, clinicName: x.clinicName }));
}

/** Manager correction of a punch (e.g. a forgotten clock-out). */
export async function editPunch(input: { id: number; clockInAt: Date; clockOutAt: Date | null; note?: string | null; editedByUserId: number }): Promise<{ success: true } | { error: string }> {
  const db = await requireDb();
  if (input.clockOutAt && +input.clockOutAt <= +input.clockInAt) return { error: "Clock-out must be after clock-in." };
  await db.update(timePunches).set({
    clockInAt: input.clockInAt, clockOutAt: input.clockOutAt, note: input.note ?? null, editedByUserId: input.editedByUserId,
    workDate: localDateStr(input.clockInAt),
  }).where(eq(timePunches.id, input.id));
  return { success: true };
}

// ---- My Day ----

export async function getMyDay(userId: number) {
  const db = await requireDb();
  const today = localDateStr();
  const [profileRow] = await db
    .select({ profile: staffProfiles, jobRole: jobRoles, clinicName: clinics.name })
    .from(staffProfiles)
    .leftJoin(jobRoles, eq(jobRoles.id, staffProfiles.jobRoleId))
    .leftJoin(clinics, eq(clinics.id, staffProfiles.homeClinicId))
    .where(eq(staffProfiles.userId, userId)).limit(1);
  const jobRoleId = profileRow?.profile.jobRoleId ?? null;
  const keys = [today, periodKey("weekly", today), periodKey("monthly", today)];
  const [duties, completions, todaysShifts, punches] = await Promise.all([
    jobRoleId
      ? db.select().from(jobDuties).where(and(eq(jobDuties.jobRoleId, jobRoleId), eq(jobDuties.active, true))).orderBy(asc(jobDuties.sortOrder), asc(jobDuties.id))
      : Promise.resolve([]),
    db.select().from(dutyCompletions).where(and(eq(dutyCompletions.userId, userId), inArray(dutyCompletions.periodKey, keys))),
    db.select({ shift: shifts, clinicName: clinics.name }).from(shifts).leftJoin(clinics, eq(clinics.id, shifts.clinicId))
      .where(and(eq(shifts.userId, userId), eq(shifts.date, today))).orderBy(asc(shifts.startTime)),
    db.select().from(timePunches).where(and(eq(timePunches.userId, userId), eq(timePunches.workDate, today))).orderBy(asc(timePunches.clockInAt)),
  ]);
  const doneIds = new Set(
    completions.filter((c) => {
      const d = duties.find((x) => x.id === c.dutyId);
      return d && c.periodKey === periodKey(d.frequency, today);
    }).map((c) => c.dutyId),
  );
  return {
    today,
    clockEnabled: !!profileRow?.profile.usesTimeClock && profileRow.profile.active,
    missedClockOuts: await missedClockOuts(userId),
    jobRole: profileRow?.jobRole ?? null,
    homeClinicName: profileRow?.clinicName ?? null,
    duties: duties.map((d) => ({ ...d, done: doneIds.has(d.id) })),
    shifts: todaysShifts.map((s) => ({ ...s.shift, clinicName: s.clinicName ?? REMOTE_LABEL })),
    punches,
    openPunch: punches.find((p) => !p.clockOutAt) ?? null,
  };
}

export async function toggleDuty(userId: number, dutyId: number, done: boolean): Promise<{ success: true } | { error: string }> {
  const db = await requireDb();
  // Only duties belonging to the caller's own job role can be checked off.
  const [row] = await db
    .select({ duty: jobDuties })
    .from(jobDuties)
    .innerJoin(staffProfiles, and(eq(staffProfiles.jobRoleId, jobDuties.jobRoleId), eq(staffProfiles.userId, userId)))
    .where(eq(jobDuties.id, dutyId)).limit(1);
  if (!row || row.duty.frequency === "as_needed") return { error: "That duty isn't on your checklist." };
  const key = periodKey(row.duty.frequency, localDateStr());
  const where = and(eq(dutyCompletions.userId, userId), eq(dutyCompletions.dutyId, dutyId), eq(dutyCompletions.periodKey, key));
  const existing = await db.select({ id: dutyCompletions.id }).from(dutyCompletions).where(where).limit(1);
  if (done && !existing.length) await db.insert(dutyCompletions).values({ userId, dutyId, periodKey: key });
  if (!done && existing.length) await db.delete(dutyCompletions).where(where);
  return { success: true };
}

export async function getMySchedule(userId: number, from: string, to: string) {
  const db = await requireDb();
  const [shiftRows, timeOff] = await Promise.all([
    db.select({ shift: shifts, clinicName: clinics.name }).from(shifts).leftJoin(clinics, eq(clinics.id, shifts.clinicId))
      .where(and(eq(shifts.userId, userId), gte(shifts.date, from), lte(shifts.date, to))).orderBy(asc(shifts.date), asc(shifts.startTime)),
    listTimeOff({ userId }),
  ]);
  return { shifts: shiftRows.map((s) => ({ ...s.shift, clinicName: s.clinicName ?? REMOTE_LABEL })), timeOff };
}

// ---- Today board ----

/** Per-clinic view of a day: who's scheduled, who's in, who's late, open coverage. */
export async function getDayBoard(date: string) {
  const db = await requireDb();
  const [{ shifts: dayShifts }, punches, allClinics, pendingTimeOff, profiles] = await Promise.all([
    getSchedule(date, date),
    db.select().from(timePunches).where(eq(timePunches.workDate, date)),
    db.select().from(clinics).orderBy(asc(clinics.name)),
    db.select({ n: sql<number>`count(*)` }).from(timeOffRequests).where(eq(timeOffRequests.status, "pending")),
    db.select({ userId: staffProfiles.userId, usesTimeClock: staffProfiles.usesTimeClock, clockStartDate: staffProfiles.clockStartDate }).from(staffProfiles),
  ]);
  const profileBy = new Map(profiles.map((p) => [p.userId, p]));
  const isToday = date === localDateStr();
  const nowMin = localMinutes();
  const rows = dayShifts.map((s) => {
    const mine = punches.filter((p) => p.shiftId === s.id || (p.shiftId == null && p.userId === s.userId));
    const first = mine.slice().sort((a, b) => +a.clockInAt - +b.clockInAt)[0];
    // "scheduled" = on the schedule but not on the time clock (yet), so never late or a no-show.
    let state: "called_out" | "upcoming" | "clocked_in" | "done" | "late" | "no_show" | "scheduled";
    if (s.status === "called_out") state = "called_out";
    else if (mine.some((p) => !p.clockOutAt)) state = "clocked_in";
    else if (first) state = "done";
    else if (!attendanceTracked(profileBy.get(s.userId), date)) state = "scheduled";
    else if (date > localDateStr() || (isToday && nowMin <= timeToMinutes(s.startTime) + LATE_GRACE_MINUTES)) state = "upcoming";
    else if (isToday && nowMin < timeToMinutes(s.endTime)) state = "late";
    else state = "no_show";
    return { ...s, state, clockInAt: first?.clockInAt ?? null, minutesLate: first?.minutesLate ?? 0 };
  });
  return {
    date,
    pendingTimeOff: Number(pendingTimeOff[0]?.n ?? 0),
    clinics: [
      ...allClinics.map((c) => ({ id: c.id as number | null, name: c.name, shifts: rows.filter((r) => r.clinicId === c.id) })),
      ...(rows.some((r) => !r.clinicId) ? [{ id: null, name: REMOTE_LABEL, shifts: rows.filter((r) => !r.clinicId) }] : []),
    ],
  };
}

// ---- Performance ----

/**
 * Scorecard per employee for a date range (only days up to today are judged):
 * attendance (on-time / late / no-show / call-outs), hours worked vs scheduled,
 * daily-duty completion on days worked, and manager ratings.
 */
export async function getScorecards(from: string, to: string, clinicId?: number) {
  const db = await requireDb();
  const today = localDateStr();
  const end = to > today ? today : to;
  const people = (await listPeople()).filter((p) => p.profileId && p.active && (!clinicId || p.homeClinicId === clinicId));
  if (!people.length || end < from) return [];
  const ids = people.map((p) => p.userId);
  const [shiftRows, punchRows, dutyRows, completionRows, noteRows] = await Promise.all([
    db.select().from(shifts).where(and(inArray(shifts.userId, ids), gte(shifts.date, from), lte(shifts.date, end))),
    db.select().from(timePunches).where(and(inArray(timePunches.userId, ids), gte(timePunches.workDate, from), lte(timePunches.workDate, end))),
    db.select().from(jobDuties).where(and(eq(jobDuties.active, true), eq(jobDuties.frequency, "daily"))),
    db.select().from(dutyCompletions).where(and(inArray(dutyCompletions.userId, ids), gte(dutyCompletions.periodKey, from), lte(dutyCompletions.periodKey, end))),
    db.select().from(performanceNotes).where(inArray(performanceNotes.userId, ids)),
  ]);
  const nowMin = localMinutes();
  const now = Date.now();
  return people.map((p) => {
    const myShifts = shiftRows.filter((s) => s.userId === p.userId);
    const myPunches = punchRows.filter((x) => x.userId === p.userId);
    const calledOut = myShifts.filter((s) => s.status === "called_out").length;
    // A shift is "due" once its start (plus grace) has passed.
    const due = myShifts.filter((s) => s.status === "scheduled" && attendanceTracked(p, s.date) && (s.date < today || timeToMinutes(s.startTime) + LATE_GRACE_MINUTES < nowMin));
    let onTime = 0, late = 0, noShow = 0, lateMinutes = 0;
    for (const s of due) {
      const first = myPunches.filter((x) => x.shiftId === s.id).sort((a, b) => +a.clockInAt - +b.clockInAt)[0];
      if (!first) { if (s.date < today || timeToMinutes(s.endTime) <= nowMin) noShow++; continue; }
      if (first.minutesLate > 0) { late++; lateMinutes += first.minutesLate; } else onTime++;
    }
    const scheduledMinutes = myShifts.filter((s) => s.status === "scheduled").reduce((sum, s) => sum + shiftMinutes(s.startTime, s.endTime), 0);
    const workedMinutes = myPunches.reduce((sum, x) => sum + Math.max(0, Math.round(((x.clockOutAt ? +x.clockOutAt : now) - +x.clockInAt) / 60000)), 0);
    const daysWorked = new Set(myPunches.map((x) => x.workDate)).size;
    const myDailyDuties = dutyRows.filter((d) => d.jobRoleId === p.jobRoleId);
    const dailyIds = new Set(myDailyDuties.map((d) => d.id));
    const dutiesDone = completionRows.filter((c) => c.userId === p.userId && dailyIds.has(c.dutyId)).length;
    const dutiesExpected = myDailyDuties.length * daysWorked;
    const rated = noteRows.filter((n) => n.userId === p.userId && n.rating != null);
    const attended = onTime + late;
    return {
      userId: p.userId, name: p.name, jobRoleName: p.jobRoleName, homeClinicName: p.homeClinicName,
      shiftsScheduled: myShifts.length, onTime, late, noShow, calledOut,
      onTimeRate: attended + noShow ? Math.round((onTime / (attended + noShow)) * 100) : null,
      avgMinutesLate: late ? Math.round(lateMinutes / late) : 0,
      scheduledMinutes, workedMinutes, daysWorked,
      dutiesDone, dutiesExpected,
      dutyRate: dutiesExpected ? Math.min(100, Math.round((dutiesDone / dutiesExpected) * 100)) : null,
      avgRating: rated.length ? Math.round((rated.reduce((s, n) => s + (n.rating ?? 0), 0) / rated.length) * 10) / 10 : null,
      noteCount: noteRows.filter((n) => n.userId === p.userId).length,
    };
  }).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

export async function listPerformanceNotes(userId: number) {
  const db = await requireDb();
  const rows = await db
    .select({ n: performanceNotes, authorName: users.name })
    .from(performanceNotes)
    .leftJoin(users, eq(users.id, performanceNotes.authorUserId))
    .where(eq(performanceNotes.userId, userId))
    .orderBy(desc(performanceNotes.createdAt))
    .limit(100);
  return rows.map((x) => ({ ...x.n, authorName: x.authorName }));
}

export async function addPerformanceNote(input: { userId: number; authorUserId: number; kind: "kudos" | "coaching" | "review"; rating?: number | null; note: string }) {
  const db = await requireDb();
  await db.insert(performanceNotes).values({ userId: input.userId, authorUserId: input.authorUserId, kind: input.kind, rating: input.rating ?? null, note: input.note });
}

/**
 * Add someone to the roster WITHOUT a login (no email / password, access role
 * "user" = no access). An admin can later give them a login from Team & Access by
 * setting an email + role + password on the same row, so history carries over.
 */
export async function addEmployee(input: { name: string; jobRoleId?: number | null; homeClinicId?: number | null }): Promise<{ userId: number } | { error: string }> {
  const db = await requireDb();
  const name = input.name.trim().replace(/\s+/g, " ");
  const clash = (await listPeople()).find((p) => (p.name ?? "").trim().toLowerCase() === name.toLowerCase());
  if (clash) return { error: `${clash.name} is already on the People list.` };
  const res = await db.insert(users).values({ openId: `roster:${randomUUID()}`, name, role: "user", loginMethod: "none" });
  const userId = res?.[0]?.insertId as number;
  await db.insert(staffProfiles).values({ userId, jobRoleId: input.jobRoleId ?? null, homeClinicId: input.homeClinicId ?? null });
  return { userId };
}

// ---- Team schedule (every employee can see it) ----

/**
 * Who works where in a date range, and who is on the clock right now. Deliberately
 * leaves out lateness, clock-in times, pay and time-off reasons: time off is just "Off".
 */
export async function getTeamWeek(from: string, to: string) {
  const db = await requireDb();
  const today = localDateStr();
  const [shiftRows, offRows, openNow, allClinics, profiles, providerLogins] = await Promise.all([
    db.select({ id: shifts.id, userId: shifts.userId, clinicId: shifts.clinicId, date: shifts.date, startTime: shifts.startTime, endTime: shifts.endTime, status: shifts.status, userName: users.name, userRole: users.role })
      .from(shifts).innerJoin(users, eq(users.id, shifts.userId))
      .where(and(gte(shifts.date, from), lte(shifts.date, to)))
      .orderBy(asc(shifts.date), asc(shifts.startTime)),
    db.select({ userId: timeOffRequests.userId, startDate: timeOffRequests.startDate, endDate: timeOffRequests.endDate, userName: users.name, userRole: users.role })
      .from(timeOffRequests).innerJoin(users, eq(users.id, timeOffRequests.userId))
      .where(and(eq(timeOffRequests.status, "approved"), lte(timeOffRequests.startDate, to), gte(timeOffRequests.endDate, from))),
    db.select({ userId: timePunches.userId, clinicId: timePunches.clinicId, userName: users.name, userRole: users.role })
      .from(timePunches).innerJoin(users, eq(users.id, timePunches.userId))
      .where(and(eq(timePunches.workDate, today), isNull(timePunches.clockOutAt))),
    db.select({ id: clinics.id, name: clinics.name }).from(clinics).orderBy(asc(clinics.name)),
    db.select({ userId: staffProfiles.userId, homeClinicId: staffProfiles.homeClinicId, jobRoleName: jobRoles.name })
      .from(staffProfiles).leftJoin(jobRoles, eq(jobRoles.id, staffProfiles.jobRoleId)),
    db.select({ userId: providers.userId }).from(providers).where(isNotNull(providers.userId)),
  ]);
  const profileBy = new Map(profiles.map((p) => [p.userId, p]));
  // Providers are listed apart from the rest of the team: linked to a provider record,
  // a provider login, or the "Provider" job role (Dr. Mansour is an admin who also sees patients).
  const providerIds = new Set(providerLogins.map((p) => p.userId));
  const isProvider = (userId: number, role: string | null) =>
    providerIds.has(userId) || role === "provider" || profileBy.get(userId)?.jobRoleName === "Provider";
  const todayShiftEnd = new Map(shiftRows.filter((s) => s.date === today && s.status === "scheduled").map((s) => [s.userId, s.endTime]));

  // One row per person who has a shift or approved time off in the range.
  const people = new Map<number, { userId: number; name: string; jobRoleName: string | null; homeClinicId: number | null; isProvider: boolean }>();
  const addPerson = (userId: number, name: string | null, role: string | null) => {
    if (people.has(userId)) return;
    const p = profileBy.get(userId);
    people.set(userId, { userId, name: name ?? "Unknown", jobRoleName: p?.jobRoleName ?? null, homeClinicId: p?.homeClinicId ?? null, isProvider: isProvider(userId, role) });
  };
  shiftRows.forEach((s) => addPerson(s.userId, s.userName, s.userRole));
  offRows.forEach((o) => addPerson(o.userId, o.userName, o.userRole));

  const offDays: { userId: number; date: string }[] = [];
  for (const o of offRows) {
    for (let d = o.startDate < from ? from : o.startDate; d <= o.endDate && d <= to; d = addDays(d, 1)) offDays.push({ userId: o.userId, date: d });
  }
  return {
    from,
    to,
    today,
    clinics: allClinics,
    people: Array.from(people.values()).sort((a, b) => a.name.localeCompare(b.name)),
    // out = the person can't work that shift (called out); no reason is shared.
    shifts: shiftRows.map((s) => ({ id: s.id, userId: s.userId, clinicId: s.clinicId, date: s.date, startTime: s.startTime, endTime: s.endTime, out: s.status === "called_out" })),
    offDays,
    workingNow: openNow.map((o) => ({
      userId: o.userId,
      name: o.userName ?? "Unknown",
      clinicId: o.clinicId ?? profileBy.get(o.userId)?.homeClinicId ?? null,
      jobRoleName: profileBy.get(o.userId)?.jobRoleName ?? null,
      isProvider: isProvider(o.userId, o.userRole),
      until: todayShiftEnd.get(o.userId) ?? null,
    })),
  };
}

// ---- Timesheets (managers) ----

const punchMinutes = (p: { clockInAt: Date; clockOutAt: Date | null }) =>
  p.clockOutAt ? Math.max(0, Math.round((+p.clockOutAt - +p.clockInAt) / 60000)) : 0;

/**
 * Hours per person for a date range, from time punches. Open punches before today are
 * forgotten clock-outs (they count 0 hours until a manager fixes them). Overtime is
 * time over 40 hours in a Monday–Sunday week.
 */
export async function getTimesheet(from: string, to: string) {
  const db = await requireDb();
  const today = localDateStr();
  const [punchRows, profileRows, shiftRows] = await Promise.all([
    db.select({ p: timePunches, clinicName: clinics.name, userName: users.name }).from(timePunches)
      .innerJoin(users, eq(users.id, timePunches.userId))
      .leftJoin(clinics, eq(clinics.id, timePunches.clinicId))
      .where(and(gte(timePunches.workDate, from), lte(timePunches.workDate, to)))
      .orderBy(asc(timePunches.clockInAt)),
    db.select({ userId: users.id, name: users.name, usesTimeClock: staffProfiles.usesTimeClock, active: staffProfiles.active, jobRoleName: jobRoles.name, homeClinicName: clinics.name })
      .from(staffProfiles).innerJoin(users, eq(users.id, staffProfiles.userId))
      .leftJoin(jobRoles, eq(jobRoles.id, staffProfiles.jobRoleId))
      .leftJoin(clinics, eq(clinics.id, staffProfiles.homeClinicId)),
    db.select({ userId: shifts.userId, startTime: shifts.startTime, endTime: shifts.endTime })
      .from(shifts).where(and(gte(shifts.date, from), lte(shifts.date, to), eq(shifts.status, "scheduled"))),
  ]);
  const scheduled = new Map<number, number>();
  shiftRows.forEach((s) => scheduled.set(s.userId, (scheduled.get(s.userId) ?? 0) + shiftMinutes(s.startTime, s.endTime)));
  const profileBy = new Map(profileRows.map((r) => [r.userId, r]));

  // Everyone on the time clock appears (even with no punches), plus anyone who punched.
  const people = new Map<number, { userId: number; name: string; jobRoleName: string | null; homeClinicName: string | null; usesTimeClock: boolean }>();
  profileRows.filter((r) => r.usesTimeClock && r.active).forEach((r) =>
    people.set(r.userId, { userId: r.userId, name: r.name ?? "Unknown", jobRoleName: r.jobRoleName, homeClinicName: r.homeClinicName, usesTimeClock: true }));
  punchRows.forEach(({ p, userName }) => {
    if (people.has(p.userId)) return;
    const pr = profileBy.get(p.userId);
    people.set(p.userId, { userId: p.userId, name: userName ?? "Unknown", jobRoleName: pr?.jobRoleName ?? null, homeClinicName: pr?.homeClinicName ?? null, usesTimeClock: !!pr?.usesTimeClock });
  });

  return {
    from,
    to,
    today,
    people: Array.from(people.values())
      .map((person) => {
        const mine = punchRows.filter((r) => r.p.userId === person.userId);
        const byWeek = new Map<string, number>();
        let total = 0;
        for (const { p } of mine) {
          const m = punchMinutes(p);
          total += m;
          const wk = weekStart(p.workDate);
          byWeek.set(wk, (byWeek.get(wk) ?? 0) + m);
        }
        const overtime = Array.from(byWeek.values()).reduce((s, m) => s + Math.max(0, m - 40 * 60), 0);
        return {
          ...person,
          totalMinutes: total,
          overtimeMinutes: overtime,
          regularMinutes: total - overtime,
          scheduledMinutes: scheduled.get(person.userId) ?? 0,
          daysWorked: new Set(mine.map((r) => r.p.workDate)).size,
          lateCount: mine.filter((r) => r.p.minutesLate > 0).length,
          missedClockOuts: mine.filter((r) => !r.p.clockOutAt && r.p.workDate < today).length,
          onTheClock: mine.some((r) => !r.p.clockOutAt && r.p.workDate === today),
          punches: mine.map(({ p, clinicName }) => ({
            id: p.id, workDate: p.workDate, clockInAt: p.clockInAt, clockOutAt: p.clockOutAt, minutes: punchMinutes(p),
            minutesLate: p.minutesLate, note: p.note, edited: !!p.editedByUserId, clinicName, lunch: p.outReason === "lunch",
            missingClockOut: !p.clockOutAt && p.workDate < today,
          })),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** A manager adds a punch someone forgot entirely. */
export async function addPunch(input: { userId: number; clockInAt: Date; clockOutAt: Date | null; note?: string | null; editedByUserId: number }): Promise<{ id: number } | { error: string }> {
  const db = await requireDb();
  if (input.clockOutAt && +input.clockOutAt <= +input.clockInAt) return { error: "Clock-out must be after clock-in." };
  if (+input.clockInAt > Date.now()) return { error: "Clock-in can't be in the future." };
  const [profile] = await db.select({ homeClinicId: staffProfiles.homeClinicId }).from(staffProfiles).where(eq(staffProfiles.userId, input.userId)).limit(1);
  const res = await db.insert(timePunches).values({
    userId: input.userId, clinicId: profile?.homeClinicId ?? null, workDate: localDateStr(input.clockInAt),
    clockInAt: input.clockInAt, clockOutAt: input.clockOutAt, note: input.note || "Added by manager", editedByUserId: input.editedByUserId,
  });
  return { id: res?.[0]?.insertId as number };
}

export async function deletePunch(id: number) {
  const db = await requireDb();
  await db.delete(timePunches).where(eq(timePunches.id, id));
}

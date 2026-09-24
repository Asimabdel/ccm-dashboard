// Workforce data layer — job roles, staff profiles, shifts, time off, time clock,
// duty check-offs and performance scorecards. Kept out of db.ts because nothing
// here touches patient data.
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { getDb } from "./db";
import {
  users, clinics, notifications, jobRoles, jobDuties, staffProfiles, shifts,
  timeOffRequests, timePunches, dutyCompletions, performanceNotes,
} from "../drizzle/schema";
import {
  LATE_GRACE_MINUTES, MA_ROLE_TEMPLATE, addDays, localDateStr, localMinutes,
  periodKey, shiftMinutes, timeToMinutes, type DutyFrequency,
} from "../shared/workforce";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db;
}

// ---- Notifications ----

async function notify(userIds: number[], title: string, content?: string) {
  const db = await getDb();
  const ids = Array.from(new Set(userIds)).filter(Boolean);
  if (!db || !ids.length) return;
  await db.insert(notifications).values(ids.map((userId) => ({ userId, type: "workforce" as const, title, content })));
}

async function adminIds(): Promise<number[]> {
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
      canFloat: staffProfiles.canFloat, hoursPerWeek: staffProfiles.hoursPerWeek,
      hireDate: staffProfiles.hireDate, active: staffProfiles.active,
    })
    .from(users)
    .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .leftJoin(jobRoles, eq(jobRoles.id, staffProfiles.jobRoleId))
    .leftJoin(clinics, eq(clinics.id, staffProfiles.homeClinicId))
    .where(or(ne(users.role, "user"), isNotNull(staffProfiles.id)))
    .orderBy(asc(users.name));
}

export async function saveProfile(input: {
  userId: number; jobRoleId: number | null; homeClinicId: number | null; canFloat: boolean;
  hoursPerWeek?: number | null; hireDate?: string | null; active: boolean;
}) {
  const db = await requireDb();
  const values = {
    jobRoleId: input.jobRoleId, homeClinicId: input.homeClinicId, canFloat: input.canFloat,
    hoursPerWeek: input.hoursPerWeek ?? 40, hireDate: input.hireDate ?? null, active: input.active,
  };
  const existing = await db.select({ id: staffProfiles.id }).from(staffProfiles).where(eq(staffProfiles.userId, input.userId)).limit(1);
  if (existing.length) await db.update(staffProfiles).set(values).where(eq(staffProfiles.userId, input.userId));
  else await db.insert(staffProfiles).values({ userId: input.userId, ...values });
}

// ---- Schedule ----

export async function getShiftById(id: number) {
  const db = await requireDb();
  const rows = await db.select().from(shifts).where(eq(shifts.id, id)).limit(1);
  return rows[0];
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
      .innerJoin(clinics, eq(clinics.id, shifts.clinicId))
      .where(and(...conds))
      .orderBy(asc(shifts.date), asc(shifts.startTime)),
    db.select().from(timeOffRequests).where(and(
      inArray(timeOffRequests.status, ["approved", "pending"]),
      lte(timeOffRequests.startDate, to), gte(timeOffRequests.endDate, from),
    )),
  ]);
  const coveredIds = new Set(shiftRows.map((r) => r.shift.coversShiftId).filter(Boolean) as number[]);
  return {
    shifts: shiftRows.map((r) => ({ ...r.shift, userName: r.userName, clinicName: r.clinicName, covered: coveredIds.has(r.shift.id) })),
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
  id?: number; userId: number; clinicId: number; date: string; startTime: string; endTime: string;
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
  const [clinic] = await db.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, shift.clinicId));
  await notify(await adminIds(), `Call-out: ${who?.name ?? "Employee"} — ${clinic?.name ?? "clinic"}`,
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
  const [clinic] = await db.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, shift.clinicId));
  await notify([coverUserId], `You're covering a shift at ${clinic?.name ?? "another clinic"}`, `${shift.date}, ${shift.startTime}–${shift.endTime}.`);
  return { id: res?.[0]?.insertId as number };
}

// ---- Time off ----

export async function listTimeOff(filter: { status?: string; userId?: number } = {}) {
  const db = await requireDb();
  const conds = [];
  if (filter.status) conds.push(eq(timeOffRequests.status, filter.status as any));
  if (filter.userId) conds.push(eq(timeOffRequests.userId, filter.userId));
  const rows = await db
    .select({ r: timeOffRequests, userName: users.name })
    .from(timeOffRequests)
    .innerJoin(users, eq(users.id, timeOffRequests.userId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(timeOffRequests.createdAt))
    .limit(200);
  return rows.map((x) => ({ ...x.r, userName: x.userName }));
}

export async function requestTimeOff(input: { userId: number; userName: string | null; startDate: string; endDate: string; type: "pto" | "sick" | "unpaid" | "other"; reason?: string | null }) {
  const db = await requireDb();
  const res = await db.insert(timeOffRequests).values({
    userId: input.userId, startDate: input.startDate, endDate: input.endDate, type: input.type, reason: input.reason ?? null,
  });
  await notify(await adminIds(), `Time-off request: ${input.userName ?? "Employee"}`,
    `${input.type.toUpperCase()} ${input.startDate}${input.endDate !== input.startDate ? ` → ${input.endDate}` : ""}`);
  return { id: res?.[0]?.insertId as number };
}

export async function cancelTimeOff(id: number, userId: number) {
  const db = await requireDb();
  await db.update(timeOffRequests).set({ status: "cancelled" })
    .where(and(eq(timeOffRequests.id, id), eq(timeOffRequests.userId, userId), inArray(timeOffRequests.status, ["pending", "approved"])));
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
  const conflicts = input.status === "approved"
    ? await db.select().from(shifts).where(and(eq(shifts.userId, req.userId), gte(shifts.date, req.startDate), lte(shifts.date, req.endDate), eq(shifts.status, "scheduled")))
    : [];
  return { conflicts };
}

// ---- Time clock ----

export async function getOpenPunch(userId: number) {
  const db = await requireDb();
  const rows = await db.select().from(timePunches).where(and(eq(timePunches.userId, userId), isNull(timePunches.clockOutAt))).orderBy(desc(timePunches.clockInAt)).limit(1);
  return rows[0];
}

export async function clockIn(userId: number): Promise<{ id: number; minutesLate: number } | { error: string }> {
  const db = await requireDb();
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
  if (shift) {
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

export async function clockOut(userId: number): Promise<{ success: true } | { error: string }> {
  const db = await requireDb();
  const open = await getOpenPunch(userId);
  if (!open) return { error: "You're not clocked in." };
  await db.update(timePunches).set({ clockOutAt: new Date() }).where(eq(timePunches.id, open.id));
  return { success: true };
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
    db.select({ shift: shifts, clinicName: clinics.name }).from(shifts).innerJoin(clinics, eq(clinics.id, shifts.clinicId))
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
    jobRole: profileRow?.jobRole ?? null,
    homeClinicName: profileRow?.clinicName ?? null,
    duties: duties.map((d) => ({ ...d, done: doneIds.has(d.id) })),
    shifts: todaysShifts.map((s) => ({ ...s.shift, clinicName: s.clinicName })),
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
    db.select({ shift: shifts, clinicName: clinics.name }).from(shifts).innerJoin(clinics, eq(clinics.id, shifts.clinicId))
      .where(and(eq(shifts.userId, userId), gte(shifts.date, from), lte(shifts.date, to))).orderBy(asc(shifts.date), asc(shifts.startTime)),
    listTimeOff({ userId }),
  ]);
  return { shifts: shiftRows.map((s) => ({ ...s.shift, clinicName: s.clinicName })), timeOff };
}

// ---- Today board ----

/** Per-clinic view of a day: who's scheduled, who's in, who's late, open coverage. */
export async function getDayBoard(date: string) {
  const db = await requireDb();
  const [{ shifts: dayShifts }, punches, allClinics, pendingTimeOff] = await Promise.all([
    getSchedule(date, date),
    db.select().from(timePunches).where(eq(timePunches.workDate, date)),
    db.select().from(clinics).orderBy(asc(clinics.name)),
    db.select({ n: sql<number>`count(*)` }).from(timeOffRequests).where(eq(timeOffRequests.status, "pending")),
  ]);
  const isToday = date === localDateStr();
  const nowMin = localMinutes();
  const rows = dayShifts.map((s) => {
    const mine = punches.filter((p) => p.shiftId === s.id || (p.shiftId == null && p.userId === s.userId));
    const first = mine.slice().sort((a, b) => +a.clockInAt - +b.clockInAt)[0];
    let state: "called_out" | "upcoming" | "clocked_in" | "done" | "late" | "no_show";
    if (s.status === "called_out") state = "called_out";
    else if (mine.some((p) => !p.clockOutAt)) state = "clocked_in";
    else if (first) state = "done";
    else if (date > localDateStr() || (isToday && nowMin <= timeToMinutes(s.startTime) + LATE_GRACE_MINUTES)) state = "upcoming";
    else if (isToday && nowMin < timeToMinutes(s.endTime)) state = "late";
    else state = "no_show";
    return { ...s, state, clockInAt: first?.clockInAt ?? null, minutesLate: first?.minutesLate ?? 0 };
  });
  return {
    date,
    pendingTimeOff: Number(pendingTimeOff[0]?.n ?? 0),
    clinics: allClinics.map((c) => ({ id: c.id, name: c.name, shifts: rows.filter((r) => r.clinicId === c.id) })),
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
    const due = myShifts.filter((s) => s.status === "scheduled" && (s.date < today || timeToMinutes(s.startTime) + LATE_GRACE_MINUTES < nowMin));
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

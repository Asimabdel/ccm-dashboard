// Workspace data access: tasks, schedule import + patient flow, home metrics,
// Opportunity Finder, playbooks and the Patient 360 operational summary.
// Access decisions (who may call what) live in server/routers/workspace.ts;
// the helpers here take an explicit clinic scope so they never widen access.
import { createHash } from "crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import {
  appointments,
  appointmentStatusEvents,
  auditLogs,
  ccmTasks,
  clinics,
  notifications,
  opportunityActions,
  patients,
  playbooks,
  playbookVersions,
  providerEscalations,
  providers,
  refillRequests,
  scheduleImports,
  shifts,
  staffProfiles,
  users,
  workTaskActivities,
  workTasks,
} from "../drizzle/schema";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";
import { getDb } from "./db";
import { currentMonth } from "./seed";
import { localDateStr, addDays } from "../shared/workforce";
import {
  IN_CLINIC_STATUSES,
  OPEN_TASK_STATUSES,
  PRIORITY_RANK,
  STATUS_TIMESTAMP,
  WAITING_STATUSES,
  checkFlowTransition,
  clinicLocalToUtc,
  evaluateOpportunities,
  evaluateScheduleOpportunities,
  SEEN_STATUSES,
  type OpportunityMatch,
  type ScheduleVisit,
  evaluateScheduleFill,
  providerActivity,
  type FillGroup,
  type FillVisit,
  findOpenings,
  minutesBetween,
  nameKey,
  nextClinicDay,
  type FlowStatus,
  type OpportunityCategory,
  type ParsedAppointmentRow,
  type TaskCategory,
  type TaskPriority,
  type TaskStatus,
} from "../shared/workspace";
import { matchProviderId } from "../shared/csvImport";
import { normalizePhone } from "../shared/phone";

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public code: "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST" = "BAD_REQUEST",
  ) {
    super(message);
  }
}

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

/** Who is acting, and which clinics they may see (null = every clinic). */
export interface WorkspaceActor {
  id: number;
  name: string | null;
  role: string;
  clinicIds: number[] | null;
  ip?: string | null;
}

// ---------------------------------------------------------------------------
// Audit + notifications
// ---------------------------------------------------------------------------

type AuditAction =
  | "create_task"
  | "update_task"
  | "view_schedule"
  | "import_schedule"
  | "update_appointment"
  | "opportunity_action"
  | "manage_playbook"
  | "view_patient"
  | "manage_access";

export async function audit(actor: WorkspaceActor, action: AuditAction, opts: { entityType?: string; entityId?: number; description?: string } = {}) {
  try {
    const d = await db();
    await d.insert(auditLogs).values({
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action,
      entityType: opts.entityType,
      entityId: opts.entityId,
      description: opts.description,
      ipAddress: actor.ip ?? null,
    });
  } catch (e) {
    console.warn("[Audit] workspace audit failed:", e);
  }
}

async function notifyTask(userId: number, title: string, content: string, patientId: number | null) {
  try {
    const d = await db();
    await d.insert(notifications).values({ userId, type: "task", title, content, relatedPatientId: patientId });
  } catch (e) {
    console.warn("[Notify] task notification failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Clinic scope
// ---------------------------------------------------------------------------

/**
 * Clinics a medical assistant may work in today: their home clinic, the clinic
 * of any shift they have today, or every clinic if they're a floater.
 */
export async function getMaClinicIds(userId: number): Promise<number[] | null> {
  const d = await db();
  const [profile] = await d.select().from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
  if (profile?.canFloat) return null;
  const set = new Set<number>();
  if (profile?.homeClinicId) set.add(profile.homeClinicId);
  const todays = await d
    .select({ clinicId: shifts.clinicId })
    .from(shifts)
    .where(and(eq(shifts.userId, userId), eq(shifts.date, localDateStr()), eq(shifts.status, "scheduled")));
  todays.forEach((s) => { if (s.clinicId) set.add(s.clinicId); });
  return Array.from(set);
}

/** Intersect a requested clinic with the actor's allowed clinics. */
export function scopeClinics(actor: WorkspaceActor, requested?: number | null): number[] | null {
  if (requested) {
    if (actor.clinicIds && !actor.clinicIds.includes(requested)) return [];
    return [requested];
  }
  return actor.clinicIds;
}

function clinicFilter(col: AnyMySqlColumn, scope: number[] | null): SQL | undefined {
  if (scope === null) return undefined;
  if (scope.length === 0) return sql`1 = 0`;
  return inArray(col, scope);
}

export async function listClinics(actor: WorkspaceActor) {
  const d = await db();
  const all = await d.select({ id: clinics.id, name: clinics.name, location: clinics.location }).from(clinics).orderBy(asc(clinics.name));
  return actor.clinicIds === null ? all : all.filter((c) => actor.clinicIds!.includes(c.id));
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskView = "mine" | "team" | "due_today" | "overdue" | "high" | "completed" | "all";

export interface TaskFilters {
  view: TaskView;
  clinicId?: number | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  category?: TaskCategory;
  due?: "overdue" | "today" | "week" | "none";
  q?: string;
  patientId?: number;
}

/** Team = my role's queue, unassigned tasks, and (for managers) everything assigned. */
function teamCondition(actor: WorkspaceActor): SQL {
  const parts: SQL[] = [eq(workTasks.assignedRole, actor.role), and(isNull(workTasks.assignedUserId), isNull(workTasks.assignedRole))!];
  if (actor.role === "admin") parts.push(sql`${workTasks.assignedUserId} IS NOT NULL`);
  return or(...parts)!;
}

function taskWhere(actor: WorkspaceActor, f: TaskFilters): SQL {
  const today = localDateStr();
  const conds: (SQL | undefined)[] = [];
  const scope = scopeClinics(actor, f.clinicId);
  if (scope !== null) {
    const inScope = scope.length ? inArray(workTasks.clinicId, scope) : sql`1 = 0`;
    // Clinic-less tasks always show. A picked clinic filters the rest; an access limit
    // (MAs) never hides a task that was assigned directly to you.
    conds.push(f.clinicId ? or(inScope, isNull(workTasks.clinicId))! : or(inScope, isNull(workTasks.clinicId), eq(workTasks.assignedUserId, actor.id))!);
  }
  const open = inArray(workTasks.status, OPEN_TASK_STATUSES);
  const minePlusTeam = or(eq(workTasks.assignedUserId, actor.id), teamCondition(actor))!;
  switch (f.view) {
    case "mine":
      conds.push(eq(workTasks.assignedUserId, actor.id), open);
      break;
    case "team":
      conds.push(teamCondition(actor), open);
      break;
    case "due_today":
      conds.push(minePlusTeam, open, eq(workTasks.dueDate, today));
      break;
    case "overdue":
      conds.push(minePlusTeam, open, lt(workTasks.dueDate, today));
      break;
    case "high":
      conds.push(minePlusTeam, open, inArray(workTasks.priority, ["high", "urgent"]));
      break;
    case "completed":
      conds.push(minePlusTeam, eq(workTasks.status, "completed"));
      break;
    case "all":
      if (actor.role !== "admin") conds.push(minePlusTeam);
      break;
  }
  if (f.status) conds.push(eq(workTasks.status, f.status));
  if (f.priority) conds.push(eq(workTasks.priority, f.priority));
  if (f.category) conds.push(eq(workTasks.category, f.category));
  if (f.patientId) conds.push(eq(workTasks.patientId, f.patientId));
  if (f.due === "overdue") conds.push(lt(workTasks.dueDate, today));
  if (f.due === "today") conds.push(eq(workTasks.dueDate, today));
  if (f.due === "week") conds.push(gte(workTasks.dueDate, today), lte(workTasks.dueDate, addDays(today, 7)));
  if (f.due === "none") conds.push(isNull(workTasks.dueDate));
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "")}%`;
    conds.push(or(sql`${workTasks.title} LIKE ${like}`, sql`${patients.name} LIKE ${like}`));
  }
  return and(...conds.filter((c): c is SQL => !!c)) ?? sql`1 = 1`;
}

const taskSelect = {
  id: workTasks.id,
  title: workTasks.title,
  status: workTasks.status,
  priority: workTasks.priority,
  category: workTasks.category,
  dueDate: workTasks.dueDate,
  completedAt: workTasks.completedAt,
  createdAt: workTasks.createdAt,
  assignedUserId: workTasks.assignedUserId,
  assignedRole: workTasks.assignedRole,
  patientId: workTasks.patientId,
  patientName: patients.name,
  clinicId: workTasks.clinicId,
  clinicName: clinics.name,
  assigneeName: users.name,
};

export async function listTasks(actor: WorkspaceActor, f: TaskFilters) {
  const d = await db();
  const rows = await d
    .select(taskSelect)
    .from(workTasks)
    .leftJoin(patients, eq(workTasks.patientId, patients.id))
    .leftJoin(clinics, eq(workTasks.clinicId, clinics.id))
    .leftJoin(users, eq(workTasks.assignedUserId, users.id))
    .where(taskWhere(actor, f))
    .orderBy(f.view === "completed" ? desc(workTasks.completedAt) : asc(workTasks.dueDate))
    .limit(300);
  if (f.view === "completed") return rows;
  // Due date first (no date last), then priority.
  return rows.sort((a, b) => {
    const da = a.dueDate ?? "9999-99-99";
    const dbb = b.dueDate ?? "9999-99-99";
    if (da !== dbb) return da < dbb ? -1 : 1;
    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  });
}

export async function taskCounts(actor: WorkspaceActor, clinicId?: number | null) {
  const d = await db();
  const count = async (view: TaskView) =>
    (
      await d
        .select({ n: sql<number>`count(*)` })
        .from(workTasks)
        .leftJoin(patients, eq(workTasks.patientId, patients.id))
        .where(taskWhere(actor, { view, clinicId }))
    )[0]?.n ?? 0;
  const today = localDateStr();
  const [mine, team, dueToday, overdue, high] = await Promise.all([count("mine"), count("team"), count("due_today"), count("overdue"), count("high")]);
  const completedToday =
    (
      await d
        .select({ n: sql<number>`count(*)` })
        .from(workTasks)
        .leftJoin(patients, eq(workTasks.patientId, patients.id))
        .where(and(taskWhere(actor, { view: "completed", clinicId }), gte(workTasks.completedAt, clinicLocalToUtc(today, "00:00"))))
    )[0]?.n ?? 0;
  return { mine: Number(mine), team: Number(team), dueToday: Number(dueToday), overdue: Number(overdue), high: Number(high), completedToday: Number(completedToday) };
}

/** A task is visible if it's in the actor's clinics and they own it, are its queue, or manage. */
async function loadVisibleTask(actor: WorkspaceActor, taskId: number) {
  const d = await db();
  const [t] = await d.select().from(workTasks).where(eq(workTasks.id, taskId)).limit(1);
  if (!t) throw new WorkspaceError("Task not found.", "NOT_FOUND");
  if (actor.clinicIds && t.clinicId && !actor.clinicIds.includes(t.clinicId) && t.assignedUserId !== actor.id) throw new WorkspaceError("Task not found.", "NOT_FOUND");
  const mineOrQueue = t.assignedUserId === actor.id || t.assignedRole === actor.role || (!t.assignedUserId && !t.assignedRole) || t.createdByUserId === actor.id;
  if (!mineOrQueue && !["admin", "staff", "provider", "front_desk"].includes(actor.role)) throw new WorkspaceError("Task not found.", "NOT_FOUND");
  return t;
}

export async function taskDetail(actor: WorkspaceActor, taskId: number) {
  const t = await loadVisibleTask(actor, taskId);
  const d = await db();
  const [extra] = await d
    .select({ patientName: patients.name, patientDob: patients.dateOfBirth, patientPhone: patients.phoneNumber, clinicName: clinics.name, assigneeName: users.name })
    .from(workTasks)
    .leftJoin(patients, eq(workTasks.patientId, patients.id))
    .leftJoin(clinics, eq(workTasks.clinicId, clinics.id))
    .leftJoin(users, eq(workTasks.assignedUserId, users.id))
    .where(eq(workTasks.id, taskId))
    .limit(1);
  const creator = t.createdByUserId ? (await d.select({ name: users.name }).from(users).where(eq(users.id, t.createdByUserId)).limit(1))[0] : undefined;
  const activities = await d
    .select({ id: workTaskActivities.id, type: workTaskActivities.type, body: workTaskActivities.body, meta: workTaskActivities.meta, createdAt: workTaskActivities.createdAt, userName: users.name })
    .from(workTaskActivities)
    .leftJoin(users, eq(workTaskActivities.userId, users.id))
    .where(eq(workTaskActivities.taskId, taskId))
    .orderBy(asc(workTaskActivities.createdAt));
  return { ...t, ...extra, createdByName: creator?.name ?? null, activities };
}

export async function assignableUsers(actor: WorkspaceActor) {
  const d = await db();
  const rows = await d
    .select({ id: users.id, name: users.name, role: users.role, homeClinicId: staffProfiles.homeClinicId })
    .from(users)
    .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .where(and(ne(users.role, "user"), sql`${users.openId} NOT LIKE 'roster:%' OR ${users.role} = 'medical_assistant'`))
    .orderBy(asc(users.name));
  return rows.filter((u) => u.name);
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  patientId?: number | null;
  clinicId?: number | null;
  assignedUserId?: number | null;
  assignedRole?: string | null;
  priority: TaskPriority;
  category: TaskCategory;
  dueDate?: string | null;
  sourceType?: string | null;
  sourceRef?: string | null;
}

export async function createTask(actor: WorkspaceActor, input: CreateTaskInput) {
  const d = await db();
  let clinicId = input.clinicId ?? null;
  if (input.patientId) {
    const [p] = await d.select({ clinicId: patients.clinicId }).from(patients).where(eq(patients.id, input.patientId)).limit(1);
    if (!p) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
    clinicId = clinicId ?? p.clinicId ?? null;
  }
  if (actor.clinicIds && clinicId && !actor.clinicIds.includes(clinicId)) throw new WorkspaceError("You can't create tasks for that clinic.", "FORBIDDEN");
  const assignedUserId = input.assignedUserId ?? (input.assignedRole ? null : actor.id);
  const [res] = await d.insert(workTasks).values({
    title: input.title,
    description: input.description ?? null,
    patientId: input.patientId ?? null,
    clinicId,
    assignedUserId,
    assignedRole: assignedUserId ? null : (input.assignedRole ?? null),
    priority: input.priority,
    category: input.category,
    dueDate: input.dueDate ?? null,
    createdByUserId: actor.id,
    sourceType: input.sourceType ?? "manual",
    sourceRef: input.sourceRef ?? null,
  });
  const id = Number((res as unknown as { insertId: number }).insertId);
  await d.insert(workTaskActivities).values({ taskId: id, userId: actor.id, type: "created" });
  await audit(actor, "create_task", { entityType: "workTask", entityId: id, description: `category=${input.category}; source=${input.sourceType ?? "manual"}` });
  if (assignedUserId && assignedUserId !== actor.id) await notifyTask(assignedUserId, "New task assigned to you", input.title, input.patientId ?? null);
  return { id };
}

export async function updateTask(
  actor: WorkspaceActor,
  taskId: number,
  input: { status?: TaskStatus; priority?: TaskPriority; assignedUserId?: number | null; assignedRole?: string | null; dueDate?: string | null },
) {
  const t = await loadVisibleTask(actor, taskId);
  const d = await db();
  const patch: Partial<typeof workTasks.$inferInsert> = {};
  const acts: (typeof workTaskActivities.$inferInsert)[] = [];
  if (input.status && input.status !== t.status) {
    if (t.status === "cancelled") throw new WorkspaceError("Cancelled tasks can't be changed.");
    patch.status = input.status;
    patch.completedAt = input.status === "completed" ? new Date() : null;
    acts.push({ taskId, userId: actor.id, type: "status_changed", meta: { from: t.status, to: input.status } });
  }
  if (input.priority && input.priority !== t.priority) {
    patch.priority = input.priority;
    acts.push({ taskId, userId: actor.id, type: "priority_changed", meta: { from: t.priority, to: input.priority } });
  }
  if (input.assignedUserId !== undefined && input.assignedUserId !== t.assignedUserId) {
    patch.assignedUserId = input.assignedUserId;
    patch.assignedRole = input.assignedUserId ? null : (input.assignedRole ?? t.assignedRole);
    acts.push({ taskId, userId: actor.id, type: "assigned", meta: { to: input.assignedUserId ? String(input.assignedUserId) : null } });
  }
  if (input.dueDate !== undefined && input.dueDate !== t.dueDate) {
    patch.dueDate = input.dueDate;
    acts.push({ taskId, userId: actor.id, type: "due_date_changed", meta: { to: input.dueDate } });
  }
  if (!acts.length) return { changed: false };
  await d.update(workTasks).set(patch).where(eq(workTasks.id, taskId));
  await d.insert(workTaskActivities).values(acts);
  await audit(actor, "update_task", { entityType: "workTask", entityId: taskId, description: `fields=${Object.keys(patch).join(",")}` });
  if (input.assignedUserId && input.assignedUserId !== actor.id && input.assignedUserId !== t.assignedUserId) {
    await notifyTask(input.assignedUserId, "Task assigned to you", t.title, t.patientId);
  }
  return { changed: true };
}

export async function commentTask(actor: WorkspaceActor, taskId: number, body: string) {
  await loadVisibleTask(actor, taskId);
  const d = await db();
  await d.insert(workTaskActivities).values({ taskId, userId: actor.id, type: "comment", body });
  await audit(actor, "update_task", { entityType: "workTask", entityId: taskId, description: "comment" });
}

// ---------------------------------------------------------------------------
// Schedule import
// ---------------------------------------------------------------------------

/**
 * Stable identity of a schedule row across re-imports: same patient, same provider,
 * same start time. The clinic is deliberately NOT part of it, so assigning a
 * provider to a clinic later just updates the existing appointments.
 */
export function appointmentKey(row: ParsedAppointmentRow): string {
  const raw = [row.date, row.time, nameKey(row.patientName), (row.provider ?? "").toLowerCase().replace(/[^a-z]/g, "")].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 48);
}

function matchClinicId(location: string | null, all: { id: number; name: string; location: string }[]): number | null {
  if (!location) return null;
  const l = location.toLowerCase().trim();
  const hit = all.find((c) => l.includes(c.location.toLowerCase()) || l.includes(c.name.toLowerCase()) || (l.length >= 4 && c.name.toLowerCase().includes(l)));
  return hit?.id ?? null;
}

const ymd = (dt: Date | null) => (dt ? dt.toISOString().slice(0, 10) : null);
/** "john q public" → "john public" (first + last word), for a second-chance match. */
const firstLast = (key: string) => {
  const w = key.split(" ").filter(Boolean);
  return w.length >= 2 ? `${w[0]} ${w[w.length - 1]}` : key;
};

/**
 * Build lookups once, then resolve provider, patient and clinic for each row.
 * Clinic comes from the file's location text when it names a clinic, else the
 * provider's home clinic, else the linked patient's clinic, else the default
 * picked for the file; otherwise it stays unassigned (managers still see it).
 */
export async function resolveScheduleRows(rows: ParsedAppointmentRow[], defaultClinicId: number | null) {
  const d = await db();
  const [allClinics, allProviders, allPatients] = await Promise.all([
    d.select({ id: clinics.id, name: clinics.name, location: clinics.location }).from(clinics),
    d.select({ id: providers.id, name: providers.name, aliases: providers.aliases, clinicId: providers.clinicId }).from(providers),
    d.select({ id: patients.id, name: patients.name, dateOfBirth: patients.dateOfBirth, clinicId: patients.clinicId }).from(patients),
  ]);
  const providerClinic = new Map(allProviders.map((p) => [p.id, p.clinicId]));
  const patientClinic = new Map(allPatients.map((p) => [p.id, p.clinicId]));
  const byName = new Map<string, { id: number; dob: string | null }[]>();
  const byFirstLast = new Map<string, { id: number; dob: string | null }[]>();
  for (const p of allPatients) {
    const k = nameKey(p.name);
    const entry = { id: p.id, dob: ymd(p.dateOfBirth) };
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(entry);
    const fl = firstLast(k);
    (byFirstLast.get(fl) ?? byFirstLast.set(fl, []).get(fl)!).push(entry);
  }
  const findPatient = (name: string, dob: string | null): number | null => {
    const key = nameKey(name);
    const cands = byName.get(key) ?? [];
    if (cands.length) {
      if (dob) {
        const exact = cands.filter((c) => c.dob === dob);
        if (exact.length === 1) return exact[0]!.id;
        if (exact.length > 1) return null;
        // Legacy rows may lack a DOB: accept a unique same-name patient with no DOB on file.
        const noDob = cands.filter((c) => !c.dob);
        return cands.length === 1 && noDob.length === 1 ? noDob[0]!.id : null;
      }
      return cands.length === 1 ? cands[0]!.id : null;
    }
    // Middle names/initials differ between systems: first + last name with an exact DOB.
    if (!dob) return null;
    const fl = (byFirstLast.get(firstLast(key)) ?? []).filter((c) => c.dob === dob);
    return fl.length === 1 ? fl[0]!.id : null;
  };
  return rows.map((r) => {
    const providerId = matchProviderId(r.provider, allProviders);
    const patientId = findPatient(r.patientName, r.dob);
    const clinicId =
      matchClinicId(r.location, allClinics) ??
      (providerId ? providerClinic.get(providerId) ?? null : null) ??
      (patientId ? patientClinic.get(patientId) ?? null : null) ??
      defaultClinicId ??
      null;
    return { ...r, clinicId, providerId, patientId, key: appointmentKey(r) };
  });
}

const FINAL_STATUSES = ["completed", "no_show", "cancelled"];

export async function commitSchedule(
  actor: WorkspaceActor,
  input: { fileName: string | null; rows: ParsedAppointmentRow[]; defaultClinicId: number | null; cancelMissing: boolean },
) {
  const d = await db();
  const resolvedAll = await resolveScheduleRows(input.rows, input.defaultClinicId);
  if (actor.clinicIds) {
    const outside = resolvedAll.filter((r) => !r.clinicId || !actor.clinicIds!.includes(r.clinicId));
    if (outside.length) throw new WorkspaceError("This file includes clinics you don't have access to.", "FORBIDDEN");
  }
  // The same patient/provider/time listed twice counts once (the later line wins).
  const resolved = Array.from(new Map(resolvedAll.map((r) => [r.key, r])).values());
  const dates = Array.from(new Set(resolved.map((r) => r.date))).sort();
  const [imp] = await d.insert(scheduleImports).values({
    fileName: input.fileName?.slice(0, 255) ?? null,
    importedByUserId: actor.id,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    rowCount: resolved.length,
  });
  const importId = Number((imp as unknown as { insertId: number }).insertId);

  const keys = resolved.map((r) => r.key);
  const existing: (typeof appointments.$inferSelect)[] = [];
  for (let i = 0; i < keys.length; i += 1000) {
    existing.push(...(await d.select().from(appointments).where(inArray(appointments.externalKey, keys.slice(i, i + 1000)))));
  }
  const existingByKey = new Map(existing.map((e) => [e.externalKey, e]));
  const inserts: (typeof appointments.$inferInsert)[] = [];
  const updateGroups = new Map<string, { diff: Partial<typeof appointments.$inferInsert>; ids: number[] }>();
  let updated = 0;
  let unchanged = 0;
  for (const r of resolved) {
    const base = {
      clinicId: r.clinicId,
      patientId: r.patientId,
      patientName: r.patientName,
      dateOfBirth: r.dob ? new Date(`${r.dob}T12:00:00Z`) : null,
      phoneNumber: r.phone,
      providerId: r.providerId,
      providerName: r.provider,
      date: r.date,
      startsAt: clinicLocalToUtc(r.date, r.time),
      durationMin: r.durationMin,
      visitType: r.visitType,
      reason: r.reason,
    };
    const prev = existingByKey.get(r.key);
    if (!prev) {
      inserts.push({ ...base, status: r.status, externalKey: r.key, importId });
      continue;
    }
    // Practice Fusion's final outcome (seen / no-show / cancelled) wins; otherwise keep a
    // status already moved on the flow board and only adopt the file's while still "scheduled".
    const status = FINAL_STATUSES.includes(r.status) || prev.status === "scheduled" ? r.status : prev.status;
    const next = { ...base, patientId: base.patientId ?? prev.patientId, status };
    // Only the fields that actually changed.
    const diff: Partial<typeof appointments.$inferInsert> = {};
    if (next.clinicId !== prev.clinicId) diff.clinicId = next.clinicId;
    if (next.patientId !== prev.patientId) diff.patientId = next.patientId;
    if (next.patientName !== prev.patientName) diff.patientName = next.patientName;
    if (ymd(next.dateOfBirth) !== ymd(prev.dateOfBirth)) diff.dateOfBirth = next.dateOfBirth;
    if (next.phoneNumber !== prev.phoneNumber) diff.phoneNumber = next.phoneNumber;
    if (next.providerId !== prev.providerId) diff.providerId = next.providerId;
    if (next.providerName !== prev.providerName) diff.providerName = next.providerName;
    if (next.durationMin !== prev.durationMin) diff.durationMin = next.durationMin;
    if (next.visitType !== prev.visitType) diff.visitType = next.visitType;
    if (next.reason !== prev.reason) diff.reason = next.reason;
    if (next.status !== prev.status) diff.status = next.status;
    if (!Object.keys(diff).length) {
      unchanged++;
      continue;
    }
    // Identical changes (e.g. "move to clinic 4" after a provider changes clinics) are
    // written together, so re-importing a whole year stays within the request time limit.
    const groupKey = JSON.stringify(diff);
    const group = updateGroups.get(groupKey) ?? updateGroups.set(groupKey, { diff, ids: [] }).get(groupKey)!;
    group.ids.push(prev.id);
    updated++;
  }
  for (const { diff, ids } of Array.from(updateGroups.values())) {
    for (let i = 0; i < ids.length; i += 1000) await d.update(appointments).set({ ...diff, importId }).where(inArray(appointments.id, ids.slice(i, i + 1000)));
  }
  for (let i = 0; i < inserts.length; i += 400) await d.insert(appointments).values(inserts.slice(i, i + 400));
  const created = inserts.length;

  let cancelled = 0;
  if (input.cancelMissing && dates.length) {
    const clinicIds = Array.from(new Set(resolved.map((r) => r.clinicId).filter((c): c is number => c != null)));
    const clinicCond = clinicIds.length ? or(inArray(appointments.clinicId, clinicIds), isNull(appointments.clinicId)) : isNull(appointments.clinicId);
    const stale = await d
      .select({ id: appointments.id, key: appointments.externalKey })
      .from(appointments)
      .where(and(inArray(appointments.date, dates), clinicCond, eq(appointments.status, "scheduled")));
    const keep = new Set(keys);
    const toCancel = stale.filter((s) => !keep.has(s.key)).map((s) => s.id);
    for (let i = 0; i < toCancel.length; i += 1000) {
      await d.update(appointments).set({ status: "cancelled" }).where(inArray(appointments.id, toCancel.slice(i, i + 1000)));
    }
    cancelled = toCancel.length;
  }
  const linked = resolved.filter((r) => r.patientId).length;
  await d.update(scheduleImports).set({ createdCount: created, updatedCount: updated, linkedCount: linked }).where(eq(scheduleImports.id, importId));
  await audit(actor, "import_schedule", { entityType: "scheduleImport", entityId: importId, description: `rows=${resolved.length}; created=${created}; updated=${updated}; unchanged=${unchanged}; cancelled=${cancelled}; dates=${dates[0]}..${dates[dates.length - 1]}` });
  scheduleCache.clear();
  return { importId, created, updated, unchanged, cancelled, linked, rows: resolved.length, dates };
}

export async function recentImports() {
  const d = await db();
  return d
    .select({ id: scheduleImports.id, fileName: scheduleImports.fileName, firstDate: scheduleImports.firstDate, lastDate: scheduleImports.lastDate, rowCount: scheduleImports.rowCount, createdCount: scheduleImports.createdCount, updatedCount: scheduleImports.updatedCount, linkedCount: scheduleImports.linkedCount, createdAt: scheduleImports.createdAt, importedBy: users.name })
    .from(scheduleImports)
    .leftJoin(users, eq(scheduleImports.importedByUserId, users.id))
    .orderBy(desc(scheduleImports.createdAt))
    .limit(10);
}

// ---------------------------------------------------------------------------
// Patient flow
// ---------------------------------------------------------------------------

export async function flowBoard(actor: WorkspaceActor, input: { clinicId?: number | null; date?: string }) {
  const d = await db();
  const date = input.date ?? localDateStr();
  const scope = scopeClinics(actor, input.clinicId);
  const rows = await d
    .select({
      id: appointments.id,
      patientId: appointments.patientId,
      patientName: appointments.patientName,
      dateOfBirth: appointments.dateOfBirth,
      startsAt: appointments.startsAt,
      durationMin: appointments.durationMin,
      providerName: appointments.providerName,
      providerDisplay: providers.name,
      visitType: appointments.visitType,
      reason: appointments.reason,
      status: appointments.status,
      room: appointments.room,
      clinicId: appointments.clinicId,
      clinicName: clinics.name,
      arrivedAt: appointments.arrivedAt,
      checkedInAt: appointments.checkedInAt,
      roomedAt: appointments.roomedAt,
      withProviderAt: appointments.withProviderAt,
      checkoutAt: appointments.checkoutAt,
      completedAt: appointments.completedAt,
    })
    .from(appointments)
    .leftJoin(providers, eq(appointments.providerId, providers.id))
    .leftJoin(clinics, eq(appointments.clinicId, clinics.id))
    .where(and(eq(appointments.date, date), clinicFilter(appointments.clinicId, scope)))
    .orderBy(asc(appointments.startsAt));
  const now = new Date();
  const cards = rows.map((r) => {
    const tsField = STATUS_TIMESTAMP[r.status as keyof typeof STATUS_TIMESTAMP];
    return {
      ...r,
      provider: r.providerDisplay ?? r.providerName ?? "—",
      statusSince: tsField ? ((r as Record<string, unknown>)[tsField] as Date | null) : null,
    };
  });
  // Imported "In lobby" visits have no arrival time: they count as waiting, but only
  // visits with a known arrival time feed the wait-time numbers.
  const waiting = cards.filter((c) => WAITING_STATUSES.includes(c.status as FlowStatus));
  const waits = waiting.filter((c) => c.arrivedAt).map((c) => minutesBetween(c.arrivedAt!, now));
  const seenWaits = cards.filter((c) => c.arrivedAt && c.withProviderAt).map((c) => minutesBetween(c.arrivedAt!, c.withProviderAt!));
  const allWaits = [...waits, ...seenWaits];
  return {
    date,
    cards,
    metrics: {
      total: cards.filter((c) => c.status !== "cancelled").length,
      inClinic: cards.filter((c) => IN_CLINIC_STATUSES.includes(c.status as FlowStatus)).length,
      waiting: waiting.length,
      avgWait: allWaits.length ? Math.round(allWaits.reduce((s, n) => s + n, 0) / allWaits.length) : 0,
      longestWait: waits.length ? Math.max(...waits) : 0,
      completed: cards.filter((c) => c.status === "completed").length,
      noShows: cards.filter((c) => c.status === "no_show").length,
    },
  };
}

export async function moveAppointment(actor: WorkspaceActor, input: { appointmentId: number; to: FlowStatus; confirmed: boolean; room?: string | null }) {
  const d = await db();
  const [a] = await d.select().from(appointments).where(eq(appointments.id, input.appointmentId)).limit(1);
  if (!a) throw new WorkspaceError("Appointment not found.", "NOT_FOUND");
  if (actor.clinicIds && (!a.clinicId || !actor.clinicIds.includes(a.clinicId))) throw new WorkspaceError("Appointment not found.", "NOT_FOUND");
  const check = checkFlowTransition(a.status as FlowStatus, input.to);
  if (!check.allowed) throw new WorkspaceError(check.reason);
  if (check.requiresConfirmation && !input.confirmed) throw new WorkspaceError("This change needs confirmation.");
  const now = new Date();
  const patch: Partial<typeof appointments.$inferInsert> = { status: input.to };
  const field = STATUS_TIMESTAMP[input.to as keyof typeof STATUS_TIMESTAMP];
  if (field) (patch as Record<string, unknown>)[field] = now;
  if (input.to === "arrived" && !a.arrivedAt) patch.arrivedAt = now;
  if (input.to === "scheduled") Object.values(STATUS_TIMESTAMP).forEach((f) => ((patch as Record<string, unknown>)[f] = null));
  if (input.room !== undefined) patch.room = input.room;
  await d.update(appointments).set(patch).where(eq(appointments.id, a.id));
  await d.insert(appointmentStatusEvents).values({ appointmentId: a.id, fromStatus: a.status, toStatus: input.to, changedByUserId: actor.id });
  // Completing a linked visit keeps the CCM "last office visit" date current.
  if (input.to === "completed" && a.patientId) {
    await d.update(patients).set({ lastOfficeVisit: a.startsAt }).where(and(eq(patients.id, a.patientId), or(isNull(patients.lastOfficeVisit), lt(patients.lastOfficeVisit, a.startsAt))));
  }
  scheduleCache.clear();
  await audit(actor, "update_appointment", { entityType: "appointment", entityId: a.id, description: `${a.status} -> ${input.to}` });
  return { from: a.status, to: input.to };
}

export async function setRoom(actor: WorkspaceActor, appointmentId: number, room: string | null) {
  const d = await db();
  const [a] = await d.select({ clinicId: appointments.clinicId }).from(appointments).where(eq(appointments.id, appointmentId)).limit(1);
  if (!a || (actor.clinicIds && (!a.clinicId || !actor.clinicIds.includes(a.clinicId)))) throw new WorkspaceError("Appointment not found.", "NOT_FOUND");
  await d.update(appointments).set({ room }).where(eq(appointments.id, appointmentId));
}

// ---------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------

export async function openings(actor: WorkspaceActor, input: { clinicId?: number | null; days: number }) {
  const d = await db();
  const today = localDateStr();
  const until = addDays(today, input.days);
  const scope = scopeClinics(actor, input.clinicId);
  const rows = await d
    .select({ date: appointments.date, startsAt: appointments.startsAt, durationMin: appointments.durationMin, clinicId: appointments.clinicId, providerId: appointments.providerId, providerName: appointments.providerName, providerDisplay: providers.name, status: appointments.status })
    .from(appointments)
    .leftJoin(providers, eq(appointments.providerId, providers.id))
    .where(and(gte(appointments.date, today), lte(appointments.date, until), clinicFilter(appointments.clinicId, scope)));
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const list = findOpenings(
    rows.map((r) => ({
      date: r.date,
      time: fmt.format(r.startsAt),
      durationMin: r.durationMin,
      clinicId: r.clinicId,
      providerKey: r.providerId ? `p${r.providerId}` : (r.providerName ?? "?").toLowerCase(),
      providerName: r.providerDisplay ?? r.providerName ?? "Unassigned",
      status: r.status,
    })),
  );
  const now = new Date();
  // Drop gaps that already started today.
  return list.filter((o) => clinicLocalToUtc(o.date, o.start).getTime() > now.getTime());
}

// ---------------------------------------------------------------------------
// Opportunity Finder
// ---------------------------------------------------------------------------

/** Everyone on the imported schedule, keyed "p:<patientId>" (CCM roster) or "s:<name>|<dob>". */
interface ScheduleSubject {
  key: string;
  patientId: number | null;
  name: string;
  dob: Date | null;
  phone: string | null;
  clinicId: number | null;
  providerName: string | null;
  visits: FillVisit[];
}

// Schedule history is read on every Home / Opportunity Finder load; keep it for a
// minute per Lambda instance. Imports and flow-board moves clear it.
const scheduleCache = new Map<string, { at: number; subjects: Map<string, ScheduleSubject> }>();

const subjectKeyFor = (patientId: number | null, name: string, dob: Date | null) => (patientId ? `p:${patientId}` : `s:${nameKey(name)}|${ymd(dob) ?? ""}`);

async function loadScheduleSubjects(): Promise<Map<string, ScheduleSubject>> {
  const hit = scheduleCache.get("all");
  if (hit && Date.now() - hit.at < 60_000) return hit.subjects;
  const d = await db();
  const rows = await d
    .select({
      patientId: appointments.patientId,
      patientName: appointments.patientName,
      dateOfBirth: appointments.dateOfBirth,
      phoneNumber: appointments.phoneNumber,
      clinicId: appointments.clinicId,
      providerId: appointments.providerId,
      providerName: appointments.providerName,
      providerDisplay: providers.name,
      startsAt: appointments.startsAt,
      status: appointments.status,
      visitType: appointments.visitType,
    })
    .from(appointments)
    .leftJoin(providers, eq(appointments.providerId, providers.id))
    .where(gte(appointments.date, addDays(localDateStr(), -400)));
  const now = Date.now();
  const subjects = new Map<string, ScheduleSubject & { latestAt: number }>();
  for (const r of rows) {
    const key = subjectKeyFor(r.patientId, r.patientName, r.dateOfBirth);
    let s = subjects.get(key);
    if (!s) {
      s = { key, patientId: r.patientId, name: r.patientName, dob: r.dateOfBirth, phone: r.phoneNumber, clinicId: r.clinicId, providerName: r.providerDisplay ?? r.providerName, visits: [], latestAt: -Infinity };
      subjects.set(key, s);
    }
    const providerKey = r.providerId ? `id:${r.providerId}` : r.providerName?.trim() ? `name:${nameKey(r.providerName)}` : null;
    s.visits.push({ startsAt: r.startsAt, status: r.status, visitType: r.visitType, providerKey, providerName: r.providerDisplay ?? r.providerName, clinicId: r.clinicId });
    // Contact details, clinic and provider come from the most recent visit so far (future ones only if nothing past).
    const t = r.startsAt.getTime();
    const rank = t <= now ? t : -t;
    if (rank > s.latestAt) {
      s.latestAt = rank;
      s.name = r.patientName;
      s.phone = r.phoneNumber ?? s.phone;
      s.clinicId = r.clinicId ?? s.clinicId;
      s.providerName = r.providerDisplay ?? r.providerName ?? s.providerName;
    }
  }
  scheduleCache.set("all", { at: Date.now(), subjects });
  return subjects;
}

/** Every known patient phone number (last 10 digits): CCM roster first, then the imported schedule. */
export async function buildPhoneIndex(): Promise<Map<string, { key: string; patientId: number | null; name: string }>> {
  const d = await db();
  const out = new Map<string, { key: string; patientId: number | null; name: string }>();
  for (const p of await d.select({ id: patients.id, name: patients.name, phoneNumber: patients.phoneNumber }).from(patients)) {
    const n = normalizePhone(p.phoneNumber);
    if (n && !out.has(n)) out.set(n, { key: `p:${p.id}`, patientId: p.id, name: p.name });
  }
  for (const s of Array.from((await loadScheduleSubjects()).values())) {
    const n = normalizePhone(s.phone);
    if (n && !out.has(n)) out.set(n, { key: s.key, patientId: s.patientId, name: s.name });
  }
  return out;
}

/** Everyone an email could be from, by full name (roster + imported schedule); more than one = ambiguous. */
export async function buildNameIndex(): Promise<Map<string, { key: string; patientId: number | null; name: string }[]>> {
  const d = await db();
  const out = new Map<string, { key: string; patientId: number | null; name: string }[]>();
  const add = (name: string, v: { key: string; patientId: number | null; name: string }) => {
    const k = nameKey(name);
    if (!k) return;
    const list = out.get(k) ?? [];
    if (!list.some((x) => x.key === v.key)) list.push(v);
    out.set(k, list);
  };
  for (const p of await d.select({ id: patients.id, name: patients.name }).from(patients)) add(p.name, { key: `p:${p.id}`, patientId: p.id, name: p.name });
  for (const s of Array.from((await loadScheduleSubjects()).values())) if (!s.patientId) add(s.name, { key: s.key, patientId: null, name: s.name });
  return out;
}

/** The person behind an Opportunity Finder key: name, clinic (roster → latest visit → provider) and CCM coordinator. */
export async function subjectCare(key: string): Promise<{ patientId: number | null; name: string; clinicId: number | null; coordinatorId: number | null } | null> {
  const d = await db();
  const subjects = await loadScheduleSubjects();
  const visit = subjects.get(key);
  const m = key.match(/^p:(\d+)$/);
  if (m) {
    const [p] = await d.select({ id: patients.id, name: patients.name, clinicId: patients.clinicId, providerId: patients.providerId, assignedStaffId: patients.assignedStaffId }).from(patients).where(eq(patients.id, Number(m[1]))).limit(1);
    if (!p) return null;
    let clinicId = p.clinicId ?? visit?.clinicId ?? null;
    if (!clinicId && p.providerId) clinicId = (await d.select({ clinicId: providers.clinicId }).from(providers).where(eq(providers.id, p.providerId)).limit(1))[0]?.clinicId ?? null;
    return { patientId: p.id, name: p.name, clinicId, coordinatorId: p.assignedStaffId };
  }
  return visit ? { patientId: null, name: visit.name, clinicId: visit.clinicId, coordinatorId: null } : null;
}

/** Find patients by name (roster + imported schedule), for linking an email to the right person. */
export async function searchSubjects(q: string, limit = 20) {
  const needle = nameKey(q);
  if (needle.length < 2) return [];
  const d = await db();
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));
  const out: { key: string; patientId: number | null; name: string; dob: string | null; clinicName: string | null; phoneLast4: string | null }[] = [];
  const roster = await d.select({ id: patients.id, name: patients.name, dob: patients.dateOfBirth, clinicId: patients.clinicId, phone: patients.phoneNumber }).from(patients);
  for (const p of roster) {
    if (!nameKey(p.name).includes(needle)) continue;
    out.push({ key: `p:${p.id}`, patientId: p.id, name: p.name, dob: ymd(p.dob), clinicName: p.clinicId ? clinicName.get(p.clinicId) ?? null : null, phoneLast4: normalizePhone(p.phone)?.slice(-4) ?? null });
  }
  for (const s of Array.from((await loadScheduleSubjects()).values())) {
    if (s.patientId || !nameKey(s.name).includes(needle)) continue;
    out.push({ key: s.key, patientId: null, name: s.name, dob: ymd(s.dob), clinicName: s.clinicId ? clinicName.get(s.clinicId) ?? null : null, phoneLast4: normalizePhone(s.phone)?.slice(-4) ?? null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
}

/** Who a phone number belongs to: a CCM-roster patient first, then anyone on the imported schedule. */
export async function findSubjectByPhone(phone: string): Promise<{ key: string; patientId: number | null; name: string } | null> {
  const d = await db();
  const roster = await d.select({ id: patients.id, name: patients.name, phoneNumber: patients.phoneNumber }).from(patients);
  const r = roster.find((p) => normalizePhone(p.phoneNumber) === phone);
  if (r) return { key: `p:${r.id}`, patientId: r.id, name: r.name };
  for (const s of Array.from((await loadScheduleSubjects()).values())) {
    if (normalizePhone(s.phone) === phone) return { key: s.key, patientId: s.patientId, name: s.name };
  }
  return null;
}

function visitDates(visits: ScheduleVisit[], now: Date) {
  let lastSeen: Date | null = null;
  let nextBooked: Date | null = null;
  for (const v of visits) {
    if (v.startsAt <= now && SEEN_STATUSES.includes(v.status) && (!lastSeen || v.startsAt > lastSeen)) lastSeen = v.startsAt;
    if (v.startsAt > now && v.status !== "cancelled" && v.status !== "no_show" && (!nextBooked || v.startsAt < nextBooked)) nextBooked = v.startsAt;
  }
  return { lastSeen, nextBooked };
}

interface OpportunityCandidate {
  key: string;
  patientId: number | null;
  name: string;
  dateOfBirth: Date | null;
  phoneNumber: string | null;
  clinicId: number | null;
  clinicName: string | null;
  providerId: number | null;
  providerName: string | null;
  lastVisit: Date | null;
  nextVisit: Date | null;
  matches: OpportunityMatch[];
}

async function loadOpportunityData(actor: WorkspaceActor, clinicId?: number | null) {
  const d = await db();
  const scope = scopeClinics(actor, clinicId);
  const now = new Date();
  const [pats, subjects, clinicRows] = await Promise.all([
    d
      .select({
        id: patients.id,
        name: patients.name,
        dateOfBirth: patients.dateOfBirth,
        phoneNumber: patients.phoneNumber,
        clinicId: patients.clinicId,
        clinicName: clinics.name,
        providerId: patients.providerId,
        providerName: providers.name,
        chronicConditions: patients.chronicConditions,
        bhiConditions: patients.bhiConditions,
        ccmEnrollmentStatus: patients.ccmEnrollmentStatus,
        bhiEnrollmentStatus: patients.bhiEnrollmentStatus,
        rpmStatus: patients.rpmStatus,
        rpmEnrolled: patients.rpmEnrolled,
        lastOfficeVisit: patients.lastOfficeVisit,
        nextAppointment: patients.nextAppointment,
      })
      .from(patients)
      .leftJoin(clinics, eq(patients.clinicId, clinics.id))
      .leftJoin(providers, eq(patients.providerId, providers.id)),
    loadScheduleSubjects(),
    d.select({ id: clinics.id, name: clinics.name }).from(clinics),
  ]);
  const clinicName = new Map(clinicRows.map((c) => [c.id, c.name]));
  const providerClinic = new Map((await d.select({ id: providers.id, clinicId: providers.clinicId }).from(providers)).map((p) => [p.id, p.clinicId]));
  const inScope = (id: number | null) => scope === null || (id != null && scope.includes(id));
  const candidates: OpportunityCandidate[] = [];

  // CCM roster: condition/enrollment rules plus the schedule rules on their visits.
  for (const p of pats) {
    // Many roster records have no clinic: use their latest imported visit's clinic, then
    // their provider's. (Workspace grouping only; the CCM record isn't changed.)
    const clinicId = p.clinicId ?? subjects.get(`p:${p.id}`)?.clinicId ?? (p.providerId ? providerClinic.get(p.providerId) ?? null : null);
    if (!inScope(clinicId)) continue;
    const visits = subjects.get(`p:${p.id}`)?.visits ?? [];
    const { lastSeen, nextBooked } = visitDates(visits, now);
    const lastVisit = lastSeen && (!p.lastOfficeVisit || lastSeen > p.lastOfficeVisit) ? lastSeen : p.lastOfficeVisit;
    const futureRoster = p.nextAppointment && p.nextAppointment > now ? p.nextAppointment : null;
    const nextVisit = [nextBooked, futureRoster].filter((x): x is Date => !!x).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const matches = [
      ...evaluateScheduleOpportunities(visits, now),
      ...evaluateOpportunities(
        {
          chronicConditions: p.chronicConditions ?? [],
          bhiConditions: p.bhiConditions ?? [],
          ccmEnrollmentStatus: p.ccmEnrollmentStatus,
          bhiEnrollmentStatus: p.bhiEnrollmentStatus,
          rpmStatus: p.rpmStatus,
          rpmEnrolled: p.rpmEnrolled,
          lastOfficeVisit: lastVisit,
          nextVisit,
        },
        now,
      ),
    ];
    if (!matches.length) continue;
    const latest = subjects.get(`p:${p.id}`);
    candidates.push({ key: `p:${p.id}`, patientId: p.id, name: p.name, dateOfBirth: p.dateOfBirth, phoneNumber: p.phoneNumber ?? latest?.phone ?? null, clinicId, clinicName: clinicId ? clinicName.get(clinicId) ?? null : null, providerId: p.providerId, providerName: p.providerName ?? latest?.providerName ?? null, lastVisit, nextVisit, matches });
  }

  // Everyone else on the schedule (not on the CCM roster): schedule rules only.
  for (const s of Array.from(subjects.values())) {
    if (s.patientId) continue;
    if (scope !== null && (s.clinicId == null || !scope.includes(s.clinicId))) continue;
    const matches = evaluateScheduleOpportunities(s.visits, now);
    if (!matches.length) continue;
    const { lastSeen, nextBooked } = visitDates(s.visits, now);
    candidates.push({ key: s.key, patientId: null, name: s.name, dateOfBirth: s.dob, phoneNumber: s.phone, clinicId: s.clinicId, clinicName: s.clinicId ? clinicName.get(s.clinicId) ?? null : null, providerId: null, providerName: s.providerName, lastVisit: lastSeen, nextVisit: nextBooked, matches });
  }

  const acted = await d
    .select({ patientId: opportunityActions.patientId, subjectKey: opportunityActions.subjectKey, category: opportunityActions.category, action: opportunityActions.action, createdAt: opportunityActions.createdAt })
    .from(opportunityActions)
    .where(gte(opportunityActions.createdAt, new Date(now.getTime() - 30 * 86_400_000)));
  const actedKey = new Map(acted.map((a) => [`${a.subjectKey ?? `p:${a.patientId}`}|${a.category}`, a]));
  return candidates.map((c) => ({ ...c, acted: (cat: string) => actedKey.get(`${c.key}|${cat}`) ?? null }));
}

export async function opportunitySummary(actor: WorkspaceActor, clinicId?: number | null) {
  const data = await loadOpportunityData(actor, clinicId);
  const counts: Record<string, number> = {};
  const unique = new Set<string>();
  for (const c of data) {
    for (const m of c.matches) {
      if (c.acted(m.category)) continue;
      counts[m.category] = (counts[m.category] ?? 0) + 1;
      unique.add(c.key);
    }
  }
  // How far ahead the imported schedule reaches: "nothing booked" is only reliable up to here.
  const [range] = await (await db()).select({ last: sql<string | null>`MAX(${appointments.date})` }).from(appointments);
  return { counts, uniquePatients: unique.size, scheduleThrough: range?.last ?? null };
}

const OPPORTUNITY_LIST_LIMIT = 1000;

export async function opportunityList(actor: WorkspaceActor, input: { category: OpportunityCategory; clinicId?: number | null; providerId?: number | null; includeActioned: boolean }) {
  const data = await loadOpportunityData(actor, input.clinicId);
  const out = [];
  for (const c of data) {
    const m = c.matches.find((x) => x.category === input.category);
    if (!m) continue;
    if (input.providerId && c.providerId !== input.providerId) continue;
    const a = c.acted(input.category);
    if (a && !input.includeActioned) continue;
    out.push({
      key: c.key,
      patientId: c.patientId,
      name: c.name,
      dateOfBirth: c.dateOfBirth,
      phoneNumber: c.phoneNumber,
      clinicId: c.clinicId,
      clinicName: c.clinicName,
      providerName: c.providerName,
      lastOfficeVisit: c.lastVisit,
      nextVisit: c.nextVisit,
      reason: m.reason,
      score: m.score,
      lastAction: a?.action ?? null,
      lastActionAt: a?.createdAt ?? null,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return { total: out.length, rows: out.slice(0, OPPORTUNITY_LIST_LIMIT) };
}

export async function actOnOpportunities(
  actor: WorkspaceActor,
  input: { category: OpportunityCategory; keys: string[]; action: "reviewed" | "task_created" | "dismissed"; assigneeId?: number | null; taskTitle: string; taskCategory: TaskCategory },
) {
  const d = await db();
  // Only people this user can see in the Opportunity Finder can be acted on.
  const byKey = new Map((await loadOpportunityData(actor, null)).map((c) => [c.key, c]));
  const targets = input.keys.map((k) => byKey.get(k)).filter((c): c is NonNullable<typeof c> => !!c);
  let tasks = 0;
  const rows: (typeof opportunityActions.$inferInsert)[] = [];
  for (const c of targets) {
    let taskId: number | null = null;
    if (input.action === "task_created") {
      const reason = c.matches.find((m) => m.category === input.category)?.reason;
      const details = c.patientId
        ? ""
        : ` Not on the CCM roster. DOB ${c.dateOfBirth ? c.dateOfBirth.toISOString().slice(0, 10) : "unknown"}${c.phoneNumber ? `, phone ${c.phoneNumber}` : ""}.`;
      const t = await createTask(actor, {
        title: `${input.taskTitle} — ${c.name}`,
        description: `Created from Opportunity Finder${reason ? ` (${reason})` : ""}.${details} No one has contacted the patient yet.`,
        patientId: c.patientId,
        clinicId: c.clinicId,
        assignedUserId: input.assigneeId ?? null,
        assignedRole: input.assigneeId ? null : "staff",
        priority: "normal",
        category: input.taskCategory,
        dueDate: nextClinicDay(localDateStr()),
        sourceType: "opportunity",
        sourceRef: input.category,
      });
      taskId = t.id;
      tasks++;
    }
    rows.push({ patientId: c.patientId, subjectKey: c.key, category: input.category, action: input.action, userId: actor.id, taskId });
  }
  for (let i = 0; i < rows.length; i += 400) await d.insert(opportunityActions).values(rows.slice(i, i + 400));
  await audit(actor, "opportunity_action", { entityType: "opportunity", description: `${input.category}: ${input.action} x${targets.length}` });
  return { count: targets.length, tasks };
}

// ---------------------------------------------------------------------------
// Fill a provider's schedule
// ---------------------------------------------------------------------------

const FILL_CATEGORY = "schedule_fill";
const FILL_LIST_LIMIT = 1000;

/** Providers to fill for, with how busy they've been lately (from the imported schedule). */
export async function fillProviders(actor: WorkspaceActor) {
  const d = await db();
  const scope = scopeClinics(actor, null);
  const [provs, subjects, clinicRows] = await Promise.all([
    d.select({ id: providers.id, name: providers.name, title: providers.title, clinicId: providers.clinicId }).from(providers),
    loadScheduleSubjects(),
    d.select({ id: clinics.id, name: clinics.name }).from(clinics),
  ]);
  const activity = providerActivity(Array.from(subjects.values()).flatMap((s) => s.visits));
  return provs
    .filter((p) => scope === null || (p.clinicId != null && scope.includes(p.clinicId)))
    .map((p) => {
      const a = activity.get(`id:${p.id}`);
      return { id: p.id, name: p.name, title: p.title, clinicId: p.clinicId, clinicName: clinicRows.find((c) => c.id === p.clinicId)?.name ?? null, seenLast60: a?.seenLast60 ?? 0, active: a ? a.active : false };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

async function loadScheduleFill(actor: WorkspaceActor, input: { providerId: number; includeOtherClinics: boolean }) {
  const d = await db();
  const [prov] = await d.select({ id: providers.id, name: providers.name, clinicId: providers.clinicId }).from(providers).where(eq(providers.id, input.providerId)).limit(1);
  if (!prov) throw new WorkspaceError("Provider not found.", "NOT_FOUND");
  const now = new Date();
  const scope = scopeClinics(actor, null);
  const [subjects, roster, clinicRows] = await Promise.all([
    loadScheduleSubjects(),
    d.select({ id: patients.id, phoneNumber: patients.phoneNumber, ccmEnrollmentStatus: patients.ccmEnrollmentStatus }).from(patients),
    d.select({ id: clinics.id, name: clinics.name }).from(clinics),
  ]);
  const rosterBy = new Map(roster.map((p) => [p.id, p]));
  const clinicName = new Map(clinicRows.map((c) => [c.id, c.name]));
  const targetKey = `id:${prov.id}`;
  const activity = providerActivity(Array.from(subjects.values()).flatMap((s) => s.visits), now);
  const inactive = new Set(Array.from(activity.values()).filter((a) => a.stopped && a.key !== targetKey).map((a) => a.key));
  const target = { key: targetKey, name: prov.name, clinicId: prov.clinicId };

  const candidates = [];
  for (const s of Array.from(subjects.values())) {
    const r = s.patientId ? rosterBy.get(s.patientId) : undefined;
    const phone = s.phone || r?.phoneNumber || null;
    const ccmActive = r?.ccmEnrollmentStatus === "active";
    const m = evaluateScheduleFill(s.visits, target, inactive, { includeOtherClinics: input.includeOtherClinics, hasPhone: !!phone, ccmActive }, now);
    if (!m) continue;
    if (scope !== null && (m.clinicId == null || !scope.includes(m.clinicId))) continue;
    candidates.push({ key: s.key, patientId: s.patientId, name: s.name, dateOfBirth: s.dob, phoneNumber: phone, ccmActive, clinicName: m.clinicId ? clinicName.get(m.clinicId) ?? null : null, ...m });
  }
  const stopped = Array.from(activity.values())
    .filter((a) => inactive.has(a.key))
    .map((a) => ({ name: a.name, lastSeen: a.lastSeen, seenLast60: a.seenLast60 }))
    .sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0));
  return { prov, candidates, stopped, clinicName };
}

export async function scheduleFill(actor: WorkspaceActor, input: { providerId: number; includeOtherClinics: boolean; includeActioned: boolean }) {
  const d = await db();
  const { prov, candidates, stopped, clinicName } = await loadScheduleFill(actor, input);
  const acted = await d
    .select({ subjectKey: opportunityActions.subjectKey, action: opportunityActions.action, createdAt: opportunityActions.createdAt })
    .from(opportunityActions)
    .where(and(eq(opportunityActions.category, FILL_CATEGORY), gte(opportunityActions.createdAt, new Date(Date.now() - 30 * 86_400_000))))
    .orderBy(desc(opportunityActions.createdAt));
  const actedBy = new Map<string, (typeof acted)[number]>();
  for (const a of acted) if (a.subjectKey && !actedBy.has(a.subjectKey)) actedBy.set(a.subjectKey, a);

  const counts: Record<FillGroup, number> = { own_due: 0, orphaned: 0, never_seen: 0 };
  const rows = [];
  for (const c of candidates) {
    const a = actedBy.get(c.key);
    if (a && !input.includeActioned) continue;
    counts[c.group]++;
    rows.push({ ...c, lastAction: a?.action ?? null, lastActionAt: a?.createdAt ?? null, calls: null as { count: number; lastAt: Date; lastOutcome: string | null } | null });
  }
  // Calls made through RingCentral in the last 90 days.
  const { recentCallsBySubject } = await import("./phoneDb");
  const calls = await recentCallsBySubject(rows.map((r) => r.key));
  for (const r of rows) r.calls = calls.get(r.key) ?? null;
  // Ties: most recently seen first, then the most visits.
  rows.sort((a, b) => b.score - a.score || (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0) || b.seenCount - a.seenCount);
  const [range] = await d.select({ last: sql<string | null>`MAX(${appointments.date})` }).from(appointments);
  return {
    provider: { id: prov.id, name: prov.name, clinicId: prov.clinicId, clinicName: prov.clinicId ? clinicName.get(prov.clinicId) ?? null : null },
    stoppedProviders: stopped,
    counts,
    total: rows.length,
    rows: rows.slice(0, FILL_LIST_LIMIT),
    scheduleThrough: range?.last ?? null,
  };
}

export async function scheduleFillAct(
  actor: WorkspaceActor,
  input: { providerId: number; keys: string[]; action: "reviewed" | "task_created" | "dismissed"; assigneeId?: number | null; taskTitle: string },
) {
  const d = await db();
  // Only people on this provider's fill list (as this user sees it) can be acted on.
  const { prov, candidates } = await loadScheduleFill(actor, { providerId: input.providerId, includeOtherClinics: true });
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const targets = input.keys.map((k) => byKey.get(k)).filter((c): c is NonNullable<typeof c> => !!c);
  let tasks = 0;
  const rows: (typeof opportunityActions.$inferInsert)[] = [];
  for (const c of targets) {
    let taskId: number | null = null;
    if (input.action === "task_created") {
      const details = c.patientId ? "" : ` Not on the CCM roster. DOB ${c.dateOfBirth ? c.dateOfBirth.toISOString().slice(0, 10) : "unknown"}.`;
      const t = await createTask(actor, {
        title: `${input.taskTitle} — ${c.name}`,
        description: `Fill ${prov.name}'s schedule: ${c.reason}.${c.phoneNumber ? ` Phone ${c.phoneNumber}.` : " No phone on file."}${details} No one has contacted the patient yet.`,
        patientId: c.patientId,
        clinicId: c.clinicId ?? prov.clinicId,
        assignedUserId: input.assigneeId ?? null,
        assignedRole: input.assigneeId ? null : "front_desk",
        priority: c.likelihood === "very_likely" ? "high" : "normal",
        category: "patient_call",
        dueDate: nextClinicDay(localDateStr()),
        sourceType: "opportunity",
        sourceRef: FILL_CATEGORY,
      });
      taskId = t.id;
      tasks++;
    }
    rows.push({ patientId: c.patientId, subjectKey: c.key, category: FILL_CATEGORY, action: input.action, userId: actor.id, taskId });
  }
  for (let i = 0; i < rows.length; i += 400) await d.insert(opportunityActions).values(rows.slice(i, i + 400));
  await audit(actor, "opportunity_action", { entityType: "opportunity", description: `${FILL_CATEGORY} (provider #${prov.id}): ${input.action} x${targets.length}` });
  return { count: targets.length, tasks };
}


// ---------------------------------------------------------------------------
// People (CCM roster + everyone seen on the imported schedule) — shared by Testing
// ---------------------------------------------------------------------------

export interface Person {
  key: string;
  patientId: number | null;
  name: string;
  dob: string | null;
  phone: string | null;
  clinicId: number | null;
  clinicName: string | null;
  providerName: string | null;
  conditions: string[];
  insurance: string | null;
  lastSeen: Date | null;
  nextVisit: Date | null;
}

/**
 * Active patients: the CCM roster (except transferred) plus everyone with a completed visit on
 * the imported schedule. Clinic falls back to the latest visit, then the provider's clinic.
 */
export async function loadPeople(actor: WorkspaceActor, clinicId?: number | null): Promise<Person[]> {
  const d = await db();
  const scope = scopeClinics(actor, clinicId);
  const now = new Date();
  const [pats, subjects, clinicRows, provRows] = await Promise.all([
    d.select({
      id: patients.id, name: patients.name, dateOfBirth: patients.dateOfBirth, phoneNumber: patients.phoneNumber, clinicId: patients.clinicId,
      providerId: patients.providerId, providerName: providers.name, chronicConditions: patients.chronicConditions, bhiConditions: patients.bhiConditions,
      insurance: patients.insurance, ccmEnrollmentStatus: patients.ccmEnrollmentStatus, lastOfficeVisit: patients.lastOfficeVisit, nextAppointment: patients.nextAppointment,
    }).from(patients).leftJoin(providers, eq(patients.providerId, providers.id)),
    loadScheduleSubjects(),
    d.select({ id: clinics.id, name: clinics.name }).from(clinics),
    d.select({ id: providers.id, clinicId: providers.clinicId }).from(providers),
  ]);
  const clinicName = new Map(clinicRows.map((c) => [c.id, c.name]));
  const providerClinic = new Map(provRows.map((p) => [p.id, p.clinicId]));
  const inScope = (id: number | null) => scope === null || (id != null && scope.includes(id));
  const out: Person[] = [];
  for (const p of pats) {
    if (p.ccmEnrollmentStatus === "transferred") continue;
    const s = subjects.get(`p:${p.id}`);
    const cid = p.clinicId ?? s?.clinicId ?? (p.providerId ? providerClinic.get(p.providerId) ?? null : null);
    if (!inScope(cid)) continue;
    const { lastSeen, nextBooked } = visitDates(s?.visits ?? [], now);
    const last = lastSeen && (!p.lastOfficeVisit || lastSeen > p.lastOfficeVisit) ? lastSeen : p.lastOfficeVisit;
    const next = [nextBooked, p.nextAppointment && p.nextAppointment > now ? p.nextAppointment : null].filter((x): x is Date => !!x).sort((a, b) => +a - +b)[0] ?? null;
    out.push({ key: `p:${p.id}`, patientId: p.id, name: p.name, dob: ymd(p.dateOfBirth), phone: p.phoneNumber ?? s?.phone ?? null, clinicId: cid, clinicName: cid ? clinicName.get(cid) ?? null : null, providerName: p.providerName ?? s?.providerName ?? null, conditions: [...(p.chronicConditions ?? []), ...(p.bhiConditions ?? [])], insurance: p.insurance, lastSeen: last, nextVisit: next });
  }
  for (const s of Array.from(subjects.values())) {
    if (s.patientId || !inScope(s.clinicId)) continue;
    const { lastSeen, nextBooked } = visitDates(s.visits, now);
    if (!lastSeen) continue; // never actually came in
    out.push({ key: s.key, patientId: null, name: s.name, dob: ymd(s.dob), phone: s.phone, clinicId: s.clinicId, clinicName: s.clinicId ? clinicName.get(s.clinicId) ?? null : null, providerName: s.providerName, conditions: [], insurance: null, lastSeen, nextVisit: nextBooked });
  }
  return out;
}

/** name|DOB → person (roster first), for Practice Fusion imports. */
export async function buildNameDobIndex(): Promise<Map<string, { key: string; patientId: number | null; name: string }>> {
  const d = await db();
  const out = new Map<string, { key: string; patientId: number | null; name: string }>();
  for (const p of await d.select({ id: patients.id, name: patients.name, dob: patients.dateOfBirth }).from(patients)) {
    const dob = ymd(p.dob);
    if (dob) out.set(`${nameKey(p.name)}|${dob}`, { key: `p:${p.id}`, patientId: p.id, name: p.name });
  }
  for (const s of Array.from((await loadScheduleSubjects()).values())) {
    const dob = ymd(s.dob);
    if (dob && !s.patientId && !out.has(`${nameKey(s.name)}|${dob}`)) out.set(`${nameKey(s.name)}|${dob}`, { key: s.key, patientId: null, name: s.name });
  }
  return out;
}

/** Care coordinator first; else the least-busy front-desk person at the patient's clinic; else that clinic's front-desk queue. */
export async function careTeamAssignee(subjectKey: string, opts: { skipCoordinator?: boolean } = {}) {
  const d = await db();
  const care = await subjectCare(subjectKey);
  if (care?.coordinatorId && !opts.skipCoordinator) {
    const [u] = await d.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, care.coordinatorId)).limit(1);
    if (u && u.role !== "user") return { assignedUserId: u.id as number | null, assignedRole: null as string | null, clinicId: care.clinicId, who: "care coordinator" };
  }
  if (care?.clinicId) {
    const desk = await d.select({ id: users.id }).from(users)
      .innerJoin(staffProfiles, eq(staffProfiles.userId, users.id))
      .where(and(eq(users.role, "front_desk"), eq(staffProfiles.homeClinicId, care.clinicId), eq(staffProfiles.active, true)));
    if (desk.length) {
      const open = await d.select({ userId: workTasks.assignedUserId }).from(workTasks)
        .where(and(inArray(workTasks.assignedUserId, desk.map((x) => x.id)), inArray(workTasks.status, OPEN_TASK_STATUSES)));
      const load = (id: number) => open.filter((o) => o.userId === id).length;
      const pick = desk.map((x) => x.id).sort((a, b) => load(a) - load(b) || a - b)[0]!;
      return { assignedUserId: pick as number | null, assignedRole: null as string | null, clinicId: care.clinicId, who: "front desk" };
    }
  }
  return { assignedUserId: null as number | null, assignedRole: "front_desk" as string | null, clinicId: care?.clinicId ?? null, who: "front desk queue" };
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export async function homeDashboard(actor: WorkspaceActor, input: { clinicId?: number | null; includeCare: boolean; includeOpportunities: boolean }) {
  const d = await db();
  const today = localDateStr();
  const tomorrow = nextClinicDay(today);
  const scope = scopeClinics(actor, input.clinicId);
  const [board, counts, openingsSoon, clinicList] = await Promise.all([
    flowBoard(actor, { clinicId: input.clinicId, date: today }),
    taskCounts(actor, input.clinicId),
    openings(actor, { clinicId: input.clinicId, days: 1 }),
    listClinics(actor),
  ]);
  const byStatus: Record<string, number> = {};
  board.cards.forEach((c) => (byStatus[c.status] = (byStatus[c.status] ?? 0) + 1));

  let care: null | { ccmTotal: number; ccmDone: number; bhiTotal: number; bhiDone: number; pendingRefills: number; pendingEscalations: number } = null;
  if (input.includeCare) {
    // Same month and "actively enrolled" rules as the CCM dashboard (getAdminStats),
    // so both screens show the same numbers.
    const month = currentMonth();
    const monthTasks = await d
      .select({ program: ccmTasks.program, status: ccmTasks.status, ccmStatus: patients.ccmEnrollmentStatus, bhiStatus: patients.bhiEnrollmentStatus })
      .from(ccmTasks)
      .innerJoin(patients, eq(ccmTasks.patientId, patients.id))
      .where(and(eq(ccmTasks.month, month), clinicFilter(patients.clinicId, scope)));
    const done = (s: string | null) => !!s && ["completed", "ready_for_billing", "billed"].includes(s);
    const ccm = monthTasks.filter((t) => t.program === "ccm" && t.ccmStatus === "active");
    const bhi = monthTasks.filter((t) => t.program === "bhi" && t.bhiStatus === "active");
    const [refills] = await d.select({ n: sql<number>`count(*)` }).from(refillRequests).where(eq(refillRequests.status, "pending"));
    const [esc] = await d.select({ n: sql<number>`count(*)` }).from(providerEscalations).where(eq(providerEscalations.escalationStatus, "pending"));
    care = {
      ccmTotal: ccm.length,
      ccmDone: ccm.filter((t) => done(t.status)).length,
      bhiTotal: bhi.length,
      bhiDone: bhi.filter((t) => done(t.status)).length,
      pendingRefills: Number(refills?.n ?? 0),
      pendingEscalations: Number(esc?.n ?? 0),
    };
  }

  let opportunities: null | { uniquePatients: number; missed: number; cancelled: number; newNoReturn: number; lapsed: number; overdue: number } = null;
  if (input.includeOpportunities) {
    const s = await opportunitySummary(actor, input.clinicId);
    const n = (k: OpportunityCategory) => s.counts[k] ?? 0;
    opportunities = { uniquePatients: s.uniquePatients, missed: n("missed_appointment"), cancelled: n("cancelled_not_rebooked"), newNoReturn: n("new_patient_no_return"), lapsed: n("lapsed_follow_up"), overdue: n("overdue_follow_up") };
  }

  const tomorrowOpenings = await openings(actor, { clinicId: input.clinicId, days: 3 });
  const perClinic = clinicList.map((c) => {
    const mine = board.cards.filter((x) => x.clinicId === c.id);
    return {
      id: c.id,
      name: c.name,
      appointments: mine.filter((x) => x.status !== "cancelled").length,
      completed: mine.filter((x) => x.status === "completed").length,
      inClinic: mine.filter((x) => IN_CLINIC_STATUSES.includes(x.status as FlowStatus)).length,
      noShows: mine.filter((x) => x.status === "no_show").length,
    };
  });
  const [lastImport] = await d.select({ createdAt: scheduleImports.createdAt, lastDate: scheduleImports.lastDate }).from(scheduleImports).orderBy(desc(scheduleImports.createdAt)).limit(1);

  return {
    today,
    tomorrow,
    flow: board.metrics,
    byStatus,
    tasks: counts,
    openingsToday: openingsSoon.filter((o) => o.date === today).length,
    openingsTomorrow: tomorrowOpenings.filter((o) => o.date === tomorrow).length,
    care,
    opportunities,
    perClinic,
    scheduleLoadedToday: board.cards.length > 0,
    lastImportAt: lastImport?.createdAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Patient 360 (operational summary; CCM detail stays on patients.detail)
// ---------------------------------------------------------------------------

export async function patientOperational(actor: WorkspaceActor, patientId: number) {
  const d = await db();
  const [p] = await d
    .select({ id: patients.id, name: patients.name, dateOfBirth: patients.dateOfBirth, phoneNumber: patients.phoneNumber, clinicId: patients.clinicId, clinicName: clinics.name, providerName: providers.name, insurance: patients.insurance, preferredLanguage: patients.preferredLanguage, lastOfficeVisit: patients.lastOfficeVisit, nextAppointment: patients.nextAppointment })
    .from(patients)
    .leftJoin(clinics, eq(patients.clinicId, clinics.id))
    .leftJoin(providers, eq(patients.providerId, providers.id))
    .where(eq(patients.id, patientId))
    .limit(1);
  if (!p) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
  const appts = await d
    .select({ id: appointments.id, startsAt: appointments.startsAt, date: appointments.date, status: appointments.status, visitType: appointments.visitType, reason: appointments.reason, providerName: appointments.providerName, providerDisplay: providers.name, clinicId: appointments.clinicId, clinicName: clinics.name })
    .from(appointments)
    .leftJoin(providers, eq(appointments.providerId, providers.id))
    .leftJoin(clinics, eq(appointments.clinicId, clinics.id))
    .where(eq(appointments.patientId, patientId))
    .orderBy(desc(appointments.startsAt))
    .limit(50);
  // MAs may open patients in their clinics, or anyone on their clinic's schedule today.
  if (actor.clinicIds) {
    const inClinic = p.clinicId != null && actor.clinicIds.includes(p.clinicId);
    const onScheduleToday = appts.some((a) => a.date === localDateStr() && a.clinicId != null && actor.clinicIds!.includes(a.clinicId));
    if (!inClinic && !onScheduleToday) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
  }
  const tasks = await d
    .select({ id: workTasks.id, title: workTasks.title, status: workTasks.status, priority: workTasks.priority, category: workTasks.category, dueDate: workTasks.dueDate, createdAt: workTasks.createdAt, completedAt: workTasks.completedAt, assigneeName: users.name, assignedRole: workTasks.assignedRole })
    .from(workTasks)
    .leftJoin(users, eq(workTasks.assignedUserId, users.id))
    .where(eq(workTasks.patientId, patientId))
    .orderBy(desc(workTasks.createdAt))
    .limit(50);
  await audit(actor, "view_patient", { entityType: "patient", entityId: patientId, description: "workspace summary" });
  const now = new Date();
  const upcoming = appts.filter((a) => a.startsAt > now && a.status === "scheduled").sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return {
    patient: p,
    appointments: appts.map((a) => ({ ...a, provider: a.providerDisplay ?? a.providerName })),
    nextAppointment: upcoming[0] ?? null,
    today: appts.find((a) => a.date === localDateStr() && a.status !== "cancelled") ?? null,
    tasks,
    openTasks: tasks.filter((t) => OPEN_TASK_STATUSES.includes(t.status as TaskStatus)),
  };
}

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

export async function listPlaybooks(q?: string) {
  const d = await db();
  const rows = await d
    .select({ id: playbooks.id, slug: playbooks.slug, title: playbooks.title, category: playbooks.category, description: playbooks.description, currentVersion: playbooks.currentVersion, updatedAt: playbooks.updatedAt, owner: users.name })
    .from(playbooks)
    .leftJoin(users, eq(playbooks.ownerUserId, users.id))
    .where(eq(playbooks.archived, false))
    .orderBy(asc(playbooks.category), asc(playbooks.title));
  if (!q) return rows;
  const s = q.toLowerCase();
  return rows.filter((r) => `${r.title} ${r.category} ${r.description ?? ""}`.toLowerCase().includes(s));
}

export async function getPlaybook(slug: string) {
  const d = await db();
  const [pb] = await d.select().from(playbooks).where(eq(playbooks.slug, slug)).limit(1);
  if (!pb || pb.archived) throw new WorkspaceError("Playbook not found.", "NOT_FOUND");
  const versions = await d
    .select({ version: playbookVersions.version, steps: playbookVersions.steps, changeNote: playbookVersions.changeNote, createdAt: playbookVersions.createdAt, by: users.name })
    .from(playbookVersions)
    .leftJoin(users, eq(playbookVersions.createdByUserId, users.id))
    .where(eq(playbookVersions.playbookId, pb.id))
    .orderBy(desc(playbookVersions.version));
  const [owner] = pb.ownerUserId ? await d.select({ name: users.name }).from(users).where(eq(users.id, pb.ownerUserId)).limit(1) : [];
  return { ...pb, owner: owner?.name ?? null, steps: versions[0]?.steps ?? [], history: versions.map(({ steps: _s, ...v }) => v) };
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "playbook";

export async function savePlaybook(
  actor: WorkspaceActor,
  input: { slug?: string | null; title: string; category: string; description?: string | null; steps: { title: string; detail: string }[]; changeNote?: string | null },
) {
  const d = await db();
  if (input.slug) {
    const [pb] = await d.select().from(playbooks).where(eq(playbooks.slug, input.slug)).limit(1);
    if (!pb) throw new WorkspaceError("Playbook not found.", "NOT_FOUND");
    const version = pb.currentVersion + 1;
    await d.update(playbooks).set({ title: input.title, category: input.category, description: input.description ?? null, currentVersion: version, ownerUserId: pb.ownerUserId ?? actor.id }).where(eq(playbooks.id, pb.id));
    await d.insert(playbookVersions).values({ playbookId: pb.id, version, steps: input.steps, changeNote: input.changeNote ?? null, createdByUserId: actor.id });
    await audit(actor, "manage_playbook", { entityType: "playbook", entityId: pb.id, description: `updated to v${version}` });
    return { slug: pb.slug };
  }
  let slug = slugify(input.title);
  const clash = await d.select({ id: playbooks.id }).from(playbooks).where(eq(playbooks.slug, slug)).limit(1);
  if (clash.length) slug = `${slug}-${Date.now().toString(36)}`;
  const [res] = await d.insert(playbooks).values({ slug, title: input.title, category: input.category, description: input.description ?? null, ownerUserId: actor.id });
  const id = Number((res as unknown as { insertId: number }).insertId);
  await d.insert(playbookVersions).values({ playbookId: id, version: 1, steps: input.steps, changeNote: input.changeNote ?? "First version", createdByUserId: actor.id });
  await audit(actor, "manage_playbook", { entityType: "playbook", entityId: id, description: "created" });
  return { slug };
}

export async function archivePlaybook(actor: WorkspaceActor, slug: string) {
  const d = await db();
  const [pb] = await d.select({ id: playbooks.id }).from(playbooks).where(eq(playbooks.slug, slug)).limit(1);
  if (!pb) throw new WorkspaceError("Playbook not found.", "NOT_FOUND");
  await d.update(playbooks).set({ archived: true }).where(eq(playbooks.id, pb.id));
  await audit(actor, "manage_playbook", { entityType: "playbook", entityId: pb.id, description: "archived" });
}

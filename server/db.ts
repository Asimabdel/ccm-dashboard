import { eq, and, gte, lte, desc, sql, like } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import {
  InsertUser,
  users,
  clinics,
  providers,
  patients,
  ccmTasks,
  ccmNotes,
  providerEscalations,
  followUpItems,
  billingRecords,
  notifications,
  productivityMetrics,
  auditLogs,
  teamInvites,
  monthlyGoals,
  type InsertAuditLog,
  type User,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: MySql2Database<Record<string, never>> | null = null;

/**
 * Build a mysql2 pool from DATABASE_URL with TLS handling.
 *
 * Managed MySQL (Aiven, PlanetScale, RDS, TiDB, ...) require TLS, but mysql2's URL
 * parser does NOT map `?ssl-mode=REQUIRED`, so passing the URL string alone would
 * connect without TLS and be rejected. We therefore parse the URL and enable TLS
 * for any non-local host. Set DATABASE_SSL_CA (PEM contents) to pin the provider's
 * CA in production; without it we still encrypt but skip CA verification, which is
 * acceptable for a demo/staging deploy.
 */
function createPool(databaseUrl: string) {
  const u = new URL(databaseUrl);
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  const ca = process.env.DATABASE_SSL_CA;
  const ssl = isLocal
    ? undefined
    : ca
      ? { ca, rejectUnauthorized: true }
      : { rejectUnauthorized: false };
  return mysql.createPool({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, "") || undefined,
    ssl,
    // Tuned for serverless (Lambda runs one request per instance at a time, and
    // RDS t4g.micro caps at ~60 connections). Keep each instance's footprint small
    // so many concurrent users don't exhaust the database's connection limit:
    // a tiny pool, release idle connections quickly, and keep the socket alive to
    // avoid reconnect latency on warm invocations.
    connectionLimit: 3,
    maxIdle: 1,
    idleTimeout: 30_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  });
}

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(createPool(process.env.DATABASE_URL));
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod", "clinicLocation"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    // Link an admin-pre-created "pending" login: if no row matches this openId yet but a
    // pending row matches the email, upgrade that row's openId and keep its assigned role.
    if (user.email && user.openId !== ENV.ownerOpenId) {
      const byOpenId = await db.select().from(users).where(eq(users.openId, user.openId)).limit(1);
      if (!byOpenId.length) {
        const email = user.email.trim().toLowerCase();
        const pending = await db
          .select()
          .from(users)
          .where(and(eq(users.email, email), like(users.openId, "pending:%")))
          .limit(1);
        if (pending.length) {
          const row = pending[0];
          await db
            .update(users)
            .set({
              openId: user.openId,
              name: user.name ?? row.name,
              loginMethod: user.loginMethod ?? row.loginMethod,
              lastSignedIn: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(users.id, row.id));
          return; // role preserved from the pre-created row
        }
      }
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// Patient queries
export async function getPatientsByClinic(clinicId: number) {
  const db = await getDb();
  if (!db) return [];

  return db.select().from(patients).where(eq(patients.clinicId, clinicId));
}

export async function getPatientsByProvider(providerId: number) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(patients)
    .where(eq(patients.providerId, providerId));
}

export async function getPatientsByRiskLevel(riskLevel: "high" | "medium" | "low") {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(patients)
    .where(eq(patients.riskLevel, riskLevel));
}

export async function getActivePatients() {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(patients)
    .where(eq(patients.ccmEnrollmentStatus, "active"));
}

export async function getPatientById(patientId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// CCM Task queries
export async function getCCMTasksForMonth(month: string) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(ccmTasks)
    .where(eq(ccmTasks.month, month))
    .orderBy(desc(ccmTasks.createdAt));
}

export async function getCCMTasksByStaff(staffId: number, month: string) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(ccmTasks)
    .where(and(eq(ccmTasks.assignedStaffId, staffId), eq(ccmTasks.month, month)))
    .orderBy(desc(ccmTasks.createdAt));
}

export async function getCCMTaskById(taskId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(ccmTasks)
    .where(eq(ccmTasks.id, taskId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getCCMTaskByPatientAndMonth(patientId: number, month: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(ccmTasks)
    .where(and(eq(ccmTasks.patientId, patientId), eq(ccmTasks.month, month)))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// CCM Note queries
export async function getCCMNoteByTaskId(taskId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(ccmNotes)
    .where(eq(ccmNotes.ccmTaskId, taskId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// Provider Escalation queries
export async function getEscalationsByProvider(providerId: number) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(providerEscalations)
    .where(eq(providerEscalations.providerId, providerId))
    .orderBy(desc(providerEscalations.createdAt));
}

export async function getPendingEscalations() {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(providerEscalations)
    .where(eq(providerEscalations.escalationStatus, "pending"))
    .orderBy(desc(providerEscalations.createdAt));
}

// Billing queries
export async function getBillingRecordsForMonth(month: string) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(billingRecords)
    .where(eq(billingRecords.month, month))
    .orderBy(desc(billingRecords.createdAt));
}

export async function getBillingReadyCount(month: string) {
  const db = await getDb();
  if (!db) return 0;

  const result = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(billingRecords)
    .where(
      and(
        eq(billingRecords.month, month),
        eq(billingRecords.billingStatus, "ready_for_billing")
      )
    );

  return result[0]?.count || 0;
}

// Notification queries
export async function getUnreadNotifications(userId: number) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)))
    .orderBy(desc(notifications.createdAt));
}

// Productivity metrics queries
export async function getProductivityMetrics(month: string, staffId?: number) {
  const db = await getDb();
  if (!db) return [];

  if (staffId) {
    return db
      .select()
      .from(productivityMetrics)
      .where(
        and(
          eq(productivityMetrics.month, month),
          eq(productivityMetrics.staffId, staffId)
        )
      );
  }

  return db
    .select()
    .from(productivityMetrics)
    .where(eq(productivityMetrics.month, month));
}

// Clinic queries
export async function getAllClinics() {
  const db = await getDb();
  if (!db) return [];

  return db.select().from(clinics);
}

// Provider queries
export async function getProvidersByClinic(clinicId: number) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(providers)
    .where(eq(providers.clinicId, clinicId));
}

export async function getProviderById(providerId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// Staff queries
export async function getStaffByRole(role: "admin" | "staff" | "provider" | "billing" | "front_desk" | "user") {
  const db = await getDb();
  if (!db) return [];

  return db.select().from(users).where(eq(users.role, role));
}

export async function getStaffByClinic(clinicLocation: string | null) {
  const db = await getDb();
  if (!db) return [];

  if (!clinicLocation) return [];

  return db
    .select()
    .from(users)
    .where(eq(users.clinicLocation, clinicLocation));
}


// ============================================================
// Enriched queries (with joins) and dashboard aggregations
// ============================================================

import { alias } from "drizzle-orm/mysql-core";
import { inArray } from "drizzle-orm";

/** Worklist row enriched with patient + staff + provider + clinic info */
export async function getWorklistForMonth(month: string, filters?: {
  status?: string;
  priorityLevel?: "high" | "medium" | "low";
  assignedStaffId?: number;
  clinicId?: number;
  providerId?: number;
}) {
  const db = await getDb();
  if (!db) return [];

  const staffAlias = alias(users, "staff");

  const conditions = [eq(ccmTasks.month, month)];
  if (filters?.status) conditions.push(eq(ccmTasks.status, filters.status as any));
  if (filters?.priorityLevel) conditions.push(eq(ccmTasks.priorityLevel, filters.priorityLevel));
  if (filters?.assignedStaffId) conditions.push(eq(ccmTasks.assignedStaffId, filters.assignedStaffId));
  if (filters?.clinicId) conditions.push(eq(patients.clinicId, filters.clinicId));
  if (filters?.providerId) conditions.push(eq(patients.providerId, filters.providerId));

  const rows = await db
    .select({
      task: ccmTasks,
      patient: patients,
      staffName: staffAlias.name,
      providerName: providers.name,
      clinicName: clinics.name,
      clinicLocation: clinics.location,
    })
    .from(ccmTasks)
    .innerJoin(patients, eq(ccmTasks.patientId, patients.id))
    .leftJoin(staffAlias, eq(ccmTasks.assignedStaffId, staffAlias.id))
    .leftJoin(providers, eq(patients.providerId, providers.id))
    .leftJoin(clinics, eq(patients.clinicId, clinics.id))
    .where(and(...conditions))
    .orderBy(desc(ccmTasks.updatedAt));

  return rows;
}

/** Enriched patient list with provider, clinic, staff names */
export async function getEnrichedPatients(filters?: {
  clinicId?: number;
  providerId?: number;
  riskLevel?: "high" | "medium" | "low";
  enrollmentStatus?: string;
  search?: string;
}) {
  const db = await getDb();
  if (!db) return [];

  const staffAlias = alias(users, "staff");
  const conditions: any[] = [];
  if (filters?.clinicId) conditions.push(eq(patients.clinicId, filters.clinicId));
  if (filters?.providerId) conditions.push(eq(patients.providerId, filters.providerId));
  if (filters?.riskLevel) conditions.push(eq(patients.riskLevel, filters.riskLevel));
  if (filters?.enrollmentStatus) conditions.push(eq(patients.ccmEnrollmentStatus, filters.enrollmentStatus as any));

  const rows = await db
    .select({
      patient: patients,
      providerName: providers.name,
      clinicName: clinics.name,
      clinicLocation: clinics.location,
      staffName: staffAlias.name,
    })
    .from(patients)
    .leftJoin(providers, eq(patients.providerId, providers.id))
    .leftJoin(clinics, eq(patients.clinicId, clinics.id))
    .leftJoin(staffAlias, eq(patients.assignedStaffId, staffAlias.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(patients.createdAt));

  if (filters?.search) {
    const s = filters.search.toLowerCase();
    return rows.filter((r) => r.patient.name.toLowerCase().includes(s) || r.patient.phoneNumber.includes(s));
  }
  return rows;
}

/** Full patient detail incl. tasks, notes, follow-ups */
export async function getPatientDetail(patientId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const patient = await getPatientById(patientId);
  if (!patient) return undefined;

  const tasks = await db.select().from(ccmTasks).where(eq(ccmTasks.patientId, patientId)).orderBy(desc(ccmTasks.month));
  const notes = await db.select().from(ccmNotes).where(eq(ccmNotes.patientId, patientId)).orderBy(desc(ccmNotes.createdAt));
  // Resolve the staff member who completed each call, for the call-history log.
  const completerIds = Array.from(new Set(tasks.map((t) => t.completedByStaffId).filter((x): x is number => !!x)));
  const completers = completerIds.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, completerIds))
    : [];
  const completedByName: Record<number, string> = Object.fromEntries(completers.map((c) => [c.id, c.name || ""]));
  const fus = await db.select().from(followUpItems).where(eq(followUpItems.patientId, patientId)).orderBy(desc(followUpItems.createdAt));
  const prov = patient.providerId ? await getProviderById(patient.providerId) : undefined;
  const clinicArr = patient.clinicId ? await db.select().from(clinics).where(eq(clinics.id, patient.clinicId)).limit(1) : [];
  const staffArr = patient.assignedStaffId ? await db.select().from(users).where(eq(users.id, patient.assignedStaffId)).limit(1) : [];

  return {
    patient,
    tasks,
    notes,
    completedByName,
    followUps: fus,
    provider: prov,
    clinic: clinicArr[0],
    staff: staffArr[0],
  };
}

/** Admin dashboard aggregate stats for a month */
export async function getAdminStats(month: string) {
  const db = await getDb();
  if (!db) return null;

  const tasks = await db.select().from(ccmTasks).where(eq(ccmTasks.month, month));
  const activePats = await db.select().from(patients).where(eq(patients.ccmEnrollmentStatus, "active"));

  const completedStatuses = ["completed", "ready_for_billing", "billed"];
  const total = tasks.length;
  const completed = tasks.filter((t) => completedStatuses.includes(t.status as string)).length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const notReached = tasks.filter((t) => ["called_no_answer", "voicemail_left", "wrong_number"].includes(t.status as string)).length;
  const notStarted = tasks.filter((t) => ["not_started", "assigned"].includes(t.status as string)).length;
  const readyForBilling = tasks.filter((t) => t.status === "ready_for_billing").length;
  const needsReview = tasks.filter((t) => t.providerReviewNeeded).length;

  const pendingEsc = await db.select({ c: sql<number>`COUNT(*)` }).from(providerEscalations).where(eq(providerEscalations.escalationStatus, "pending"));

  // status distribution
  const statusDistribution: Record<string, number> = {};
  tasks.forEach((t) => {
    statusDistribution[t.status as string] = (statusDistribution[t.status as string] || 0) + 1;
  });

  // priority distribution
  const priorityDistribution: Record<string, number> = { high: 0, medium: 0, low: 0 };
  tasks.forEach((t) => {
    const p = (t.priorityLevel || "medium") as string;
    priorityDistribution[p] = (priorityDistribution[p] || 0) + 1;
  });

  return {
    totalActivePatients: activePats.length,
    totalTasks: total,
    completed,
    inProgress,
    notReached,
    notStarted,
    readyForBilling,
    needsReview,
    pendingEscalations: pendingEsc[0]?.c ?? 0,
    completionPct: total ? Math.round((completed / total) * 100) : 0,
    statusDistribution,
    priorityDistribution,
  };
}

/** Per-staff performance for a month (with names) */
export async function getStaffPerformance(month: string) {
  const db = await getDb();
  if (!db) return [];

  const staffAlias = alias(users, "staff");
  const rows = await db
    .select({
      staffId: ccmTasks.assignedStaffId,
      staffName: staffAlias.name,
      status: ccmTasks.status,
      ccmNoteCompleted: ccmTasks.ccmNoteCompleted,
    })
    .from(ccmTasks)
    .leftJoin(staffAlias, eq(ccmTasks.assignedStaffId, staffAlias.id))
    .where(eq(ccmTasks.month, month));

  const map = new Map<number, { staffId: number; staffName: string; assigned: number; completed: number }>();
  const completedStatuses = ["completed", "ready_for_billing", "billed"];
  for (const r of rows) {
    if (!r.staffId) continue;
    const cur = map.get(r.staffId) || { staffId: r.staffId, staffName: r.staffName || "Unassigned", assigned: 0, completed: 0 };
    cur.assigned += 1;
    if (completedStatuses.includes(r.status as string)) cur.completed += 1;
    map.set(r.staffId, cur);
  }
  return Array.from(map.values());
}

const COMPLETED_TASK_STATUSES = ["completed", "ready_for_billing", "billed"];

/** Get a coordinator's admin-set CCM goal for a month (0 if none). */
export async function getMonthlyGoal(userId: number, month: string): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ goal: monthlyGoals.goal })
    .from(monthlyGoals)
    .where(and(eq(monthlyGoals.userId, userId), eq(monthlyGoals.month, month)))
    .limit(1);
  return rows[0]?.goal ?? 0;
}

/** Admin sets/updates a coordinator's CCM goal for a month (upsert). */
export async function setMonthlyGoal(userId: number, month: string, goal: number) {
  const db = await getDb();
  if (!db) return;
  const existing = await db
    .select({ id: monthlyGoals.id })
    .from(monthlyGoals)
    .where(and(eq(monthlyGoals.userId, userId), eq(monthlyGoals.month, month)))
    .limit(1);
  if (existing[0]) {
    await db.update(monthlyGoals).set({ goal, updatedAt: new Date() }).where(eq(monthlyGoals.id, existing[0].id));
  } else {
    await db.insert(monthlyGoals).values({ userId, month, goal });
  }
}

/** Stats for one care coordinator's month: completed, remaining, pace, goal, etc. */
export async function getCoordinatorDashboard(staffId: number, month: string) {
  const db = await getDb();
  if (!db) return null;

  const tasks = await db
    .select({ status: ccmTasks.status, completedAt: ccmTasks.completedAt })
    .from(ccmTasks)
    .where(and(eq(ccmTasks.assignedStaffId, staffId), eq(ccmTasks.month, month)));

  const assigned = tasks.length;
  const completed = tasks.filter((t) => COMPLETED_TASK_STATUSES.includes(t.status as string)).length;
  const remaining = Math.max(0, assigned - completed);

  const statusCounts: Record<string, number> = {};
  for (const t of tasks) statusCounts[t.status as string] = (statusCounts[t.status as string] || 0) + 1;

  // Calendar math for the requested month.
  const [y, m] = month.split("-").map(Number);
  const now = new Date();
  const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const isCurrent = month === curMonth;
  const isPast = y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1);
  const daysElapsed = isCurrent ? now.getDate() : isPast ? daysInMonth : 0;
  const daysRemaining = Math.max(0, daysInMonth - daysElapsed);
  const avgPerDay = daysElapsed > 0 ? Math.round((completed / daysElapsed) * 10) / 10 : 0;

  const todayStr = now.toISOString().slice(0, 10);
  const completedToday = tasks.filter(
    (t) => COMPLETED_TASK_STATUSES.includes(t.status as string) && t.completedAt && new Date(t.completedAt).toISOString().slice(0, 10) === todayStr,
  ).length;

  const goal = await getMonthlyGoal(staffId, month);
  const neededPerDay = goal > completed && daysRemaining > 0 ? Math.ceil((goal - completed) / daysRemaining) : 0;
  const projectedEom = Math.round(avgPerDay * daysInMonth);

  return {
    month, assigned, completed, remaining, avgPerDay, completedToday,
    daysElapsed, daysInMonth, daysRemaining, goal, neededPerDay, projectedEom, statusCounts,
  };
}

/** Admin overview: every coordinator with their goal + completed/assigned for a month. */
export async function getCoordinatorGoalsOverview(month: string) {
  const staff = (await getAllStaffUsers()).filter((s) => s.role === "staff");
  const perf = await getStaffPerformance(month);
  const perfMap = new Map(perf.map((p) => [p.staffId, p]));
  const db = await getDb();
  const goalRows = db ? await db.select().from(monthlyGoals).where(eq(monthlyGoals.month, month)) : [];
  const goalMap = new Map(goalRows.map((g) => [g.userId, g.goal]));
  return staff.map((s) => ({
    userId: s.id,
    name: s.name || s.email || `User ${s.id}`,
    goal: goalMap.get(s.id) ?? 0,
    completed: perfMap.get(s.id)?.completed ?? 0,
    assigned: perfMap.get(s.id)?.assigned ?? 0,
  }));
}

/** Per-clinic performance for a month */
export async function getClinicPerformance(month: string) {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      clinicId: clinics.id,
      clinicName: clinics.name,
      location: clinics.location,
      status: ccmTasks.status,
    })
    .from(ccmTasks)
    .innerJoin(patients, eq(ccmTasks.patientId, patients.id))
    .innerJoin(clinics, eq(patients.clinicId, clinics.id))
    .where(eq(ccmTasks.month, month));

  const map = new Map<number, { clinicId: number; clinicName: string; location: string; total: number; completed: number }>();
  const completedStatuses = ["completed", "ready_for_billing", "billed"];
  for (const r of rows) {
    const cur = map.get(r.clinicId) || { clinicId: r.clinicId, clinicName: r.clinicName, location: r.location, total: 0, completed: 0 };
    cur.total += 1;
    if (completedStatuses.includes(r.status as string)) cur.completed += 1;
    map.set(r.clinicId, cur);
  }
  return Array.from(map.values());
}

/** Daily completion trend for a month (based on dateContacted of completed tasks) */
export async function getDailyCompletionTrend(month: string) {
  const db = await getDb();
  if (!db) return [];
  const completedStatuses = ["completed", "ready_for_billing", "billed"];
  const tasks = await db.select().from(ccmTasks).where(eq(ccmTasks.month, month));
  const byDay: Record<string, number> = {};
  tasks.forEach((t) => {
    if (completedStatuses.includes(t.status as string) && t.dateContacted) {
      const day = new Date(t.dateContacted).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
  });
  return Object.entries(byDay)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Active patients with an upcoming appointment (soonest first) — for the dashboard widget. */
export async function getUpcomingAppointments(limit = 8) {
  const db = await getDb();
  if (!db) return [];
  const now = new Date();
  return db
    .select({
      id: patients.id,
      name: patients.name,
      nextAppointment: patients.nextAppointment,
      clinicName: clinics.name,
      staffName: users.name,
    })
    .from(patients)
    .leftJoin(clinics, eq(patients.clinicId, clinics.id))
    .leftJoin(users, eq(patients.assignedStaffId, users.id))
    .where(and(gte(patients.nextAppointment, now), eq(patients.ccmEnrollmentStatus, "active")))
    .orderBy(patients.nextAppointment)
    .limit(limit);
}

/** Enriched escalations with patient + note info */
export async function getEnrichedEscalations(filters?: { providerId?: number; status?: string }) {
  const db = await getDb();
  if (!db) return [];

  const conditions: any[] = [];
  if (filters?.providerId) conditions.push(eq(providerEscalations.providerId, filters.providerId));
  if (filters?.status) conditions.push(eq(providerEscalations.escalationStatus, filters.status as any));

  return db
    .select({
      escalation: providerEscalations,
      patient: patients,
      note: ccmNotes,
      providerName: providers.name,
    })
    .from(providerEscalations)
    .innerJoin(patients, eq(providerEscalations.patientId, patients.id))
    .leftJoin(ccmNotes, eq(providerEscalations.ccmNoteId, ccmNotes.id))
    .leftJoin(providers, eq(providerEscalations.providerId, providers.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(providerEscalations.createdAt));
}

/** Enriched billing records with patient info */
export async function getEnrichedBilling(month: string, status?: string) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(billingRecords.month, month)];
  if (status) conditions.push(eq(billingRecords.billingStatus, status as any));
  return db
    .select({
      billing: billingRecords,
      patient: patients,
      task: ccmTasks,
    })
    .from(billingRecords)
    .innerJoin(patients, eq(billingRecords.patientId, patients.id))
    .leftJoin(ccmTasks, eq(billingRecords.ccmTaskId, ccmTasks.id))
    .where(and(...conditions))
    .orderBy(desc(billingRecords.updatedAt));
}

/** Enriched follow-up items with patient info */
export async function getEnrichedFollowUps(filters?: { status?: string; type?: string }) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (filters?.status) conditions.push(eq(followUpItems.status, filters.status as any));
  if (filters?.type) conditions.push(eq(followUpItems.type, filters.type as any));
  return db
    .select({
      followUp: followUpItems,
      patient: patients,
      clinicName: clinics.name,
    })
    .from(followUpItems)
    .innerJoin(patients, eq(followUpItems.patientId, patients.id))
    .leftJoin(clinics, eq(patients.clinicId, clinics.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(followUpItems.createdAt));
}

/** Staff workload: number of active assigned patients & open tasks per staff */
export async function getStaffWorkload(month: string) {
  const db = await getDb();
  if (!db) return [];
  const staffUsers = await db
    .select()
    .from(users)
    .where(inArray(users.role, ["staff"] as any));

  const tasks = await db.select().from(ccmTasks).where(eq(ccmTasks.month, month));
  const completedStatuses = ["completed", "ready_for_billing", "billed"];

  return staffUsers.map((s) => {
    const theirs = tasks.filter((t) => t.assignedStaffId === s.id);
    const open = theirs.filter((t) => !completedStatuses.includes(t.status as string)).length;
    return {
      staffId: s.id,
      name: s.name,
      clinicLocation: s.clinicLocation,
      languagesSpoken: s.languagesSpoken,
      totalAssigned: theirs.length,
      openTasks: open,
      completed: theirs.length - open,
    };
  });
}

/** All staff users (for assignment dropdowns) */
export async function getAllStaffUsers() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(users).where(inArray(users.role, ["staff", "admin"] as any));
}

/** All providers with clinic name */
export async function getAllProviders() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ provider: providers, clinicName: clinics.name, location: clinics.location })
    .from(providers)
    .leftJoin(clinics, eq(providers.clinicId, clinics.id));
}

/** Generate monthly worklist tasks for all active patients lacking a task this month */
export async function generateMonthlyWorklist(month: string) {
  const db = await getDb();
  if (!db) return { created: 0 };

  const activePats = await db.select().from(patients).where(eq(patients.ccmEnrollmentStatus, "active"));
  const existing = await db.select().from(ccmTasks).where(eq(ccmTasks.month, month));
  const existingPatientIds = new Set(existing.map((t) => t.patientId));

  const toCreate = activePats.filter((p) => !existingPatientIds.has(p.id));
  if (!toCreate.length) return { created: 0 };

  await db.insert(ccmTasks).values(
    toCreate.map((p) => ({
      patientId: p.id,
      month,
      assignedStaffId: p.assignedStaffId,
      priorityLevel: p.priorityLevel || p.riskLevel || "medium",
      status: p.assignedStaffId ? ("assigned" as const) : ("not_started" as const),
    }))
  );
  return { created: toCreate.length };
}

// Tracks which months this warm Lambda instance has already generated, so the
// auto-generation below runs at most once per instance per month.
const _generatedMonths = new Set<string>();

/**
 * Make sure the worklist for `month` exists, generating it at most once per warm
 * instance. Called when the current-month worklist is loaded so that at the start
 * of each month every active patient automatically gets a fresh task assigned to
 * their staff (status "assigned"), without needing a scheduled job. Idempotent —
 * generateMonthlyWorklist only adds tasks for active patients missing one.
 */
export async function ensureMonthlyWorklistGenerated(month: string) {
  if (_generatedMonths.has(month)) return;
  _generatedMonths.add(month); // mark first so a failure doesn't loop; cleared on error
  try {
    await generateMonthlyWorklist(month);
  } catch (e) {
    _generatedMonths.delete(month);
    console.warn("[Worklist] auto-generation failed:", e);
  }
}

/**
 * Ensure an active patient has a CCM task for `month`, creating it if missing and
 * keeping its staff assignment in sync with the patient's assignedStaffId.
 *
 * This is what makes a newly enrolled (or reassigned) patient show up on the
 * worklist — and on the assigned employee's worklist — immediately, instead of
 * only after the monthly batch (generateMonthlyWorklist) is run.
 */
export async function ensureMonthlyTask(patientId: number, month: string) {
  const db = await getDb();
  if (!db) return;
  const patient = await getPatientById(patientId);
  if (!patient) return;

  const existing = await getCCMTaskByPatientAndMonth(patientId, month);
  if (existing) {
    const desiredStaff = patient.assignedStaffId ?? null;
    if ((existing.assignedStaffId ?? null) !== desiredStaff) {
      // If a task was unstarted and now has an owner, mark it assigned.
      const status = desiredStaff && existing.status === "not_started" ? "assigned" : existing.status;
      await db
        .update(ccmTasks)
        .set({ assignedStaffId: desiredStaff, status, updatedAt: new Date() })
        .where(eq(ccmTasks.id, existing.id));
    }
    return;
  }

  // Only auto-create tasks for actively enrolled patients.
  if (patient.ccmEnrollmentStatus !== "active") return;
  await db.insert(ccmTasks).values({
    patientId,
    month,
    assignedStaffId: patient.assignedStaffId ?? null,
    priorityLevel: (patient.priorityLevel || patient.riskLevel || "medium") as "high" | "medium" | "low",
    status: patient.assignedStaffId ? "assigned" : "not_started",
  });
}

/** Permanently delete a patient and all of their dependent CCM records (FK-safe order). */
export async function deletePatient(patientId: number) {
  const db = await getDb();
  if (!db) return;
  const taskRows = await db.select({ id: ccmTasks.id }).from(ccmTasks).where(eq(ccmTasks.patientId, patientId));
  const taskIds = taskRows.map((t) => t.id);
  if (taskIds.length) await db.delete(notifications).where(inArray(notifications.relatedCCMTaskId, taskIds));
  await db.delete(notifications).where(eq(notifications.relatedPatientId, patientId));
  await db.delete(billingRecords).where(eq(billingRecords.patientId, patientId));
  await db.delete(followUpItems).where(eq(followUpItems.patientId, patientId));
  await db.delete(providerEscalations).where(eq(providerEscalations.patientId, patientId));
  await db.delete(ccmNotes).where(eq(ccmNotes.patientId, patientId));
  await db.delete(ccmTasks).where(eq(ccmTasks.patientId, patientId));
  await db.delete(patients).where(eq(patients.id, patientId));
}

/** Recompute billing readiness for a task and upsert billing record */
export async function recomputeBilling(taskId: number, month: string) {
  const db = await getDb();
  if (!db) return;
  const task = await getCCMTaskById(taskId);
  if (!task) return;

  const docComplete = !!task.ccmNoteCompleted;
  const providerReviewDone = !task.providerReviewNeeded;
  const contacted = !!task.dateContacted || ["in_progress", "completed", "ready_for_billing", "billed"].includes(task.status as string);
  let billingStatus:
    | "not_started" | "in_progress" | "documentation_incomplete"
    | "provider_review_pending" | "ready_for_billing" | "billed"
    | "denied" | "needs_correction" = "not_started";
  if (task.status === "billed") billingStatus = "billed";
  else if (docComplete && providerReviewDone) billingStatus = "ready_for_billing";
  else if (task.status === "documentation_incomplete") billingStatus = "documentation_incomplete";
  else if (task.providerReviewNeeded) billingStatus = "provider_review_pending";
  else if (contacted) billingStatus = "in_progress";

  const existing = await db.select().from(billingRecords).where(eq(billingRecords.ccmTaskId, taskId)).limit(1);
  const values = {
    ccmTaskId: taskId,
    patientId: task.patientId,
    month,
    timeThresholdMet: true,
    documentationComplete: docComplete,
    providerAssociated: true,
    carePlanReviewed: docComplete,
    noMissingFields: docComplete,
    providerReviewCompleted: providerReviewDone,
    billingStatus,
  };
  if (existing.length) {
    await db.update(billingRecords).set(values).where(eq(billingRecords.id, existing[0].id));
  } else {
    await db.insert(billingRecords).values(values);
  }

  // keep task.billingReady in sync
  await db.update(ccmTasks).set({ billingReady: billingStatus === "ready_for_billing" }).where(eq(ccmTasks.id, taskId));
}

/** Create a notification */
export async function createNotification(n: {
  userId: number;
  type: "urgent_symptom" | "escalation" | "missing_documentation" | "not_reached" | "billing_ready";
  title: string;
  content?: string;
  relatedPatientId?: number | null;
  relatedCCMTaskId?: number | null;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(notifications).values({
    userId: n.userId,
    type: n.type,
    title: n.title,
    content: n.content,
    relatedPatientId: n.relatedPatientId ?? null,
    relatedCCMTaskId: n.relatedCCMTaskId ?? null,
    read: false,
  });
}

/** Mark notification read */
export async function markNotificationRead(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(notifications).set({ read: true }).where(eq(notifications.id, id));
}

/** Get all notifications for a user (read + unread) */
export async function getAllNotifications(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt));
}

/** Find first user by role (for routing notifications) */
export async function getFirstUserByRole(role: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(users).where(eq(users.role, role as any)).limit(1);
  return r[0];
}

/** Update a user's role (admin-managed access control). */
export async function setUserRole(userId: number, role: "admin" | "staff" | "provider" | "billing" | "front_desk" | "user") {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ role }).where(eq(users.id, userId));
}

/** List all worker accounts for the admin Team / Access page. */
export async function getAllUsers() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: users.id,
      openId: users.openId,
      name: users.name,
      email: users.email,
      role: users.role,
      clinicLocation: users.clinicLocation,
      loginMethod: users.loginMethod,
      mustChangePassword: users.mustChangePassword,
      passwordSetAt: users.passwordSetAt,
      lastSignedIn: users.lastSignedIn,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt));
  // A member whose openId is still a placeholder has not signed in yet.
  // `hasPassword` lets the admin see at a glance who can sign in with a password.
  return rows.map((r) => {
    const { passwordSetAt, ...rest } = r;
    return {
      ...rest,
      pending: r.openId.startsWith("pending:"),
      hasPassword: !!passwordSetAt,
    };
  });
}

const PENDING_PREFIX = "pending:";
const LOCAL_PREFIX = "local:";

/**
 * Admin-created worker login. Pre-creates (or updates) a users row keyed by email
 * with the assigned role. The worker then signs in with Manus OAuth using that email,
 * at which point upsertUser links their real openId and preserves the assigned role.
 */
export async function createMember(input: {
  email: string;
  name?: string | null;
  role: "admin" | "staff" | "provider" | "billing" | "front_desk" | "user";
  clinicLocation?: string | null;
  passwordHash?: string | null;
}): Promise<{ created: boolean; pending: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const email = input.email.trim().toLowerCase();
  const hasPassword = !!input.passwordHash;

  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing.length) {
    const row = existing[0];
    const set: Record<string, unknown> = {
      role: input.role,
      name: input.name ?? row.name,
      clinicLocation: input.clinicLocation ?? row.clinicLocation,
      updatedAt: new Date(),
    };
    if (hasPassword) {
      set.passwordHash = input.passwordHash;
      set.passwordSetAt = new Date();
      set.mustChangePassword = true;
      set.loginMethod = "password";
      // If this was a not-yet-signed-in pending row, convert it to a local account
      // so the worker can sign in immediately with email + password.
      if (row.openId.startsWith(PENDING_PREFIX)) {
        set.openId = `${LOCAL_PREFIX}${email}`;
      }
    }
    await db.update(users).set(set).where(eq(users.id, row.id));
    return { created: false, pending: row.openId.startsWith(PENDING_PREFIX) && !hasPassword };
  }

  // With a password the worker can sign in immediately, so give them a real local openId.
  // Without one, fall back to the legacy pending-row + Manus OAuth linking flow.
  await db.insert(users).values({
    openId: hasPassword ? `${LOCAL_PREFIX}${email}` : `${PENDING_PREFIX}${email}`,
    email,
    name: input.name ?? null,
    role: input.role,
    clinicLocation: input.clinicLocation ?? null,
    loginMethod: hasPassword ? "password" : "manus",
    passwordHash: input.passwordHash ?? null,
    passwordSetAt: hasPassword ? new Date() : null,
    mustChangePassword: hasPassword ? true : false,
  });
  return { created: true, pending: !hasPassword };
}

/** Look up a worker by email (case-insensitive). Used for password login. */
export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;
  const normalized = email.trim().toLowerCase();
  const rows = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  return rows.length ? rows[0] : undefined;
}

/** Set (or reset) a user's password hash. `mustChange` forces a change on next login. */
export async function setUserPassword(userId: number, passwordHash: string, mustChange: boolean) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(users)
    .set({
      passwordHash,
      passwordSetAt: new Date(),
      mustChangePassword: mustChange,
      loginMethod: "password",
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

/** A user object with all credential material removed, safe to send to the client. */
export type SafeUser = Omit<User, "passwordHash" | "passwordSetAt">;

/**
 * Strip sensitive auth fields (password hash, etc.) from a user row before it is
 * ever returned to the client. HIPAA: never expose credential material to the browser.
 */
export function sanitizeUser(user: User): SafeUser;
export function sanitizeUser(user: User | null | undefined): SafeUser | null;
export function sanitizeUser(user: User | null | undefined): SafeUser | null {
  if (!user) return null;
  const { passwordHash: _ph, passwordSetAt: _ps, ...safe } = user;
  return safe;
}

// ---------------------------------------------------------------------------
// Brute-force protection for password login
// ---------------------------------------------------------------------------

type Attempt = { count: number; firstAt: number; lockedUntil: number | null };
const loginAttempts = new Map<string, Attempt>();
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Returns remaining lockout ms if the identifier is currently locked, else 0. */
export function getLockoutRemaining(identifier: string): number {
  const a = loginAttempts.get(identifier.toLowerCase());
  if (!a || !a.lockedUntil) return 0;
  const remaining = a.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

/** Record a failed login attempt; locks the identifier after MAX_ATTEMPTS within the window. */
export function recordFailedLogin(identifier: string): void {
  const key = identifier.toLowerCase();
  const now = Date.now();
  const a = loginAttempts.get(key);
  if (!a || now - a.firstAt > ATTEMPT_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: now, lockedUntil: null });
    return;
  }
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = now + LOCKOUT_MS;
  }
}

/** Clear attempt state after a successful login. */
export function clearLoginAttempts(identifier: string): void {
  loginAttempts.delete(identifier.toLowerCase());
}

// ---------------------------------------------------------------------------
// HIPAA audit logging
// ---------------------------------------------------------------------------

/** Append a record to the immutable HIPAA audit log. Never throws into callers. */
export async function writeAuditLog(entry: InsertAuditLog) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(auditLogs).values(entry);
  } catch (e) {
    console.warn("[Audit] Failed to write audit log:", e);
  }
}

/** Fetch the most recent audit log entries (admin only — enforced at router). */
export async function getAuditLogs(opts?: { limit?: number; action?: string; userId?: number }) {
  const db = await getDb();
  if (!db) return [];
  const conditions: any[] = [];
  if (opts?.action) conditions.push(eq(auditLogs.action, opts.action as any));
  if (opts?.userId) conditions.push(eq(auditLogs.userId, opts.userId));
  return db
    .select()
    .from(auditLogs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(opts?.limit ?? 200);
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/** Normalize a name for comparison: lowercase, collapse whitespace, trim. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Format a date to YYYY-MM-DD for DOB comparison, or "" if absent. */
function dobKey(d?: Date | null): string {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

/**
 * Returns a Map keyed by normalized name -> array of patient ids sharing that name.
 * Only includes names with 2+ patients (i.e. actual duplicates).
 */
export async function getDuplicateNameGroups(): Promise<Record<string, { ids: number[]; sameDob: boolean }>> {
  const db = await getDb();
  if (!db) return {};
  const rows = await db.select({ id: patients.id, name: patients.name, dob: patients.dateOfBirth }).from(patients);
  const groups: Record<string, { ids: number[]; dobs: string[] }> = {};
  for (const r of rows) {
    const key = normalizeName(r.name);
    if (!groups[key]) groups[key] = { ids: [], dobs: [] };
    groups[key].ids.push(r.id);
    groups[key].dobs.push(dobKey(r.dob));
  }
  const result: Record<string, { ids: number[]; sameDob: boolean }> = {};
  for (const [key, g] of Object.entries(groups)) {
    if (g.ids.length > 1) {
      // sameDob is true when at least two records share an identical, non-empty DOB
      const counts: Record<string, number> = {};
      let repeatedDob = false;
      for (const d of g.dobs) {
        if (!d) continue;
        counts[d] = (counts[d] || 0) + 1;
        if (counts[d] > 1) repeatedDob = true;
      }
      result[key] = { ids: g.ids, sameDob: repeatedDob };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Bulk patient import
// ---------------------------------------------------------------------------

export type BulkPatientRow = {
  name: string;
  dateOfBirth?: Date | null;
  phoneNumber?: string;
  clinicId: number | null;
  providerId: number | null;
  preferredLanguage?: string;
  chronicConditions?: string[];
  insurance?: string;
  consentStatus?: "consented" | "pending" | "declined";
  rpmEnrolled?: boolean;
  rpmStatus?: "not_enrolled" | "eligible" | "enrolled" | "active" | "declined" | "inactive";
  rpmDeviceType?: string;
  lastCalledAt?: Date | null;
  nextAppointment?: Date | null;
  lastCCMDate?: Date | null;
  assignedStaffId?: number | null;
  /** Canonical worklist status (from matchWorklistStatus) for this month's task. */
  worklistStatus?: string | null;
  ccmEnrollmentStatus?: "active" | "inactive" | "declined" | "transferred";
};

/**
 * Insert many patients in one batch. When `month` is given, also creates each
 * patient's worklist task for that month, carrying the per-row `worklistStatus`
 * (so an import preserves the status from the file). Returns inserted count.
 */
export async function bulkInsertPatients(rows: BulkPatientRow[], month?: string): Promise<number> {
  const db = await getDb();
  if (!db || rows.length === 0) return 0;
  const values = rows.map((r) => ({
    name: r.name,
    dateOfBirth: r.dateOfBirth ?? null,
    phoneNumber: r.phoneNumber || "",
    clinicId: r.clinicId,
    providerId: r.providerId,
    preferredLanguage: r.preferredLanguage || "English",
    chronicConditions: r.chronicConditions || [],
    insurance: r.insurance,
    priorityLevel: "medium" as const,
    ccmEnrollmentStatus: r.ccmEnrollmentStatus || ("active" as const),
    consentStatus: r.consentStatus || "pending",
    rpmEnrolled: r.rpmEnrolled ?? false,
    rpmStatus: r.rpmStatus || (r.rpmEnrolled ? "enrolled" : "not_enrolled"),
    rpmDeviceType: r.rpmDeviceType,
    lastCalledAt: r.lastCalledAt ?? null,
    nextAppointment: r.nextAppointment ?? null,
    lastCCMDate: r.lastCCMDate ?? null,
    assignedStaffId: r.assignedStaffId ?? null,
  }));
  const res: any = await db.insert(patients).values(values);
  // A single multi-row INSERT yields consecutive auto-increment ids beginning at
  // insertId, so row i maps to patient id (firstId + i).
  const firstId = Number(res?.[0]?.insertId ?? 0);
  if (month && firstId > 0) {
    const taskValues = rows
      .map((r, i) => ({ r, i }))
      // Inactive patients don't get a monthly worklist task.
      .filter(({ r }) => (r.ccmEnrollmentStatus || "active") === "active")
      .map(({ r, i }) => {
        const isCompleted = r.worklistStatus === "completed";
        return {
          patientId: firstId + i,
          month,
          assignedStaffId: r.assignedStaffId ?? null,
          priorityLevel: "medium" as const,
          status: (r.worklistStatus as any) || (r.assignedStaffId ? "assigned" : "not_started"),
          // A completed import row represents a call that already happened — stamp the
          // completion date + crediting staff so it shows in the completion report
          // (the date comes from the file; fall back to now when the file had none).
          dateContacted: isCompleted ? (r.lastCalledAt ?? null) : null,
          completedAt: isCompleted ? (r.lastCalledAt ?? new Date()) : null,
          completedByStaffId: isCompleted ? (r.assignedStaffId ?? null) : null,
        };
      });
    if (taskValues.length) await db.insert(ccmTasks).values(taskValues);
  }
  return values.length;
}

/** Find existing patients whose normalized name matches any in the provided list. */
export async function findExistingByNames(names: string[]): Promise<Record<string, number[]>> {
  const db = await getDb();
  if (!db || names.length === 0) return {};
  const rows = await db.select({ id: patients.id, name: patients.name }).from(patients);
  const wanted = new Set(names.map(normalizeName));
  const map: Record<string, number[]> = {};
  for (const r of rows) {
    const key = normalizeName(r.name);
    if (wanted.has(key)) {
      if (!map[key]) map[key] = [];
      map[key].push(r.id);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// RPM
// ---------------------------------------------------------------------------

export async function updatePatientRPM(
  patientId: number,
  data: { rpmEnrolled?: boolean; rpmStatus?: string; rpmDeviceType?: string | null }
) {
  const db = await getDb();
  if (!db) return undefined;
  await db.update(patients).set(data as any).where(eq(patients.id, patientId));
  return getPatientById(patientId);
}

// ---------------------------------------------------------------------------
// Reporting: completed CCM aggregation by flexible dimensions
// ---------------------------------------------------------------------------

export type ReportDimension = "date" | "week" | "provider" | "employee" | "clinic";

export interface CompletionReportRow {
  // dimension keys (present depending on requested groupBy)
  date?: string;
  week?: string;
  providerId?: number | null;
  providerName?: string;
  employeeId?: number | null;
  employeeName?: string;
  clinicId?: number | null;
  clinicName?: string;
  count: number;
}

/**
 * Flexible completion report. Counts CCM tasks that have been completed
 * (status completed/ready_for_billing/billed, completedAt set), grouped by
 * any combination of: date, week (ISO year-week), provider, employee, clinic.
 * Optional date range filters on completedAt.
 */
export async function getCompletionReport(opts: {
  groupBy: ReportDimension[];
  from?: number; // unix ms
  to?: number; // unix ms
}): Promise<CompletionReportRow[]> {
  const db = await getDb();
  if (!db) return [];

  const groupBy: ReportDimension[] = opts.groupBy.length ? opts.groupBy : ["date"];

  // Pull completed tasks joined with patient -> provider/clinic and completing employee.
  const conds: any[] = [
    sql`${ccmTasks.completedAt} IS NOT NULL`,
    inArray(ccmTasks.status, ["completed", "ready_for_billing", "billed"]),
  ];
  // Include the whole "from" calendar day: callers send local midnight, which is a
  // few hours into the UTC day, so floor it to the day start or boundary-day
  // completions (stored at UTC midnight) get dropped.
  if (opts.from) {
    const from = new Date(opts.from);
    from.setUTCHours(0, 0, 0, 0);
    conds.push(gte(ccmTasks.completedAt, from));
  }
  if (opts.to) conds.push(lte(ccmTasks.completedAt, new Date(opts.to)));

  const rows = await db
    .select({
      completedAt: ccmTasks.completedAt,
      employeeId: ccmTasks.completedByStaffId,
      assignedStaffId: ccmTasks.assignedStaffId,
      employeeName: users.name,
      providerId: patients.providerId,
      providerName: providers.name,
      clinicId: patients.clinicId,
      clinicName: clinics.name,
    })
    .from(ccmTasks)
    .innerJoin(patients, eq(ccmTasks.patientId, patients.id))
    .leftJoin(providers, eq(patients.providerId, providers.id))
    .leftJoin(clinics, eq(patients.clinicId, clinics.id))
    .leftJoin(users, eq(ccmTasks.completedByStaffId, users.id))
    .where(and(...conds));

  // Aggregate in JS so we can support arbitrary dimension combinations cleanly.
  const map = new Map<string, CompletionReportRow>();

  for (const r of rows) {
    if (!r.completedAt) continue;
    const d = new Date(r.completedAt);
    const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
    const weekStr = isoYearWeek(d);

    const keyParts: string[] = [];
    const row: CompletionReportRow = { count: 0 };

    for (const dim of groupBy) {
      switch (dim) {
        case "date":
          row.date = dateStr; keyParts.push("d:" + dateStr); break;
        case "week":
          row.week = weekStr; keyParts.push("w:" + weekStr); break;
        case "provider":
          row.providerId = r.providerId ?? null;
          row.providerName = r.providerName || "Unassigned";
          keyParts.push("p:" + (r.providerId ?? "0")); break;
        case "employee":
          row.employeeId = r.employeeId ?? null;
          row.employeeName = r.employeeName || "Unknown";
          keyParts.push("e:" + (r.employeeId ?? "0")); break;
        case "clinic":
          row.clinicId = r.clinicId ?? null;
          row.clinicName = r.clinicName || "Unassigned";
          keyParts.push("c:" + (r.clinicId ?? "0")); break;
      }
    }

    const key = keyParts.join("|");
    const existing = map.get(key);
    if (existing) existing.count += 1;
    else { row.count = 1; map.set(key, row); }
  }

  const result = Array.from(map.values());
  // Sort by first dimension for stable display
  result.sort((a, b) => {
    const ka = reportSortKey(a, groupBy);
    const kb = reportSortKey(b, groupBy);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return result;
}

function reportSortKey(r: CompletionReportRow, groupBy: ReportDimension[]): string {
  return groupBy.map((dim) => {
    switch (dim) {
      case "date": return r.date || "";
      case "week": return r.week || "";
      case "provider": return r.providerName || "";
      case "employee": return r.employeeName || "";
      case "clinic": return r.clinicName || "";
    }
  }).join("|");
}

/** ISO year-week, e.g. "2026-W24". */
function isoYearWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

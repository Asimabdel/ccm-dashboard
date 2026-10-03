import { eq, and, or, gte, lte, desc, sql, like } from "drizzle-orm";
import { countChronicConditions } from "../shared/programRules";
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
  refillRequests,
  reachOutContacts,
  appointments,
  workTasks,
  opportunityActions,
  type InsertAuditLog,
  type User,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { buildStandardApcmCarePlan } from "../shared/carePlan";

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

export async function getCCMTaskByPatientAndMonth(patientId: number, month: string, program: "ccm" | "bhi" | "apcm" = "ccm") {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(ccmTasks)
    .where(and(eq(ccmTasks.patientId, patientId), eq(ccmTasks.month, month), eq(ccmTasks.program, program)))
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
export async function getStaffByRole(role: "admin" | "office_manager" | "staff" | "provider" | "billing" | "front_desk" | "medical_assistant" | "user") {
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
  program?: "ccm" | "bhi" | "apcm";
}) {
  const db = await getDb();
  if (!db) return [];

  const staffAlias = alias(users, "staff");

  const program = filters?.program ?? "ccm";
  const conditions = [eq(ccmTasks.month, month), eq(ccmTasks.program, program)];
  // The worklist only shows patients actively enrolled in THIS program — inactive
  // and declined patients live on their own tabs. BHI and CCM enrollment are
  // independent, so gate on the matching enrollment column.
  conditions.push(program === "bhi" ? eq(patients.bhiEnrollmentStatus, "active") : eq(patients.ccmEnrollmentStatus, "active"));
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
  assignedStaffId?: number;
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
  if (filters?.assignedStaffId) conditions.push(eq(patients.assignedStaffId, filters.assignedStaffId));

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

/** Admin dashboard aggregate stats for a month (defaults to the CCM program). */
export async function getAdminStats(month: string, program: "ccm" | "bhi" | "apcm" = "ccm") {
  const db = await getDb();
  if (!db) return null;

  const enrollmentActive = program === "bhi" ? eq(patients.bhiEnrollmentStatus, "active") : eq(patients.ccmEnrollmentStatus, "active");

  // Scope to actively-enrolled patients so the numbers match the worklist and the
  // coordinator dashboards (inactive/declined patients live on their own tabs and
  // must not drag down the month's completion rate).
  const tasks = await db
    .select({
      status: ccmTasks.status,
      priorityLevel: ccmTasks.priorityLevel,
      providerReviewNeeded: ccmTasks.providerReviewNeeded,
      timeSpentMinutes: ccmTasks.timeSpentMinutes,
    })
    .from(ccmTasks)
    .innerJoin(patients, eq(ccmTasks.patientId, patients.id))
    .where(and(eq(ccmTasks.month, month), eq(ccmTasks.program, program), enrollmentActive));

  const [activeRow] = await db.select({ c: sql<number>`COUNT(*)` }).from(patients).where(enrollmentActive);

  const completedStatuses = ["completed", "ready_for_billing", "billed"];
  const total = tasks.length;
  const completed = tasks.filter((t) => completedStatuses.includes(t.status as string)).length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const notReached = tasks.filter((t) => ["called_no_answer", "voicemail_left", "wrong_number", "needs_callback", "unable_to_reach"].includes(t.status as string)).length;
  const notStarted = tasks.filter((t) => ["not_started", "assigned"].includes(t.status as string)).length;
  const readyForBilling = tasks.filter((t) => t.status === "ready_for_billing").length;
  const needsReview = tasks.filter((t) => t.providerReviewNeeded).length;
  // Billable = a completed CCM with the CMS ≥20-min clinical-time threshold met.
  const billable = tasks.filter((t) => completedStatuses.includes(t.status as string) && (t.timeSpentMinutes ?? 0) >= 20).length;
  const totalMinutes = tasks.reduce((s, t) => s + (t.timeSpentMinutes ?? 0), 0);

  const pendingEsc = await db.select({ c: sql<number>`COUNT(*)` }).from(providerEscalations).where(eq(providerEscalations.escalationStatus, "pending"));

  // Calendar pacing: average completions per elapsed day (days-so-far for the
  // current month, full month otherwise).
  const [yy, mm] = month.split("-").map(Number);
  const nowMonth = new Date().toISOString().slice(0, 7);
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const daysElapsed = month === nowMonth ? new Date().getUTCDate() : (month > nowMonth ? 0 : daysInMonth);
  const avgPerDay = daysElapsed ? Math.round((completed / daysElapsed) * 10) / 10 : 0;

  const statusDistribution: Record<string, number> = {};
  tasks.forEach((t) => { statusDistribution[t.status as string] = (statusDistribution[t.status as string] || 0) + 1; });

  const priorityDistribution: Record<string, number> = { high: 0, medium: 0, low: 0 };
  tasks.forEach((t) => { const p = (t.priorityLevel || "medium") as string; priorityDistribution[p] = (priorityDistribution[p] || 0) + 1; });

  return {
    totalActivePatients: Number(activeRow?.c ?? 0),
    totalTasks: total,
    completed,
    inProgress,
    notReached,
    notStarted,
    readyForBilling,
    needsReview,
    billable,
    totalMinutes,
    avgPerDay,
    daysElapsed,
    daysInMonth,
    pendingEscalations: pendingEsc[0]?.c ?? 0,
    completionPct: total ? Math.round((completed / total) * 100) : 0,
    statusDistribution,
    priorityDistribution,
  };
}

/** Per-staff performance for a month (with names) */
export async function getStaffPerformance(month: string, program: "ccm" | "bhi" | "apcm" = "ccm") {
  const db = await getDb();
  if (!db) return [];

  const enrollmentActive = program === "bhi" ? eq(patients.bhiEnrollmentStatus, "active") : eq(patients.ccmEnrollmentStatus, "active");
  const staffAlias = alias(users, "staff");
  const rows = await db
    .select({
      staffId: ccmTasks.assignedStaffId,
      staffName: staffAlias.name,
      status: ccmTasks.status,
      timeSpentMinutes: ccmTasks.timeSpentMinutes,
    })
    .from(ccmTasks)
    .innerJoin(patients, eq(ccmTasks.patientId, patients.id))
    .leftJoin(staffAlias, eq(ccmTasks.assignedStaffId, staffAlias.id))
    .where(and(eq(ccmTasks.month, month), eq(ccmTasks.program, program), enrollmentActive));

  const map = new Map<number, { staffId: number; staffName: string; assigned: number; completed: number; billable: number }>();
  const completedStatuses = ["completed", "ready_for_billing", "billed"];
  for (const r of rows) {
    if (!r.staffId) continue;
    const cur = map.get(r.staffId) || { staffId: r.staffId, staffName: r.staffName || "Unassigned", assigned: 0, completed: 0, billable: 0 };
    cur.assigned += 1;
    if (completedStatuses.includes(r.status as string)) {
      cur.completed += 1;
      if ((r.timeSpentMinutes ?? 0) >= 20) cur.billable += 1;
    }
    map.set(r.staffId, cur);
  }
  return Array.from(map.values()).sort((a, b) => b.completed - a.completed);
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
    .select({
      taskId: ccmTasks.id,
      status: ccmTasks.status,
      completedAt: ccmTasks.completedAt,
      patientId: patients.id,
      patientName: patients.name,
      lastCalledAt: patients.lastCalledAt,
    })
    .from(ccmTasks)
    .innerJoin(patients, eq(ccmTasks.patientId, patients.id))
    .where(and(eq(ccmTasks.assignedStaffId, staffId), eq(ccmTasks.month, month), eq(patients.ccmEnrollmentStatus, "active")));

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

  // Scale by the coordinator's working days per week so per-day metrics reflect
  // their actual schedule (e.g. 4 days/week) instead of raw calendar days.
  const u = await db.select({ wd: users.workDaysPerWeek }).from(users).where(eq(users.id, staffId)).limit(1);
  const workDaysPerWeek = Math.min(7, Math.max(1, u[0]?.wd ?? 5));
  const workFraction = workDaysPerWeek / 7;
  const workElapsed = daysElapsed * workFraction;
  const workRemaining = daysRemaining * workFraction;
  const workInMonth = daysInMonth * workFraction;
  const avgPerDay = workElapsed >= 1 ? Math.round((completed / workElapsed) * 10) / 10 : completed;

  const todayStr = now.toISOString().slice(0, 10);
  const completedToday = tasks.filter(
    (t) => COMPLETED_TASK_STATUSES.includes(t.status as string) && t.completedAt && new Date(t.completedAt).toISOString().slice(0, 10) === todayStr,
  ).length;

  const goal = await getMonthlyGoal(staffId, month);
  const neededPerDay = goal > completed ? (workRemaining >= 1 ? Math.ceil((goal - completed) / workRemaining) : goal - completed) : 0;
  const projectedEom = workElapsed >= 1 ? Math.round((completed / workElapsed) * workInMonth) : completed;

  // Actionable work queues: patients to re-attempt (call-back) and not-yet-reached
  // (overdue), oldest-contacted first so the most overdue surface at the top.
  const CALLBACK_STATUSES = ["called_no_answer", "voicemail_left", "needs_callback"];
  const TODO_STATUSES = ["not_started", "assigned", "in_progress"];
  const byOldest = (a: { lastCalledAt: Date | null }, b: { lastCalledAt: Date | null }) =>
    (a.lastCalledAt ? new Date(a.lastCalledAt).getTime() : 0) - (b.lastCalledAt ? new Date(b.lastCalledAt).getTime() : 0);
  const item = (t: typeof tasks[number]) => ({ taskId: t.taskId, patientId: t.patientId, name: t.patientName, status: t.status as string, lastCalledAt: t.lastCalledAt });
  const callbackAll = tasks.filter((t) => CALLBACK_STATUSES.includes(t.status as string)).sort(byOldest);
  const overdueAll = tasks.filter((t) => TODO_STATUSES.includes(t.status as string)).sort(byOldest);

  return {
    month, assigned, completed, remaining, avgPerDay, completedToday,
    daysElapsed, daysInMonth, daysRemaining,
    workDaysPerWeek, workDaysElapsed: Math.round(workElapsed), workDaysRemaining: Math.round(workRemaining),
    goal, neededPerDay, projectedEom, statusCounts,
    callbackCount: callbackAll.length, overdueCount: overdueAll.length,
    callbackQueue: callbackAll.slice(0, 12).map(item),
    overdueQueue: overdueAll.slice(0, 12).map(item),
  };
}

/** Admin sets a coordinator's working days per week (1-7). */
export async function setWorkDays(userId: number, workDaysPerWeek: number) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(users)
    .set({ workDaysPerWeek: Math.min(7, Math.max(1, Math.round(workDaysPerWeek))), updatedAt: new Date() })
    .where(eq(users.id, userId));
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
    workDaysPerWeek: s.workDaysPerWeek ?? 5,
    completed: perfMap.get(s.id)?.completed ?? 0,
    assigned: perfMap.get(s.id)?.assigned ?? 0,
  }));
}

/** Per-clinic performance for a month */
export async function getClinicPerformance(month: string, program: "ccm" | "bhi" | "apcm" = "ccm") {
  const db = await getDb();
  if (!db) return [];

  const enrollmentActive = program === "bhi" ? eq(patients.bhiEnrollmentStatus, "active") : eq(patients.ccmEnrollmentStatus, "active");
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
    .where(and(eq(ccmTasks.month, month), eq(ccmTasks.program, program), enrollmentActive));

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

/** Per-provider performance for a month (active patients). */
export async function getProviderPerformance(month: string, program: "ccm" | "bhi" | "apcm" = "ccm") {
  const db = await getDb();
  if (!db) return [];
  const enrollmentActive = program === "bhi" ? eq(patients.bhiEnrollmentStatus, "active") : eq(patients.ccmEnrollmentStatus, "active");
  const rows = await db
    .select({ providerId: providers.id, providerName: providers.name, status: ccmTasks.status })
    .from(ccmTasks)
    .innerJoin(patients, eq(ccmTasks.patientId, patients.id))
    .innerJoin(providers, eq(patients.providerId, providers.id))
    .where(and(eq(ccmTasks.month, month), eq(ccmTasks.program, program), enrollmentActive));
  const map = new Map<number, { providerId: number; providerName: string; total: number; completed: number }>();
  const completedStatuses = ["completed", "ready_for_billing", "billed"];
  for (const r of rows) {
    const cur = map.get(r.providerId) || { providerId: r.providerId, providerName: r.providerName, total: 0, completed: 0 };
    cur.total += 1;
    if (completedStatuses.includes(r.status as string)) cur.completed += 1;
    map.set(r.providerId, cur);
  }
  return Array.from(map.values()).sort((a, b) => b.completed - a.completed);
}

/** Daily completion trend for a month — bucketed by completedAt (the actual
 *  completion), scoped to active patients, matching the completion report. */
export async function getDailyCompletionTrend(month: string, program: "ccm" | "bhi" | "apcm" = "ccm") {
  const db = await getDb();
  if (!db) return [];
  const enrollmentActive = program === "bhi" ? eq(patients.bhiEnrollmentStatus, "active") : eq(patients.ccmEnrollmentStatus, "active");
  const rows = await db
    .select({ completedAt: ccmTasks.completedAt })
    .from(ccmTasks)
    .innerJoin(patients, eq(ccmTasks.patientId, patients.id))
    .where(and(
      eq(ccmTasks.month, month),
      eq(ccmTasks.program, program),
      enrollmentActive,
      inArray(ccmTasks.status, ["completed", "ready_for_billing", "billed"]),
      sql`${ccmTasks.completedAt} IS NOT NULL`,
    ));
  const byDay: Record<string, number> = {};
  for (const r of rows) {
    if (!r.completedAt) continue;
    const day = new Date(r.completedAt).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }
  return Object.entries(byDay).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
}

/** Completions per calendar month over the last N months, by completedAt (a true
 *  month-over-month CCM production trend across all task months). Active patients. */
export async function getMonthlyCompletionTrend(months = 6, program: "ccm" | "bhi" | "apcm" = "ccm") {
  const db = await getDb();
  if (!db) return [] as { month: string; count: number }[];
  const enrollmentActive = program === "bhi" ? eq(patients.bhiEnrollmentStatus, "active") : eq(patients.ccmEnrollmentStatus, "active");
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const rows = await db
    .select({ completedAt: ccmTasks.completedAt })
    .from(ccmTasks)
    .innerJoin(patients, eq(ccmTasks.patientId, patients.id))
    .where(and(
      eq(ccmTasks.program, program),
      enrollmentActive,
      inArray(ccmTasks.status, ["completed", "ready_for_billing", "billed"]),
      sql`${ccmTasks.completedAt} IS NOT NULL`,
      gte(ccmTasks.completedAt, start),
    ));
  const byMonth: Record<string, number> = {};
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1) + i, 1));
    byMonth[d.toISOString().slice(0, 7)] = 0;
  }
  for (const r of rows) {
    if (!r.completedAt) continue;
    const k = new Date(r.completedAt).toISOString().slice(0, 7);
    byMonth[k] = (byMonth[k] || 0) + 1;
  }
  return Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0])).map(([month, count]) => ({ month, count }));
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
export async function getEnrichedBilling(month: string, status?: string, program?: "ccm" | "bhi" | "apcm") {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(billingRecords.month, month)];
  if (status) conditions.push(eq(billingRecords.billingStatus, status as any));
  if (program) conditions.push(eq(billingRecords.program, program));
  return db
    .select({
      billing: billingRecords,
      patient: patients,
      task: ccmTasks,
      providerName: providers.name,
    })
    .from(billingRecords)
    .innerJoin(patients, eq(billingRecords.patientId, patients.id))
    .leftJoin(ccmTasks, eq(billingRecords.ccmTaskId, ccmTasks.id))
    .leftJoin(providers, eq(patients.providerId, providers.id))
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

/** In APCM without CCM: enrolled in APCM and consented to it (APCM is otherwise the CCM set). */
const apcmOnly = (p: { apcmEnrollmentStatus?: string | null; apcmConsentStatus?: string | null }) =>
  p.apcmEnrollmentStatus === "active" && p.apcmConsentStatus === "consented";

/** Generate monthly worklist tasks for all active patients lacking a task this month */
export async function generateMonthlyWorklist(month: string) {
  const db = await getDb();
  if (!db) return { created: 0 };

  // One task per (patient, month, program). Generate CCM tasks for CCM-active
  // patients and BHI tasks for BHI-active patients — a dual-enrolled patient gets
  // both, tracked independently.
  const existing = await db.select({ patientId: ccmTasks.patientId, program: ccmTasks.program }).from(ccmTasks).where(eq(ccmTasks.month, month));
  const has = new Set(existing.map((t) => `${t.patientId}:${t.program}`));

  const ccmPats = await db.select().from(patients).where(eq(patients.ccmEnrollmentStatus, "active"));
  const bhiPats = await db.select().from(patients).where(eq(patients.bhiEnrollmentStatus, "active"));
  // APCM covers the SAME active patients as CCM (mirror), plus anyone enrolled in APCM on their own
  // who consented to it (e.g. said Yes on their consent form). A completed CCM later suppresses that
  // month's APCM task (handled in recomputeBilling).
  const apcmOnly = await db.select().from(patients).where(and(eq(patients.apcmEnrollmentStatus, "active"), eq(patients.apcmConsentStatus, "consented")));
  const apcmPats = [...ccmPats, ...apcmOnly.filter((p) => p.ccmEnrollmentStatus !== "active")];

  const rows: (typeof ccmTasks.$inferInsert)[] = [];
  for (const p of ccmPats) {
    if (has.has(`${p.id}:ccm`)) continue;
    rows.push({ patientId: p.id, month, program: "ccm", assignedStaffId: p.assignedStaffId, priorityLevel: p.priorityLevel || p.riskLevel || "medium", status: p.assignedStaffId ? "assigned" : "not_started" });
  }
  for (const p of bhiPats) {
    if (has.has(`${p.id}:bhi`)) continue;
    rows.push({ patientId: p.id, month, program: "bhi", assignedStaffId: p.assignedStaffId, priorityLevel: p.priorityLevel || p.riskLevel || "medium", status: p.assignedStaffId ? "assigned" : "not_started" });
  }
  for (const p of apcmPats) {
    if (has.has(`${p.id}:apcm`)) continue;
    rows.push({ patientId: p.id, month, program: "apcm", assignedStaffId: p.assignedStaffId, priorityLevel: p.priorityLevel || p.riskLevel || "medium", status: p.assignedStaffId ? "assigned" : "not_started" });
  }
  if (!rows.length) return { created: 0 };

  await db.insert(ccmTasks).values(rows);
  return { created: rows.length };
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
export async function ensureMonthlyTask(patientId: number, month: string, program: "ccm" | "bhi" | "apcm" = "ccm") {
  const db = await getDb();
  if (!db) return;
  const patient = await getPatientById(patientId);
  if (!patient) return;

  // APCM mirrors CCM enrollment (same active patient set), plus consented APCM-only patients.
  const enrolled = program === "bhi" ? patient.bhiEnrollmentStatus === "active"
    : program === "apcm" ? patient.ccmEnrollmentStatus === "active" || apcmOnly(patient)
    : patient.ccmEnrollmentStatus === "active";

  const existing = await getCCMTaskByPatientAndMonth(patientId, month, program);
  if (existing) {
    // Reactivated patient: clear a stuck inactive/declined task so they return to
    // the worklist with a fresh status.
    if (enrolled && (existing.status === "inactive" || existing.status === "declined_ccm")) {
      await db
        .update(ccmTasks)
        .set({ status: patient.assignedStaffId ? "assigned" : "not_started", assignedStaffId: patient.assignedStaffId ?? null, updatedAt: new Date() })
        .where(eq(ccmTasks.id, existing.id));
      return;
    }
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

  // Only auto-create tasks for patients actively enrolled in this program.
  if (!enrolled) return;
  await db.insert(ccmTasks).values({
    patientId,
    month,
    program,
    assignedStaffId: patient.assignedStaffId ?? null,
    priorityLevel: (patient.priorityLevel || patient.riskLevel || "medium") as "high" | "medium" | "low",
    status: patient.assignedStaffId ? "assigned" : "not_started",
  });
}

/** Ensure this month's tasks exist for whichever programs the patient is enrolled in. */
export async function ensureMonthlyTasksForPatient(patientId: number, month: string) {
  await ensureMonthlyTask(patientId, month, "ccm");
  await ensureMonthlyTask(patientId, month, "bhi");
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
  // Workspace rows: schedule entries and tasks stay (they came from the PF schedule / staff work),
  // just unlinked from the removed roster record.
  await db.update(appointments).set({ patientId: null }).where(eq(appointments.patientId, patientId));
  await db.update(workTasks).set({ patientId: null }).where(eq(workTasks.patientId, patientId));
  await db.delete(opportunityActions).where(eq(opportunityActions.patientId, patientId));
  await db.delete(patients).where(eq(patients.id, patientId));
}

/** APCM complexity level → HCPCS G-code. */
export function apcmCptFor(level?: string | null): string {
  return level === "level_3" ? "G0558" : level === "level_2" ? "G0557" : "G0556";
}

/**
 * APCM complexity from chronic-condition count + QMB status:
 *   level_1 (G0556) = 1 chronic condition
 *   level_2 (G0557) = 2+ chronic conditions
 *   level_3 (G0558) = 2+ chronic conditions AND Qualified Medicare Beneficiary
 */
export function computeApcmLevel(conditionCount: number, isQMB: boolean, mirrorsCcm = true): "level_1" | "level_2" | "level_3" {
  // APCM mostly mirrors the CCM panel, and CCM eligibility REQUIRES 2+ chronic
  // conditions — so a CCM-mirrored APCM patient is at least Level 2 (G0557). QMB raises
  // them to Level 3 (G0558). We don't rely on the (often under-populated)
  // chronicConditions list for that floor.
  if (mirrorsCcm) return isQMB ? "level_3" : "level_2";
  // APCM-only patients (not in CCM) are leveled by their conditions on file: 0–1 = Level 1 (G0556).
  if (conditionCount < 2) return "level_1";
  return isQMB ? "level_3" : "level_2";
}

/** Recompute billing readiness for a task and upsert billing record */
export async function recomputeBilling(taskId: number, month: string) {
  const db = await getDb();
  if (!db) return;
  const task = await getCCMTaskById(taskId);
  if (!task) return;

  const isBhi = task.program === "bhi";
  const isApcm = task.program === "apcm";
  const docComplete = !!task.ccmNoteCompleted;
  const providerReviewDone = !task.providerReviewNeeded;
  const contacted = !!task.dateContacted || ["in_progress", "completed", "ready_for_billing", "billed"].includes(task.status as string);
  const timeMet = (task.timeSpentMinutes ?? 0) >= 20;

  // BHI (99484) and APCM (G0556-8) carry patient-level prerequisites beyond a
  // completed note. Load the patient to check them. Key difference: APCM is NOT
  // time-based (no 20-min rule) — it's a bundled service billed by complexity.
  const patient = await getPatientById(task.patientId);
  // CCM: a patient who declined CCM consent (e.g. said No on their consent form) must not be billed.
  // Only a recorded "declined" blocks it; "pending" is how most of the roster was imported. Patients
  // enrolled from a diagnosis-based program approval (ccmConsentRequired) bill only once they consent.
  const ccmConsentOk = isBhi || isApcm || (patient?.ccmConsentRequired ? patient?.consentStatus === "consented" : patient?.consentStatus !== "declined");
  const lastVisit = patient?.lastOfficeVisit ? new Date(patient.lastOfficeVisit) : null;
  const twelveMonthsAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const threeYearsAgo = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000);
  let consentObtained = true, initiatingVisitOnFile = true, carePlanDocumented = docComplete;
  if (isBhi) {
    consentObtained = patient?.bhiConsentStatus === "consented";
    initiatingVisitOnFile = !!(patient?.bhiInitiatingVisitDate || (lastVisit && lastVisit >= twelveMonthsAgo));
    carePlanDocumented = !!(patient?.bhiCarePlan && String(patient.bhiCarePlan).trim().length > 0);
  } else if (isApcm) {
    consentObtained = patient?.apcmConsentStatus === "consented";
    // APCM initiating visit: within 3 years (vs 12 months for BHI).
    initiatingVisitOnFile = !!(patient?.apcmInitiatingVisitDate || (lastVisit && lastVisit >= threeYearsAgo));
    carePlanDocumented = !!(patient?.apcmCarePlan && String(patient.apcmCarePlan).trim().length > 0);
  }

  let billingStatus:
    | "not_started" | "in_progress" | "documentation_incomplete"
    | "provider_review_pending" | "ready_for_billing" | "billed"
    | "denied" | "needs_correction" = "not_started";
  // APCM is SUPPRESSED for the month once the patient's CCM is completed — its task
  // is retired to "inactive" (see the CCM reconciliation below) and must not bill.
  const apcmSuppressed = isApcm && ["inactive", "cancelled", "declined_ccm"].includes(task.status as string);
  // Program readiness:
  //  • CCM  — completed note + provider review (+ the ≥20-min time gate above)
  //  • BHI  — every 99484 gate incl. the 20-min threshold
  //  • APCM — NON-time-based & AUTO-billing: consent + initiating visit + care plan
  //           on file, and NOT suppressed by a completed CCM this month. No note/
  //           time required — APCM is a monthly bundle, not a per-call service.
  const ready =
    isBhi ? (docComplete && providerReviewDone && timeMet && consentObtained && initiatingVisitOnFile && carePlanDocumented)
    : isApcm ? (!apcmSuppressed && consentObtained && initiatingVisitOnFile && carePlanDocumented)
    : (docComplete && providerReviewDone && ccmConsentOk);
  if (task.status === "billed") billingStatus = "billed";
  else if (isApcm && apcmSuppressed) billingStatus = "not_started"; // CCM billed this month → no APCM
  else if (ready) billingStatus = "ready_for_billing";
  else if (!ccmConsentOk && docComplete && providerReviewDone) billingStatus = "documentation_incomplete"; // CCM consent declined
  else if (isApcm) billingStatus = "documentation_incomplete"; // needs consent / initiating visit / care plan
  else if (isBhi && docComplete && providerReviewDone) billingStatus = "documentation_incomplete";
  else if (task.status === "documentation_incomplete") billingStatus = "documentation_incomplete";
  else if (task.providerReviewNeeded) billingStatus = "provider_review_pending";
  else if (contacted) billingStatus = "in_progress";

  const existing = await db.select().from(billingRecords).where(eq(billingRecords.ccmTaskId, taskId)).limit(1);
  const values = {
    ccmTaskId: taskId,
    patientId: task.patientId,
    month,
    program: task.program as "ccm" | "bhi" | "apcm",
    // CCM bills 99490, BHI 99484, APCM a complexity G-code (G0556/57/58).
    cptCode: isBhi ? "99484" : isApcm ? apcmCptFor(patient?.apcmLevel) : "99490",
    // APCM is not time-based, so the time gate never blocks it.
    timeThresholdMet: isApcm ? true : timeMet,
    documentationComplete: docComplete,
    providerAssociated: true,
    carePlanReviewed: carePlanDocumented,
    noMissingFields: docComplete,
    providerReviewCompleted: providerReviewDone,
    consentObtained,
    initiatingVisitOnFile,
    billingStatus,
  };
  if (existing.length) {
    await db.update(billingRecords).set(values).where(eq(billingRecords.id, existing[0].id));
  } else {
    await db.insert(billingRecords).values(values);
  }

  // keep task.billingReady in sync
  await db.update(ccmTasks).set({ billingReady: billingStatus === "ready_for_billing" }).where(eq(ccmTasks.id, taskId));

  // CCM-first / APCM-fallback reconciliation: a patient can never bill both CCM and
  // APCM in the same month. When their CCM is completed for the month, drop them off
  // APCM (retire the APCM task to "inactive"); if the CCM is reopened, restore APCM.
  if (task.program === "ccm") {
    const ccmDone = ["completed", "ready_for_billing", "billed"].includes(task.status as string);
    const apcmTask = await getCCMTaskByPatientAndMonth(task.patientId, month, "apcm");
    if (apcmTask) {
      if (ccmDone && !["inactive", "billed"].includes(apcmTask.status as string)) {
        await db.update(ccmTasks).set({ status: "inactive", updatedAt: new Date() }).where(eq(ccmTasks.id, apcmTask.id));
        await recomputeBilling(apcmTask.id, month);
      } else if (!ccmDone && apcmTask.status === "inactive") {
        const p = await getPatientById(task.patientId);
        if (p?.ccmEnrollmentStatus === "active") {
          await db.update(ccmTasks).set({ status: p.assignedStaffId ? "assigned" : "not_started", updatedAt: new Date() }).where(eq(ccmTasks.id, apcmTask.id));
          await recomputeBilling(apcmTask.id, month);
        }
      }
    }
  }
}

/** Create a notification */
export async function createNotification(n: {
  userId: number;
  type: "urgent_symptom" | "escalation" | "missing_documentation" | "not_reached" | "billing_ready" | "refill_request" | "refill_decision" | "task";
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
export async function setUserRole(userId: number, role: "admin" | "office_manager" | "staff" | "provider" | "billing" | "front_desk" | "medical_assistant" | "user") {
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
  role: "admin" | "office_manager" | "staff" | "provider" | "billing" | "front_desk" | "medical_assistant" | "user";
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

/**
 * Give a provider (providers row) their own secure login: creates or updates a users
 * row with role=provider + a password, and links providers.userId so the provider
 * portal can resolve the logged-in user back to their provider record + patients.
 */
export async function createProviderLogin(providerId: number, email: string, passwordHash: string): Promise<{ success: boolean; userId?: number; error?: string }> {
  const db = await getDb();
  if (!db) return { success: false, error: "Database not available" };
  const normEmail = email.trim().toLowerCase();
  const prov = await getProviderById(providerId);
  if (!prov) return { success: false, error: "Provider not found" };

  let userId: number;
  const existing = await db.select().from(users).where(eq(users.email, normEmail)).limit(1);
  if (existing.length) {
    const row = existing[0];
    const set: Record<string, unknown> = {
      role: "provider", name: prov.name, passwordHash, passwordSetAt: new Date(),
      mustChangePassword: true, loginMethod: "password", updatedAt: new Date(),
    };
    if (row.openId.startsWith(PENDING_PREFIX)) set.openId = `${LOCAL_PREFIX}${normEmail}`;
    await db.update(users).set(set as any).where(eq(users.id, row.id));
    userId = row.id;
  } else {
    const res: any = await db.insert(users).values({
      openId: `${LOCAL_PREFIX}${normEmail}`, email: normEmail, name: prov.name, role: "provider",
      loginMethod: "password", passwordHash, passwordSetAt: new Date(), mustChangePassword: true,
    });
    userId = res?.[0]?.insertId as number;
  }
  await db.update(providers).set({ userId }).where(eq(providers.id, providerId));
  return { success: true, userId };
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
  /** Behavioral Health Integration (BHI 99484) enrollment for this import row. */
  bhiEnroll?: boolean;
  bhiConditions?: string[];
  bhiConsentStatus?: "consented" | "pending" | "declined";
};

/**
 * Insert many patients in one batch. When `month` is given, also creates each
 * patient's worklist task for that month, carrying the per-row `worklistStatus`
 * (so an import preserves the status from the file). Returns inserted count.
 */
export async function bulkInsertPatients(rows: BulkPatientRow[], month?: string): Promise<number> {
  const db = await getDb();
  if (!db || rows.length === 0) return 0;
  // A row imported as "Deny CCM Care" / "Inactive" makes the patient declined/inactive,
  // so they land on the right tab and stay off the worklist (no task created).
  const enrollOf = (r: BulkPatientRow): "active" | "inactive" | "declined" | "transferred" =>
    r.worklistStatus === "declined_ccm" ? "declined" : r.worklistStatus === "inactive" ? "inactive" : (r.ccmEnrollmentStatus || "active");
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
    ccmEnrollmentStatus: enrollOf(r),
    consentStatus: r.consentStatus || "pending",
    rpmEnrolled: r.rpmEnrolled ?? false,
    rpmStatus: r.rpmStatus || (r.rpmEnrolled ? "enrolled" : "not_enrolled"),
    rpmDeviceType: r.rpmDeviceType,
    lastCalledAt: r.lastCalledAt ?? null,
    nextAppointment: r.nextAppointment ?? null,
    lastCCMDate: r.lastCCMDate ?? null,
    assignedStaffId: r.assignedStaffId ?? null,
    bhiEnrollmentStatus: (r.bhiEnroll ? "active" : "not_enrolled") as "active" | "not_enrolled",
    bhiConditions: r.bhiConditions || [],
    bhiConsentStatus: r.bhiConsentStatus || "pending",
  }));
  const res: any = await db.insert(patients).values(values);
  // A single multi-row INSERT yields consecutive auto-increment ids beginning at
  // insertId, so row i maps to patient id (firstId + i).
  const firstId = Number(res?.[0]?.insertId ?? 0);
  if (month && firstId > 0) {
    const taskValues = rows
      .map((r, i) => ({ r, i }))
      // Inactive/declined patients don't get a monthly worklist task.
      .filter(({ r }) => enrollOf(r) === "active")
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

    // Separately create BHI (99484) tasks for rows enrolled in BHI — independent of
    // the CCM enrollment above, so a patient can be imported into BHI, CCM, or both.
    const bhiTaskValues = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.bhiEnroll)
      .map(({ r, i }) => ({
        patientId: firstId + i,
        month,
        program: "bhi" as const,
        assignedStaffId: r.assignedStaffId ?? null,
        priorityLevel: "medium" as const,
        status: (r.assignedStaffId ? "assigned" : "not_started") as "assigned" | "not_started",
      }));
    if (bhiTaskValues.length) await db.insert(ccmTasks).values(bhiTaskValues);
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

/**
 * Enroll / update a patient's Behavioral Health Integration (BHI, CPT 99484)
 * status. Independent of CCM. Setting it active spins up this month's BHI worklist
 * task; setting it non-active retires the current BHI task off the worklist.
 */
export async function updatePatientBHI(
  patientId: number,
  data: {
    bhiEnrollmentStatus?: "not_enrolled" | "active" | "inactive" | "declined" | "transferred";
    bhiConditions?: string[];
    bhiConsentStatus?: "consented" | "pending" | "declined";
    bhiConsentDate?: Date | null;
    bhiInitiatingVisitDate?: Date | null;
    bhiCarePlan?: string | null;
    assignedStaffId?: number | null;
  },
  month: string
) {
  const db = await getDb();
  if (!db) return undefined;
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (data.bhiEnrollmentStatus !== undefined) patch.bhiEnrollmentStatus = data.bhiEnrollmentStatus;
  if (data.bhiConditions !== undefined) patch.bhiConditions = data.bhiConditions;
  if (data.bhiConsentStatus !== undefined) patch.bhiConsentStatus = data.bhiConsentStatus;
  if (data.bhiConsentDate !== undefined) patch.bhiConsentDate = data.bhiConsentDate;
  if (data.bhiInitiatingVisitDate !== undefined) patch.bhiInitiatingVisitDate = data.bhiInitiatingVisitDate;
  if (data.bhiCarePlan !== undefined) patch.bhiCarePlan = data.bhiCarePlan;
  // Allow assigning a coordinator at enrollment time (used by the BHI panel).
  if (data.assignedStaffId !== undefined) patch.assignedStaffId = data.assignedStaffId;
  await db.update(patients).set(patch as any).where(eq(patients.id, patientId));

  if (data.bhiEnrollmentStatus === "active") {
    // Create (or reactivate) this month's BHI task.
    await ensureMonthlyTask(patientId, month, "bhi");
  } else if (data.bhiEnrollmentStatus) {
    // Any non-active status: retire the current BHI task off the worklist.
    const task = await getCCMTaskByPatientAndMonth(patientId, month, "bhi");
    if (task && !["completed", "ready_for_billing", "billed"].includes(task.status as string)) {
      await db.update(ccmTasks)
        .set({ status: data.bhiEnrollmentStatus === "declined" ? "declined_ccm" : "inactive", updatedAt: new Date() })
        .where(eq(ccmTasks.id, task.id));
    }
  }
  // Consent / initiating-visit / care-plan changes affect 99484 billing eligibility,
  // so recompute this month's BHI billing record to reflect the new compliance state.
  const bhiTask = await getCCMTaskByPatientAndMonth(patientId, month, "bhi");
  if (bhiTask) await recomputeBilling(bhiTask.id, month);
  return getPatientById(patientId);
}

/**
 * Bulk-enroll existing patients in BHI (99484). Sets each to active, optionally
 * applies a shared set of behavioral conditions + consent, and creates this
 * month's BHI worklist task for each. Returns how many were enrolled.
 */
export async function bulkEnrollPatientsBHI(
  ids: number[],
  opts: { bhiConditions?: string[]; bhiConsentStatus?: "consented" | "pending" | "declined" },
  month: string
): Promise<number> {
  const db = await getDb();
  if (!db || ids.length === 0) return 0;
  const patch: Record<string, unknown> = { bhiEnrollmentStatus: "active", updatedAt: new Date() };
  if (opts.bhiConditions !== undefined) patch.bhiConditions = opts.bhiConditions;
  if (opts.bhiConsentStatus !== undefined) patch.bhiConsentStatus = opts.bhiConsentStatus;
  await db.update(patients).set(patch as any).where(inArray(patients.id, ids));
  // Create each patient's BHI task for the month (skips any that already have one).
  for (const id of ids) await ensureMonthlyTask(id, month, "bhi");
  return ids.length;
}

/**
 * Update a patient's APCM setup (QMB, consent, initiating visit, care plan). APCM
 * covers the SAME active patients as CCM automatically, so this does NOT toggle a
 * separate enrollment — it recomputes the complexity level and this month's APCM
 * billing readiness. A completed CCM suppresses APCM for the month (see
 * recomputeBilling), so the two never bill together.
 */
export async function updatePatientAPCM(
  patientId: number,
  data: {
    apcmEnrollmentStatus?: "not_enrolled" | "active" | "inactive" | "declined" | "transferred";
    isQMB?: boolean;
    apcmConsentStatus?: "consented" | "pending" | "declined";
    apcmConsentDate?: Date | null;
    apcmInitiatingVisitDate?: Date | null;
    apcmCarePlan?: string | null;
    assignedStaffId?: number | null;
  },
  month: string
) {
  const db = await getDb();
  if (!db) return undefined;
  const current = await getPatientById(patientId);
  if (!current) return undefined;

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (data.apcmEnrollmentStatus !== undefined) patch.apcmEnrollmentStatus = data.apcmEnrollmentStatus;
  if (data.isQMB !== undefined) patch.isQMB = data.isQMB;
  if (data.apcmConsentStatus !== undefined) patch.apcmConsentStatus = data.apcmConsentStatus;
  if (data.apcmConsentDate !== undefined) patch.apcmConsentDate = data.apcmConsentDate;
  if (data.apcmInitiatingVisitDate !== undefined) patch.apcmInitiatingVisitDate = data.apcmInitiatingVisitDate;
  if (data.apcmCarePlan !== undefined) patch.apcmCarePlan = data.apcmCarePlan;
  if (data.assignedStaffId !== undefined) patch.assignedStaffId = data.assignedStaffId;

  // Recompute complexity level from conditions + (possibly new) QMB status.
  const qmb = data.isQMB ?? (current.isQMB ?? false);
  // APCM-only patients are leveled by the chronic conditions the program rules recognize (conservative:
  // an unrecognized entry doesn't raise the level). CCM-mirrored patients keep the Level 2 floor.
  const conditionCount = countChronicConditions(((current.chronicConditions as string[]) || []).filter(Boolean));
  patch.apcmLevel = computeApcmLevel(conditionCount, !!qmb, current.ccmEnrollmentStatus === "active");

  await db.update(patients).set(patch as any).where(eq(patients.id, patientId));

  // APCM covers active CCM patients automatically (mirror). Ensure this month's APCM
  // task exists so its billing readiness tracks — but DON'T reactivate one that a
  // completed CCM suppressed (only the CCM reconciliation restores it).
  let apcmTask = await getCCMTaskByPatientAndMonth(patientId, month, "apcm");
  const after = { ...current, apcmEnrollmentStatus: data.apcmEnrollmentStatus ?? current.apcmEnrollmentStatus, apcmConsentStatus: data.apcmConsentStatus ?? current.apcmConsentStatus };
  if (!apcmTask && (current.ccmEnrollmentStatus === "active" || apcmOnly(after))) {
    await db.insert(ccmTasks).values({
      patientId, month, program: "apcm",
      assignedStaffId: current.assignedStaffId ?? null,
      priorityLevel: (current.priorityLevel || current.riskLevel || "medium") as "high" | "medium" | "low",
      status: current.assignedStaffId ? "assigned" : "not_started",
    });
    apcmTask = await getCCMTaskByPatientAndMonth(patientId, month, "apcm");
  }
  if (apcmTask) await recomputeBilling(apcmTask.id, month);
  return getPatientById(patientId);
}

/**
 * Bulk APCM setup for a set of patients (e.g. capture consent across a cohort).
 * Each is re-stratified from its own conditions/QMB. Returns how many were touched.
 */
export async function bulkEnrollAPCM(
  ids: number[],
  opts: { apcmConsentStatus?: "consented" | "pending" | "declined" },
  month: string
): Promise<number> {
  if (!ids.length) return 0;
  for (const id of ids) {
    await updatePatientAPCM(id, { apcmEnrollmentStatus: "active", apcmConsentStatus: opts.apcmConsentStatus }, month);
  }
  return ids.length;
}

/**
 * Bulk-apply the standard APCM care plan (personalized with each patient's name,
 * conditions, and provider) to active-CCM patients who don't have one yet. Bounded
 * per call to stay under the API-gateway timeout — returns how many were filled and
 * how many still remain, so the UI can apply the rest in another click.
 */
export async function applyStandardApcmCarePlan(opts: { limit?: number } = {}): Promise<{ applied: number; remaining: number }> {
  const db = await getDb();
  if (!db) return { applied: 0, remaining: 0 };
  const limit = Math.min(opts.limit ?? 400, 800);
  const missing = and(eq(patients.ccmEnrollmentStatus, "active"), sql`CHAR_LENGTH(COALESCE(${patients.apcmCarePlan}, '')) = 0`);
  const rows = await db
    .select({ id: patients.id, name: patients.name, chronicConditions: patients.chronicConditions, providerName: providers.name })
    .from(patients)
    .leftJoin(providers, eq(patients.providerId, providers.id))
    .where(missing)
    .limit(limit);
  for (const r of rows) {
    const plan = buildStandardApcmCarePlan({ name: r.name, conditions: (r.chronicConditions as string[]) || [], providerName: r.providerName });
    await db.update(patients).set({ apcmCarePlan: plan, updatedAt: new Date() }).where(eq(patients.id, r.id));
  }
  const [cnt] = await db.select({ c: sql<number>`COUNT(*)` }).from(patients).where(missing);
  return { applied: rows.length, remaining: Number(cnt?.c ?? 0) };
}

/** CCM task statuses that mean the month's CCM was completed. */
const CCM_DONE_STATUSES = ["completed", "ready_for_billing", "billed"] as const;
/** CCM task statuses that mean we reached out (called, left a message, talked, ...). */
const CCM_REACHED_STATUSES = ["called_no_answer", "voicemail_left", "wrong_number", "needs_callback", "in_progress", "completed", "needs_provider_review", "needs_appointment", "documentation_incomplete", "ready_for_billing", "billed", "unable_to_reach", "declined_ccm"] as const;

/**
 * APCM priority for a month (lower goes first): 1 = we completed a CCM with them this year,
 * 2 = we reached out this year but no CCM completed yet, 3 = not reached this year.
 * Patients whose CCM was completed THIS month bill CCM, not APCM (no tier).
 */
export function apcmPriority(r: { ccmDoneThisMonth: boolean; ccmCompletedThisYear: number; reachedThisYear: boolean }): 1 | 2 | 3 | null {
  if (r.ccmDoneThisMonth) return null;
  if (r.ccmCompletedThisYear > 0) return 1;
  return r.reachedThisYear ? 2 : 3;
}

/**
 * APCM management overview for a month: every APCM-covered patient (active CCM, APCM-only
 * consented, or anyone with an APCM task that month) with their complexity level,
 * consent/care-plan/visit setup, the month's APCM task + billing state, whether a completed
 * CCM takes the month, and their priority (completed a CCM this year first). Returns a
 * filtered/paginated page plus whole-panel stats.
 */
export async function getApcmOverview(
  month: string,
  filters: { category?: "ready" | "needs_setup" | "ccm_done"; priority?: 1 | 2 | 3; assignedStaffId?: number; search?: string; limit?: number; offset?: number } = {}
) {
  const db = await getDb();
  if (!db) return { rows: [], total: 0, stats: { total: 0, ready: 0, needsSetup: 0, ccmDone: 0, consented: 0, withCarePlan: 0, tier1: 0, tier2: 0, tier3: 0 } };
  const staffAlias = alias(users, "apcmStaff");
  const apcmT = alias(ccmTasks, "apcmOT");
  const ccmT = alias(ccmTasks, "apcmCT");
  const bill = alias(billingRecords, "apcmOB");
  // The CCM set (APCM mirrors it), APCM-only patients who consented to APCM, and (for past
  // months) anyone who had an APCM task that month even if they've left CCM since.
  const conds: any[] = [or(
    eq(patients.ccmEnrollmentStatus, "active"),
    and(eq(patients.apcmEnrollmentStatus, "active"), eq(patients.apcmConsentStatus, "consented")),
    and(sql`${apcmT.id} IS NOT NULL`, sql`${apcmT.status} NOT IN ('cancelled','declined_ccm')`),
  )];
  if (filters.assignedStaffId) conds.push(eq(patients.assignedStaffId, filters.assignedStaffId));

  const all = await db
    .select({
      id: patients.id,
      name: patients.name,
      dateOfBirth: patients.dateOfBirth,
      chronicConditions: patients.chronicConditions,
      isQMB: patients.isQMB,
      apcmLevel: patients.apcmLevel,
      apcmConsentStatus: patients.apcmConsentStatus,
      apcmInitiatingVisitDate: patients.apcmInitiatingVisitDate,
      lastOfficeVisit: patients.lastOfficeVisit,
      ccmEnrollmentStatus: patients.ccmEnrollmentStatus,
      carePlanLen: sql<number>`CHAR_LENGTH(COALESCE(${patients.apcmCarePlan}, ''))`,
      staffName: staffAlias.name,
      apcmStatus: apcmT.status,
      ccmStatus: ccmT.status,
      billingStatus: bill.billingStatus,
      cptCode: bill.cptCode,
    })
    .from(patients)
    .leftJoin(apcmT, and(eq(apcmT.patientId, patients.id), eq(apcmT.month, month), eq(apcmT.program, "apcm")))
    .leftJoin(ccmT, and(eq(ccmT.patientId, patients.id), eq(ccmT.month, month), eq(ccmT.program, "ccm")))
    .leftJoin(bill, and(eq(bill.patientId, patients.id), eq(bill.month, month), eq(bill.program, "apcm")))
    .leftJoin(staffAlias, eq(patients.assignedStaffId, staffAlias.id))
    .where(and(...conds))
    .orderBy(patients.name);

  // This year's CCM history up to and including the month: completed CCMs and any outreach.
  const year = month.slice(0, 4);
  const done = sql.join(CCM_DONE_STATUSES.map((x) => sql`${x}`), sql`, `);
  const reached = sql.join(CCM_REACHED_STATUSES.map((x) => sql`${x}`), sql`, `);
  const history = await db
    .select({
      patientId: ccmTasks.patientId,
      completed: sql<number>`SUM(CASE WHEN ${ccmTasks.status} IN (${done}) THEN 1 ELSE 0 END)`,
      lastCompleted: sql<string | null>`MAX(CASE WHEN ${ccmTasks.status} IN (${done}) THEN ${ccmTasks.month} END)`,
      reached: sql<number>`MAX(CASE WHEN ${ccmTasks.status} IN (${reached}) OR ${ccmTasks.dateContacted} IS NOT NULL OR ${ccmTasks.noAnswerCount} > 0 THEN 1 ELSE 0 END)`,
    })
    .from(ccmTasks)
    .where(and(eq(ccmTasks.program, "ccm"), gte(ccmTasks.month, `${year}-01`), lte(ccmTasks.month, month)))
    .groupBy(ccmTasks.patientId);
  const historyOf = new Map(history.map((h) => [h.patientId, h]));

  const threeYrs = Date.now() - 3 * 365 * 24 * 60 * 60 * 1000;
  const enrich = all.map((r) => {
    const hasCarePlan = (r.carePlanLen ?? 0) > 0;
    const consented = r.apcmConsentStatus === "consented";
    const hasVisit = !!(r.apcmInitiatingVisitDate || (r.lastOfficeVisit && new Date(r.lastOfficeVisit).getTime() >= threeYrs));
    // CCM completed this month → it bills CCM and APCM is suppressed.
    const ccmDone = r.apcmStatus === "inactive" || (CCM_DONE_STATUSES as readonly string[]).includes(r.ccmStatus ?? "");
    const ready = r.billingStatus === "ready_for_billing";
    const category: "ready" | "needs_setup" | "ccm_done" = ccmDone ? "ccm_done" : ready ? "ready" : "needs_setup";
    const h = historyOf.get(r.id);
    const ccmCompletedThisYear = Number(h?.completed ?? 0);
    const reachedThisYear = Number(h?.reached ?? 0) > 0;
    const priority = apcmPriority({ ccmDoneThisMonth: ccmDone, ccmCompletedThisYear, reachedThisYear });
    return { ...r, hasCarePlan, consented, hasVisit, category, ccmCompletedThisYear, lastCcmCompleted: h?.lastCompleted ?? null, reachedThisYear, priority };
  });
  // Completed a CCM this year first, then reached, then not reached; CCM-this-month last.
  enrich.sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || a.name.localeCompare(b.name));

  const stats = {
    total: enrich.length,
    ready: enrich.filter((r) => r.category === "ready").length,
    needsSetup: enrich.filter((r) => r.category === "needs_setup").length,
    ccmDone: enrich.filter((r) => r.category === "ccm_done").length,
    consented: enrich.filter((r) => r.consented).length,
    withCarePlan: enrich.filter((r) => r.hasCarePlan).length,
    tier1: enrich.filter((r) => r.priority === 1).length,
    tier2: enrich.filter((r) => r.priority === 2).length,
    tier3: enrich.filter((r) => r.priority === 3).length,
  };

  let filtered = enrich;
  if (filters.category) filtered = filtered.filter((r) => r.category === filters.category);
  if (filters.priority) filtered = filtered.filter((r) => r.priority === filters.priority);
  if (filters.search) { const s = filters.search.toLowerCase(); filtered = filtered.filter((r) => r.name.toLowerCase().includes(s)); }
  const total = filtered.length;
  const offset = filters.offset ?? 0;
  const limit = Math.min(filters.limit ?? 100, 2000);
  return { rows: filtered.slice(offset, offset + limit), total, stats };
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

// ---------------------------------------------------------------------------
// Medication refill requests (coordinator -> provider)
// ---------------------------------------------------------------------------

/** The provider row linked to a given user login (provider portal), if any. */
export async function getProviderByUserId(userId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(providers).where(eq(providers.userId, userId)).limit(1);
  return rows[0];
}

/** Create a refill request and notify the target provider's login (if they have one). */
export async function createRefillRequest(input: {
  patientId: number;
  providerId: number | null;
  requestedByUserId: number;
  ccmTaskId?: number | null;
  medications: { name: string; note?: string }[];
  note?: string;
}) {
  const db = await getDb();
  if (!db) return { id: 0 };
  const res: any = await db.insert(refillRequests).values({
    patientId: input.patientId,
    providerId: input.providerId ?? null,
    requestedByUserId: input.requestedByUserId,
    ccmTaskId: input.ccmTaskId ?? null,
    medications: input.medications,
    note: input.note ?? null,
    status: "pending",
  });
  const id = res?.[0]?.insertId as number | undefined;

  // Notify the provider's login, if the provider is linked to a user account.
  if (input.providerId) {
    const prov = await getProviderById(input.providerId);
    const patient = await getPatientById(input.patientId);
    if (prov?.userId) {
      const medNames = input.medications.map((m) => m.name).join(", ");
      await createNotification({
        userId: prov.userId,
        type: "refill_request",
        title: "New refill request",
        content: `${patient?.name ?? "A patient"} — ${medNames || "medication refill"}`,
        relatedPatientId: input.patientId,
      });
    }
  }
  return { id: id ?? 0 };
}

/** Refill requests routed to a provider (enriched), optionally filtered by status. */
export async function getRefillRequestsForProvider(providerId: number, status?: string) {
  const db = await getDb();
  if (!db) return [];
  const staffAlias = alias(users, "requester");
  const conditions = [eq(refillRequests.providerId, providerId)];
  if (status) conditions.push(eq(refillRequests.status, status as any));
  return db
    .select({ req: refillRequests, patient: patients, requesterName: staffAlias.name })
    .from(refillRequests)
    .innerJoin(patients, eq(refillRequests.patientId, patients.id))
    .leftJoin(staffAlias, eq(refillRequests.requestedByUserId, staffAlias.id))
    .where(and(...conditions))
    .orderBy(desc(refillRequests.createdAt));
}

/** All refill requests for a patient (for the patient page history). */
export async function getRefillRequestsForPatient(patientId: number) {
  const db = await getDb();
  if (!db) return [];
  const reqAlias = alias(users, "requester2");
  const decAlias = alias(users, "decider");
  return db
    .select({ req: refillRequests, requesterName: reqAlias.name, deciderName: decAlias.name })
    .from(refillRequests)
    .leftJoin(reqAlias, eq(refillRequests.requestedByUserId, reqAlias.id))
    .leftJoin(decAlias, eq(refillRequests.decidedByUserId, decAlias.id))
    .where(eq(refillRequests.patientId, patientId))
    .orderBy(desc(refillRequests.createdAt));
}

/** Count of a provider's pending refill requests (portal badge). */
export async function getPendingRefillCountForProvider(providerId: number) {
  const db = await getDb();
  if (!db) return 0;
  const r = await db.select({ c: sql<number>`COUNT(*)` }).from(refillRequests)
    .where(and(eq(refillRequests.providerId, providerId), eq(refillRequests.status, "pending")));
  return Number(r[0]?.c ?? 0);
}

/** Provider decides a refill request; notifies the coordinator who sent it.
 *  When mustBelongToProviderId is given, the request must be routed to that provider. */
export async function decideRefillRequest(id: number, decidedByUserId: number, status: "approved" | "schedule_visit" | "denied", providerNote?: string, mustBelongToProviderId?: number) {
  const db = await getDb();
  if (!db) return { success: false };
  const existing = await db.select().from(refillRequests).where(eq(refillRequests.id, id)).limit(1);
  const req = existing[0];
  if (!req) return { success: false };
  if (mustBelongToProviderId !== undefined && req.providerId !== mustBelongToProviderId) return { success: false };
  await db.update(refillRequests).set({
    status, providerNote: providerNote ?? null, decidedByUserId, decidedAt: new Date(), updatedAt: new Date(),
  }).where(eq(refillRequests.id, id));

  // Notify the coordinator who sent it.
  if (req.requestedByUserId) {
    const patient = await getPatientById(req.patientId);
    const label = status === "approved" ? "approved" : status === "schedule_visit" ? "marked for a visit" : "declined";
    await createNotification({
      userId: req.requestedByUserId,
      type: "refill_decision",
      title: `Refill ${label}`,
      content: `${patient?.name ?? "Patient"}: refill ${label}${providerNote ? ` — ${providerNote}` : ""}`,
      relatedPatientId: req.patientId,
    });
  }
  return { success: true };
}

// ============================================================================
// Reach Out — outbound appointment-scheduling call campaign (shared pool)
// ============================================================================

/** Paginated, filtered contact list. Un-called (and callback-requested) surface first
 *  so a coordinator working the shared pool always gets the next person to call. */
export async function getReachOutContacts(filters: {
  callStatus?: string; outcome?: string; search?: string; uncontactedOnly?: boolean; limit?: number; offset?: number;
} = {}) {
  const db = await getDb();
  if (!db) return { rows: [], total: 0 };
  const caller = alias(users, "roCaller");
  const conds: any[] = [];
  if (filters.uncontactedOnly) conds.push(eq(reachOutContacts.callStatus, "not_called"));
  else if (filters.callStatus) conds.push(eq(reachOutContacts.callStatus, filters.callStatus as any));
  if (filters.outcome) conds.push(eq(reachOutContacts.outcome, filters.outcome as any));
  if (filters.search) {
    const q = `%${filters.search}%`;
    conds.push(sql`(${reachOutContacts.name} LIKE ${q} OR ${reachOutContacts.phoneNumber} LIKE ${q})`);
  }
  const where = conds.length ? and(...conds) : undefined;
  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;

  const rows = await db
    .select({ c: reachOutContacts, callerName: caller.name })
    .from(reachOutContacts)
    .leftJoin(caller, eq(reachOutContacts.lastCalledByStaffId, caller.id))
    .where(where)
    .orderBy(
      // Callable contacts first: anyone WITH a phone before the phone-less (who can't
      // be dialed), then un-called before callbacks before already-worked, then id.
      sql`(${reachOutContacts.phoneNumber} = '' OR ${reachOutContacts.phoneNumber} IS NULL)`,
      sql`CASE ${reachOutContacts.callStatus} WHEN 'not_called' THEN 0 WHEN 'callback' THEN 1 ELSE 2 END`,
      reachOutContacts.id,
    )
    .limit(limit)
    .offset(offset);

  const [cnt] = await db.select({ n: sql<number>`count(*)` }).from(reachOutContacts).where(where);
  return { rows, total: Number(cnt?.n ?? 0) };
}

/** Campaign dashboard: totals, call-result & outcome breakdowns, per-caller productivity. */
export async function getReachOutStats() {
  const db = await getDb();
  if (!db) return null;
  const caller = alias(users, "roCaller2");
  const [agg] = await db
    .select({
      total: sql<number>`count(*)`,
      called: sql<number>`sum(${reachOutContacts.callStatus} <> 'not_called')`,
      reached: sql<number>`sum(${reachOutContacts.callStatus} = 'reached')`,
      noAnswer: sql<number>`sum(${reachOutContacts.callStatus} = 'no_answer')`,
      voicemail: sql<number>`sum(${reachOutContacts.callStatus} = 'voicemail')`,
      wrongNumber: sql<number>`sum(${reachOutContacts.callStatus} = 'wrong_number')`,
      callback: sql<number>`sum(${reachOutContacts.callStatus} = 'callback')`,
      doNotCall: sql<number>`sum(${reachOutContacts.callStatus} = 'do_not_call')`,
      wantsAppt: sql<number>`sum(${reachOutContacts.outcome} = 'wants_appointment')`,
      scheduled: sql<number>`sum(${reachOutContacts.outcome} = 'appointment_scheduled')`,
      alreadyScheduled: sql<number>`sum(${reachOutContacts.outcome} = 'already_scheduled')`,
      notInterested: sql<number>`sum(${reachOutContacts.outcome} = 'not_interested')`,
      declined: sql<number>`sum(${reachOutContacts.outcome} = 'declined')`,
    })
    .from(reachOutContacts);

  const byCaller = await db
    .select({
      name: caller.name,
      calls: sql<number>`count(*)`,
      reached: sql<number>`sum(${reachOutContacts.callStatus} = 'reached')`,
      scheduled: sql<number>`sum(${reachOutContacts.outcome} = 'appointment_scheduled')`,
    })
    .from(reachOutContacts)
    .innerJoin(caller, eq(reachOutContacts.lastCalledByStaffId, caller.id))
    .groupBy(caller.name)
    .orderBy(sql`count(*) DESC`);

  const num = (v: any) => Number(v ?? 0);
  return {
    total: num(agg?.total), called: num(agg?.called), reached: num(agg?.reached),
    noAnswer: num(agg?.noAnswer), voicemail: num(agg?.voicemail), wrongNumber: num(agg?.wrongNumber),
    callback: num(agg?.callback), doNotCall: num(agg?.doNotCall), wantsAppt: num(agg?.wantsAppt),
    scheduled: num(agg?.scheduled), alreadyScheduled: num(agg?.alreadyScheduled),
    notInterested: num(agg?.notInterested), declined: num(agg?.declined),
    byCaller: byCaller.map((r) => ({ name: r.name, calls: num(r.calls), reached: num(r.reached), scheduled: num(r.scheduled) })),
  };
}

/** Log a call attempt: set result + outcome, append a timestamped note, stamp caller, bump attempts. */
export async function logReachOutCall(input: {
  id: number; callStatus: string; outcome?: string; note?: string; staffId: number; staffName?: string | null;
}) {
  const db = await getDb();
  if (!db) return { success: false };
  const rows = await db.select().from(reachOutContacts).where(eq(reachOutContacts.id, input.id)).limit(1);
  const c = rows[0];
  if (!c) return { success: false };
  let notes = c.notes ?? "";
  if (input.note && input.note.trim()) {
    const stamp = `${new Date().toISOString().slice(0, 10)}${input.staffName ? " · " + input.staffName : ""}`;
    notes = `${notes ? notes + "\n" : ""}[${stamp}] ${input.note.trim()}`;
  }
  await db.update(reachOutContacts).set({
    callStatus: input.callStatus as any,
    outcome: (input.outcome ?? c.outcome) as any,
    notes,
    attempts: (c.attempts ?? 0) + 1,
    lastCalledAt: new Date(),
    lastCalledByStaffId: input.staffId,
    updatedAt: new Date(),
  }).where(eq(reachOutContacts.id, input.id));
  return { success: true };
}

/** Bulk import the campaign list (chunked). */
export async function bulkInsertReachOut(
  rows: { name: string; phoneNumber: string; dateOfBirth?: Date | null; insurance?: string | null; language?: string | null }[],
  campaign = "insurance-outreach",
): Promise<number> {
  const db = await getDb();
  if (!db || !rows.length) return 0;
  let n = 0;
  const chunk = 200;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk).map((r) => ({
      name: r.name, phoneNumber: r.phoneNumber || "", dateOfBirth: r.dateOfBirth ?? null,
      insurance: r.insurance ?? null, language: r.language ?? null, campaign,
    }));
    await db.insert(reachOutContacts).values(slice);
    n += slice.length;
  }
  return n;
}

export async function deleteReachOutContact(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(reachOutContacts).where(eq(reachOutContacts.id, id));
}

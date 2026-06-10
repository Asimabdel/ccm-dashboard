import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
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
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
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

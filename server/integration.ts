import type { Express, Request, Response } from "express";
import { createHash, timingSafeEqual } from "crypto";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { ENV } from "./_core/env";
import { getDb, getCompletionReport, writeAuditLog, type ReportDimension } from "./db";
import { patients, providers, clinics } from "../drizzle/schema";

/**
 * Read-only integration API consumed by the SEPARATE "Clinic Command Center" app.
 *
 * The command center pulls CCM/RPM *numbers* (aggregate completions + minimal
 * per-patient linkage) from this CCM site automatically. To keep the two systems
 * decoupled and HIPAA minimum-necessary:
 *   - Machine-to-machine auth via a shared secret in the `x-api-key` header,
 *     compared in constant time. No user session is involved.
 *   - Strictly read-only. No clinical notes/symptoms ever leave — only enrollment
 *     status, counts, and the dates the command center needs to match records.
 *   - Every call is written to the HIPAA audit log as an `export_data` event.
 *
 * Mounted in server/_core/app.ts via registerIntegrationRoutes(app).
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Constant-time secret comparison that tolerates differing lengths. */
export function secretsMatch(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Guard: require a valid x-api-key. Returns the client label on success, or null
 * after having already sent the appropriate error response.
 */
function authorize(req: Request, res: Response): string | null {
  if (!ENV.integrationApiKey) {
    res.status(503).json({ error: "Integration API is not configured on this server." });
    return null;
  }
  const provided = (req.headers["x-api-key"] as string | undefined) ?? "";
  if (!provided || !secretsMatch(provided, ENV.integrationApiKey)) {
    res.status(401).json({ error: "Invalid or missing API key." });
    return null;
  }
  return "integration";
}

/** Parse an ISO date (YYYY-MM-DD) or unix-ms string into a Date, or undefined. */
export function parseWhen(raw: unknown): Date | undefined {
  if (raw == null || raw === "") return undefined;
  const s = String(raw);
  if (/^\d+$/.test(s)) {
    const ms = Number(s);
    return Number.isFinite(ms) ? new Date(ms) : undefined;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

const VALID_DIMENSIONS: ReportDimension[] = ["date", "week", "provider", "employee", "clinic"];

export function parseGroupBy(raw: unknown): ReportDimension[] {
  const list = String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ReportDimension => (VALID_DIMENSIONS as string[]).includes(s));
  return list.length ? Array.from(new Set(list)).slice(0, 3) : ["provider"];
}

function ip(req: Request): string | null {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null;
}

export function registerIntegrationRoutes(app: Express) {
  // Liveness/connectivity check. Still requires the key so we don't advertise the
  // endpoint to unauthenticated callers.
  app.get("/api/integration/health", (req, res) => {
    if (!authorize(req, res)) return;
    res.json({ ok: true, app: "ccm-dashboard", time: new Date().toISOString() });
  });

  /**
   * Aggregate CCM numbers for a date range.
   * Query: from, to (ISO or unix ms), groupBy (csv of date|week|provider|employee|clinic).
   */
  app.get("/api/integration/ccm/summary", async (req, res) => {
    if (!authorize(req, res)) return;
    try {
      const db = await getDb();
      if (!db) {
        res.status(503).json({ error: "Database unavailable." });
        return;
      }

      const to = parseWhen(req.query.to) ?? new Date();
      const from = parseWhen(req.query.from) ?? new Date(to.getTime() - 30 * ONE_DAY_MS);
      const groupBy = parseGroupBy(req.query.groupBy);

      const completions = await getCompletionReport({
        groupBy,
        from: from.getTime(),
        to: to.getTime(),
      });

      // Current enrollment snapshot (point-in-time counts).
      const [activeRow] = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(patients)
        .where(eq(patients.ccmEnrollmentStatus, "active"));
      const [rpmRow] = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(patients)
        .where(eq(patients.rpmEnrolled, true));

      // Best-effort "new in range" using patient creation date (the CCM app does not
      // store a dedicated enrollment date yet). Documented as a proxy for the consumer.
      const [newCcmRow] = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(patients)
        .where(
          and(
            eq(patients.ccmEnrollmentStatus, "active"),
            gte(patients.createdAt, from),
            lte(patients.createdAt, to)
          )
        );
      const [newRpmRow] = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(patients)
        .where(
          and(eq(patients.rpmEnrolled, true), gte(patients.createdAt, from), lte(patients.createdAt, to))
        );

      void writeAuditLog({
        userId: null,
        userName: "integration",
        userRole: "integration",
        action: "export_data",
        entityType: "ccm_summary",
        description: `Integration pulled CCM summary ${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)} groupBy=${groupBy.join("+")}`,
        ipAddress: ip(req),
      });

      res.json({
        range: { from: from.toISOString(), to: to.toISOString() },
        completions: {
          groupBy,
          rows: completions,
          total: completions.reduce((s, r) => s + r.count, 0),
        },
        totals: {
          ccmActive: activeRow?.c ?? 0,
          rpmEnrolled: rpmRow?.c ?? 0,
        },
        newInRange: {
          ccm: newCcmRow?.c ?? 0,
          rpm: newRpmRow?.c ?? 0,
          basis: "patient.createdAt (proxy; CCM app has no dedicated enrollment date)",
        },
      });
    } catch (err) {
      console.error("[Integration] summary failed:", err);
      res.status(500).json({ error: "Failed to build CCM summary." });
    }
  });

  /**
   * Minimal per-patient linkage so the command center can match CCM/RPM status to
   * its own patient/finance records. No clinical content is included.
   * Query: limit (default 5000, max 20000).
   */
  app.get("/api/integration/ccm/patients", async (req, res) => {
    if (!authorize(req, res)) return;
    try {
      const db = await getDb();
      if (!db) {
        res.status(503).json({ error: "Database unavailable." });
        return;
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 5000, 1), 20000);

      const rows = await db
        .select({
          name: patients.name,
          dateOfBirth: patients.dateOfBirth,
          clinicName: clinics.name,
          clinicLocation: clinics.location,
          providerName: providers.name,
          ccmEnrollmentStatus: patients.ccmEnrollmentStatus,
          rpmEnrolled: patients.rpmEnrolled,
          rpmStatus: patients.rpmStatus,
          rpmDeviceType: patients.rpmDeviceType,
          lastCalledAt: patients.lastCalledAt,
          lastCCMDate: patients.lastCCMDate,
          nextAppointment: patients.nextAppointment,
          lastOfficeVisit: patients.lastOfficeVisit,
        })
        .from(patients)
        .leftJoin(clinics, eq(patients.clinicId, clinics.id))
        .leftJoin(providers, eq(patients.providerId, providers.id))
        .limit(limit);

      void writeAuditLog({
        userId: null,
        userName: "integration",
        userRole: "integration",
        action: "export_data",
        entityType: "ccm_patient_link",
        description: `Integration pulled ${rows.length} CCM patient linkage rows`,
        ipAddress: ip(req),
      });

      res.json({ count: rows.length, patients: rows });
    } catch (err) {
      console.error("[Integration] patients failed:", err);
      res.status(500).json({ error: "Failed to list CCM patients." });
    }
  });
}

import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { hashPassword, verifyPassword, validatePasswordStrength } from "./password";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, and, ne, sql } from "drizzle-orm";
import {
  getPatientById,
  getCCMTaskById,
  getCCMNoteByTaskId,
  getAllClinics,
  getProvidersByClinic,
  getProviderById,
  // enriched + aggregate
  getWorklistForMonth,
  getEnrichedPatients,
  getPatientDetail,
  getAdminStats,
  getCompletionReport,
  getStaffPerformance,
  getClinicPerformance,
  getDailyCompletionTrend,
  getMonthlyCompletionTrend,
  getProviderPerformance,
  getCoordinatorDashboard,
  getCoordinatorGoalsOverview,
  setMonthlyGoal,
  setWorkDays,
  getEnrichedEscalations,
  getEnrichedBilling,
  getEnrichedFollowUps,
  getStaffWorkload,
  getAllStaffUsers,
  getAllProviders,
  generateMonthlyWorklist,
  ensureMonthlyWorklistGenerated,
  recomputeBilling,
  createNotification,
  markNotificationRead,
  getAllNotifications,
  getUnreadNotifications,
  getFirstUserByRole,
  setUserRole,
  getAllUsers,
  createMember,
  getUserByEmail,
  getUserByOpenId,
  setUserPassword,
  sanitizeUser,
  getLockoutRemaining,
  recordFailedLogin,
  clearLoginAttempts,
  getDb,
  writeAuditLog,
  getAuditLogs,
  getDuplicateNameGroups,
  bulkInsertPatients,
  findExistingByNames,
  updatePatientRPM,
  updatePatientBHI,
  bulkEnrollPatientsBHI,
  updatePatientAPCM,
  bulkEnrollAPCM,
  normalizeName,
} from "./db";
import {
  patients,
  ccmTasks,
  ccmNotes,
  providerEscalations,
  followUpItems,
  billingRecords,
  users,
} from "../drizzle/schema";
import { ccmNotesRouter } from "./routers/ccmNotes";
import { workforceRouter } from "./routers/workforce";
import { workspaceRouter } from "./routers/workspace";
import { seedDatabase, isSeeded, currentMonth } from "./seed";
import { ensureMonthlyTask, ensureMonthlyTasksForPatient, deletePatient, getUpcomingAppointments } from "./db";
import {
  getProviderByUserId, createRefillRequest, getRefillRequestsForProvider,
  getRefillRequestsForPatient, getPendingRefillCountForProvider, decideRefillRequest,
  createProviderLogin,
} from "./db";
import {
  getReachOutContacts, getReachOutStats, logReachOutCall, bulkInsertReachOut, deleteReachOutContact,
} from "./db";
import { getApcmOverview, applyStandardApcmCarePlan } from "./db";
import { parsePatientCsv, findInBatchDuplicates, matchProviderId, matchWorklistStatus } from "../shared/csvImport";
import { clinics, providers, appointments, workTasks } from "../drizzle/schema";

// ---- Role guards ----
function requireRole(ctx: any, roles: string[]) {
  if (!ctx.user || !roles.includes(ctx.user.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this resource." });
  }
}

/** Fire-and-forget HIPAA audit logging from a tRPC context. */
function logAudit(
  ctx: any,
  action: string,
  opts: { entityType?: string; entityId?: number; description?: string } = {}
) {
  return writeAuditLog({
    userId: ctx.user?.id,
    userName: ctx.user?.name ?? null,
    userRole: ctx.user?.role ?? null,
    action: action as any,
    entityType: opts.entityType,
    entityId: opts.entityId,
    description: opts.description,
    ipAddress: (ctx.req?.headers?.["x-forwarded-for"] as string)?.split(",")[0] || ctx.req?.ip || null,
  });
}

const statusEnum = z.enum([
  "not_started", "assigned", "called_no_answer", "voicemail_left", "wrong_number",
  "needs_callback", "in_progress", "completed", "needs_provider_review",
  "needs_appointment", "documentation_incomplete", "ready_for_billing", "billed",
  "cancelled", "unable_to_reach", "declined_ccm", "inactive",
]);
const roleEnum = z.enum(["admin", "staff", "provider", "billing", "front_desk", "medical_assistant", "user"]);

// Statuses that mean the patient was actually called this cycle — these stamp the
// patient's "Last Called" date automatically.
const CONTACTED_STATUSES = [
  "in_progress", "completed", "called_no_answer", "voicemail_left",
  "needs_provider_review", "needs_appointment", "documentation_incomplete",
  "ready_for_billing", "billed",
];

// Minimal CSV parser for the Reach Out import: flexible headers (name or first/last,
// any phone column, optional DOB/insurance/language). Handles quoted fields + commas.
function parseReachOutCsv(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (q) {
      if (ch === '"') { if (csv[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iName = idx("name", "patient", "patient name", "full name");
  const iFirst = idx("first name", "firstname", "first");
  const iLast = idx("last name", "lastname", "last");
  const iPhone = idx("phone", "phonenumber", "phone number", "mobile phone", "mobile", "cell", "cell phone", "home phone");
  const iDob = idx("dob", "date of birth", "dateofbirth", "birthdate");
  const iIns = idx("insurance", "plan", "payer", "carrier");
  const iLang = idx("language", "preferred language", "preferredlanguage");
  const out: { name: string; phoneNumber: string; dateOfBirth: Date | null; insurance: string | null; language: string | null }[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    if (!cols || cols.every((c) => !c || !c.trim())) continue;
    const at = (i: number) => (i >= 0 ? (cols[i] ?? "").trim() : "");
    const name = iName >= 0 ? at(iName) : `${at(iFirst)} ${at(iLast)}`.replace(/\s+/g, " ").trim();
    const phone = at(iPhone);
    if (!name && !phone) continue;
    let dob: Date | null = null;
    const dRaw = at(iDob);
    if (dRaw) { const m = dRaw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); if (m) { let [, mo, d, y] = m; if (y.length === 2) y = (Number(y) > 30 ? "19" : "20") + y; const dt = new Date(`${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00Z`); if (!isNaN(+dt)) dob = dt; } }
    out.push({ name: name.slice(0, 255), phoneNumber: phone.slice(0, 20), dateOfBirth: dob, insurance: (at(iIns) || null)?.slice(0, 255) ?? null, language: (at(iLang) || null)?.slice(0, 50) ?? null });
  }
  return out;
}

const reachCallStatusEnum = z.enum(["not_called", "no_answer", "voicemail", "wrong_number", "callback", "reached", "do_not_call"]);
const reachOutcomeEnum = z.enum(["pending", "wants_appointment", "appointment_scheduled", "already_scheduled", "not_interested", "declined"]);

export const appRouter = router({
  system: systemRouter,
  ccmNotesAI: ccmNotesRouter,
  workforce: workforceRouter,
  workspace: workspaceRouter,

  auth: router({
    me: publicProcedure.query((opts) => sanitizeUser(opts.ctx.user)),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, cookieOptions);
      return { success: true } as const;
    }),
    // Admin-only role switcher so the owner/admin can preview every role-based
    // dashboard. Regular workers CANNOT self-escalate â€” their role is assigned
    // by an admin via the Team / Access page (users.setRole).
    setRole: protectedProcedure
      .input(z.object({ role: z.enum(["admin", "staff", "provider", "billing", "front_desk"]) }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        await setUserRole(ctx.user.id, input.role);
        void logAudit(ctx, "manage_access", { description: `Admin previewed role: ${input.role}` });
        return { success: true, role: input.role };
      }),

    // Email + password sign-in for admin-created worker logins. Issues the same
    // JWT session cookie as the Manus OAuth flow so the rest of the app is unchanged.
    passwordLogin: publicProcedure
      .input(z.object({ email: z.string().email(), password: z.string().min(1) }))
      .mutation(async ({ input, ctx }) => {
        const genericError = new TRPCError({ code: "UNAUTHORIZED", message: "Incorrect email or password." });
        const idKey = input.email.trim().toLowerCase();
        // Brute-force protection: lock the account+IP identifier after repeated failures.
        const lockMs = getLockoutRemaining(idKey);
        if (lockMs > 0) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: `Too many failed attempts. Try again in ${Math.ceil(lockMs / 60000)} minute(s).`,
          });
        }
        const user = await getUserByEmail(input.email);
        if (!user || !user.passwordHash) {
          recordFailedLogin(idKey);
          throw genericError;
        }
        const ok = await verifyPassword(input.password, user.passwordHash);
        if (!ok) {
          recordFailedLogin(idKey);
          void logAudit({ user }, "login_failed", { entityType: "user", entityId: user.id, description: `Failed password login: ${user.email}` });
          throw genericError;
        }
        clearLoginAttempts(idKey);
        const sessionToken = await sdk.createSessionToken(user.openId, {
          name: user.name || user.email || "",
          expiresInMs: ONE_YEAR_MS,
        });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
        void logAudit({ user }, "login", { entityType: "user", entityId: user.id, description: `Password login: ${user.email}` });
        return { success: true, mustChangePassword: !!user.mustChangePassword };
      }),

    // Self-service password change. Workers with mustChangePassword set are forced here on first login.
    changePassword: protectedProcedure
      .input(z.object({ currentPassword: z.string().optional(), newPassword: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const strengthError = validatePasswordStrength(input.newPassword);
        if (strengthError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: strengthError });
        }
        // Re-fetch the full user row (ctx.user may be a trimmed projection in some flows).
        const fresh = await getUserByOpenId(ctx.user.openId);
        if (!fresh) {
          throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
        }
        // If the user already has a password and is NOT being forced to change it,
        // require the current password to confirm identity.
        if (fresh.passwordHash && !fresh.mustChangePassword) {
          const ok = await verifyPassword(input.currentPassword ?? "", fresh.passwordHash);
          if (!ok) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Your current password is incorrect." });
          }
        }
        const newHash = await hashPassword(input.newPassword);
        await setUserPassword(fresh.id, newHash, false);
        void logAudit(ctx, "change_password", { entityType: "user", entityId: fresh.id, description: `Changed own password` });
        return { success: true };
      }),
  }),

  // ---- Admin: worker access management (RBAC) ----
  users: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      requireRole(ctx, ["admin"]);
      // getAllUsers() already projects out credential fields (no passwordHash).
      return getAllUsers();
    }),
    setRole: protectedProcedure
      .input(z.object({ userId: z.number(), role: roleEnum }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        // Prevent an admin from accidentally removing their own admin access (lockout guard).
        if (input.userId === ctx.user.id && input.role !== "admin") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot change your own admin role. Ask another admin to do this." });
        }
        await setUserRole(input.userId, input.role);
        void logAudit(ctx, "manage_access", { entityType: "user", entityId: input.userId, description: `Set user #${input.userId} role to ${input.role}` });
        return { success: true };
      }),
    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          email: z.string().email().optional(),
          role: roleEnum,
          clinicLocation: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { id, ...updateData } = input;
        const set: Record<string, unknown> = { ...updateData, updatedAt: new Date() };
        if (updateData.email) {
          // Password sign-in looks emails up lowercased, so store them that way.
          const email = updateData.email.trim().toLowerCase();
          const [taken] = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.email, email), ne(users.id, id))).limit(1);
          if (taken) throw new TRPCError({ code: "BAD_REQUEST", message: `That email is already used by ${taken.name ?? "another account"}.` });
          set.email = email;
          // A roster-only employee getting their first login becomes a regular local account.
          const [row] = await db.select({ openId: users.openId }).from(users).where(eq(users.id, id)).limit(1);
          if (row?.openId.startsWith("roster:")) set.openId = `local:${email}`;
        }
        await db.update(users).set(set).where(eq(users.id, id));
        void logAudit(ctx, "manage_access", { entityType: "user", entityId: id, description: `Updated user #${id}` });
        return { success: true };
      }),
    remove: protectedProcedure
      .input(z.number())
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        if (input === ctx.user.id) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot remove your own admin account." });
        }
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.update(users).set({ role: "user", clinicLocation: null, updatedAt: new Date() }).where(eq(users.id, input));
        void logAudit(ctx, "manage_access", { entityType: "user", entityId: input, description: `Removed access for user #${input}` });
        return { success: true };
      }),
    // Admin sets/resets a worker's password. Worker must change it on next login.
    resetPassword: protectedProcedure
      .input(z.object({ userId: z.number(), password: z.string() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        const strengthError = validatePasswordStrength(input.password);
        if (strengthError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: strengthError });
        }
        const newHash = await hashPassword(input.password);
        await setUserPassword(input.userId, newHash, true);
        void logAudit(ctx, "reset_password", { entityType: "user", entityId: input.userId, description: `Admin reset password for user #${input.userId}` });
        return { success: true };
      }),
  }),

  // ---- Admin: create worker logins directly (no email invites) ----
  members: router({
    // Create a login for a worker by email + role. They sign in with Manus OAuth
    // using that email and inherit the assigned role automatically.
    create: protectedProcedure
      .input(z.object({
        email: z.string().email(),
        name: z.string().optional(),
        role: roleEnum,
        clinicLocation: z.string().optional(),
        password: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        let passwordHash: string | null = null;
        if (input.password && input.password.length > 0) {
          const strengthError = validatePasswordStrength(input.password);
          if (strengthError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: strengthError });
          }
          passwordHash = await hashPassword(input.password);
        }
        const result = await createMember({
          email: input.email,
          name: input.name ?? null,
          role: input.role,
          clinicLocation: input.clinicLocation ?? null,
          passwordHash,
        });
        void logAudit(ctx, "manage_access", { entityType: "user", description: `Created login for ${input.email} (${input.role})${passwordHash ? " with password" : ""}` });
        return { success: true, created: result.created, pending: result.pending };
      }),
  }),

  // ---- Admin: seed + system ----
  admin: router({
    seedStatus: protectedProcedure.query(async () => {
      return { seeded: await isSeeded(), month: currentMonth() };
    }),
    seed: protectedProcedure.mutation(async ({ ctx }) => {
      requireRole(ctx, ["admin"]);
      const summary = await seedDatabase(ctx.user.openId);
      return summary;
    }),
    stats: protectedProcedure
      .input(z.object({ month: z.string().optional(), program: z.enum(["ccm", "bhi", "apcm"]).optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        return getAdminStats(input?.month || currentMonth(), input?.program);
      }),
    staffPerformance: protectedProcedure
      .input(z.object({ month: z.string() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        return getStaffPerformance(input?.month || currentMonth());
      }),
    clinicPerformance: protectedProcedure
      .input(z.object({ month: z.string() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        return getClinicPerformance(input?.month || currentMonth());
      }),
    dailyTrend: protectedProcedure
      .input(z.object({ month: z.string() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        return getDailyCompletionTrend(input?.month || currentMonth());
      }),
    upcomingAppointments: protectedProcedure.query(async ({ ctx }) => {
      requireRole(ctx, ["admin", "staff", "front_desk", "provider", "billing"]);
      return getUpcomingAppointments(8);
    }),
  }),

  // ---- Patients ----
  patients: router({
    list: protectedProcedure
      .input(
        z.object({
          clinicId: z.number().optional(),
          providerId: z.number().optional(),
          enrollmentStatus: z.string().optional(),
          assignedStaffId: z.number().optional(),
          search: z.string().optional(),
        }).optional()
      )
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "provider", "billing", "front_desk"]);
        void logAudit(ctx, "list_patients", { entityType: "patient", description: "Viewed patient list" });
        return getEnrichedPatients(input || {});
      }),

    /** Map of normalized name -> { ids, sameDob } for duplicate flagging in the UI. */
    duplicates: protectedProcedure.query(async ({ ctx }) => {
      requireRole(ctx, ["admin", "staff", "provider", "billing", "front_desk"]);
      return getDuplicateNameGroups();
    }),

    detail: protectedProcedure
      .input(z.number())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "provider", "billing", "front_desk"]);
        void logAudit(ctx, "view_patient", { entityType: "patient", entityId: input, description: `Viewed patient #${input}` });
        return getPatientDetail(input);
      }),

    getById: protectedProcedure.input(z.number()).query(async ({ input }) => getPatientById(input)),

    create: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          dateOfBirth: z.date().optional(),
          phoneNumber: z.string().min(1),
          clinicId: z.number().optional(),
          providerId: z.number(),
          preferredLanguage: z.string().optional(),
          chronicConditions: z.array(z.string()).optional(),
          insurance: z.string().optional(),
          consentStatus: z.enum(["consented", "pending", "declined"]).optional(),
          assignedStaffId: z.number().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "front_desk"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const res: any = await db.insert(patients).values({
          name: input.name,
          dateOfBirth: input.dateOfBirth,
          phoneNumber: input.phoneNumber,
          clinicId: input.clinicId,
          providerId: input.providerId,
          preferredLanguage: input.preferredLanguage || "English",
          chronicConditions: input.chronicConditions || [],
          insurance: input.insurance,
          ccmEnrollmentStatus: "active",
          consentStatus: input.consentStatus || "pending",
          assignedStaffId: input.assignedStaffId,
        });
        const newId = res?.[0]?.insertId as number | undefined;
        // Create this month's CCM task so the patient appears on the worklist now
        // (assigned to the chosen staff member, if any).
        if (newId) await ensureMonthlyTask(Number(newId), currentMonth());
        void logAudit(ctx, "create_patient", { entityType: "patient", entityId: newId, description: `Created patient "${input.name}"` });
        return { success: true, id: newId };
      }),

    /** Update RPM enrollment fields for a single patient. */
    updateRPM: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          rpmEnrolled: z.boolean().optional(),
          rpmStatus: z.enum(["not_enrolled", "eligible", "enrolled", "active", "declined", "inactive"]).optional(),
          rpmDeviceType: z.string().nullable().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "front_desk"]);
        const { id, ...data } = input;
        const result = await updatePatientRPM(id, data);
        void logAudit(ctx, "update_rpm", { entityType: "patient", entityId: id, description: `Updated RPM for patient #${id}` });
        return result;
      }),

    /** Enroll / update a patient's Behavioral Health Integration (BHI 99484) status. */
    updateBHI: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          bhiEnrollmentStatus: z.enum(["not_enrolled", "active", "inactive", "declined", "transferred"]).optional(),
          bhiConditions: z.array(z.string()).optional(),
          bhiConsentStatus: z.enum(["consented", "pending", "declined"]).optional(),
          bhiConsentDate: z.date().nullable().optional(),
          bhiInitiatingVisitDate: z.date().nullable().optional(),
          bhiCarePlan: z.string().nullable().optional(),
          assignedStaffId: z.number().nullable().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "front_desk"]);
        const { id, ...data } = input;
        const result = await updatePatientBHI(id, data, currentMonth());
        void logAudit(ctx, "update_patient", { entityType: "patient", entityId: id, description: `Updated BHI enrollment for patient #${id}` });
        return result;
      }),

    /** Bulk-enroll a set of existing patients in BHI (99484). */
    bulkEnrollBHI: protectedProcedure
      .input(
        z.object({
          ids: z.array(z.number()).min(1),
          bhiConditions: z.array(z.string()).optional(),
          bhiConsentStatus: z.enum(["consented", "pending", "declined"]).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "front_desk"]);
        const count = await bulkEnrollPatientsBHI(input.ids, { bhiConditions: input.bhiConditions, bhiConsentStatus: input.bhiConsentStatus }, currentMonth());
        void logAudit(ctx, "update_patient", { entityType: "patient", description: `Bulk-enrolled ${count} patients in BHI` });
        return { success: true, count };
      }),

    /** Enroll/update a patient in APCM (G0556/57/58). Auto-stratifies by complexity
     *  and enforces CCM mutual-exclusivity (enrolling APCM takes them off CCM). */
    updateAPCM: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          apcmEnrollmentStatus: z.enum(["not_enrolled", "active", "inactive", "declined", "transferred"]).optional(),
          isQMB: z.boolean().optional(),
          apcmConsentStatus: z.enum(["consented", "pending", "declined"]).optional(),
          apcmConsentDate: z.date().nullable().optional(),
          apcmInitiatingVisitDate: z.date().nullable().optional(),
          apcmCarePlan: z.string().nullable().optional(),
          assignedStaffId: z.number().nullable().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "front_desk"]);
        const { id, ...data } = input;
        const result = await updatePatientAPCM(id, data, currentMonth());
        void logAudit(ctx, "update_patient", { entityType: "patient", entityId: id, description: `Updated APCM enrollment for patient #${id}` });
        return result;
      }),

    /** Bulk-enroll a set of existing patients in APCM (moves them off CCM). */
    bulkEnrollAPCM: protectedProcedure
      .input(
        z.object({
          ids: z.array(z.number()).min(1),
          apcmConsentStatus: z.enum(["consented", "pending", "declined"]).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "front_desk"]);
        const count = await bulkEnrollAPCM(input.ids, { apcmConsentStatus: input.apcmConsentStatus }, currentMonth());
        void logAudit(ctx, "update_patient", { entityType: "patient", description: `Bulk-enrolled ${count} patients in APCM` });
        return { success: true, count };
      }),

    /** Update Last Called and/or Next Appointment dates for a single patient. */
    updateDates: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          lastCalledAt: z.date().nullable().optional(),
          nextAppointment: z.date().nullable().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "front_desk"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const data: Record<string, unknown> = { updatedAt: new Date() };
        if (input.lastCalledAt !== undefined) data.lastCalledAt = input.lastCalledAt;
        if (input.nextAppointment !== undefined) data.nextAppointment = input.nextAppointment;
        await db.update(patients).set(data).where(eq(patients.id, input.id));
        void logAudit(ctx, "update_patient", { entityType: "patient", entityId: input.id, description: `Updated dates for patient #${input.id}` });
        return { success: true };
      }),

    /**
     * Preview a CSV import: parse, validate, and flag duplicates (in-batch and
     * against existing patients) without writing anything.
     */
    bulkImportPreview: protectedProcedure
      .input(z.object({ csv: z.string() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "front_desk"]);
        const { rows, headerError, template } = parsePatientCsv(input.csv);
        if (headerError) return { headerError, template, rows: [], inBatchDuplicates: [], existingDuplicates: {}, clinicOptions: [], providerOptions: [] };
        const inBatch = findInBatchDuplicates(rows);
        const existing = await findExistingByNames(rows.map((r) => r.name));
        const allClinics = await getAllClinics();
        const allProviders = await getAllProviders();
        const provOpts = allProviders.map((p) => ({ id: p.provider.id, name: p.provider.name, aliases: p.provider.aliases ?? [] }));
        const provById = new Map(provOpts.map((p) => [p.id, p.name]));
        // Resolve each row's free-text provider onto a canonical provider so the
        // preview shows the consolidation (e.g. "Dr. Sudad" -> "Sudad Al Hadad").
        const rowsResolved = rows.map((r) => {
          const pid = matchProviderId(r.provider, provOpts);
          return {
            ...r,
            resolvedProviderId: pid,
            resolvedProviderName: pid ? provById.get(pid) ?? null : null,
            // Map the file's status onto a canonical worklist status for the preview.
            resolvedStatus: matchWorklistStatus(r.wellnessCallStatus) ?? null,
          };
        });
        return {
          template,
          rows: rowsResolved,
          inBatchDuplicates: Array.from(inBatch),
          existingDuplicates: existing,
          clinicOptions: allClinics.map((c) => ({ id: c.id, name: c.name })),
          providerOptions: provOpts,
        };
      }),

    /**
     * Commit a bulk import. Resolves clinic/provider by name or accepts a
     * default clinicId/providerId. Skips rows with validation errors.
     */
    bulkImportCommit: protectedProcedure
      .input(
        z.object({
          csv: z.string(),
          // Optional fallbacks — only used when a row's clinic/provider can't be
          // resolved from the file. Import no longer requires them.
          defaultClinicId: z.number().optional(),
          defaultProviderId: z.number().optional(),
          defaultStaffId: z.number().optional(),
          skipExistingDuplicates: z.boolean().default(true),
          // Enroll every imported patient in BHI (99484) — use when the whole file
          // is a BHI-eligibility list. Per-row "BHI" columns still apply on top.
          defaultEnrollBHI: z.boolean().optional(),
          defaultBhiConditions: z.array(z.string()).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "front_desk"]);
        const { rows, headerError } = parsePatientCsv(input.csv);
        if (headerError) throw new TRPCError({ code: "BAD_REQUEST", message: headerError });

        const allClinics = await getAllClinics();
        const allProviders = await getAllProviders();
        const clinicByName = new Map(allClinics.map((c) => [c.name.toLowerCase().trim(), c.id]));
        const provOpts = allProviders.map((p) => ({ id: p.provider.id, name: p.provider.name, aliases: p.provider.aliases ?? [] }));
        const existing = await findExistingByNames(rows.map((r) => r.name));

        const valid = rows.filter((r) => r.errors.length === 0);
        const toInsert = valid.filter((r) => {
          if (!input.skipExistingDuplicates) return true;
          return !existing[normalizeName(r.name)];
        });

        const mapped = toInsert.map((r) => ({
          name: r.name,
          dateOfBirth: r.dateOfBirth ? new Date(r.dateOfBirth) : null,
          phoneNumber: r.phoneNumber,
          // Resolve clinic/provider from the file; fall back to the optional
          // defaults; otherwise leave unset (both columns are nullable now).
          clinicId: (r.clinic && clinicByName.get(r.clinic.toLowerCase().trim())) || input.defaultClinicId || null,
          providerId: matchProviderId(r.provider, provOpts) ?? (input.defaultProviderId || null),
          preferredLanguage: r.preferredLanguage,
          chronicConditions: r.chronicConditions,
          insurance: r.insurance,
          consentStatus: (r.consentStatus as any) || "pending",
          rpmEnrolled: r.rpmEnrolled ?? false,
          rpmStatus: (r.rpmEnrolled ? "enrolled" : "not_enrolled") as any,
          rpmDeviceType: r.rpmDeviceType,
          lastCalledAt: r.lastCalled ? new Date(r.lastCalled) : null,
          nextAppointment: r.nextAppointment ? new Date(r.nextAppointment) : null,
          lastCCMDate: r.completed && r.lastCalled ? new Date(r.lastCalled) : null,
          assignedStaffId: input.defaultStaffId ?? null,
          // Carry the file's status onto this month's worklist task.
          worklistStatus: matchWorklistStatus(r.wellnessCallStatus),
          ccmEnrollmentStatus: r.enrollmentStatus,
          // BHI: per-row "BHI" column OR the whole-file toggle enrolls the patient;
          // conditions come from the row's "BHI Conditions" column or the shared default.
          bhiEnroll: r.bhiEnroll || input.defaultEnrollBHI || false,
          bhiConditions: (r.bhiConditions && r.bhiConditions.length ? r.bhiConditions : input.defaultBhiConditions) || [],
        }));

        // Inserts patients AND their current-month worklist tasks (with the mapped
        // status). generateMonthlyWorklist then backfills any other active patients.
        const inserted = await bulkInsertPatients(mapped, currentMonth());
        if (inserted > 0) await generateMonthlyWorklist(currentMonth());
        void logAudit(ctx, "bulk_import_patients", {
          entityType: "patient",
          description: `Bulk imported ${inserted} patients (skipped ${valid.length - inserted} duplicates, ${rows.length - valid.length} invalid)`,
        });
        return {
          inserted,
          skippedDuplicates: valid.length - inserted,
          invalid: rows.length - valid.length,
          total: rows.length,
        };
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          phoneNumber: z.string().optional(),
          dateOfBirth: z.date().nullable().optional(),
          chronicConditions: z.array(z.string()).optional(),
          insurance: z.string().optional(),
          preferredLanguage: z.string().optional(),
          providerId: z.number().optional(),
          clinicId: z.number().optional(),
          assignedStaffId: z.number().optional(),
          ccmEnrollmentStatus: z.enum(["active", "inactive", "declined", "transferred"]).optional(),
          consentStatus: z.enum(["consented", "pending", "declined"]).optional(),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "front_desk"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { id, ...updateData } = input;
        await db.update(patients).set({ ...updateData, updatedAt: new Date() }).where(eq(patients.id, id));
        // Keep this month's worklist tasks in sync for whichever programs the patient
        // is enrolled in (creates missing ones, updates the assigned employee).
        await ensureMonthlyTasksForPatient(id, currentMonth());
        void logAudit(ctx, "update_patient", { entityType: "patient", entityId: id, description: `Updated patient #${id}` });
        return getPatientById(id);
      }),

    /** Permanently delete a patient and all of their CCM records. Admin only. */
    remove: protectedProcedure
      .input(z.number())
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        const patient = await getPatientById(input);
        await deletePatient(input);
        void logAudit(ctx, "update_patient", { entityType: "patient", entityId: input, description: `Deleted patient #${input}${patient ? ` (${patient.name})` : ""}` });
        return { success: true };
      }),
  }),

  // ---- HIPAA audit log ----
  audit: router({
    list: protectedProcedure
      .input(z.object({ limit: z.number().max(500).optional(), action: z.string().optional(), userId: z.number().optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        return getAuditLogs(input || {});
      }),
  }),

  // ---- Worklist / CCM Tasks ----
  worklist: router({
    forMonth: protectedProcedure
      .input(
        z.object({
          month: z.string().optional(),
          status: z.string().optional(),
          assignedStaffId: z.number().optional(),
          clinicId: z.number().optional(),
          providerId: z.number().optional(),
          program: z.enum(["ccm", "bhi", "apcm"]).optional(),
        }).optional()
      )
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "provider", "billing", "front_desk"]);
        const month = input?.month || currentMonth();
        // At the start of a new month, auto-generate everyone's worklist so each
        // active patient shows up as "assigned" to their staff (once per month).
        if (month === currentMonth()) await ensureMonthlyWorklistGenerated(month);
        return getWorklistForMonth(month, input);
      }),

    mine: protectedProcedure
      .input(z.object({ month: z.string().optional(), program: z.enum(["ccm", "bhi", "apcm"]).optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["staff", "admin"]);
        const month = input?.month || currentMonth();
        if (month === currentMonth()) await ensureMonthlyWorklistGenerated(month);
        return getWorklistForMonth(month, { assignedStaffId: ctx.user.id, program: input?.program });
      }),

    generate: protectedProcedure
      .input(z.object({ month: z.string().optional() }).optional())
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        return generateMonthlyWorklist(input?.month || currentMonth());
      }),

    getTask: protectedProcedure.input(z.number()).query(async ({ input }) => getCCMTaskById(input)),

    updateStatus: protectedProcedure
      .input(z.object({ id: z.number(), status: statusEnum }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const now = new Date();
        const contacted = CONTACTED_STATUSES.includes(input.status);
        await db.update(ccmTasks).set({ status: input.status, updatedAt: now, ...(contacted ? { dateContacted: now } : {}) }).where(eq(ccmTasks.id, input.id));
        // A completed/contacted call automatically stamps the patient's Last Called date.
        if (contacted) {
          const task = await getCCMTaskById(input.id);
          if (task?.patientId) await db.update(patients).set({ lastCalledAt: now, updatedAt: now }).where(eq(patients.id, task.patientId));
        }
        // Marking Inactive / Declined moves the patient off THIS program's worklist
        // onto its own tab by syncing the matching enrollment status (CCM vs BHI).
        if (input.status === "inactive" || input.status === "declined_ccm") {
          const t = await getCCMTaskById(input.id);
          if (t?.patientId) {
            const patch: Record<string, unknown> = { updatedAt: now };
            patch[t.program === "bhi" ? "bhiEnrollmentStatus" : t.program === "apcm" ? "apcmEnrollmentStatus" : "ccmEnrollmentStatus"] = input.status === "inactive" ? "inactive" : "declined";
            await db.update(patients).set(patch as any).where(eq(patients.id, t.patientId));
          }
        }
        await recomputeBilling(input.id, currentMonth());
        return getCCMTaskById(input.id);
      }),

    bulkUpdateStatus: protectedProcedure
      .input(z.object({ ids: z.array(z.number()), status: statusEnum }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const now = new Date();
        const contacted = CONTACTED_STATUSES.includes(input.status);
        for (const id of input.ids) {
          await db.update(ccmTasks).set({ status: input.status, updatedAt: now, ...(contacted ? { dateContacted: now } : {}) }).where(eq(ccmTasks.id, id));
          if (contacted) {
            const task = await getCCMTaskById(id);
            if (task?.patientId) await db.update(patients).set({ lastCalledAt: now, updatedAt: now }).where(eq(patients.id, task.patientId));
          }
          if (input.status === "inactive" || input.status === "declined_ccm") {
            const t = await getCCMTaskById(id);
            if (t?.patientId) {
              const patch: Record<string, unknown> = { updatedAt: now };
              patch[t.program === "bhi" ? "bhiEnrollmentStatus" : t.program === "apcm" ? "apcmEnrollmentStatus" : "ccmEnrollmentStatus"] = input.status === "inactive" ? "inactive" : "declined";
              await db.update(patients).set(patch as any).where(eq(patients.id, t.patientId));
            }
          }
          await recomputeBilling(id, currentMonth());
        }
        return { success: true, count: input.ids.length };
      }),

    // Log one no-answer attempt: bump the monthly counter, set the status, and
    // stamp the patient's Last Called date. Each call = one logged attempt.
    logNoAnswer: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const now = new Date();
        const task = await getCCMTaskById(input.id);
        if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found." });
        await db.update(ccmTasks).set({
          status: "called_no_answer",
          noAnswerCount: (task.noAnswerCount ?? 0) + 1,
          dateContacted: now,
          updatedAt: now,
        }).where(eq(ccmTasks.id, input.id));
        if (task.patientId) await db.update(patients).set({ lastCalledAt: now, updatedAt: now }).where(eq(patients.id, task.patientId));
        await recomputeBilling(input.id, currentMonth());
        return getCCMTaskById(input.id);
      }),

    // Undo a no-answer attempt logged by mistake: decrement the counter (never
    // below 0). If that was the last attempt, send the task back to "assigned".
    unlogNoAnswer: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const task = await getCCMTaskById(input.id);
        if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found." });
        const next = Math.max(0, (task.noAnswerCount ?? 0) - 1);
        const update: any = { noAnswerCount: next, updatedAt: new Date() };
        if (next === 0 && task.status === "called_no_answer") update.status = "assigned";
        await db.update(ccmTasks).set(update).where(eq(ccmTasks.id, input.id));
        await recomputeBilling(input.id, currentMonth());
        return getCCMTaskById(input.id);
      }),

    // Assignment: manual single, bulk, and rule-based
    assign: protectedProcedure
      .input(z.object({ taskIds: z.array(z.number()), staffId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        for (const id of input.taskIds) {
          await db.update(ccmTasks).set({ assignedStaffId: input.staffId, status: "assigned", updatedAt: new Date() }).where(eq(ccmTasks.id, id));
        }
        return { success: true, count: input.taskIds.length };
      }),

    autoBalance: protectedProcedure
      .input(z.object({ month: z.string().optional() }).optional())
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const month = input?.month || currentMonth();
        const staff = (await getAllStaffUsers()).filter((s) => s.role === "staff");
        if (!staff.length) return { success: false, assigned: 0 };
        const tasks = await getWorklistForMonth(month, {});
        const unassigned = tasks.filter((t) => !t.task.assignedStaffId);
        let i = 0;
        for (const t of unassigned) {
          // prefer staff in same clinic location
          const sameClinic = staff.filter((s) => s.clinicLocation === t.clinicLocation);
          const pool = sameClinic.length ? sameClinic : staff;
          const chosen = pool[i % pool.length];
          await db.update(ccmTasks).set({ assignedStaffId: chosen.id, status: "assigned", updatedAt: new Date() }).where(eq(ccmTasks.id, t.task.id));
          i++;
        }
        return { success: true, assigned: unassigned.length };
      }),
  }),

  // ---- CCM Notes (documentation) ----
  ccmNotes: router({
    getByTaskId: protectedProcedure.input(z.number()).query(async ({ input }) => getCCMNoteByTaskId(input)),

    save: protectedProcedure
      .input(
        z.object({
          ccmTaskId: z.number(),
          patientId: z.number(),
          howFeeling: z.string().optional(),
          newSymptoms: z.string().optional(),
          medicationAdherence: z.string().optional(),
          refillsNeeded: z.string().optional(),
          erHospitalizationSince: z.string().optional(),
          recentSpecialistVisits: z.string().optional(),
          bloodPressureReading: z.string().optional(),
          bloodSugarReading: z.string().optional(),
          upcomingAppointments: z.string().optional(),
          followUpNeeded: z.string().optional(),
          patientConcerns: z.string().optional(),
          generatedNote: z.string().optional(),
          aiGeneratedAt: z.number().optional(),
          escalationFlag: z.boolean().optional(),
          escalationReason: z.string().optional(),
          followUpActions: z.array(z.string()).optional(),
          // ---- BHI (99484) behavioral-health assessment (BHI calls only) ----
          phq9Score: z.number().int().min(0).max(27).nullable().optional(),
          gad7Score: z.number().int().min(0).max(21).nullable().optional(),
          assessmentToolOther: z.string().optional(),
          assessmentScoreOther: z.number().int().nullable().optional(),
          behavioralStatus: z.enum(["improved", "unchanged", "worsening", "new"]).optional(),
          carePlanUpdated: z.boolean().optional(),
          bhiRiskFlag: z.boolean().optional(),
          // Clinical staff minutes spent during THIS session — accrued onto the
          // monthly task's total (CCM 99490 / BHI 99484 require >=20 documented min/month).
          sessionMinutes: z.number().int().min(0).max(480).optional(),
          markCompleted: z.boolean().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        const existing = await getCCMNoteByTaskId(input.ccmTaskId);
        const noteData = {
          ccmTaskId: input.ccmTaskId,
          patientId: input.patientId,
          staffId: ctx.user.id,
          howFeeling: input.howFeeling,
          newSymptoms: input.newSymptoms,
          medicationAdherence: input.medicationAdherence,
          refillsNeeded: input.refillsNeeded,
          erHospitalizationSince: input.erHospitalizationSince,
          recentSpecialistVisits: input.recentSpecialistVisits,
          bloodPressureReading: input.bloodPressureReading,
          bloodSugarReading: input.bloodSugarReading,
          upcomingAppointments: input.upcomingAppointments,
          followUpNeeded: input.followUpNeeded,
          patientConcerns: input.patientConcerns,
          generatedNote: input.generatedNote,
          aiGeneratedAt: input.aiGeneratedAt ? new Date(input.aiGeneratedAt) : undefined,
          escalationFlag: (input.escalationFlag || input.bhiRiskFlag) || false,
          escalationReason: input.escalationReason,
          followUpActions: input.followUpActions || [],
          // BHI assessment (undefined for CCM calls — columns stay null).
          phq9Score: input.phq9Score ?? null,
          gad7Score: input.gad7Score ?? null,
          assessmentToolOther: input.assessmentToolOther,
          assessmentScoreOther: input.assessmentScoreOther ?? null,
          behavioralStatus: input.behavioralStatus,
          carePlanUpdated: input.carePlanUpdated || false,
          bhiRiskFlag: input.bhiRiskFlag || false,
        };

        let noteId: number;
        if (existing) {
          await db.update(ccmNotes).set(noteData).where(eq(ccmNotes.id, existing.id));
          noteId = existing.id;
        } else {
          const res: any = await db.insert(ccmNotes).values(noteData);
          noteId = res[0]?.insertId ?? 0;
        }

        // A behavioral-health risk flag (e.g. PHQ-9 item 9 / suicidal ideation) is
        // treated like a clinical escalation — routes the task to provider review.
        const escalate = !!(input.escalationFlag || input.bhiRiskFlag);

        // Update task time + completion
        const taskUpdate: any = { updatedAt: new Date() };
        const mins = input.sessionMinutes ?? 0;
        if (mins > 0) {
          taskUpdate.timeSpentMinutes = sql`${ccmTasks.timeSpentMinutes} + ${mins}`;
          await db.update(ccmNotes).set({ timeSpentMinutes: sql`${ccmNotes.timeSpentMinutes} + ${mins}` }).where(eq(ccmNotes.id, noteId));
        }
        if (input.markCompleted) {
          taskUpdate.ccmNoteCompleted = true;
          taskUpdate.status = escalate ? "needs_provider_review" : "completed";
          if (escalate) taskUpdate.providerReviewNeeded = true;
          taskUpdate.completedAt = new Date();
          taskUpdate.completedByStaffId = ctx.user.id;
        }
        await db.update(ccmTasks).set(taskUpdate).where(eq(ccmTasks.id, input.ccmTaskId));

        // Record that this patient was contacted now (powers the "Last Called" column)
        await db.update(patients).set({ lastCalledAt: new Date() }).where(eq(patients.id, input.patientId));

        // Escalation -> create provider escalation + notify provider.
        // Requires a provider on the patient (escalations route to a provider);
        // patients imported without a provider simply can't be escalated this way.
        if (escalate && noteId) {
          const patient = await getPatientById(input.patientId);
          if (patient && patient.providerId) {
            const reason = input.escalationReason || (input.bhiRiskFlag ? "Behavioral-health safety risk flagged." : "Provider review requested.");
            await db.insert(providerEscalations).values({
              ccmNoteId: noteId,
              patientId: input.patientId,
              providerId: patient.providerId,
              reason,
              escalationStatus: "pending",
            });
            const provider = await getProviderById(patient.providerId);
            if (provider?.userId) {
              await createNotification({
                userId: provider.userId,
                type: "escalation",
                title: "Patient escalated for review",
                content: `${patient.name} was escalated: ${reason}`,
                relatedPatientId: patient.id,
                relatedCCMTaskId: input.ccmTaskId,
              });
            }
            // urgent symptom -> notify admin/practice manager
            const admin = await getFirstUserByRole("admin");
            if (admin) {
              await createNotification({
                userId: admin.id,
                type: "urgent_symptom",
                title: "Urgent symptom flagged",
                content: `${patient.name}: ${input.escalationReason || input.newSymptoms || "Urgent review requested."}`,
                relatedPatientId: patient.id,
                relatedCCMTaskId: input.ccmTaskId,
              });
            }
          }
        }

        await recomputeBilling(input.ccmTaskId, currentMonth());
        return { success: true, noteId };
      }),
  }),

  // ---- Escalations (provider) ----
  escalations: router({
    list: protectedProcedure
      .input(z.object({ providerId: z.number().optional(), status: z.string().optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "provider"]);
        return getEnrichedEscalations(input || {});
      }),

    updateStatus: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          escalationStatus: z.enum(["pending", "reviewed", "action_needed", "completed"]),
          recommendedAction: z.string().optional(),
          providerNotes: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "provider"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { id, ...updateData } = input;
        await db
          .update(providerEscalations)
          .set({ ...updateData, reviewedAt: new Date(), updatedAt: new Date() })
          .where(eq(providerEscalations.id, id));
        return { success: true };
      }),
  }),

  // ---- Medication refill requests (coordinator -> provider) ----
  refills: router({
    // Coordinator sends a refill request; it routes to the patient's provider.
    create: protectedProcedure
      .input(z.object({
        patientId: z.number(),
        medications: z.array(z.object({ name: z.string().min(1), note: z.string().optional() })).min(1),
        note: z.string().optional(),
        ccmTaskId: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        const patient = await getPatientById(input.patientId);
        if (!patient) throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found." });
        const res = await createRefillRequest({
          patientId: input.patientId,
          providerId: patient.providerId ?? null,
          requestedByUserId: ctx.user.id,
          ccmTaskId: input.ccmTaskId ?? null,
          medications: input.medications,
          note: input.note,
        });
        void logAudit(ctx, "update_patient", { entityType: "patient", entityId: input.patientId, description: `Refill request sent to provider: ${input.medications.map((m) => m.name).join(", ")}` });
        return res;
      }),

    // Provider portal: refill requests routed to me (optionally filtered by status).
    mine: protectedProcedure
      .input(z.object({ status: z.string().optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "provider"]);
        const prov = await getProviderByUserId(ctx.user.id);
        if (!prov) return [];
        return getRefillRequestsForProvider(prov.id, input?.status);
      }),

    // Pending count for the logged-in provider (portal badge).
    myPendingCount: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "provider" && ctx.user.role !== "admin") return 0;
      const prov = await getProviderByUserId(ctx.user.id);
      return prov ? getPendingRefillCountForProvider(prov.id) : 0;
    }),

    // Refill history for a patient (shown on the patient page).
    forPatient: protectedProcedure
      .input(z.number())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "provider", "front_desk", "billing"]);
        return getRefillRequestsForPatient(input);
      }),

    // Provider decides: Approve / Schedule visit / Don't refill (+ optional note).
    decide: protectedProcedure
      .input(z.object({ id: z.number(), status: z.enum(["approved", "schedule_visit", "denied"]), providerNote: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "provider"]);
        // Providers may only decide requests routed to them; admins may decide any.
        const guard = ctx.user.role === "provider" ? (await getProviderByUserId(ctx.user.id))?.id ?? -1 : undefined;
        const res = await decideRefillRequest(input.id, ctx.user.id, input.status, input.providerNote, guard);
        if (!res.success) throw new TRPCError({ code: "FORBIDDEN", message: "This refill request is not assigned to you." });
        return res;
      }),
  }),

  // ---- APCM (Advanced Primary Care Management) management tab ----
  apcm: router({
    overview: protectedProcedure
      .input(z.object({
        month: z.string().optional(),
        category: z.enum(["ready", "needs_setup", "ccm_done"]).optional(),
        assignedStaffId: z.number().optional(),
        search: z.string().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "billing"]);
        return getApcmOverview(input?.month || currentMonth(), input || {});
      }),

    // Bulk-apply the standard (personalized) care plan to APCM patients missing one.
    applyStandardCarePlan: protectedProcedure
      .input(z.object({ limit: z.number().optional() }).optional())
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        const res = await applyStandardApcmCarePlan({ limit: input?.limit });
        void logAudit(ctx, "update_patient", { entityType: "apcm", description: `Applied standard APCM care plan to ${res.applied} patients` });
        return res;
      }),
  }),

  // ---- Reach Out (outbound appointment-scheduling call campaign) ----
  reachOut: router({
    // Shared-pool contact list (un-called first), filtered + paginated.
    list: protectedProcedure
      .input(z.object({
        callStatus: z.string().optional(),
        outcome: z.string().optional(),
        search: z.string().optional(),
        uncontactedOnly: z.boolean().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        return getReachOutContacts(input || {});
      }),

    // Campaign dashboard metrics.
    stats: protectedProcedure.query(async ({ ctx }) => {
      requireRole(ctx, ["admin", "staff"]);
      return getReachOutStats();
    }),

    // Log a call: result + (optional) outcome + note; stamps caller and bumps attempts.
    logCall: protectedProcedure
      .input(z.object({
        id: z.number(),
        callStatus: reachCallStatusEnum,
        outcome: reachOutcomeEnum.optional(),
        note: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        const res = await logReachOutCall({ ...input, staffId: ctx.user.id, staffName: ctx.user.name ?? null });
        if (!res.success) throw new TRPCError({ code: "NOT_FOUND", message: "Contact not found." });
        return res;
      }),

    // Bulk-import the campaign list from CSV text (admin).
    import: protectedProcedure
      .input(z.object({ csv: z.string().min(1), campaign: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        const parsed = parseReachOutCsv(input.csv);
        if (!parsed.length) throw new TRPCError({ code: "BAD_REQUEST", message: "No valid rows found. Expected a header row with at least a name and phone column." });
        const imported = await bulkInsertReachOut(parsed, input.campaign || "insurance-outreach");
        void logAudit(ctx, "bulk_import_patients", { entityType: "reachOut", description: `Reach Out import: ${imported} contacts` });
        return { imported };
      }),

    remove: protectedProcedure
      .input(z.number())
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        await deleteReachOutContact(input);
        return { success: true };
      }),
  }),

  // ---- Billing ----
  billing: router({
    list: protectedProcedure
      .input(z.object({ month: z.string().optional(), status: z.string().optional(), program: z.enum(["ccm", "bhi", "apcm"]).optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "billing"]);
        return getEnrichedBilling(input?.month || currentMonth(), input?.status, input?.program);
      }),

    markBilled: protectedProcedure
      .input(z.object({ id: z.number(), ccmTaskId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "billing"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.update(billingRecords).set({ billingStatus: "billed", claimSubmittedDate: new Date() }).where(eq(billingRecords.id, input.id));
        await db.update(ccmTasks).set({ status: "billed" }).where(eq(ccmTasks.id, input.ccmTaskId));
        return { success: true };
      }),
  }),

  // ---- Follow-ups (front desk) ----
  followUps: router({
    list: protectedProcedure
      .input(z.object({ status: z.string().optional(), type: z.string().optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "front_desk", "staff"]);
        return getEnrichedFollowUps(input || {});
      }),

    updateStatus: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          status: z.enum(["pending", "scheduled", "completed"]),
          scheduledDate: z.date().optional(),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "front_desk", "staff"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const update: any = { status: input.status, updatedAt: new Date() };
        if (input.scheduledDate) update.scheduledDate = input.scheduledDate;
        if (input.notes !== undefined) update.notes = input.notes;
        if (input.status === "completed") update.completedDate = new Date();
        await db.update(followUpItems).set(update).where(eq(followUpItems.id, input.id));
        return { success: true };
      }),

    create: protectedProcedure
      .input(
        z.object({
          ccmTaskId: z.number(),
          patientId: z.number(),
          type: z.enum([
            "office_visit", "telemedicine_visit", "lab_work", "medication_refill",
            "referral", "imaging", "testing", "rpm_enrollment", "dexa", "abi",
            "pft", "balance_test", "vaccination", "annual_wellness",
          ]),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "front_desk", "staff"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.insert(followUpItems).values({
          ccmTaskId: input.ccmTaskId,
          patientId: input.patientId,
          type: input.type,
          status: "pending",
          notes: input.notes,
        });
        return { success: true };
      }),
  }),

  // ---- Notifications ----
  notifications: router({
    list: protectedProcedure.query(async ({ ctx }) => getAllNotifications(ctx.user.id)),
    unread: protectedProcedure.query(async ({ ctx }) => getUnreadNotifications(ctx.user.id)),
    markRead: protectedProcedure.input(z.number()).mutation(async ({ input }) => {
      await markNotificationRead(input);
      return { success: true };
    }),
  }),

  // ---- Reference data ----
  clinics: router({
    list: protectedProcedure.query(async () => getAllClinics()),
    create: protectedProcedure
      .input(z.object({ name: z.string().min(1), location: z.string().min(1), address: z.string().optional(), phone: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.insert(clinics).values(input);
        return { success: true };
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), name: z.string().min(1), location: z.string().min(1), address: z.string().optional(), phone: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { id, ...updateData } = input;
        await db.update(clinics).set(updateData).where(eq(clinics.id, id));
        return { success: true };
      }),
    remove: protectedProcedure.input(z.number()).mutation(async ({ input, ctx }) => {
      requireRole(ctx, ["admin"]);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const assignedPatients = await db.select({ id: patients.id }).from(patients).where(eq(patients.clinicId, input)).limit(1);
      const assignedProviders = await db.select({ id: providers.id }).from(providers).where(eq(providers.clinicId, input)).limit(1);
      if (assignedPatients.length || assignedProviders.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This clinic is assigned to patients or providers. Reassign them before removing it." });
      }
      const [hasAppt] = await db.select({ id: appointments.id }).from(appointments).where(eq(appointments.clinicId, input)).limit(1);
      const [hasTask] = await db.select({ id: workTasks.id }).from(workTasks).where(eq(workTasks.clinicId, input)).limit(1);
      if (hasAppt || hasTask) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This clinic has appointments or tasks in the Workspace, so it can't be removed." });
      }
      await db.delete(clinics).where(eq(clinics.id, input));
      return { success: true };
    }),
  }),
  providers: router({
    all: protectedProcedure.query(async () => getAllProviders()),
    listByClinic: protectedProcedure.input(z.number()).query(async ({ input }) => getProvidersByClinic(input)),
    getById: protectedProcedure.input(z.number()).query(async ({ input }) => getProviderById(input)),
    // Give a provider their own secure portal login (creates role=provider user + links it).
    createLogin: protectedProcedure
      .input(z.object({ providerId: z.number(), email: z.string().email(), password: z.string() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        const strengthError = validatePasswordStrength(input.password);
        if (strengthError) throw new TRPCError({ code: "BAD_REQUEST", message: strengthError });
        const passwordHash = await hashPassword(input.password);
        const res = await createProviderLogin(input.providerId, input.email, passwordHash);
        if (!res.success) throw new TRPCError({ code: "BAD_REQUEST", message: res.error || "Could not create login." });
        void logAudit(ctx, "manage_access", { entityType: "user", entityId: res.userId, description: `Created provider portal login for provider #${input.providerId} (${input.email})` });
        return { success: true };
      }),
    create: protectedProcedure
      .input(z.object({ name: z.string().min(1), title: z.string().optional(), clinicId: z.number().optional(), userId: z.number().optional(), aliases: z.array(z.string()).optional() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.insert(providers).values(input);
        return { success: true };
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), name: z.string().min(1), title: z.string().optional(), clinicId: z.number().optional(), userId: z.number().optional(), aliases: z.array(z.string()).optional() }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { id, ...updateData } = input;
        await db.update(providers).set(updateData).where(eq(providers.id, id));
        return { success: true };
      }),
    remove: protectedProcedure.input(z.number()).mutation(async ({ input, ctx }) => {
      requireRole(ctx, ["admin"]);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const assignedPatients = await db.select({ id: patients.id }).from(patients).where(eq(patients.providerId, input)).limit(1);
      if (assignedPatients.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This provider is assigned to patients. Reassign them before removing it." });
      }
      // Imported appointments keep the provider's name as text.
      await db.update(appointments).set({ providerId: null }).where(eq(appointments.providerId, input));
      await db.delete(providers).where(eq(providers.id, input));
      return { success: true };
    }),
  }),
  staff: router({
    all: protectedProcedure.query(async ({ ctx }) => {
      requireRole(ctx, ["admin"]);
      return getAllStaffUsers();
    }),
    workload: protectedProcedure
      .input(z.object({ month: z.string().optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        return getStaffWorkload(input?.month || currentMonth());
      }),
  }),

  // ---- Reports ----
  reports: router({
    summary: protectedProcedure
      .input(z.object({ month: z.string().optional(), program: z.enum(["ccm", "bhi", "apcm"]).optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "billing"]);
        const month = input?.month || currentMonth();
        const program = input?.program ?? "ccm";
        const [stats, staffPerf, clinicPerf, providerPerf, trend, monthlyTrend] = await Promise.all([
          getAdminStats(month, program),
          getStaffPerformance(month, program),
          getClinicPerformance(month, program),
          getProviderPerformance(month, program),
          getDailyCompletionTrend(month, program),
          getMonthlyCompletionTrend(6, program),
        ]);
        return { month, program, stats, staffPerformance: staffPerf, clinicPerformance: clinicPerf, providerPerformance: providerPerf, dailyTrend: trend, monthlyTrend };
      }),

    // Flexible completion report: group by any combination of date/week/provider/employee/clinic
    completions: protectedProcedure
      .input(
        z.object({
          groupBy: z.array(z.enum(["date", "week", "provider", "employee", "clinic"])).min(1).max(3),
          from: z.number().optional(),
          to: z.number().optional(),
        })
      )
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "billing"]);
        const rows = await getCompletionReport({ groupBy: input.groupBy, from: input.from, to: input.to });
        return { groupBy: input.groupBy, rows, total: rows.reduce((s, r) => s + r.count, 0) };
      }),
  }),

  // ---- Per-coordinator dashboards + admin-set monthly goals ----
  coordinator: router({
    // A coordinator's own dashboard (staff); an admin can pass a staffId to view any.
    dashboard: protectedProcedure
      .input(z.object({ staffId: z.number().optional(), month: z.string().optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        const month = input?.month || currentMonth();
        const staffId = ctx.user.role === "admin" && input?.staffId ? input.staffId : ctx.user.id;
        const data = await getCoordinatorDashboard(staffId, month);
        const who = staffId === ctx.user.id ? ctx.user : (await getAllStaffUsers()).find((s) => s.id === staffId);
        return { staffId, staffName: who?.name || who?.email || "Coordinator", ...(data || {}) };
      }),
    // Admin: every coordinator with their goal + completed/assigned for the month.
    goalsOverview: protectedProcedure
      .input(z.object({ month: z.string().optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        return getCoordinatorGoalsOverview(input?.month || currentMonth());
      }),
    // Admin sets/updates a coordinator's goal for a month.
    setGoal: protectedProcedure
      .input(z.object({ userId: z.number(), month: z.string(), goal: z.number().int().min(0).max(100000) }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        await setMonthlyGoal(input.userId, input.month, input.goal);
        void logAudit(ctx, "manage_access", { entityType: "user", entityId: input.userId, description: `Set ${input.month} CCM goal to ${input.goal} for user #${input.userId}` });
        return { success: true };
      }),
    // Admin sets a coordinator's working days per week (1-7).
    setWorkDays: protectedProcedure
      .input(z.object({ userId: z.number(), workDaysPerWeek: z.number().int().min(1).max(7) }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        await setWorkDays(input.userId, input.workDaysPerWeek);
        void logAudit(ctx, "manage_access", { entityType: "user", entityId: input.userId, description: `Set work days/week to ${input.workDaysPerWeek} for user #${input.userId}` });
        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;

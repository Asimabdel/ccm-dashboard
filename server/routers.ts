import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  getPatientsByClinic,
  getPatientsByProvider,
  getPatientsByRiskLevel,
  getActivePatients,
  getPatientById,
  getCCMTasksForMonth,
  getCCMTasksByStaff,
  getCCMTaskById,
  getCCMTaskByPatientAndMonth,
  getCCMNoteByTaskId,
  getEscalationsByProvider,
  getPendingEscalations,
  getBillingRecordsForMonth,
  getBillingReadyCount,
  getUnreadNotifications,
  getProductivityMetrics,
  getAllClinics,
  getProvidersByClinic,
  getProviderById,
  getStaffByRole,
  getStaffByClinic,
} from "./db";
import { getDb } from "./db";
import {
  patients,
  ccmTasks,
  ccmNotes,
  providerEscalations,
  followUpItems,
  billingRecords,
  notifications,
  productivityMetrics,
  clinics,
  providers,
} from "../drizzle/schema";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // Patient management
  patients: router({
    list: protectedProcedure
      .input(
        z.object({
          clinicId: z.number().optional(),
          providerId: z.number().optional(),
          riskLevel: z.enum(["high", "medium", "low"]).optional(),
          activeOnly: z.boolean().optional(),
        })
      )
      .query(async ({ input }) => {
        if (input.activeOnly) {
          return getActivePatients();
        }
        if (input.clinicId) {
          return getPatientsByClinic(input.clinicId);
        }
        if (input.providerId) {
          return getPatientsByProvider(input.providerId);
        }
        if (input.riskLevel) {
          return getPatientsByRiskLevel(input.riskLevel);
        }
        return getActivePatients();
      }),

    getById: protectedProcedure
      .input(z.number())
      .query(async ({ input }) => {
        return getPatientById(input);
      }),

    create: protectedProcedure
      .input(
        z.object({
          name: z.string(),
          dateOfBirth: z.date().optional(),
          phoneNumber: z.string(),
          clinicId: z.number(),
          providerId: z.number(),
          preferredLanguage: z.string().optional(),
          chronicConditions: z.array(z.string()).optional(),
          insurance: z.string().optional(),
          riskLevel: z.enum(["high", "medium", "low"]).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user?.role !== "admin" && ctx.user?.role !== "staff") {
          throw new Error("Unauthorized");
        }

        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const result = await db.insert(patients).values({
          name: input.name,
          dateOfBirth: input.dateOfBirth,
          phoneNumber: input.phoneNumber,
          clinicId: input.clinicId,
          providerId: input.providerId,
          preferredLanguage: input.preferredLanguage || "English",
          chronicConditions: input.chronicConditions || [],
          insurance: input.insurance,
          riskLevel: input.riskLevel || "medium",
          ccmEnrollmentStatus: "active",
          consentStatus: "pending",
        });

        return result;
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          riskLevel: z.enum(["high", "medium", "low"]).optional(),
          chronicConditions: z.array(z.string()).optional(),
          ccmEnrollmentStatus: z.enum(["active", "inactive", "declined", "transferred"]).optional(),
          consentStatus: z.enum(["consented", "pending", "declined"]).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user?.role !== "admin" && ctx.user?.role !== "staff") {
          throw new Error("Unauthorized");
        }

        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const { id, ...updateData } = input;
        await db.update(patients).set(updateData).where(eq(patients.id, id));

        return getPatientById(id);
      }),
  }),

  // CCM Tasks
  ccmTasks: router({
    listForMonth: protectedProcedure
      .input(z.string())
      .query(async ({ input }) => {
        return getCCMTasksForMonth(input);
      }),

    listByStaff: protectedProcedure
      .input(z.object({ staffId: z.number(), month: z.string() }))
      .query(async ({ input }) => {
        return getCCMTasksByStaff(input.staffId, input.month);
      }),

    getById: protectedProcedure
      .input(z.number())
      .query(async ({ input }) => {
        return getCCMTaskById(input);
      }),

    create: protectedProcedure
      .input(
        z.object({
          patientId: z.number(),
          month: z.string(),
          assignedStaffId: z.number().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user?.role !== "admin") {
          throw new Error("Unauthorized");
        }

        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const result = await db.insert(ccmTasks).values({
          patientId: input.patientId,
          month: input.month,
          assignedStaffId: input.assignedStaffId,
          status: "not_started",
        });

        return result;
      }),

    updateStatus: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          status: z.enum([
            "not_started",
            "assigned",
            "called_no_answer",
            "voicemail_left",
            "wrong_number",
            "needs_callback",
            "in_progress",
            "completed",
            "needs_provider_review",
            "needs_appointment",
            "documentation_incomplete",
            "ready_for_billing",
            "billed",
            "declined_ccm",
            "inactive",
          ]),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user?.role !== "admin" && ctx.user?.role !== "staff") {
          throw new Error("Unauthorized");
        }

        const db = await getDb();
        if (!db) throw new Error("Database not available");

        await db
          .update(ccmTasks)
          .set({ status: input.status, updatedAt: new Date() })
          .where(eq(ccmTasks.id, input.id));

        return getCCMTaskById(input.id);
      }),

    updateTime: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          timeSpentMinutes: z.number(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user?.role !== "staff") {
          throw new Error("Unauthorized");
        }

        const db = await getDb();
        if (!db) throw new Error("Database not available");

        await db
          .update(ccmTasks)
          .set({ timeSpentMinutes: input.timeSpentMinutes, updatedAt: new Date() })
          .where(eq(ccmTasks.id, input.id));

        return getCCMTaskById(input.id);
      }),
  }),

  // CCM Notes
  ccmNotes: router({
    getByTaskId: protectedProcedure
      .input(z.number())
      .query(async ({ input }) => {
        return getCCMNoteByTaskId(input);
      }),

    create: protectedProcedure
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
          escalationFlag: z.boolean().optional(),
          escalationReason: z.string().optional(),
          timeSpentMinutes: z.number().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user?.role !== "staff") {
          throw new Error("Unauthorized");
        }

        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const result = await db.insert(ccmNotes).values({
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
          escalationFlag: input.escalationFlag || false,
          escalationReason: input.escalationReason,
          timeSpentMinutes: input.timeSpentMinutes || 0,
        });

        return result;
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          generatedNote: z.string().optional(),
          escalationFlag: z.boolean().optional(),
          escalationReason: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        if (ctx.user?.role !== "staff") {
          throw new Error("Unauthorized");
        }

        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const { id, ...updateData } = input;
        await db.update(ccmNotes).set(updateData).where(eq(ccmNotes.id, id));

        return getCCMNoteByTaskId(id);
      }),
  }),

  // Provider Escalations
  escalations: router({
    listByProvider: protectedProcedure
      .input(z.number())
      .query(async ({ input, ctx }) => {
        if (ctx.user?.role !== "provider" && ctx.user?.role !== "admin") {
          throw new Error("Unauthorized");
        }
        return getEscalationsByProvider(input);
      }),

    listPending: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user?.role !== "admin" && ctx.user?.role !== "provider") {
        throw new Error("Unauthorized");
      }
      return getPendingEscalations();
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
        if (ctx.user?.role !== "provider" && ctx.user?.role !== "admin") {
          throw new Error("Unauthorized");
        }

        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const { id, ...updateData } = input;
        await db
          .update(providerEscalations)
          .set({ ...updateData, reviewedAt: new Date(), updatedAt: new Date() })
          .where(eq(providerEscalations.id, id));

        return true;
      }),
  }),

  // Billing
  billing: router({
    listForMonth: protectedProcedure
      .input(z.string())
      .query(async ({ input, ctx }) => {
        if (ctx.user?.role !== "billing" && ctx.user?.role !== "admin") {
          throw new Error("Unauthorized");
        }
        return getBillingRecordsForMonth(input);
      }),

    readyCount: protectedProcedure
      .input(z.string())
      .query(async ({ input, ctx }) => {
        if (ctx.user?.role !== "billing" && ctx.user?.role !== "admin") {
          throw new Error("Unauthorized");
        }
        return getBillingReadyCount(input);
      }),
  }),

  // Notifications
  notifications: router({
    listUnread: protectedProcedure.query(async ({ ctx }) => {
      return getUnreadNotifications(ctx.user.id);
    }),
  }),

  // Clinics
  clinics: router({
    list: protectedProcedure.query(async () => {
      return getAllClinics();
    }),
  }),

  // Providers
  providers: router({
    listByClinic: protectedProcedure
      .input(z.number())
      .query(async ({ input }) => {
        return getProvidersByClinic(input);
      }),

    getById: protectedProcedure
      .input(z.number())
      .query(async ({ input }) => {
        return getProviderById(input);
      }),
  }),

  // Staff
  staff: router({
    listByRole: protectedProcedure
      .input(z.enum(["admin", "staff", "provider", "billing", "front_desk"]))
      .query(async ({ input, ctx }) => {
        if (ctx.user?.role !== "admin") {
          throw new Error("Unauthorized");
        }
        return getStaffByRole(input);
      }),

    listByClinic: protectedProcedure
      .input(z.string())
      .query(async ({ input, ctx }) => {
        if (ctx.user?.role !== "admin") {
          throw new Error("Unauthorized");
        }
        return getStaffByClinic(input);
      }),
  }),

  // Productivity
  productivity: router({
    getMetrics: protectedProcedure
      .input(z.object({ month: z.string(), staffId: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        if (ctx.user?.role !== "admin") {
          throw new Error("Unauthorized");
        }
        return getProductivityMetrics(input.month, input.staffId);
      }),
  }),
});

export type AppRouter = typeof appRouter;

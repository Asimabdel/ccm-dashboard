import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
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
  getStaffPerformance,
  getClinicPerformance,
  getDailyCompletionTrend,
  getEnrichedEscalations,
  getEnrichedBilling,
  getEnrichedFollowUps,
  getStaffWorkload,
  getAllStaffUsers,
  getAllProviders,
  generateMonthlyWorklist,
  recomputeBilling,
  createNotification,
  markNotificationRead,
  getAllNotifications,
  getUnreadNotifications,
  getFirstUserByRole,
  setUserRole,
  getDb,
} from "./db";
import {
  patients,
  ccmTasks,
  ccmNotes,
  providerEscalations,
  followUpItems,
  billingRecords,
} from "../drizzle/schema";
import { ccmNotesRouter } from "./routers/ccmNotes";
import { seedDatabase, isSeeded, currentMonth } from "./seed";

// ---- Role guards ----
function requireRole(ctx: any, roles: string[]) {
  if (!ctx.user || !roles.includes(ctx.user.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this resource." });
  }
}

const statusEnum = z.enum([
  "not_started", "assigned", "called_no_answer", "voicemail_left", "wrong_number",
  "needs_callback", "in_progress", "completed", "needs_provider_review",
  "needs_appointment", "documentation_incomplete", "ready_for_billing", "billed",
  "cancelled", "unable_to_reach", "declined_ccm", "inactive",
]);

export const appRouter = router({
  system: systemRouter,
  ccmNotesAI: ccmNotesRouter,

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
    // Demo role switcher so the owner can preview every role-based dashboard
    setRole: protectedProcedure
      .input(z.object({ role: z.enum(["admin", "staff", "provider", "billing", "front_desk"]) }))
      .mutation(async ({ input, ctx }) => {
        await setUserRole(ctx.user.id, input.role);
        return { success: true, role: input.role };
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
      .input(z.object({ month: z.string() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin"]);
        return getAdminStats(input?.month || currentMonth());
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
  }),

  // ---- Patients ----
  patients: router({
    list: protectedProcedure
      .input(
        z.object({
          clinicId: z.number().optional(),
          providerId: z.number().optional(),
          riskLevel: z.enum(["high", "medium", "low"]).optional(),
          enrollmentStatus: z.string().optional(),
          search: z.string().optional(),
        }).optional()
      )
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "provider", "billing", "front_desk"]);
        return getEnrichedPatients(input || {});
      }),

    detail: protectedProcedure
      .input(z.number())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "provider", "billing", "front_desk"]);
        return getPatientDetail(input);
      }),

    getById: protectedProcedure.input(z.number()).query(async ({ input }) => getPatientById(input)),

    create: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          dateOfBirth: z.date().optional(),
          phoneNumber: z.string().min(1),
          clinicId: z.number(),
          providerId: z.number(),
          preferredLanguage: z.string().optional(),
          chronicConditions: z.array(z.string()).optional(),
          insurance: z.string().optional(),
          riskLevel: z.enum(["high", "medium", "low"]).optional(),
          priorityLevel: z.enum(["high", "medium", "low"]).optional(),
          consentStatus: z.enum(["consented", "pending", "declined"]).optional(),
          assignedStaffId: z.number().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "front_desk"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.insert(patients).values({
          name: input.name,
          dateOfBirth: input.dateOfBirth,
          phoneNumber: input.phoneNumber,
          clinicId: input.clinicId,
          providerId: input.providerId,
          preferredLanguage: input.preferredLanguage || "English",
          chronicConditions: input.chronicConditions || [],
          insurance: input.insurance,
          riskLevel: input.riskLevel || "medium",
          priorityLevel: input.priorityLevel || input.riskLevel || "medium",
          ccmEnrollmentStatus: "active",
          consentStatus: input.consentStatus || "pending",
          assignedStaffId: input.assignedStaffId,
        });
        return { success: true };
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          phoneNumber: z.string().optional(),
          riskLevel: z.enum(["high", "medium", "low"]).optional(),
          priorityLevel: z.enum(["high", "medium", "low"]).optional(),
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
        await db.update(patients).set(updateData).where(eq(patients.id, id));
        return getPatientById(id);
      }),
  }),

  // ---- Worklist / CCM Tasks ----
  worklist: router({
    forMonth: protectedProcedure
      .input(
        z.object({
          month: z.string().optional(),
          status: z.string().optional(),
          priorityLevel: z.enum(["high", "medium", "low"]).optional(),
          assignedStaffId: z.number().optional(),
          clinicId: z.number().optional(),
          providerId: z.number().optional(),
        }).optional()
      )
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff", "provider", "billing", "front_desk"]);
        const month = input?.month || currentMonth();
        return getWorklistForMonth(month, input);
      }),

    mine: protectedProcedure
      .input(z.object({ month: z.string().optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["staff", "admin"]);
        const month = input?.month || currentMonth();
        return getWorklistForMonth(month, { assignedStaffId: ctx.user.id });
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
        await db.update(ccmTasks).set({ status: input.status, updatedAt: new Date() }).where(eq(ccmTasks.id, input.id));
        await recomputeBilling(input.id, currentMonth());
        return getCCMTaskById(input.id);
      }),

    bulkUpdateStatus: protectedProcedure
      .input(z.object({ ids: z.array(z.number()), status: statusEnum }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        for (const id of input.ids) {
          await db.update(ccmTasks).set({ status: input.status, updatedAt: new Date() }).where(eq(ccmTasks.id, id));
          await recomputeBilling(id, currentMonth());
        }
        return { success: true, count: input.ids.length };
      }),

    updatePriority: protectedProcedure
      .input(z.object({ id: z.number(), priorityLevel: z.enum(["high", "medium", "low"]) }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.update(ccmTasks).set({ priorityLevel: input.priorityLevel }).where(eq(ccmTasks.id, input.id));
        return getCCMTaskById(input.id);
      }),

    updateTime: protectedProcedure
      .input(z.object({ id: z.number(), timeSpentMinutes: z.number().min(0) }))
      .mutation(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "staff"]);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.update(ccmTasks).set({ timeSpentMinutes: input.timeSpentMinutes, updatedAt: new Date() }).where(eq(ccmTasks.id, input.id));
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
          escalationFlag: z.boolean().optional(),
          escalationReason: z.string().optional(),
          followUpActions: z.array(z.string()).optional(),
          timeSpentMinutes: z.number().optional(),
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
          escalationFlag: input.escalationFlag || false,
          escalationReason: input.escalationReason,
          followUpActions: input.followUpActions || [],
          timeSpentMinutes: input.timeSpentMinutes || 0,
        };

        let noteId: number;
        if (existing) {
          await db.update(ccmNotes).set(noteData).where(eq(ccmNotes.id, existing.id));
          noteId = existing.id;
        } else {
          const res: any = await db.insert(ccmNotes).values(noteData);
          noteId = res[0]?.insertId ?? 0;
        }

        // Update task time + completion
        const taskUpdate: any = { updatedAt: new Date() };
        if (input.timeSpentMinutes !== undefined) taskUpdate.timeSpentMinutes = input.timeSpentMinutes;
        if (input.markCompleted) {
          taskUpdate.ccmNoteCompleted = true;
          taskUpdate.status = input.escalationFlag ? "needs_provider_review" : "completed";
          if (input.escalationFlag) taskUpdate.providerReviewNeeded = true;
        }
        await db.update(ccmTasks).set(taskUpdate).where(eq(ccmTasks.id, input.ccmTaskId));

        // Escalation -> create provider escalation + notify provider
        if (input.escalationFlag && noteId) {
          const patient = await getPatientById(input.patientId);
          if (patient) {
            await db.insert(providerEscalations).values({
              ccmNoteId: noteId,
              patientId: input.patientId,
              providerId: patient.providerId,
              reason: input.escalationReason || "Provider review requested.",
              escalationStatus: "pending",
            });
            const provider = await getProviderById(patient.providerId);
            if (provider?.userId) {
              await createNotification({
                userId: provider.userId,
                type: "escalation",
                title: "Patient escalated for review",
                content: `${patient.name} was escalated: ${input.escalationReason || "Provider review requested."}`,
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

  // ---- Billing ----
  billing: router({
    list: protectedProcedure
      .input(z.object({ month: z.string().optional(), status: z.string().optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "billing"]);
        return getEnrichedBilling(input?.month || currentMonth(), input?.status);
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
  }),
  providers: router({
    all: protectedProcedure.query(async () => getAllProviders()),
    listByClinic: protectedProcedure.input(z.number()).query(async ({ input }) => getProvidersByClinic(input)),
    getById: protectedProcedure.input(z.number()).query(async ({ input }) => getProviderById(input)),
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
      .input(z.object({ month: z.string().optional() }).optional())
      .query(async ({ input, ctx }) => {
        requireRole(ctx, ["admin", "billing"]);
        const month = input?.month || currentMonth();
        const [stats, staffPerf, clinicPerf, trend] = await Promise.all([
          getAdminStats(month),
          getStaffPerformance(month),
          getClinicPerformance(month),
          getDailyCompletionTrend(month),
        ]);
        return { month, stats, staffPerformance: staffPerf, clinicPerformance: clinicPerf, dailyTrend: trend };
      }),
  }),
});

export type AppRouter = typeof appRouter;

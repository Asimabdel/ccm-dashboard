import { protectedProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isValidDateStr, isValidTimeStr, localDateStr, addDays } from "../../shared/workforce";
import * as wf from "../workforceDb";

// Managing the workforce (roles, schedules, approvals, scorecards) is admin-only;
// the `me` procedures are open to every signed-in employee for their own data.
function requireAdmin(ctx: { user: { role: string } }) {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this resource." });
  }
}

/** Turn a data-layer `{ error }` result into a user-facing BAD_REQUEST. */
function unwrap<T extends object>(res: T | { error: string }): T {
  if ("error" in res) throw new TRPCError({ code: "BAD_REQUEST", message: res.error });
  return res;
}

const dateStr = z.string().refine(isValidDateStr, "Expected a YYYY-MM-DD date");
const timeStr = z.string().refine(isValidTimeStr, "Expected an HH:MM time");
const range = z.object({ from: dateStr, to: dateStr });

export const workforceRouter = router({
  // ---- Job roles & duties ----
  roles: router({
    list: protectedProcedure.query(async ({ ctx }) => { requireAdmin(ctx); return wf.listJobRoles(); }),
    save: protectedProcedure
      .input(z.object({ id: z.number().optional(), name: z.string().trim().min(1).max(120), summary: z.string().max(2000).nullish() }))
      .mutation(async ({ input, ctx }) => { requireAdmin(ctx); return wf.saveJobRole(input); }),
    archive: protectedProcedure.input(z.number()).mutation(async ({ input, ctx }) => { requireAdmin(ctx); await wf.archiveJobRole(input); return { success: true }; }),
    seedMaTemplate: protectedProcedure.mutation(async ({ ctx }) => { requireAdmin(ctx); return wf.seedMaTemplate(); }),
    saveDuty: protectedProcedure
      .input(z.object({
        id: z.number().optional(), jobRoleId: z.number(), category: z.string().trim().min(1).max(80),
        title: z.string().trim().min(1).max(255), detail: z.string().max(2000).nullish(),
        frequency: z.enum(["daily", "weekly", "monthly", "as_needed"]), sortOrder: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => { requireAdmin(ctx); return wf.saveDuty(input); }),
    archiveDuty: protectedProcedure.input(z.number()).mutation(async ({ input, ctx }) => { requireAdmin(ctx); await wf.archiveDuty(input); return { success: true }; }),
  }),

  // ---- People (employment profiles) ----
  people: router({
    list: protectedProcedure.query(async ({ ctx }) => { requireAdmin(ctx); return wf.listPeople(); }),
    // Roster-only employee: on the schedule and scorecards, but no login yet.
    add: protectedProcedure
      .input(z.object({ name: z.string().trim().min(1).max(255), jobRoleId: z.number().nullish(), homeClinicId: z.number().nullish() }))
      .mutation(async ({ input, ctx }) => { requireAdmin(ctx); return unwrap(await wf.addEmployee(input)); }),
    saveProfile: protectedProcedure
      .input(z.object({
        userId: z.number(), jobRoleId: z.number().nullable(), homeClinicId: z.number().nullable(), canFloat: z.boolean(),
        usesTimeClock: z.boolean().optional(), clockStartDate: dateStr.nullish(), hoursPerWeek: z.number().min(0).max(80).nullish(), hireDate: dateStr.nullish(), active: z.boolean(),
        moveUpcomingShifts: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => { requireAdmin(ctx); return { success: true, ...(await wf.saveProfile(input)) }; }),
  }),

  // ---- Schedule ----
  schedule: router({
    range: protectedProcedure
      .input(range.extend({ clinicId: z.number().optional() }))
      .query(async ({ input, ctx }) => { requireAdmin(ctx); return wf.getSchedule(input.from, input.to, input.clinicId); }),
    saveShift: protectedProcedure
      .input(z.object({
        id: z.number().optional(), userId: z.number(), clinicId: z.number(), date: dateStr,
        startTime: timeStr, endTime: timeStr, note: z.string().max(500).nullish(),
      }))
      .mutation(async ({ input, ctx }) => { requireAdmin(ctx); return unwrap(await wf.saveShift({ ...input, createdByUserId: ctx.user.id })); }),
    deleteShift: protectedProcedure.input(z.number()).mutation(async ({ input, ctx }) => { requireAdmin(ctx); await wf.deleteShift(input); return { success: true }; }),
    copyWeek: protectedProcedure
      .input(z.object({ fromWeekStart: dateStr, toWeekStart: dateStr, clinicId: z.number().optional() }))
      .mutation(async ({ input, ctx }) => { requireAdmin(ctx); return wf.copyWeek(input.fromWeekStart, input.toWeekStart, input.clinicId, ctx.user.id); }),
    callOut: protectedProcedure
      .input(z.object({ shiftId: z.number(), note: z.string().max(500).nullish() }))
      .mutation(async ({ input, ctx }) => {
        requireAdmin(ctx);
        const shift = await wf.markCalledOut(input.shiftId, input.note ?? null, ctx.user.name ?? null);
        if (!shift) throw new TRPCError({ code: "NOT_FOUND", message: "Shift not found." });
        return { success: true };
      }),
    undoCallOut: protectedProcedure.input(z.number()).mutation(async ({ input, ctx }) => { requireAdmin(ctx); await wf.undoCallOut(input); return { success: true }; }),
    coverageCandidates: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => { requireAdmin(ctx); return wf.coverageCandidates(input); }),
    assignCoverage: protectedProcedure
      .input(z.object({ shiftId: z.number(), userId: z.number() }))
      .mutation(async ({ input, ctx }) => { requireAdmin(ctx); return unwrap(await wf.assignCoverage(input.shiftId, input.userId, ctx.user.id)); }),
  }),

  // ---- Time off (manager side) ----
  timeOff: router({
    list: protectedProcedure
      .input(z.object({ status: z.enum(["pending", "approved", "denied", "cancelled"]).optional() }).optional())
      .query(async ({ input, ctx }) => { requireAdmin(ctx); return wf.listTimeOff({ status: input?.status }); }),
    decide: protectedProcedure
      .input(z.object({ id: z.number(), status: z.enum(["approved", "denied"]), managerNote: z.string().max(500).nullish() }))
      .mutation(async ({ input, ctx }) => {
        requireAdmin(ctx);
        const res = await wf.decideTimeOff({ ...input, decidedByUserId: ctx.user.id });
        if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "Request not found." });
        return res;
      }),
  }),

  // ---- Today board, time clock review, performance ----
  board: protectedProcedure
    .input(z.object({ date: dateStr.optional() }).optional())
    .query(async ({ input, ctx }) => { requireAdmin(ctx); return wf.getDayBoard(input?.date ?? localDateStr()); }),

  punches: router({
    list: protectedProcedure
      .input(range.extend({ userId: z.number().optional() }))
      .query(async ({ input, ctx }) => { requireAdmin(ctx); return wf.listPunches(input.from, input.to, input.userId); }),
    edit: protectedProcedure
      .input(z.object({ id: z.number(), clockInAt: z.date(), clockOutAt: z.date().nullable(), note: z.string().max(500).nullish() }))
      .mutation(async ({ input, ctx }) => { requireAdmin(ctx); return unwrap(await wf.editPunch({ ...input, editedByUserId: ctx.user.id })); }),
    add: protectedProcedure
      .input(z.object({ userId: z.number(), clockInAt: z.date(), clockOutAt: z.date().nullable(), note: z.string().max(500).nullish() }))
      .mutation(async ({ input, ctx }) => { requireAdmin(ctx); return unwrap(await wf.addPunch({ ...input, editedByUserId: ctx.user.id })); }),
    delete: protectedProcedure.input(z.number()).mutation(async ({ input, ctx }) => { requireAdmin(ctx); await wf.deletePunch(input); return { success: true }; }),
  }),

  // Hours, overtime and missed clock-outs per person — for payroll.
  timesheet: protectedProcedure
    .input(range)
    .query(async ({ input, ctx }) => {
      requireAdmin(ctx);
      if (input.to < input.from) throw new TRPCError({ code: "BAD_REQUEST", message: "The end date can't be before the start date." });
      return wf.getTimesheet(input.from, input.to);
    }),

  // ---- Team schedule: every employee sees who works where, and who is in now ----
  team: router({
    week: protectedProcedure
      .input(range)
      .query(async ({ input, ctx }) => {
        if (ctx.user.role === "user") throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this resource." });
        if (input.to < input.from || input.to > addDays(input.from, 41)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a range of up to 6 weeks." });
        return wf.getTeamWeek(input.from, input.to);
      }),
  }),

  performance: router({
    scorecards: protectedProcedure
      .input(range.extend({ clinicId: z.number().optional() }))
      .query(async ({ input, ctx }) => { requireAdmin(ctx); return wf.getScorecards(input.from, input.to, input.clinicId); }),
    notes: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => { requireAdmin(ctx); return wf.listPerformanceNotes(input); }),
    addNote: protectedProcedure
      .input(z.object({
        userId: z.number(), kind: z.enum(["kudos", "coaching", "review"]),
        rating: z.number().int().min(1).max(5).nullish(), note: z.string().trim().min(1).max(4000),
      }))
      .mutation(async ({ input, ctx }) => { requireAdmin(ctx); await wf.addPerformanceNote({ ...input, authorUserId: ctx.user.id }); return { success: true }; }),
  }),

  // ---- Self-service: every procedure here is scoped to ctx.user.id ----
  me: router({
    today: protectedProcedure.query(async ({ ctx }) => wf.getMyDay(ctx.user.id)),
    clockIn: protectedProcedure.mutation(async ({ ctx }) => unwrap(await wf.clockIn(ctx.user.id))),
    clockOut: protectedProcedure.mutation(async ({ ctx }) => unwrap(await wf.clockOut(ctx.user.id))),
    toggleDuty: protectedProcedure
      .input(z.object({ dutyId: z.number(), done: z.boolean() }))
      .mutation(async ({ input, ctx }) => unwrap(await wf.toggleDuty(ctx.user.id, input.dutyId, input.done))),
    schedule: protectedProcedure
      .input(range.optional())
      .query(async ({ input, ctx }) => {
        const from = input?.from ?? localDateStr();
        return wf.getMySchedule(ctx.user.id, from, input?.to ?? addDays(from, 27));
      }),
    requestTimeOff: protectedProcedure
      .input(z.object({ startDate: dateStr, endDate: dateStr, type: z.enum(["pto", "sick", "unpaid", "other"]), reason: z.string().max(1000).nullish() }))
      .mutation(async ({ input, ctx }) => {
        if (input.endDate < input.startDate) throw new TRPCError({ code: "BAD_REQUEST", message: "The end date can't be before the start date." });
        return wf.requestTimeOff({ ...input, userId: ctx.user.id, userName: ctx.user.name ?? null });
      }),
    cancelTimeOff: protectedProcedure.input(z.number()).mutation(async ({ input, ctx }) => { await wf.cancelTimeOff(input, ctx.user.id); return { success: true }; }),
  }),
});

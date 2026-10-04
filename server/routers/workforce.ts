import { protectedProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isValidDateStr, isValidTimeStr, localDateStr, addDays } from "../../shared/workforce";
import * as wf from "../workforceDb";
import { officeClinicIds, officeStaff } from "../workspaceDb";
import * as sched from "../scheduleRequestsDb";
import * as punchFix from "../punchRequestsDb";
import * as offers from "../shiftOffersDb";
import * as pay from "../payPeriodsDb";
import * as cal from "../calendarFeed";

// Managing the workforce (schedules, approvals, time clock, scorecards) is for admins (everyone)
// and office managers (the staff whose home clinic is their office, at that clinic). Job-role
// definitions are practice-wide, so admin-only. The `me` procedures are open to every signed-in
// employee for their own data.
type Ctx = { user: { id: number; role: string } };
interface Manager { clinicId: number | null; staff: Set<number> | null }
const forbid = (message = "You do not have access to this resource.") => new TRPCError({ code: "FORBIDDEN", message });

function requireAdmin(ctx: Ctx) {
  if (ctx.user.role !== "admin") throw forbid();
}

/** Admin: everyone. Office manager: their office's staff, at their office. */
async function requireManager(ctx: Ctx): Promise<Manager> {
  if (ctx.user.role === "admin") return { clinicId: null, staff: null };
  if (ctx.user.role !== "office_manager") throw forbid();
  const [clinicId] = await officeClinicIds(ctx.user.id);
  if (!clinicId) throw forbid("Your office isn't set yet. Ask an admin to set your home clinic in Workforce.");
  return { clinicId, staff: await officeStaff(ctx.user.id, clinicId) };
}
const manages = (m: Manager, userId: number) => !m.staff || m.staff.has(userId);
function needPerson(m: Manager, userId: number) {
  if (!manages(m, userId)) throw forbid("That person isn't on your office's staff.");
}
function needClinic(m: Manager, clinicId: number | null | undefined) {
  if (m.clinicId && clinicId !== m.clinicId) throw forbid("You can only manage your own office.");
}
async function needShift(m: Manager, shiftId: number) {
  const s = await wf.getShiftById(shiftId);
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Shift not found." });
  needClinic(m, s.clinicId);
  return s;
}

/** Turn a data-layer `{ error }` result into a user-facing BAD_REQUEST. */
/** The site's address for links (the calendar feed). */
function calendarBase(ctx: unknown): string {
  const req = (ctx as { req?: { headers?: Record<string, string | string[] | undefined>; protocol?: string } }).req;
  const h = req?.headers ?? {};
  const host = String(h["x-forwarded-host"] ?? h.host ?? "mypcpcare.com").split(",")[0]!.trim();
  const proto = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
  return `${proto}://${host}`;
}

function unwrap<T extends object>(res: T | { error: string }): T {
  if ("error" in res) throw new TRPCError({ code: "BAD_REQUEST", message: res.error });
  return res;
}

const dateStr = z.string().refine(isValidDateStr, "Expected a YYYY-MM-DD date");
const timeStr = z.string().refine(isValidTimeStr, "Expected an HH:MM time");
const range = z.object({ from: dateStr, to: dateStr });
const dayPlan = z.object({ work: z.boolean(), start: timeStr, end: timeStr, clinicId: z.number().int().positive().nullable() });
const weekPattern = z.object({ mon: dayPlan, tue: dayPlan, wed: dayPlan, thu: dayPlan, fri: dayPlan, sat: dayPlan, sun: dayPlan });

/** Schedule-request errors are the user's to fix. */
async function schedRun<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof sched.ScheduleError || e instanceof punchFix.PunchRequestError || e instanceof offers.ShiftOfferError || e instanceof pay.PayPeriodError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
    throw e;
  }
}

export const workforceRouter = router({
  // ---- Job roles & duties (practice-wide: admins edit; managers read) ----
  roles: router({
    list: protectedProcedure.query(async ({ ctx }) => { await requireManager(ctx); return wf.listJobRoles(); }),
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
    list: protectedProcedure.query(async ({ ctx }) => {
      const m = await requireManager(ctx);
      return (await wf.listPeople()).filter((p) => manages(m, p.userId));
    }),
    // Roster-only employee: on the schedule and scorecards, but no login yet.
    add: protectedProcedure
      .input(z.object({ name: z.string().trim().min(1).max(255), jobRoleId: z.number().nullish(), homeClinicId: z.number().nullish() }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        // An office manager's new people belong to their office.
        return unwrap(await wf.addEmployee({ ...input, homeClinicId: m.clinicId ?? input.homeClinicId }));
      }),
    saveProfile: protectedProcedure
      .input(z.object({
        userId: z.number(), jobRoleId: z.number().nullable(), homeClinicId: z.number().nullable(), canFloat: z.boolean(),
        usesTimeClock: z.boolean().optional(), clockStartDate: dateStr.nullish(), hoursPerWeek: z.number().min(0).max(80).nullish(), hireDate: dateStr.nullish(), active: z.boolean(),
        moveUpcomingShifts: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        needPerson(m, input.userId);
        // Moving someone to another office is an admin's call.
        needClinic(m, input.homeClinicId);
        return { success: true, ...(await wf.saveProfile(input)) };
      }),
  }),

  // ---- Schedule ----
  schedule: router({
    range: protectedProcedure
      .input(range.extend({ clinicId: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        const res = await wf.getSchedule(input.from, input.to, m.clinicId ?? input.clinicId);
        return m.staff ? { ...res, timeOff: res.timeOff.filter((t) => manages(m, t.userId)) } : res;
      }),
    saveShift: protectedProcedure
      .input(z.object({
        id: z.number().optional(), userId: z.number(), clinicId: z.number().nullable(), date: dateStr,
        startTime: timeStr, endTime: timeStr, note: z.string().max(500).nullish(),
      }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        needPerson(m, input.userId);
        needClinic(m, input.clinicId);
        if (input.id) await needShift(m, input.id);
        return unwrap(await wf.saveShift({ ...input, createdByUserId: ctx.user.id }));
      }),
    deleteShift: protectedProcedure.input(z.number()).mutation(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      await needShift(m, input);
      await wf.deleteShift(input);
      return { success: true };
    }),
    copyWeek: protectedProcedure
      .input(z.object({ fromWeekStart: dateStr, toWeekStart: dateStr, clinicId: z.number().optional() }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        return wf.copyWeek(input.fromWeekStart, input.toWeekStart, m.clinicId ?? input.clinicId, ctx.user.id);
      }),
    callOut: protectedProcedure
      .input(z.object({ shiftId: z.number(), note: z.string().max(500).nullish() }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        await needShift(m, input.shiftId);
        const shift = await wf.markCalledOut(input.shiftId, input.note ?? null, ctx.user.name ?? null);
        if (!shift) throw new TRPCError({ code: "NOT_FOUND", message: "Shift not found." });
        return { success: true };
      }),
    undoCallOut: protectedProcedure.input(z.number()).mutation(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      await needShift(m, input);
      await wf.undoCallOut(input);
      await offers.closeOffersForShift(input, ctx.user.id, "The call-out was undone, so the shift isn't up for grabs anymore.");
      return { success: true };
    }),
    coverageCandidates: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      await needShift(m, input);
      return wf.coverageCandidates(input);
    }),
    // Covering a shift at their office may use someone from another office (that's what floaters are for).
    assignCoverage: protectedProcedure
      .input(z.object({ shiftId: z.number(), userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        await needShift(m, input.shiftId);
        const r = unwrap(await wf.assignCoverage(input.shiftId, input.userId, ctx.user.id));
        // The call-out was posted for coworkers: it's covered now.
        await offers.closeOffersForShift(input.shiftId, ctx.user.id, "Your manager arranged coverage, so the shift isn't up for grabs anymore.");
        return r;
      }),
  }),

  // ---- Time off (manager side) ----
  timeOff: router({
    list: protectedProcedure
      .input(z.object({ status: z.enum(["pending", "approved", "denied", "cancelled"]).optional() }).optional())
      .query(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        return (await wf.listTimeOff({ status: input?.status })).filter((t) => manages(m, t.userId));
      }),
    /** One request (for the Approve / Deny buttons on its task in My Work). */
    get: protectedProcedure.input(z.number().int().positive()).query(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      const [req] = await wf.listTimeOff({ id: input });
      if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "Request not found." });
      needPerson(m, req.userId);
      return req;
    }),
    /** Who every request goes to (an admin), and the admins who could. */
    approver: protectedProcedure.query(async ({ ctx }) => {
      await requireManager(ctx);
      return { approver: await wf.getTimeOffApprover(), admins: ctx.user.role === "admin" ? await wf.listAdmins() : [] };
    }),
    setApprover: protectedProcedure.input(z.object({ userId: z.number().int().positive().nullable() })).mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") throw forbid("Only an admin can choose who time-off requests go to.");
      try {
        return await wf.setTimeOffApprover(input.userId, ctx.user.id);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error).message });
      }
    }),
    decide: protectedProcedure
      .input(z.object({ id: z.number(), status: z.enum(["approved", "denied"]), managerNote: z.string().max(500).nullish() }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        const req = await wf.getTimeOffById(input.id);
        if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "Request not found." });
        needPerson(m, req.userId);
        const res = await wf.decideTimeOff({ ...input, decidedByUserId: ctx.user.id });
        if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "Request not found." });
        return res;
      }),
  }),

  // ---- Today board, time clock review, performance ----
  board: protectedProcedure
    .input(z.object({ date: dateStr.optional() }).optional())
    .query(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      const board = await wf.getDayBoard(input?.date ?? localDateStr());
      if (!m.clinicId) return board;
      const pending = (await wf.listTimeOff({ status: "pending" })).filter((t) => manages(m, t.userId)).length;
      return { ...board, pendingTimeOff: pending, clinics: board.clinics.filter((c) => c.id === m.clinicId) };
    }),

  punches: router({
    list: protectedProcedure
      .input(range.extend({ userId: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        return (await wf.listPunches(input.from, input.to, input.userId)).filter((p) => manages(m, p.userId));
      }),
    edit: protectedProcedure
      .input(z.object({ id: z.number(), clockInAt: z.date(), clockOutAt: z.date().nullable(), note: z.string().max(500).nullish() }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        const p = await wf.getPunchById(input.id);
        if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Punch not found." });
        needPerson(m, p.userId);
        await schedRun(async () => { await pay.assertOpenDate(p.workDate); await pay.assertOpenDate(localDateStr(input.clockInAt)); });
        return unwrap(await wf.editPunch({ ...input, editedByUserId: ctx.user.id }));
      }),
    add: protectedProcedure
      .input(z.object({ userId: z.number(), clockInAt: z.date(), clockOutAt: z.date().nullable(), note: z.string().max(500).nullish() }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        needPerson(m, input.userId);
        await schedRun(() => pay.assertOpenDate(localDateStr(input.clockInAt)));
        return unwrap(await wf.addPunch({ ...input, editedByUserId: ctx.user.id }));
      }),
    delete: protectedProcedure.input(z.number()).mutation(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      const p = await wf.getPunchById(input);
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Punch not found." });
      needPerson(m, p.userId);
      await schedRun(() => pay.assertOpenDate(p.workDate));
      await wf.deletePunch(input);
      return { success: true };
    }),
  }),

  // Hours, overtime and missed clock-outs per person — for payroll.
  timesheet: protectedProcedure
    .input(range)
    .query(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      if (input.to < input.from) throw new TRPCError({ code: "BAD_REQUEST", message: "The end date can't be before the start date." });
      const sheet = await wf.getTimesheet(input.from, input.to);
      return m.staff ? { ...sheet, people: sheet.people.filter((p) => manages(m, p.userId)) } : sheet;
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
      .query(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        return (await wf.getScorecards(input.from, input.to, m.clinicId ?? input.clinicId)).filter((r) => manages(m, r.userId));
      }),
    notes: protectedProcedure.input(z.number()).query(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      needPerson(m, input);
      return wf.listPerformanceNotes(input);
    }),
    addNote: protectedProcedure
      .input(z.object({
        userId: z.number(), kind: z.enum(["kudos", "coaching", "review"]),
        rating: z.number().int().min(1).max(5).nullish(), note: z.string().trim().min(1).max(4000),
      }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        needPerson(m, input.userId);
        await wf.addPerformanceNote({ ...input, authorUserId: ctx.user.id });
        return { success: true };
      }),
  }),

  // ---- Self-service: every procedure here is scoped to ctx.user.id ----
  me: router({
    today: protectedProcedure.query(async ({ ctx }) => wf.getMyDay(ctx.user.id)),
    clockIn: protectedProcedure.mutation(async ({ ctx }) => unwrap(await wf.clockIn(ctx.user.id))),
    clockOut: protectedProcedure.mutation(async ({ ctx }) => unwrap(await wf.clockOut(ctx.user.id))),
    /** Lunch: Start lunch clocks out for a break; End lunch clocks back in (not counted late). */
    startLunch: protectedProcedure.mutation(async ({ ctx }) => unwrap(await wf.clockOut(ctx.user.id, "lunch"))),
    endLunch: protectedProcedure.mutation(async ({ ctx }) => unwrap(await wf.clockIn(ctx.user.id))),
    /** Shift reminder texts to my own cell (I turn them on myself). */
    reminders: protectedProcedure.query(async ({ ctx }) => wf.getMyReminders(ctx.user.id)),
    saveReminders: protectedProcedure
      .input(z.object({ mobilePhone: z.string().max(20).nullable(), textReminders: z.boolean() }))
      .mutation(async ({ input, ctx }) => unwrap(await wf.saveMyReminders(ctx.user.id, input))),
    /** On time this week / last week. */
    attendance: protectedProcedure.query(async ({ ctx }) => wf.getMyAttendance(ctx.user.id)),
    /** Fix my punch: my punches on a day, my requests, ask, cancel. */
    punchDay: protectedProcedure.input(z.object({ date: dateStr })).query(async ({ input, ctx }) => punchFix.myPunchDay(ctx.user.id, input.date)),
    punchRequests: protectedProcedure.query(async ({ ctx }) => punchFix.myPunchRequests(ctx.user.id)),
    requestPunchFix: protectedProcedure
      .input(z.object({ workDate: dateStr, punchId: z.number().int().positive().nullish(), clockIn: timeStr.nullish(), clockOut: timeStr.nullish(), reason: z.string().max(500) }))
      .mutation(async ({ input, ctx }) => schedRun(() => punchFix.requestPunchFix({ id: ctx.user.id, name: ctx.user.name ?? null, role: ctx.user.role }, input))),
    cancelPunchRequest: protectedProcedure.input(z.number().int().positive()).mutation(async ({ input, ctx }) => schedRun(async () => { await punchFix.cancelPunchRequest(ctx.user.id, input); return { success: true }; })),
    /** Call-outs and swaps: "I can't make it", "Offer this shift", shifts I could take, and my offers. */
    callOut: protectedProcedure.input(z.object({ shiftId: z.number().int().positive(), reason: z.string().max(200).nullish() }))
      .mutation(async ({ input, ctx }) => schedRun(() => offers.callOut({ id: ctx.user.id, name: ctx.user.name ?? null, role: ctx.user.role }, input.shiftId, input.reason ?? null))),
    offerShift: protectedProcedure.input(z.object({ shiftId: z.number().int().positive(), note: z.string().max(300).nullish() }))
      .mutation(async ({ input, ctx }) => schedRun(() => offers.offerShift({ id: ctx.user.id, name: ctx.user.name ?? null, role: ctx.user.role }, input.shiftId, input.note ?? null))),
    cancelOffer: protectedProcedure.input(z.number().int().positive()).mutation(async ({ input, ctx }) => schedRun(async () => { await offers.cancelOffer(ctx.user.id, input); return { success: true }; })),
    openShifts: protectedProcedure.query(async ({ ctx }) => offers.openShiftsFor(ctx.user.id)),
    myOffers: protectedProcedure.query(async ({ ctx }) => offers.myOffers(ctx.user.id)),
    claimShift: protectedProcedure.input(z.number().int().positive()).mutation(async ({ input, ctx }) => schedRun(() => offers.claimShift({ id: ctx.user.id, name: ctx.user.name ?? null, role: ctx.user.role }, input))),
    /** My calendar link (Google / Apple / Outlook). */
    calendar: protectedProcedure.query(async ({ ctx }) => {
      const t = await cal.myCalendarToken(ctx.user.id);
      return { url: t.token ? `${calendarBase(ctx)}/api/calendar/${t.token}.ics` : null, hasProfile: t.hasProfile };
    }),
    calendarOn: protectedProcedure.mutation(async ({ ctx }) => {
      const token = await cal.newCalendarToken(ctx.user.id);
      if (!token) throw new TRPCError({ code: "BAD_REQUEST", message: "Your workforce profile isn't set up yet. Ask your manager." });
      return { url: `${calendarBase(ctx)}/api/calendar/${token}.ics` };
    }),
    calendarOff: protectedProcedure.mutation(async ({ ctx }) => { await cal.turnOffCalendar(ctx.user.id); return { success: true }; }),
    /** My hours this pay period and last, and confirming them. */
    payPeriods: protectedProcedure.query(async ({ ctx }) => pay.myPayPeriods(ctx.user.id)),
    confirmHours: protectedProcedure.input(z.object({ start: dateStr })).mutation(async ({ input, ctx }) => schedRun(() => pay.confirmMyHours(ctx.user.id, input.start))),
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
    /** My usual week: set it once; after that changes go to the manager. */
    week: protectedProcedure.query(async ({ ctx }) => sched.myWeek(ctx.user.id, ctx.user.role)),
    submitWeek: protectedProcedure
      .input(z.object({ pattern: weekPattern, effectiveFrom: dateStr, note: z.string().max(500).nullish() }))
      .mutation(async ({ input, ctx }) => schedRun(() => sched.submitWeek({ id: ctx.user.id, name: ctx.user.name ?? null, role: ctx.user.role }, input))),
    cancelWeekRequest: protectedProcedure.input(z.number().int().positive()).mutation(async ({ input, ctx }) => schedRun(async () => { await sched.cancelRequest(ctx.user.id, input); return { success: true }; })),
  }),

  // ---- Shifts taken by coworkers (manager approves) ----
  shiftOffers: router({
    get: protectedProcedure.input(z.number().int().positive()).query(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      const o = await offers.getOffer(input);
      if (!o) throw new TRPCError({ code: "NOT_FOUND", message: "Not found." });
      needPerson(m, o.offeredByUserId);
      return o;
    }),
    decide: protectedProcedure
      .input(z.object({ offerId: z.number().int().positive(), approve: z.boolean(), managerNote: z.string().max(300).nullish() }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        const o = await offers.getOffer(input.offerId);
        if (!o) throw new TRPCError({ code: "NOT_FOUND", message: "Not found." });
        needPerson(m, o.offeredByUserId);
        return schedRun(() => offers.decideOffer({ ...input, decidedBy: { id: ctx.user.id, name: (ctx.user as { name?: string | null }).name ?? null } }));
      }),
  }),

  // ---- Pay periods (every 2 weeks): approve hours, close, QuickBooks sheet ----
  payPeriods: router({
    summary: protectedProcedure.input(z.object({ start: dateStr.nullish() })).query(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      const s = await pay.paySettings();
      const { recentPayPeriods } = await import("../../shared/payPeriods");
      // Default: the last finished period (on a Sunday, the one whose Saturday just passed).
      const today = localDateStr();
      const start = input.start ?? recentPayPeriods(today, s.anchor, 2).find((p) => p.end < today)!.start;
      return pay.periodSummary(start, (userId) => manages(m, userId));
    }),
    approve: protectedProcedure.input(z.object({ userId: z.number().int().positive(), start: dateStr })).mutation(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      needPerson(m, input.userId);
      return schedRun(() => pay.approveHours(ctx.user.id, input.userId, input.start));
    }),
    setLocked: protectedProcedure.input(z.object({ start: dateStr, locked: z.boolean() })).mutation(async ({ input, ctx }) => {
      requireAdmin(ctx);
      await schedRun(() => pay.setLocked(ctx.user.id, input.start, input.locked));
      return { success: true };
    }),
    setAnchor: protectedProcedure.input(z.object({ anchor: dateStr })).mutation(async ({ input, ctx }) => {
      requireAdmin(ctx);
      await schedRun(() => pay.setAnchor(ctx.user.id, input.anchor));
      return { success: true };
    }),
  }),

  // ---- Fix-my-punch requests (manager side) ----
  punchRequests: router({
    get: protectedProcedure.input(z.number().int().positive()).query(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      const r = await punchFix.getPunchRequest(input);
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Request not found." });
      needPerson(m, r.userId);
      return r;
    }),
    decide: protectedProcedure
      .input(z.object({ id: z.number().int().positive(), approve: z.boolean(), managerNote: z.string().max(500).nullish() }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        const r = await punchFix.getPunchRequest(input.id);
        if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Request not found." });
        needPerson(m, r.userId);
        return schedRun(() => punchFix.decidePunchRequest({ ...input, decidedBy: { id: ctx.user.id, name: (ctx.user as { name?: string | null }).name ?? null } }));
      }),
  }),

  // ---- Staff schedule change requests (manager side) ----
  scheduleRequests: router({
    /** One request (for the Approve / Deny box on its task in My Work). */
    get: protectedProcedure.input(z.number().int().positive()).query(async ({ input, ctx }) => {
      const m = await requireManager(ctx);
      const r = await sched.getRequest(input);
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Request not found." });
      needPerson(m, r.userId);
      return r;
    }),
    decide: protectedProcedure
      .input(z.object({ id: z.number().int().positive(), approve: z.boolean(), managerNote: z.string().max(500).nullish() }))
      .mutation(async ({ input, ctx }) => {
        const m = await requireManager(ctx);
        const r = await sched.getRequest(input.id);
        if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Request not found." });
        needPerson(m, r.userId);
        return schedRun(() => sched.decideRequest({ ...input, decidedBy: { id: ctx.user.id, name: (ctx.user as { name?: string | null }).name ?? null } }));
      }),
  }),
});

import { protectedProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isValidDateStr } from "../../shared/workforce";
import {
  FLOW_COLUMNS,
  OPPORTUNITY_CATEGORY_LIST,
  TASK_CATEGORIES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  WORKSPACE_CAPS,
  can,
  parseScheduleCsv,
  type ScheduleMapping,
  type WorkspaceCap,
} from "../../shared/workspace";
import * as ws from "../workspaceDb";

// Every Workspace procedure resolves an actor first: who is calling and which
// clinics they may see. Medical assistants are limited to the clinics they work
// in (home clinic, today's shifts, or all if they float); everyone else sees all.
type Ctx = { user: { id: number; name: string | null; role: string }; req?: { headers?: Record<string, unknown>; ip?: string } };

async function actorFor(ctx: Ctx, cap: WorkspaceCap): Promise<ws.WorkspaceActor> {
  if (!can(ctx.user.role, cap)) throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this resource." });
  const clinicIds = ctx.user.role === "medical_assistant" ? await ws.getMaClinicIds(ctx.user.id) : null;
  const fwd = ctx.req?.headers?.["x-forwarded-for"];
  return {
    id: ctx.user.id,
    name: ctx.user.name,
    role: ctx.user.role,
    clinicIds,
    ip: (typeof fwd === "string" ? fwd.split(",")[0] : null) || ctx.req?.ip || null,
  };
}

/** Map data-layer errors to tRPC errors with user-safe messages. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ws.WorkspaceError) throw new TRPCError({ code: e.code, message: e.message });
    throw e;
  }
}

const dateStr = z.string().refine(isValidDateStr, "Expected a YYYY-MM-DD date");
const clinicId = z.number().int().positive().nullish();
const flowStatus = z.enum([...FLOW_COLUMNS, "no_show", "cancelled"] as [string, ...string[]]);
const mappingSchema = z.record(z.string(), z.number().int().min(-1).max(200)).optional();
const csvText = z.string().min(1).max(5_000_000);

export const workspaceRouter = router({
  /** What this person can do in the Workspace, and which clinics they can pick. */
  context: protectedProcedure.query(async ({ ctx }) => {
    const role = ctx.user.role;
    const caps = Object.fromEntries(Object.keys(WORKSPACE_CAPS).map((k) => [k, can(role, k as WorkspaceCap)])) as Record<WorkspaceCap, boolean>;
    if (!caps.tasks && !caps.playbooksView) return { caps, clinics: [], limitedToClinics: false, noClinicAccess: false };
    const actor = await actorFor(ctx, caps.tasks ? "tasks" : "playbooksView");
    const clinics = await ws.listClinics(actor);
    return { caps, clinics, limitedToClinics: actor.clinicIds !== null, noClinicAccess: actor.clinicIds !== null && actor.clinicIds.length === 0 };
  }),

  home: protectedProcedure.input(z.object({ clinicId })).query(async ({ ctx, input }) => {
    const actor = await actorFor(ctx, "tasks");
    return run(() =>
      ws.homeDashboard(actor, {
        clinicId: input.clinicId,
        // CCM/BHI numbers and opportunity lists are PHI-adjacent; keep them off the MA home.
        includeCare: can(ctx.user.role, "patientFull") || ctx.user.role === "billing",
        includeOpportunities: can(ctx.user.role, "opportunitiesView"),
      }),
    );
  }),

  tasks: router({
    list: protectedProcedure
      .input(
        z.object({
          view: z.enum(["mine", "team", "due_today", "overdue", "high", "completed", "all"]),
          clinicId,
          status: z.enum(TASK_STATUSES as [string, ...string[]]).optional(),
          priority: z.enum(TASK_PRIORITIES as [string, ...string[]]).optional(),
          category: z.enum(TASK_CATEGORIES as [string, ...string[]]).optional(),
          due: z.enum(["overdue", "today", "week", "none"]).optional(),
          q: z.string().max(100).optional(),
          patientId: z.number().int().positive().optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "tasks");
        return run(() => ws.listTasks(actor, input as ws.TaskFilters));
      }),
    counts: protectedProcedure.input(z.object({ clinicId })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "tasks");
      return run(() => ws.taskCounts(actor, input.clinicId));
    }),
    detail: protectedProcedure.input(z.number().int().positive()).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "tasks");
      const t = await run(() => ws.taskDetail(actor, input));
      // MAs see the patient's name only; phone/DOB stay behind the full-record roles.
      if (!can(ctx.user.role, "patientFull")) return { ...t, patientDob: null, patientPhone: ctx.user.role === "medical_assistant" ? t.patientPhone : null };
      return t;
    }),
    assignees: protectedProcedure.query(async ({ ctx }) => {
      const actor = await actorFor(ctx, "assignTasks");
      return run(() => ws.assignableUsers(actor));
    }),
    create: protectedProcedure
      .input(
        z.object({
          title: z.string().trim().min(1).max(255),
          description: z.string().max(5000).nullish(),
          patientId: z.number().int().positive().nullish(),
          clinicId,
          assignedUserId: z.number().int().positive().nullish(),
          assignedRole: z.enum(["admin", "staff", "provider", "billing", "front_desk", "medical_assistant"]).nullish(),
          priority: z.enum(TASK_PRIORITIES as [string, ...string[]]),
          category: z.enum(TASK_CATEGORIES as [string, ...string[]]),
          dueDate: dateStr.nullish(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "tasks");
        const assigningOthers = (input.assignedUserId && input.assignedUserId !== ctx.user.id) || !!input.assignedRole;
        if (assigningOthers && !can(ctx.user.role, "assignTasks")) throw new TRPCError({ code: "FORBIDDEN", message: "You can only create tasks for yourself." });
        return run(() => ws.createTask(actor, input as ws.CreateTaskInput));
      }),
    update: protectedProcedure
      .input(
        z.object({
          id: z.number().int().positive(),
          status: z.enum(TASK_STATUSES as [string, ...string[]]).optional(),
          priority: z.enum(TASK_PRIORITIES as [string, ...string[]]).optional(),
          assignedUserId: z.number().int().positive().nullish(),
          assignedRole: z.string().max(40).nullish(),
          dueDate: dateStr.nullish(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "tasks");
        if ((input.assignedUserId !== undefined || input.assignedRole !== undefined) && !can(ctx.user.role, "assignTasks")) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You can't reassign tasks." });
        }
        const { id, ...rest } = input;
        return run(() => ws.updateTask(actor, id, rest as Parameters<typeof ws.updateTask>[2]));
      }),
    comment: protectedProcedure
      .input(z.object({ id: z.number().int().positive(), body: z.string().trim().min(1).max(5000) }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "tasks");
        await run(() => ws.commentTask(actor, input.id, input.body));
        return { success: true };
      }),
  }),

  flow: router({
    board: protectedProcedure.input(z.object({ clinicId, date: dateStr.optional() })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "flowView");
      return run(() => ws.flowBoard(actor, input));
    }),
    move: protectedProcedure
      .input(z.object({ appointmentId: z.number().int().positive(), to: flowStatus, confirmed: z.boolean().default(false), room: z.string().max(40).nullish() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "flowUpdate");
        return run(() => ws.moveAppointment(actor, input as Parameters<typeof ws.moveAppointment>[1]));
      }),
    setRoom: protectedProcedure
      .input(z.object({ appointmentId: z.number().int().positive(), room: z.string().trim().max(40).nullable() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "flowUpdate");
        await run(() => ws.setRoom(actor, input.appointmentId, input.room || null));
        return { success: true };
      }),
  }),

  schedule: router({
    /** Parse + match without saving, so the user can check the columns first. */
    preview: protectedProcedure
      .input(z.object({ csv: csvText, mapping: mappingSchema, defaultClinicId: clinicId }))
      .mutation(async ({ ctx, input }) => {
        await actorFor(ctx, "scheduleImport");
        const parsed = parseScheduleCsv(input.csv, input.mapping as ScheduleMapping | undefined);
        const resolved = await ws.resolveScheduleRows(parsed.rows, input.defaultClinicId ?? null);
        const dates = Array.from(new Set(resolved.map((r) => r.date))).sort();
        return {
          headers: parsed.headers,
          mapping: parsed.mapping,
          errors: parsed.errors.slice(0, 50),
          errorCount: parsed.errors.length,
          rowCount: resolved.length,
          linked: resolved.filter((r) => r.patientId).length,
          providersMatched: resolved.filter((r) => r.providerId).length,
          missingClinic: resolved.filter((r) => !r.clinicId).length,
          dates,
          sample: resolved.slice(0, 25).map((r) => ({
            rowNumber: r.rowNumber, date: r.date, time: r.time, patientName: r.patientName, dob: r.dob, provider: r.provider,
            visitType: r.visitType, status: r.status, clinicId: r.clinicId, linked: !!r.patientId, providerMatched: !!r.providerId,
          })),
        };
      }),
    commit: protectedProcedure
      .input(z.object({ csv: csvText, mapping: mappingSchema, defaultClinicId: clinicId, cancelMissing: z.boolean().default(false), fileName: z.string().max(255).nullish() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "scheduleImport");
        const parsed = parseScheduleCsv(input.csv, input.mapping as ScheduleMapping | undefined);
        if (!parsed.rows.length) throw new TRPCError({ code: "BAD_REQUEST", message: "No appointments found in this file." });
        return run(() =>
          ws.commitSchedule(actor, { fileName: input.fileName ?? null, rows: parsed.rows, defaultClinicId: input.defaultClinicId ?? null, cancelMissing: input.cancelMissing }),
        );
      }),
    imports: protectedProcedure.query(async ({ ctx }) => {
      await actorFor(ctx, "scheduleImport");
      return ws.recentImports();
    }),
  }),

  openings: protectedProcedure.input(z.object({ clinicId, days: z.number().int().min(0).max(14).default(3) })).query(async ({ ctx, input }) => {
    const actor = await actorFor(ctx, "opportunitiesView");
    return run(() => ws.openings(actor, input));
  }),

  opportunities: router({
    summary: protectedProcedure.input(z.object({ clinicId })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "opportunitiesView");
      return run(() => ws.opportunitySummary(actor, input.clinicId));
    }),
    list: protectedProcedure
      .input(z.object({ category: z.enum(OPPORTUNITY_CATEGORY_LIST as [string, ...string[]]), clinicId, providerId: z.number().int().positive().nullish(), includeActioned: z.boolean().default(false) }))
      .query(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "opportunitiesView");
        return run(() => ws.opportunityList(actor, input as Parameters<typeof ws.opportunityList>[1]));
      }),
    // Fill a provider's schedule: who is most likely to book with them.
    fillProviders: protectedProcedure.query(async ({ ctx }) => {
      const actor = await actorFor(ctx, "opportunitiesView");
      return run(() => ws.fillProviders(actor));
    }),
    fill: protectedProcedure
      .input(z.object({ providerId: z.number().int().positive(), includeOtherClinics: z.boolean().default(false), includeActioned: z.boolean().default(false) }))
      .query(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "opportunitiesView");
        return run(() => ws.scheduleFill(actor, input));
      }),
    fillAct: protectedProcedure
      .input(
        z.object({
          providerId: z.number().int().positive(),
          keys: z.array(z.string().regex(/^(p:\d+|s:.{1,110})$/)).min(1).max(500),
          action: z.enum(["reviewed", "task_created", "dismissed"]),
          assigneeId: z.number().int().positive().nullish(),
          taskTitle: z.string().trim().min(1).max(200).default("Call to schedule"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "opportunitiesAct");
        return run(() => ws.scheduleFillAct(actor, input));
      }),
    act: protectedProcedure
      .input(
        z.object({
          category: z.enum(OPPORTUNITY_CATEGORY_LIST as [string, ...string[]]),
          keys: z.array(z.string().regex(/^(p:\d+|s:.{1,110})$/)).min(1).max(500),
          action: z.enum(["reviewed", "task_created", "dismissed"]),
          assigneeId: z.number().int().positive().nullish(),
          taskTitle: z.string().trim().min(1).max(200).default("Follow up"),
          taskCategory: z.enum(TASK_CATEGORIES as [string, ...string[]]).default("patient_call"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "opportunitiesAct");
        return run(() => ws.actOnOpportunities(actor, input as Parameters<typeof ws.actOnOpportunities>[1]));
      }),
  }),

  patients: router({
    /** Operational Patient 360: demographics, appointments and tasks. CCM detail stays on patients.getById. */
    summary: protectedProcedure.input(z.number().int().positive()).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "flowView");
      const res = await run(() => ws.patientOperational(actor, input));
      if (ctx.user.role === "medical_assistant") return { ...res, patient: { ...res.patient, insurance: null } };
      return res;
    }),
  }),

  playbooks: router({
    list: protectedProcedure.input(z.object({ q: z.string().max(100).optional() })).query(async ({ ctx, input }) => {
      await actorFor(ctx, "playbooksView");
      return ws.listPlaybooks(input.q);
    }),
    get: protectedProcedure.input(z.string().min(1).max(120)).query(async ({ ctx, input }) => {
      await actorFor(ctx, "playbooksView");
      return run(() => ws.getPlaybook(input));
    }),
    save: protectedProcedure
      .input(
        z.object({
          slug: z.string().max(120).nullish(),
          title: z.string().trim().min(1).max(255),
          category: z.string().trim().min(1).max(80),
          description: z.string().max(2000).nullish(),
          steps: z.array(z.object({ title: z.string().trim().min(1).max(255), detail: z.string().max(4000) })).min(1).max(50),
          changeNote: z.string().max(500).nullish(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "playbooksEdit");
        return run(() => ws.savePlaybook(actor, input));
      }),
    archive: protectedProcedure.input(z.string().min(1).max(120)).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "playbooksEdit");
      await run(() => ws.archivePlaybook(actor, input));
      return { success: true };
    }),
  }),
});

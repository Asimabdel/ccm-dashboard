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
import * as phone from "../phoneDb";
import * as rcSync from "../ringcentralSync";
import * as gmail from "../gmailSync";
import * as testing from "../testingDb";
import * as metrics from "../metricsDb";
import * as fax from "../faxInbox";
import * as pf from "../pfFhir";
import * as pfSync from "../pfSync";
import * as chart from "../chartDb";
import * as bookings from "../bookingsDb";
import * as intake from "../intakeDb";
import * as availity from "../availityDb";
import * as docs from "../documentsDb";
import { CONSENT_KINDS, INTAKE_LANGS } from "../../shared/intake";
import { APPROVAL_METHODS } from "../../shared/documents";
import { FAX_DOC_TYPE_KEYS } from "../../shared/fax";
import { TEST_KEYS, type TestKey } from "../../shared/testing";
import { CALL_OUTCOME_LIST } from "../../shared/phone";

// Every Workspace procedure resolves an actor first: who is calling and which
// clinics they may see. Medical assistants are limited to the clinics they work
// in (home clinic, today's shifts, or all if they float); everyone else sees all.
type Ctx = { user: { id: number; name: string | null; role: string }; req?: { headers?: Record<string, unknown>; ip?: string } };

async function actorFor(ctx: Ctx, cap: WorkspaceCap): Promise<ws.WorkspaceActor> {
  if (!can(ctx.user.role, cap)) throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this resource." });
  const clinicIds = ctx.user.role === "medical_assistant" ? await ws.getMaClinicIds(ctx.user.id)
    : ctx.user.role === "office_manager" ? await ws.officeClinicIds(ctx.user.id)
    : null;
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
/** Opportunity Finder (every tab): care coordinators / front desk see their clinic's patients, providers their own. */
async function oppActor(ctx: Ctx, cap: WorkspaceCap): Promise<ws.WorkspaceActor> {
  const actor = await actorFor(ctx, cap);
  const scope = await ws.opportunityScope({ id: ctx.user.id, name: ctx.user.name, role: ctx.user.role });
  return { ...actor, clinicIds: scope.clinicIds ?? actor.clinicIds, providerIds: scope.providerIds };
}

/** Who / where, for a document's audit trail and signature certificate. */
function docMeta(ctx: Ctx): docs.ClientMeta {
  const fwd = ctx.req?.headers?.["x-forwarded-for"];
  const ua = ctx.req?.headers?.["user-agent"];
  return { ip: (typeof fwd === "string" ? fwd.split(",")[0]!.trim() : null) || ctx.req?.ip || null, userAgent: typeof ua === "string" ? ua : null };
}

/** The page the request came from (for building patient links on the same site); checked against an allowlist later. */
function reqOrigin(ctx: Ctx): string | null {
  const o = ctx.req?.headers?.origin;
  return typeof o === "string" ? o : null;
}

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
const subjectKeyRe = /^(p:\d+|s:.{1,110})$/;

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
    const actor = await oppActor(ctx, "opportunitiesView");
    return run(() => ws.openings(actor, input));
  }),

  // RingCentral phone built into the app + the call log.
  phone: router({
    config: protectedProcedure.query(async ({ ctx }) => {
      await actorFor(ctx, "tasks");
      return phone.getRingCentralSettings();
    }),
    saveConfig: protectedProcedure
      .input(z.object({ enabled: z.boolean(), clientId: z.string().trim().max(120).regex(/^[A-Za-z0-9_-]*$/, "That doesn't look like a RingCentral client ID."), allowTexting: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "tasks");
        if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can change the RingCentral connection." });
        return phone.saveRingCentralSettings(actor, input);
      }),
    log: protectedProcedure
      .input(z.object({
        sessionId: z.string().max(120).nullable(),
        direction: z.enum(["outbound", "inbound"]),
        phoneNumber: z.string().min(10).max(20),
        startedAt: z.date(),
        durationSec: z.number().int().min(0).max(86_400),
        result: z.string().max(60).nullable(),
        context: z.object({
          patientId: z.number().int().positive().nullish(),
          subjectKey: z.string().regex(/^(p:\d+|s:.{1,110})$/).nullish(),
          name: z.string().max(255).nullish(),
          source: z.string().max(40).nullish(),
        }).nullish(),
      }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "tasks");
        return run(() => phone.logCall(actor, input));
      }),
    outcome: protectedProcedure
      .input(z.object({ callId: z.number().int().positive(), outcome: z.enum(CALL_OUTCOME_LIST as [string, ...string[]]), note: z.string().max(1000).nullish() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "tasks");
        return run(() => phone.setCallOutcome(actor, input as Parameters<typeof phone.setCallOutcome>[1]));
      }),
    forPatient: protectedProcedure.input(z.number().int().positive()).query(async ({ ctx, input }) => {
      await actorFor(ctx, "patientFull");
      return phone.callsForPatient(input);
    }),
    // Call-log sync (calls made outside MyPCP). Admin only; secrets are write-only.
    syncStatus: protectedProcedure.query(async ({ ctx }) => {
      await actorFor(ctx, "tasks");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can see the RingCentral call-log sync." });
      return rcSync.getSyncStatus();
    }),
    saveSync: protectedProcedure
      .input(z.object({
        enabled: z.boolean(),
        clientId: z.string().trim().max(120).regex(/^[A-Za-z0-9_-]*$/, "That doesn't look like a RingCentral client ID.").nullish(),
        clientSecret: z.string().trim().max(200).nullish(),
        jwt: z.string().trim().max(4000).nullish(),
      }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "tasks");
        if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can change the RingCentral call-log sync." });
        return rcSync.saveSyncConfig(actor, input);
      }),
    syncNow: protectedProcedure.mutation(async ({ ctx }) => {
      await actorFor(ctx, "tasks");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can run the RingCentral call-log sync." });
      // Kept under API Gateway's 30s limit; the schedule does the heavy lifting.
      return rcSync.runRingCentralSync({ maxRequests: 4, maxMs: 18_000, manual: true });
    }),
  }),

  // Practice mailbox (Gmail, read-only) → patient-email tasks.
  email: router({
    status: protectedProcedure.query(async ({ ctx }) => {
      await actorFor(ctx, "emailTriage");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can manage the practice mailbox connection." });
      return { ...(await gmail.getGmailStatus()), contacts: await gmail.contactCounts() };
    }),
    saveApp: protectedProcedure
      .input(z.object({ clientId: z.string().trim().min(10).max(200).regex(/^[A-Za-z0-9._-]+$/, "That doesn't look like a Google Client ID."), clientSecret: z.string().trim().max(200).nullish() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "emailTriage");
        if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can change the practice mailbox connection." });
        return run(() => gmail.saveGmailApp(actor, input));
      }),
    connectUrl: protectedProcedure.input(z.object({ origin: z.string().url() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "emailTriage");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can connect the practice mailbox." });
      return run(() => gmail.gmailConnectUrl(actor, input.origin));
    }),
    setEnabled: protectedProcedure.input(z.boolean()).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "emailTriage");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can change the practice mailbox connection." });
      return run(() => gmail.setGmailEnabled(actor, input));
    }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const actor = await actorFor(ctx, "emailTriage");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can disconnect the practice mailbox." });
      return run(() => gmail.disconnectGmail(actor));
    }),
    syncNow: protectedProcedure.mutation(async ({ ctx }) => {
      await actorFor(ctx, "emailTriage");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can run the mailbox check." });
      return gmail.runGmailSync({ maxMs: 18_000, manual: true });
    }),
    backfill: protectedProcedure.input(z.object({ days: z.number().int().min(1).max(90).default(30) })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "emailTriage");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can load earlier emails." });
      return run(() => gmail.startGmailBackfill(actor, input.days));
    }),
    importContacts: protectedProcedure.input(z.object({ csv: csvText })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "emailTriage");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can import patient email addresses." });
      return run(() => gmail.importPatientEmails(actor, input.csv));
    }),
    list: protectedProcedure.input(z.object({ filter: z.enum(["needs_patient", "all"]).default("needs_patient") })).query(async ({ ctx, input }) => {
      await actorFor(ctx, "emailTriage");
      return gmail.listEmails(input.filter);
    }),
    search: protectedProcedure.input(z.object({ q: z.string().trim().min(2).max(100) })).query(async ({ ctx, input }) => {
      await actorFor(ctx, "emailTriage");
      return gmail.searchSubjects(input.q);
    }),
    link: protectedProcedure
      .input(z.object({ emailId: z.number().int().positive(), subjectKey: z.string().regex(/^(p:\d+|s:.{1,110})$/) }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "emailTriage");
        return run(() => gmail.linkEmail(actor, input));
      }),
    ignore: protectedProcedure.input(z.number().int().positive()).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "emailTriage");
      return run(() => gmail.ignoreEmailSender(actor, input));
    }),
  }),

  // Practice Fusion (read-only FHIR bulk export) connection.
  pf: router({
    status: protectedProcedure.input(z.object({ origin: z.string().url() })).query(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can manage the Practice Fusion connection." });
      return pf.pfStatus(new URL(input.origin).origin);
    }),
    save: protectedProcedure.input(z.object({ baseUrl: z.string().max(300), clientId: z.string().max(200) })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "tasks");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can change the Practice Fusion connection." });
      return run(() => pf.savePfConfig(actor, input));
    }),
    sync: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can see the sync." });
      const { lockUntil, statusUrl, files, ...s } = await pfSync.getSyncState();
      return { ...s, files: files.map((f) => ({ type: f.type, status: f.status, size: f.size, offset: f.offset, lines: f.lines })) };
    }),
    test: protectedProcedure.mutation(async ({ ctx }) => {
      const actor = await actorFor(ctx, "tasks");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can test the connection." });
      return run(() => pfSync.testConnection(actor));
    }),
    setEnabled: protectedProcedure.input(z.boolean()).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "tasks");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can change the sync." });
      return run(() => pfSync.setSyncEnabled(actor, input));
    }),
    importNow: protectedProcedure.input(z.enum(["full", "delta"])).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "tasks");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can start an import." });
      return run(() => pfSync.requestImport(actor, input));
    }),
  }),

  // Insurance eligibility through Availity (Patient 360 checks + the nightly check of the next day).
  eligibility: router({
    status: protectedProcedure.query(async ({ ctx }) => {
      await actorFor(ctx, "eligibility");
      const s = await availity.availityStatus();
      return ctx.user.role === "admin" ? s : { configured: s.configured, mode: s.mode, nightly: s.nightly };
    }),
    saveConfig: protectedProcedure
      .input(z.object({ clientId: z.string().max(200).nullish(), clientSecret: z.string().max(500).nullish(), mode: z.enum(["demo", "production"]), npi: z.string().max(20), orgName: z.string().max(60), scope: z.string().max(120).nullish(), nightly: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "eligibility");
        if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can change the Availity connection." });
        return run(() => availity.saveAvailityConfig(actor, input));
      }),
    test: protectedProcedure.mutation(async ({ ctx }) => {
      await actorFor(ctx, "eligibility");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can test the Availity connection." });
      return run(() => availity.testAvaility());
    }),
    payers: protectedProcedure.input(z.object({ q: z.string().max(80) })).query(async ({ ctx, input }) => {
      await actorFor(ctx, "eligibility");
      return run(() => availity.searchPayers(input.q));
    }),
    defaults: protectedProcedure.input(z.object({ subjectKey: z.string().min(3).max(120) })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "eligibility");
      return run(() => availity.checkDefaults(actor, input.subjectKey));
    }),
    check: protectedProcedure
      .input(z.object({
        subjectKey: z.string().min(3).max(120),
        payerId: z.string().trim().min(1).max(40),
        payerName: z.string().max(160).nullish(),
        memberId: z.string().trim().min(1).max(60),
        groupNumber: z.string().max(60).nullish(),
        firstName: z.string().trim().min(1).max(60),
        lastName: z.string().trim().min(1).max(60),
        dob: dateStr,
        sex: z.enum(["F", "M", "X", "U"]).nullish(),
        asOfDate: dateStr.nullish(),
      }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "eligibility");
        return run(() => availity.runCheck(actor, input));
      }),
    refresh: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "eligibility");
      return run(() => availity.getCheck(actor, input.id, true));
    }),
    history: protectedProcedure.input(z.object({ subjectKey: z.string().min(3).max(120) })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "eligibility");
      return run(() => availity.checkHistory(actor, input.subjectKey));
    }),
    raw: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "eligibility");
      return run(() => availity.checkRaw(actor, input.id));
    }),
    removeCoverage: protectedProcedure.input(z.object({ subjectKey: z.string().min(3).max(120) })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "eligibility");
      return run(() => availity.removeCoverage(actor, input.subjectKey));
    }),
    schedule: protectedProcedure.input(z.object({ date: dateStr.nullish() })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "eligibility");
      return run(() => availity.scheduleCoverage(actor, input.date));
    }),
  }),

  // Documents (our own DocuSign): upload a PDF, place and fill boxes, sign, send to teammates to co-sign.
  documents: router({
    list: protectedProcedure.input(z.object({ view: z.enum(["to_sign", "in_progress", "completed", "templates"]), q: z.string().max(100).nullish() })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return docs.listDocuments(actor, input.view, input.q);
    }),
    counts: protectedProcedure.query(async ({ ctx }) => {
      const actor = await actorFor(ctx, "documents");
      return { toSign: (await docs.listDocuments(actor, "to_sign")).length };
    }),
    signers: protectedProcedure.query(async ({ ctx }) => {
      await actorFor(ctx, "documents");
      return docs.signerChoices();
    }),
    searchPatients: protectedProcedure.input(z.object({ q: z.string().trim().min(2).max(100) })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return ws.searchSubjects(input.q, 20, actor.clinicIds);
    }),
    create: protectedProcedure.input(z.object({ title: z.string().max(255), fileName: z.string().min(1).max(255), size: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return run(() => docs.createDocument(actor, input));
    }),
    uploadLocal: protectedProcedure.input(z.object({ id: z.number().int().positive(), base64: z.string().max(36_000_000) })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return run(() => docs.uploadLocal(actor, input.id, input.base64));
    }),
    uploaded: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return run(() => docs.fileUploaded(actor, input.id));
    }),
    get: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return run(() => docs.getDocument(actor, input.id, docMeta(ctx)));
    }),
    file: protectedProcedure.input(z.object({ id: z.number().int().positive(), which: z.enum(["source", "final"]) })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return run(() => docs.fileFor(actor, input.id, input.which, docMeta(ctx)));
    }),
    save: protectedProcedure
      .input(z.object({
        id: z.number().int().positive(),
        title: z.string().max(255).optional(),
        fields: z.array(z.record(z.string(), z.unknown())).max(600).optional(),
        subjectKey: z.string().max(120).nullish(),
        message: z.string().max(1000).nullish(),
      }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "documents");
        const { id, ...rest } = input;
        return run(() => docs.saveDocument(actor, id, rest));
      }),
    prefill: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return run(() => docs.applyPrefill(actor, input.id));
    }),
    setSigners: protectedProcedure.input(z.object({ id: z.number().int().positive(), userIds: z.array(z.number().int().positive()).max(10) })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return run(() => docs.setSigners(actor, input.id, input.userIds));
    }),
    signField: protectedProcedure
      .input(z.object({
        id: z.number().int().positive(), fieldId: z.string().max(40), png: z.string().max(820_000).nullish(), saveAsMine: z.boolean().optional(),
        onBehalfOf: z.object({ providerUserId: z.number().int().positive(), approval: z.enum(APPROVAL_METHODS), note: z.string().max(255).nullish() }).nullish(),
      }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "documents");
        return run(() => docs.signField(actor, input.id, input, docMeta(ctx)));
      }),
    // Provider signatures staff may apply with the provider's approval.
    providerSignatures: protectedProcedure.query(async ({ ctx }) => {
      const actor = await actorFor(ctx, "documents");
      return docs.providerSignatureOverview(actor);
    }),
    saveProviderSignature: protectedProcedure
      .input(z.object({ providerUserId: z.number().int().positive(), signaturePng: z.string().max(820_000).nullish(), initialsPng: z.string().max(820_000).nullish(), enabled: z.boolean().optional() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "documents");
        const { providerUserId, ...rest } = input;
        return run(() => docs.saveProviderSignature(actor, providerUserId, rest));
      }),
    setProviderDelegates: protectedProcedure.input(z.object({ providerUserId: z.number().int().positive(), userIds: z.array(z.number().int().positive()).max(50) })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return run(() => docs.setProviderDelegates(actor, input.providerUserId, input.userIds));
    }),
    signaturesICanApply: protectedProcedure.query(async ({ ctx }) => {
      const actor = await actorFor(ctx, "documents");
      return docs.signaturesICanApply(actor);
    }),
    signedForMe: protectedProcedure.query(async ({ ctx }) => {
      const actor = await actorFor(ctx, "documents");
      return docs.signedForMe(actor);
    }),
    send: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return run(() => docs.sendOrFinish(actor, input.id, docMeta(ctx)));
    }),
    finishSigning: protectedProcedure
      .input(z.object({ id: z.number().int().positive(), values: z.record(z.string().max(40), z.string().max(2000)) }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "documents");
        return run(() => docs.signerFinish(actor, input.id, input.values, docMeta(ctx)));
      }),
    cancel: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return run(() => docs.cancelDocument(actor, input.id));
    }),
    saveAsTemplate: protectedProcedure.input(z.object({ id: z.number().int().positive(), title: z.string().max(255) })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return run(() => docs.saveAsTemplate(actor, input.id, input.title));
    }),
    fromTemplate: protectedProcedure.input(z.object({ templateId: z.number().int().positive(), subjectKey: z.string().max(120).nullish() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "documents");
      return run(() => docs.newFromTemplate(actor, input.templateId, input.subjectKey ?? null));
    }),
    mySignature: protectedProcedure.query(async ({ ctx }) => {
      const actor = await actorFor(ctx, "documents");
      return docs.mySignature(actor);
    }),
    saveMySignature: protectedProcedure
      .input(z.object({ signaturePng: z.string().max(820_000).nullish(), initialsPng: z.string().max(820_000).nullish() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "documents");
        return run(() => docs.saveMySignature(actor, {
          ...(input.signaturePng !== undefined ? { signaturePng: input.signaturePng } : {}),
          ...(input.initialsPng !== undefined ? { initialsPng: input.initialsPng } : {}),
        }));
      }),
  }),

  // Patient forms (intake + consents, replacing BoldSign): send a private link, see what came back.
  intake: router({
    status: protectedProcedure.query(async ({ ctx }) => {
      await actorFor(ctx, "intakeForms");
      const { practiceMailSender } = await import("../gmailSync");
      return practiceMailSender();
    }),
    choices: protectedProcedure.query(async ({ ctx }) => {
      await actorFor(ctx, "intakeForms");
      return intake.formChoices();
    }),
    search: protectedProcedure.input(z.object({ q: z.string().trim().min(2).max(100) })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return ws.searchSubjects(input.q, 20, actor.clinicIds);
    }),
    contact: protectedProcedure.input(z.object({ subjectKey: z.string().min(3).max(120) })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return run(() => intake.intakeContact(actor, input.subjectKey));
    }),
    create: protectedProcedure
      .input(z.object({
        subjectKey: z.string().max(120).nullish(),
        name: z.string().trim().min(2).max(255),
        dob: dateStr,
        phone: z.string().max(30).nullish(),
        email: z.string().max(320).nullish(),
        language: z.enum(INTAKE_LANGS),
        forms: z.array(z.string().max(40)).min(1).max(12),
        clinicId,
        bookingRequestId: z.number().int().positive().nullish(),
      }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "intakeForms");
        return run(() => intake.createPacket(actor, input, reqOrigin(ctx)));
      }),
    sendEmail: protectedProcedure.input(z.object({ id: z.number().int().positive(), to: z.string().max(320).nullish() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return run(() => intake.sendByEmail(actor, input.id, reqOrigin(ctx), input.to));
    }),
    textMessage: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return run(() => intake.textMessage(actor, input.id, reqOrigin(ctx)));
    }),
    copyLink: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return run(() => intake.copyLink(actor, input.id, reqOrigin(ctx)));
    }),
    list: protectedProcedure.input(z.object({ filter: z.enum(["waiting", "to_file", "filed", "all"]).default("waiting"), q: z.string().max(100).nullish() })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return intake.listPackets(actor, input.filter, input.q);
    }),
    /** Everyone who said Yes to a program on a consent form: enrolled automatically, or waiting (and why). */
    enrollments: protectedProcedure.input(z.object({ status: z.enum(["waiting", "enrolled", "all"]).default("waiting") })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      const { listEnrollments } = await import("../enrollDb");
      return listEnrollments(actor, input.status);
    }),
    /** Patient 360 → Forms: everything this person was sent or signed, and where each consent stands. */
    forSubject: protectedProcedure.input(z.object({ subjectKey: z.string().min(3).max(120) })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return run(() => intake.subjectForms(actor, input.subjectKey));
    }),
    link: protectedProcedure.input(z.object({ id: z.number().int().positive(), subjectKey: z.string().min(3).max(120) })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return run(() => intake.linkPacket(actor, input.id, input.subjectKey));
    }),
    stats: protectedProcedure.query(async ({ ctx }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return intake.packetStats(actor);
    }),
    detail: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return run(() => intake.packetDetail(actor, input.id));
    }),
    file: protectedProcedure.input(z.object({ id: z.number().int().positive(), fileId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return run(() => intake.packetFile(actor, input.id, input.fileId));
    }),
    markFiled: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return run(() => intake.markFiled(actor, input.id));
    }),
    cancel: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return run(() => intake.cancelPacket(actor, input.id));
    }),
    extend: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "intakeForms");
      return run(() => intake.extendPacket(actor, input.id));
    }),
    documents: protectedProcedure.query(async ({ ctx }) => {
      await actorFor(ctx, "intakeForms");
      return intake.listDocuments(ctx.user.role === "admin");
    }),
    saveDocument: protectedProcedure
      .input(z.object({
        id: z.number().int().positive().nullish(),
        title: z.record(z.string(), z.string().max(200).nullish()),
        body: z.record(z.string(), z.string().max(60_000).nullish()),
        active: z.boolean(),
        consentKind: z.enum(CONSENT_KINDS).nullish(),
        publicSlug: z.string().max(40).nullish(),
        choices: z.array(z.object({
          kind: z.enum(CONSENT_KINDS),
          title: z.record(z.string(), z.string().max(200).nullish()),
          body: z.record(z.string(), z.string().max(8000).nullish()),
        })).max(10).nullish(),
      }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "intakeForms");
        if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can change the forms." });
        return run(() => intake.saveDocument(actor, input));
      }),
  }),

  // Website bookings (mypcpdr.com booking wizard): call to confirm, record how it went.
  bookings: router({
    list: protectedProcedure.input(z.object({ filter: z.enum(["open", "scheduled", "closed", "earlier", "all"]).default("open") })).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "bookings");
      return bookings.listBookings(actor, input.filter);
    }),
    stats: protectedProcedure.query(async ({ ctx }) => {
      const actor = await actorFor(ctx, "bookings");
      return bookings.bookingStats(actor);
    }),
    setStatus: protectedProcedure
      .input(z.object({ id: z.number().int().positive(), status: z.enum(["no_answer", "scheduled", "not_booked", "spam"]), note: z.string().max(500).nullish() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "bookings");
        return run(() => bookings.setBookingStatus(actor, input));
      }),
    importEarlier: protectedProcedure.input(z.object({ pageToken: z.string().max(200).nullish() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "bookings");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can load earlier bookings." });
      return run(() => bookings.importEarlierBookings(actor, input));
    }),
  }),

  // The Practice Fusion chart copy (read-only). Full for clinical roles; limited for the front desk.
  chart: router({
    get: protectedProcedure.input(z.string().regex(/^(p:\d+|s:.{1,110}|f:.{1,120})$/)).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "chartBasic");
      return run(() => chart.chartFor(actor, input));
    }),
    item: protectedProcedure.input(z.number().int().positive()).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "chartBasic");
      return run(() => chart.chartItem(actor, input));
    }),
    note: protectedProcedure.input(z.number().int().positive()).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "chartFull");
      return run(() => chart.chartNote(actor, input));
    }),
    search: protectedProcedure.input(z.string().trim().min(2).max(100)).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "chartBasic");
      return run(() => chart.chartSearch(actor, input));
    }),
    header: protectedProcedure.input(z.string().regex(/^(p:\d+|s:.{1,110}|f:.{1,120})$/)).query(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "chartBasic");
      return run(() => chart.chartHeader(actor, input));
    }),
  }),

  // Fax inbox: faxes arriving by email → patient match → "file in Practice Fusion" task.
  fax: router({
    list: protectedProcedure
      .input(z.object({ filter: z.enum(["needs_patient", "to_file", "filed", "not_patient", "all"]).default("needs_patient") }))
      .query(async ({ ctx, input }) => {
        await actorFor(ctx, "emailTriage");
        return fax.listFaxes(input.filter);
      }),
    open: protectedProcedure.input(z.number().int().positive()).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "emailTriage");
      return run(() => fax.faxFile(actor, input));
    }),
    assign: protectedProcedure
      .input(z.object({ faxId: z.number().int().positive(), subjectKey: z.string().regex(/^(p:\d+|s:.{1,110})$/), docType: z.enum(FAX_DOC_TYPE_KEYS as [string, ...string[]]).nullish() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "emailTriage");
        return run(() => fax.assignFax(actor, { ...input, docType: (input.docType ?? null) as Parameters<typeof fax.assignFax>[1]["docType"] }));
      }),
    notPatient: protectedProcedure.input(z.number().int().positive()).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "emailTriage");
      return run(() => fax.markNotPatient(actor, input));
    }),
    markFiled: protectedProcedure.input(z.number().int().positive()).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "emailTriage");
      return run(() => fax.markFiled(actor, input));
    }),
    reread: protectedProcedure.input(z.number().int().positive()).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "emailTriage");
      return run(() => fax.rereadFax(actor, input));
    }),
    status: protectedProcedure.query(async ({ ctx }) => {
      const actor = await actorFor(ctx, "emailTriage");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can manage the fax inbox." });
      const people = await ws.assignableUsers(actor);
      return {
        settings: await fax.getFaxSettings(),
        counts: await fax.faxCounts(),
        faxMailbox: await gmail.faxMailboxStatus(),
        practiceMailbox: (await gmail.getGmailStatus()).mailbox,
        aiReady: !!process.env.BEDROCK_MODEL_ID,
        people,
      };
    }),
    saveSettings: protectedProcedure
      .input(z.object({ senders: z.array(z.string().max(200)).max(50), routing: z.enum(["front_desk", "care_team", "user"]), routeUserId: z.number().int().positive().nullable(), ai: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "emailTriage");
        if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can change fax settings." });
        return run(() => fax.saveFaxSettings(actor, input));
      }),
    connectUrl: protectedProcedure.input(z.object({ origin: z.string().url() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "emailTriage");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can connect the fax mailbox." });
      return run(() => gmail.gmailConnectUrl(actor, input.origin, "fax"));
    }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const actor = await actorFor(ctx, "emailTriage");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can disconnect the fax mailbox." });
      return run(() => gmail.disconnectGmail(actor, "fax"));
    }),
    checkNow: protectedProcedure.mutation(async ({ ctx }) => {
      await actorFor(ctx, "emailTriage");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can run the fax check." });
      const started = Date.now();
      const faxBox = await gmail.runGmailSync({ slot: "fax", maxMs: 6_000, manual: true });
      const practice = await gmail.runGmailSync({ maxMs: 6_000, manual: true });
      const read = await fax.readPendingFaxes({ deadline: started + 16_000 });
      return { faxBox, practice, read, counts: await fax.faxCounts() };
    }),
  }),

  // "My progress" in the top bar: today's counts for the signed-in employee (no patient details).
  metrics: router({
    mine: protectedProcedure.query(async ({ ctx }) => {
      await actorFor(ctx, "tasks");
      return metrics.myMetrics({ id: ctx.user.id, name: ctx.user.name, role: ctx.user.role });
    }),
    team: protectedProcedure.input(z.object({ date: dateStr })).query(async ({ ctx, input }) => {
      if (ctx.user.role === "office_manager") {
        const [office] = await ws.officeClinicIds(ctx.user.id);
        if (!office) throw new TRPCError({ code: "FORBIDDEN", message: "Your office isn't set yet. Ask an admin to set your home clinic in Workforce." });
        return metrics.teamMetrics(input.date, await ws.officeStaff(ctx.user.id, office));
      }
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin or office manager can see the team's numbers." });
      return metrics.teamMetrics(input.date);
    }),
    goals: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can see the daily goals." });
      return metrics.getDailyGoals();
    }),
    setGoals: protectedProcedure
      .input(z.record(z.string().max(30), z.record(z.string().max(30), z.number().int().min(0).max(1000))))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can set daily goals." });
        return metrics.setDailyGoals(ctx.user.id, input);
      }),
  }),

  // Testing & screenings: who's due (guideline reminders), what they've had, scheduling tasks.
  testing: router({
    overview: protectedProcedure
      .input(z.object({
        clinicId,
        test: z.enum(TEST_KEYS as [string, ...string[]]).nullish(),
        states: z.array(z.enum(["due", "no_record", "due_soon", "needs_info", "current", "declined", "not_applicable"])).min(1).default(["due", "due_soon"]),
        upcomingDays: z.number().int().min(0).max(60).nullish(),
        includeActioned: z.boolean().default(false),
      }))
      .query(async ({ ctx, input }) => {
        const actor = await oppActor(ctx, "opportunitiesView");
        return run(() => testing.testingOverview(actor, input as Parameters<typeof testing.testingOverview>[1]));
      }),
    person: protectedProcedure.input(z.string().regex(subjectKeyRe)).query(async ({ ctx, input }) => {
      await actorFor(ctx, "patientFull");
      return run(() => testing.personTesting(input));
    }),
    record: protectedProcedure
      .input(z.object({
        subjectKey: z.string().regex(subjectKeyRe),
        testKey: z.enum(TEST_KEYS as [string, ...string[]]),
        status: z.enum(["done", "not_applicable", "declined"]),
        performedOn: dateStr,
        method: z.string().max(40).nullish(),
        result: z.string().max(120).nullish(),
        note: z.string().max(1000).nullish(),
      }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actorFor(ctx, "patientFull");
        return run(() => testing.recordTest(actor, { ...input, testKey: input.testKey as TestKey }));
      }),
    deleteRecord: protectedProcedure.input(z.number().int().positive()).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "patientFull");
      return run(() => testing.deleteTestRecord(actor, input));
    }),
    setSex: protectedProcedure.input(z.object({ subjectKey: z.string().regex(subjectKeyRe), sex: z.enum(["F", "M", "X"]).nullable() })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "patientFull");
      return run(() => testing.setSex(actor, input));
    }),
    act: protectedProcedure
      .input(z.object({ keys: z.array(z.string().regex(subjectKeyRe)).min(1).max(500), action: z.enum(["reviewed", "task_created", "dismissed"]), assigneeId: z.number().int().positive().nullish() }))
      .mutation(async ({ ctx, input }) => {
        const actor = await oppActor(ctx, "opportunitiesAct");
        return run(() => testing.actOnTesting(actor, input));
      }),
    importResults: protectedProcedure.input(z.object({ csv: csvText })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "opportunitiesAct");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can import test results." });
      return run(() => testing.importTestResults(actor, input.csv));
    }),
    importPatients: protectedProcedure.input(z.object({ csv: csvText })).mutation(async ({ ctx, input }) => {
      const actor = await actorFor(ctx, "opportunitiesAct");
      if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only an admin can import the patient list." });
      return run(() => testing.importPatientList(actor, input.csv));
    }),
  }),

  opportunities: router({
    /** What this person's Opportunity Finder is limited to (for the note at the top of the page). */
    scope: protectedProcedure.query(async ({ ctx }) => {
      await actorFor(ctx, "opportunitiesView");
      const sc = await ws.opportunityScope({ id: ctx.user.id, name: ctx.user.name, role: ctx.user.role });
      return { label: sc.label, clinicIds: sc.clinicIds, limitedToProviders: !!sc.providerIds };
    }),
    summary: protectedProcedure.input(z.object({ clinicId })).query(async ({ ctx, input }) => {
      const actor = await oppActor(ctx, "opportunitiesView");
      return run(() => ws.opportunitySummary(actor, input.clinicId));
    }),
    list: protectedProcedure
      .input(z.object({ category: z.enum(OPPORTUNITY_CATEGORY_LIST as [string, ...string[]]), clinicId, providerId: z.number().int().positive().nullish(), includeActioned: z.boolean().default(false) }))
      .query(async ({ ctx, input }) => {
        const actor = await oppActor(ctx, "opportunitiesView");
        return run(() => ws.opportunityList(actor, input as Parameters<typeof ws.opportunityList>[1]));
      }),
    // Fill a provider's schedule: who is most likely to book with them.
    fillProviders: protectedProcedure.query(async ({ ctx }) => {
      const actor = await oppActor(ctx, "opportunitiesView");
      return run(() => ws.fillProviders(actor));
    }),
    fill: protectedProcedure
      .input(z.object({ providerId: z.number().int().positive(), includeOtherClinics: z.boolean().default(false), includeActioned: z.boolean().default(false) }))
      .query(async ({ ctx, input }) => {
        const actor = await oppActor(ctx, "opportunitiesView");
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
        const actor = await oppActor(ctx, "opportunitiesAct");
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
        const actor = await oppActor(ctx, "opportunitiesAct");
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

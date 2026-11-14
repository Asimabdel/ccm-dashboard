// Master Billing (owner only, 2026-11-11). Every procedure: an admin's own login (not "view as")
// that is on the Master Billing list (server/masterBillingAccess.ts).
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { BILL_STATUSES } from "../../shared/billCodes";
import { BREAKDOWN_DIM_KEYS, type BreakdownDim } from "../../shared/masterBilling";
import { isValidDateStr } from "../../shared/workforce";
import * as mb from "../masterBillingDb";
import { hasMasterBilling } from "../masterBillingAccess";
import { WorkspaceError, type WorkspaceActor } from "../workspaceDb";

type Ctx = { user: { id: number; name: string | null; role: string; realRole?: string | null }; req?: { headers?: Record<string, unknown>; ip?: string } };

async function owner(ctx: Ctx): Promise<WorkspaceActor> {
  if (!(await hasMasterBilling(ctx.user))) throw new TRPCError({ code: "FORBIDDEN", message: "Master Billing is only open to the owner." });
  const fwd = ctx.req?.headers?.["x-forwarded-for"];
  return { id: ctx.user.id, name: ctx.user.name, role: ctx.user.role, clinicIds: null, ip: (typeof fwd === "string" ? fwd.split(",")[0] : null) || ctx.req?.ip || null };
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WorkspaceError) throw new TRPCError({ code: e.code, message: e.message });
    throw e;
  }
}

const dateStr = z.string().refine(isValidDateStr, "Expected a YYYY-MM-DD date");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const cents = z.number().int().min(-100_000_000).max(100_000_000);
const text = (n: number) => z.string().max(n).nullable();
const adjustment = z.object({ group: z.string().max(4), code: z.string().max(8), cents, kind: z.enum(["patient", "writeoff", "denied"]).optional() });
const line = z.object({
  // Units may be negative on a take-back line (older uploads' pages send them as the file says).
  code: z.string().min(1).max(16), modifiers: z.array(z.string().max(4)).max(6), units: z.number().min(-10_000).max(10_000), serviceDate: ymd,
  billedCents: cents, allowedCents: cents.nullable(), paidCents: cents, adjustments: z.array(adjustment).max(30), remarks: z.array(z.string().max(10)).max(20),
  paidAsCode: z.string().max(16).nullish(),
});
const event = z.object({
  source: z.enum(["era835", "pdf", "sheet"]),
  claimNo: text(80), payerClaimNo: text(80), clpStatus: text(4), sheetStatus: z.enum(BILL_STATUSES).nullable(),
  payerName: text(255), payerId: text(80), filingIndicator: text(4),
  patientName: text(255), patientDob: ymd, memberId: text(80), providerName: text(255), providerNpi: text(20),
  serviceFrom: ymd, serviceTo: ymd, paidDate: ymd, checkNumber: text(80),
  billedCents: cents, paidCents: cents, patientRespCents: cents,
  claimAdjustments: z.array(adjustment).max(30), lines: z.array(line).max(200), note: text(1000),
});
const checkSummary = z.object({
  payerName: text(255), checkNumber: text(80), paymentDate: ymd, amountCents: cents, method: text(10), claims: z.number().int().min(0),
  balanced: z.boolean().nullable(), balanceDiffCents: cents, adjustments: z.array(z.object({ code: z.string().max(4), ref: text(80), cents })).max(100),
});
const filters = z.object({
  from: dateStr, to: dateStr, basis: z.enum(["service", "paid"]).default("service"),
  status: z.array(z.enum(BILL_STATUSES)).max(BILL_STATUSES.length).nullish(),
  payer: z.string().max(160).nullish(), payerType: z.string().max(40).nullish(),
  providerId: z.number().int().positive().nullish(), clinicId: z.number().int().positive().nullish(),
  cpt: z.string().max(16).nullish(), reason: z.string().max(20).nullish(), q: z.string().max(80).nullish(), needsPatient: z.boolean().nullish(),
  closeMatch: z.boolean().nullish(), subjectKey: z.string().max(120).nullish(),
});
const importId = z.number().int().positive();
const shortText = (n: number) => z.string().max(n).nullable();
const zocdocRow = z.object({
  appointmentId: shortText(60), patientFirst: shortText(100), patientLast: shortText(100), patientDob: ymd,
  appointmentAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/), appointmentDate: dateStr, bookedAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/).nullable(),
  status: z.enum(["confirmed", "completed", "patient_canceled", "practice_canceled", "patient_rescheduled", "practice_rescheduled", "no_show", "other"]),
  statusText: shortText(80), patientType: z.enum(["new", "existing"]).nullable(), costCents: z.number().int().min(0).max(10_000_000), costReason: shortText(80),
  bookingSource: shortText(80), providerName: shortText(160), locationName: shortText(160), insuranceCarrier: shortText(160), insurancePlan: shortText(160), visitReason: shortText(160),
});
const subjectKey = z.string().regex(/^(p:\d+|s:.{1,110}|f:.{1,120})$/);

export const masterBillingRouter = router({
  /**
   * Already-saved files among these (by SHA-256). A POST, not a query: 200 hashes in a GET address are
   * ~15 KB, which production's API Gateway refuses (HTTP 431, seen 2026-11-12).
   */
  checkFiles: protectedProcedure.input(z.object({ hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(200) })).mutation(async ({ ctx, input }) => {
    await owner(ctx);
    return mb.checkFiles(input.hashes);
  }),
  startImport: protectedProcedure.input(z.object({
    kind: z.enum(["era835", "pdf", "sheet"]), fileName: z.string().min(1).max(255), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(1), contentType: z.string().max(120), checks: z.array(checkSummary).max(200).nullish(),
  })).mutation(async ({ ctx, input }) => run(async () => mb.startImport(await owner(ctx), input))),
  uploadLocal: protectedProcedure.input(z.object({ importId, base64: z.string().max(36_000_000) })).mutation(async ({ ctx, input }) => {
    await owner(ctx);
    return run(() => mb.uploadLocal(input.importId, input.base64));
  }),
  addEvents: protectedProcedure.input(z.object({ importId, events: z.array(event).min(1).max(250) }))
    .mutation(async ({ ctx, input }) => run(async () => mb.addEvents(await owner(ctx), input.importId, input.events))),
  finishImport: protectedProcedure.input(z.object({ importId, cursor: z.number().int().min(0).default(0) }))
    .mutation(async ({ ctx, input }) => run(async () => mb.finishImport(await owner(ctx), input.importId, input.cursor))),
  cancelImport: protectedProcedure.input(z.object({ importId }))
    .mutation(async ({ ctx, input }) => run(async () => mb.cancelImport(await owner(ctx), input.importId))),
  removeImport: protectedProcedure.input(z.object({ importId, cursor: z.number().int().min(0).default(0) }))
    .mutation(async ({ ctx, input }) => run(async () => mb.removeImport(await owner(ctx), input.importId, input.cursor))),
  imports: protectedProcedure.query(async ({ ctx }) => {
    await owner(ctx);
    return mb.listImports();
  }),
  originalFile: protectedProcedure.input(z.object({ importId })).mutation(async ({ ctx, input }) => {
    await owner(ctx);
    return run(() => mb.originalFile(input.importId));
  }),
  /** PDF EOBs: pages, then one page group per call (nothing saved until the owner checks it). */
  pdfInfo: protectedProcedure.input(z.object({ importId })).mutation(async ({ ctx, input }) => {
    await owner(ctx);
    const { pdfInfo } = await import("../billPdfRead");
    return run(() => pdfInfo(input.importId));
  }),
  pdfRead: protectedProcedure.input(z.object({ importId, from: z.number().int().min(0) })).mutation(async ({ ctx, input }) => {
    await owner(ctx);
    const { readPdfPages } = await import("../billPdfRead");
    return run(() => readPdfPages(input.importId, input.from));
  }),
  sheetMapping: protectedProcedure.input(z.object({ signature: z.string().max(600) })).query(async ({ ctx, input }) => {
    await owner(ctx);
    return mb.sheetMapping(input.signature);
  }),
  saveSheetMapping: protectedProcedure.input(z.object({ signature: z.string().max(600), mapping: z.record(z.string().max(20), z.number().int().min(-1).max(300)) }))
    .mutation(async ({ ctx, input }) => {
      await owner(ctx);
      return mb.saveSheetMapping(input.signature, input.mapping);
    }),

  summary: protectedProcedure.input(filters).query(async ({ ctx, input }) => run(async () => mb.summary(await owner(ctx), input))),
  breakdown: protectedProcedure.input(filters.extend({ dims: z.array(z.enum(BREAKDOWN_DIM_KEYS as [BreakdownDim, ...BreakdownDim[]])).min(1).max(3) }))
    .query(async ({ ctx, input }) => run(async () => mb.breakdown(await owner(ctx), input, input.dims))),
  claims: protectedProcedure.input(filters.extend({ page: z.number().int().min(1).max(10_000).default(1), sort: z.enum(["date", "billed", "paid", "denied"]).default("date") }))
    .query(async ({ ctx, input }) => run(async () => mb.listClaims(await owner(ctx), input, input.page, input.sort))),
  /** Patients whose deductible was applied on several visits (likely a high-deductible plan). */
  highDeductible: protectedProcedure.input(filters.extend({ minVisits: z.number().int().min(1).max(50).default(2) }))
    .query(async ({ ctx, input }) => run(async () => mb.highDeductible(await owner(ctx), input, input.minVisits))),
  claim: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => run(async () => mb.claimDetail(await owner(ctx), input.id))),
  options: protectedProcedure.query(async ({ ctx }) => {
    await owner(ctx);
    return mb.filterOptions();
  }),
  /** Payroll: estimated pay from time-clock hours and pay rates, for a month or a pay period. */
  payroll: protectedProcedure.input(z.discriminatedUnion("view", [
    z.object({ view: z.literal("month"), month: z.string().regex(/^\d{4}-\d{2}$/) }),
    z.object({ view: z.literal("period"), start: dateStr }),
  ])).query(async ({ ctx, input }) => {
    const actor = await owner(ctx);
    const { payroll } = await import("../payrollDb");
    return run(() => payroll(actor, input));
  }),
  payRates: protectedProcedure.input(z.object({ userId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    await owner(ctx);
    const { payRateHistory } = await import("../payrollDb");
    return payRateHistory(input.userId);
  }),
  payrollPeople: protectedProcedure.query(async ({ ctx }) => {
    await owner(ctx);
    const { payrollPeople } = await import("../payrollDb");
    return payrollPeople();
  }),
  setPayRate: protectedProcedure.input(z.object({
    userId: z.number().int().positive(), payType: z.enum(["hourly", "salary"]), amountCents: z.number().int().min(1).max(100_000_000),
    overtime: z.boolean(), startDate: dateStr, note: z.string().max(255).nullish(),
  })).mutation(async ({ ctx, input }) => {
    const actor = await owner(ctx);
    const { setPayRate } = await import("../payrollDb");
    return run(() => setPayRate(actor, input));
  }),
  removePayRate: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const actor = await owner(ctx);
    const { removePayRate } = await import("../payrollDb");
    return run(() => removePayRate(actor, input.id));
  }),

  /** ZocDoc: an uploaded "Appointment report" file starts here (one row per file). */
  zocdocImportStart: protectedProcedure.input(z.object({
    fileName: z.string().min(1).max(255), sha256: z.string().regex(/^[a-f0-9]{64}$/), rowCount: z.number().int().min(0).max(1_000_000), firstDate: ymd, lastDate: ymd,
  })).mutation(async ({ ctx, input }) => {
    const actor = await owner(ctx);
    const { importStart } = await import("../zocdocDb");
    return run(() => importStart(actor, input));
  }),
  /** ZocDoc: the bookings the browser read, up to 500 at a time (the same booking again updates its row). */
  zocdocImportRows: protectedProcedure.input(z.object({ importId: z.number().int().positive(), rows: z.array(zocdocRow).max(500) })).mutation(async ({ ctx, input }) => {
    const actor = await owner(ctx);
    const { importRows } = await import("../zocdocDb");
    return run(() => importRows(actor, input));
  }),
  /** ZocDoc: spend vs. what those patients brought in, for a date range of appointments. */
  zocdocReport: protectedProcedure.input(z.object({ from: dateStr, to: dateStr })).query(async ({ ctx, input }) => {
    const actor = await owner(ctx);
    const { zocdocReport } = await import("../zocdocDb");
    return run(() => zocdocReport(actor, input));
  }),
  zocdocPatients: protectedProcedure.input(z.object({
    from: dateStr, to: dateStr, filter: z.enum(["all", "no_visit", "practice_canceled", "not_matched", "already_ours", "came_in"]).default("all"), page: z.number().int().min(1).max(10_000).default(1),
  })).query(async ({ ctx, input }) => {
    const actor = await owner(ctx);
    const { zocdocPatients } = await import("../zocdocDb");
    return run(() => zocdocPatients(actor, input));
  }),
  zocdocImports: protectedProcedure.query(async ({ ctx }) => {
    await owner(ctx);
    const { zocdocImportsList } = await import("../zocdocDb");
    return zocdocImportsList();
  }),

  /** Pick the patient (null = match again; `none` = the patient isn't in MyPCP, leave it unmatched). */
  linkPatient: protectedProcedure.input(z.object({ claimId: z.number().int().positive(), subjectKey: subjectKey.nullable(), none: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => run(async () => mb.linkPatient(await owner(ctx), input.claimId, input.subjectKey, input.none === true))),
});

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
  code: z.string().min(1).max(16), modifiers: z.array(z.string().max(4)).max(6), units: z.number().min(0).max(10_000), serviceDate: ymd,
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
});
const importId = z.number().int().positive();
const subjectKey = z.string().regex(/^(p:\d+|s:.{1,110}|f:.{1,120})$/);

export const masterBillingRouter = router({
  /** Already-saved files among these (by SHA-256). */
  checkFiles: protectedProcedure.input(z.object({ hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(200) })).query(async ({ ctx, input }) => {
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
  claim: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => run(async () => mb.claimDetail(await owner(ctx), input.id))),
  options: protectedProcedure.query(async ({ ctx }) => {
    await owner(ctx);
    return mb.filterOptions();
  }),
  linkPatient: protectedProcedure.input(z.object({ claimId: z.number().int().positive(), subjectKey: subjectKey.nullable() }))
    .mutation(async ({ ctx, input }) => run(async () => mb.linkPatient(await owner(ctx), input.claimId, input.subjectKey))),
});

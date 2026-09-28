// The patient's side of patient forms: public (no MyPCP login). The link token and the
// patient's date of birth are the keys; after the date-of-birth check a short-lived session
// token is used. Everything is a POST (mutation) so nothing identifying lands in URLs or logs.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import type { TrpcContext } from "../_core/context";
import { INTAKE_LANGS, PHOTO_KINDS, SIGNER_RELATIONS, dobFromParts } from "@shared/intake";
import * as intake from "../intakeDb";

const token = z.string().min(20).max(64);
const session = z.string().min(20).max(1000);

function meta(ctx: TrpcContext): intake.ClientMeta {
  const fwd = ctx.req?.headers?.["x-forwarded-for"];
  const ua = ctx.req?.headers?.["user-agent"];
  return { ip: (typeof fwd === "string" ? fwd.split(",")[0]!.trim() : null) || ctx.req?.ip || null, userAgent: typeof ua === "string" ? ua : null };
}

// A light per-instance brake on hammering (the real protection is the unguessable link plus the
// date-of-birth lockout stored with each packet).
const hits = new Map<string, { n: number; since: number }>();
function brake(ctx: TrpcContext, max: number) {
  const ip = meta(ctx).ip ?? "?";
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.since > 10 * 60_000) { hits.set(ip, { n: 1, since: now }); return; }
  if (++h.n > max) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "slow_down" });
  if (hits.size > 5000) hits.clear();
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof intake.PatientFormError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
    throw e;
  }
}

export const patientFormsRouter = router({
  open: publicProcedure.input(z.object({ token })).mutation(({ ctx, input }) => {
    brake(ctx, 120);
    return intake.patientOpen(input.token, meta(ctx));
  }),
  verify: publicProcedure
    .input(z.object({ token, month: z.string().max(2), day: z.string().max(2), year: z.string().max(4) }))
    .mutation(({ ctx, input }) => {
      brake(ctx, 40);
      return intake.patientVerify(input.token, dobFromParts(input.month, input.day, input.year), meta(ctx));
    }),
  load: publicProcedure.input(z.object({ session })).mutation(({ ctx, input }) => {
    brake(ctx, 300);
    return run(() => intake.patientLoad(input.session));
  }),
  language: publicProcedure.input(z.object({ token, language: z.enum(INTAKE_LANGS) })).mutation(({ ctx, input }) => {
    brake(ctx, 120);
    return intake.patientSetLanguage(input.token, input.language);
  }),
  save: publicProcedure.input(z.object({ session, answers: z.record(z.string(), z.unknown()) })).mutation(({ ctx, input }) => {
    brake(ctx, 600);
    return run(() => intake.patientSave(input.session, input.answers));
  }),
  photo: publicProcedure
    .input(z.object({ session, kind: z.enum(PHOTO_KINDS), dataUrl: z.string().max(5_600_000).nullable() }))
    .mutation(({ ctx, input }) => {
      brake(ctx, 120);
      return run(() => intake.patientPhoto(input.session, { kind: input.kind, dataUrl: input.dataUrl }, meta(ctx)));
    }),
  sign: publicProcedure
    .input(z.object({
      session,
      formKey: z.string().max(40),
      version: z.number().int().min(0),
      language: z.string().max(2),
      signerName: z.string().max(160),
      relation: z.enum(SIGNER_RELATIONS),
      method: z.enum(["typed", "drawn"]),
      drawn: z.string().max(600_000).nullish(),
      esignConsent: z.boolean(),
    }))
    .mutation(({ ctx, input }) => {
      brake(ctx, 120);
      const { session: s, ...rest } = input;
      return run(() => intake.patientSign(s, rest, meta(ctx)));
    }),
});

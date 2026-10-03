// Public patient education pages (no login): provider-approved handouts only. A sent set opens by its
// random code; nothing here returns a patient's name or record.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import * as carePlans from "../carePlansDb";
import { keyOfSlug } from "../../shared/conditionLibrary";

export const learnRouter = router({
  topics: publicProcedure.query(() => carePlans.publicTopics()),
  topic: publicProcedure.input(z.object({ slug: z.string().max(60) })).query(async ({ input }) => {
    const t = await carePlans.publicTopic(keyOfSlug(input.slug));
    if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "This page isn't available." });
    return t;
  }),
  /** Clinic name, address and phone for printed flyers (public information, as on the website). */
  clinics: publicProcedure.query(() => carePlans.publicClinics()),
  sent: publicProcedure.input(z.object({ code: z.string().max(20) })).query(async ({ input }) => {
    const s = await carePlans.publicSent(input.code);
    if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "This link isn't valid." });
    return s;
  }),
});

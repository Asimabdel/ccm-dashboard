import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { invokeLLM } from "../_core/llm";

export const ccmNotesRouter = router({
  generateNote: protectedProcedure
    .input(
      z.object({
        patientName: z.string(),
        localDateTime: z.string().optional(), // caller's local date+time string for the header
        chronicConditions: z.array(z.string()).optional(),
        carePlan: z
          .object({
            problems: z
              .array(z.object({ condition: z.string(), goal: z.string(), intervention: z.string() }))
              .optional(),
            medications: z.string().optional(),
            additionalNotes: z.string().optional(),
            reviewedThisMonth: z.boolean().optional(),
          })
          .optional(),
        responses: z.object({
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
        }),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // The staff member who made the call = whoever is logged in (authoritative).
      const employee = (ctx.user?.name && ctx.user.name.trim()) || ctx.user?.email || "CCM Staff";
      const dateTime = input.localDateTime || new Date().toLocaleString();
      // The three header lines, placed deterministically at the very top of the note.
      const header = `Patient Name: ${input.patientName}\nDate and time: ${dateTime}\nCompleted by: ${employee}`;

      const conditions = (input.chronicConditions || []).filter((c) => c && c.trim());
      const plan = input.carePlan;
      const planProblems = (plan?.problems || []).filter((p) => p.condition && p.condition.trim());
      const carePlanBlock = `
Chronic Conditions Managed: ${conditions.length ? conditions.join(", ") : "Not specified"}

Comprehensive Care Plan:
${
  planProblems.length
    ? planProblems
        .map(
          (p, i) =>
            `  ${i + 1}. ${p.condition} — Goal: ${p.goal || "not set"}; Intervention: ${p.intervention || "not set"}`
        )
        .join("\n")
    : "  No structured problem/goal entries recorded."
}
Medication Management: ${plan?.medications || "Not documented"}
Care Plan Additional Notes: ${plan?.additionalNotes || "None"}
Care Plan Reviewed/Updated With Patient This Month: ${plan?.reviewedThisMonth ? "Yes" : "No"}
`;

      const prompt = `Generate a professional and concise CCM (Chronic Care Management) monthly follow-up note based on the following patient call responses. The note should be well-organized, clinically appropriate, and suitable for medical records.

Patient: ${input.patientName}
${carePlanBlock}
Call Assessment:
- Patient's Current Health Status: ${input.responses.howFeeling || "Not reported"}
- New or Worsening Symptoms: ${input.responses.newSymptoms || "None reported"}
- Medication Adherence: ${input.responses.medicationAdherence || "Not discussed"}
- Medication Refills Needed: ${input.responses.refillsNeeded || "None"}
- Recent ER/Hospitalization: ${input.responses.erHospitalizationSince || "None"}
- Recent Specialist Visits: ${input.responses.recentSpecialistVisits || "None"}
- Blood Pressure Reading: ${input.responses.bloodPressureReading || "Not taken"}
- Blood Sugar Reading: ${input.responses.bloodSugarReading || "Not taken"}
- Upcoming Appointments: ${input.responses.upcomingAppointments || "None scheduled"}
- Follow-up/Testing Needed: ${input.responses.followUpNeeded || "None identified"}
- Patient Concerns/Questions: ${input.responses.patientConcerns || "None reported"}

Generate a structured clinical note with the following sections:
1. CHIEF COMPLAINT/REASON FOR CONTACT
2. CHRONIC CONDITIONS & CARE PLAN REVIEW (list the conditions managed; for each, state the goal and intervention from the care plan; explicitly note whether the comprehensive care plan was reviewed/updated with the patient this month)
3. HISTORY OF PRESENT ILLNESS
4. VITAL SIGNS/MEASUREMENTS (if available)
5. MEDICATION REVIEW
6. ASSESSMENT
7. PLAN/RECOMMENDATIONS
8. FOLLOW-UP

The note should be professional, concise (350-600 words), and ready for inclusion in the patient's medical record. Begin directly with the first section heading — do NOT add a title, patient name, date, or "completed by" line, as those are added separately at the top of the note.`;

      try {
        const response = await invokeLLM({
          messages: [
            {
              role: "system",
              content:
                "You are an experienced medical documentation specialist. Generate professional, clinically appropriate CCM notes based on call summaries. Ensure notes are well-organized, concise, and suitable for medical records.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        });

        const raw = response.choices[0]?.message?.content;
        const body = typeof raw === "string" && raw.trim() ? raw.trim() : "";

        return {
          success: true,
          note: body ? `${header}\n\n${body}` : "Unable to generate note. Please try again.",
          generatedAt: Date.now(),
        };
      } catch (error) {
        console.error("Error generating CCM note:", error);
        return {
          success: false,
          note: "Error generating note. Please try again or contact support.",
          generatedAt: Date.now(),
        };
      }
    }),
});

import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { invokeLLM } from "../_core/llm";

export const ccmNotesRouter = router({
  generateNote: protectedProcedure
    .input(
      z.object({
        patientName: z.string(),
        chronicConditions: z.array(z.string()).optional(),
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
    .mutation(async ({ input }) => {
      const conditions = (input.chronicConditions ?? []).filter(Boolean);
      const prompt = `Write a Chronic Care Management (CCM) monthly care-management note documenting the telephone encounter below. Format it as a proper CCM note suitable for the medical record and CCM billing documentation.

PATIENT: ${input.patientName}
DATE OF SERVICE: ${new Date().toLocaleDateString()}
ENCOUNTER TYPE: Telephone — CCM monthly check-in
CHRONIC CONDITIONS BEING MANAGED: ${conditions.length ? conditions.join(", ") : "Not specified"}

Patient-reported during the call:
- Current health status: ${input.responses.howFeeling || "Not reported"}
- New or worsening symptoms: ${input.responses.newSymptoms || "None reported"}
- Medication adherence: ${input.responses.medicationAdherence || "Not discussed"}
- Medication refills needed: ${input.responses.refillsNeeded || "None"}
- Recent ER/hospitalization: ${input.responses.erHospitalizationSince || "None"}
- Recent specialist visits: ${input.responses.recentSpecialistVisits || "None"}
- Blood pressure reading: ${input.responses.bloodPressureReading || "Not obtained"}
- Blood sugar reading: ${input.responses.bloodSugarReading || "Not obtained"}
- Upcoming appointments: ${input.responses.upcomingAppointments || "None scheduled"}
- Follow-up/testing needed: ${input.responses.followUpNeeded || "None identified"}
- Patient concerns/questions: ${input.responses.patientConcerns || "None reported"}

Produce the note with these sections, in this order and with these headings:
1. REASON FOR CONTACT — that this is the monthly CCM check-in for the chronic conditions above.
2. SUBJECTIVE — patient-reported status, symptoms, medication adherence/refills, and any recent ER/hospitalizations or specialist visits.
3. OBJECTIVE / VITALS — any readings provided (BP, blood sugar); write "Not obtained this encounter" if none.
4. ASSESSMENT — a brief status line for each chronic condition being managed.
5. CARE PLAN & COORDINATION — interventions, patient education, medication actions, referrals, scheduling, and any care coordination performed.
6. FOLLOW-UP — next steps, upcoming appointments, and when the next CCM contact should occur.

Keep it professional, clinically appropriate, and concise (about 250-450 words). Do not invent clinical findings that were not provided. Do NOT add a signature, "documented by", or date/time line at the end — that is appended separately.`;

      try {
        const response = await invokeLLM({
          messages: [
            {
              role: "system",
              content:
                "You are an experienced medical documentation specialist who writes Chronic Care Management (CCM) monthly notes. Produce well-organized, clinically appropriate CCM notes from the call summary using the exact section headings requested. Be concise and never fabricate clinical findings.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        });

        const generatedNote =
          response.choices[0]?.message?.content ||
          "Unable to generate note. Please try again.";

        return {
          success: true,
          note: generatedNote,
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

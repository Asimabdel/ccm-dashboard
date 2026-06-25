import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { invokeLLM } from "../_core/llm";

export const ccmNotesRouter = router({
  generateNote: protectedProcedure
    .input(
      z.object({
        patientName: z.string(),
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
      const prompt = `Generate a professional and concise CCM (Chronic Care Management) monthly follow-up note based on the following patient call responses. The note should be well-organized, clinically appropriate, and suitable for medical records.

Patient Name: ${input.patientName}
Date: ${new Date().toLocaleDateString()}
Call completed by (CCM staff member who conducted this call): ${employee}

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
2. HISTORY OF PRESENT ILLNESS
3. VITAL SIGNS/MEASUREMENTS (if available)
4. MEDICATION REVIEW
5. ASSESSMENT
6. PLAN/RECOMMENDATIONS
7. FOLLOW-UP

The note should be professional, concise (300-500 words), and ready for inclusion in the patient's medical record. End the note with a final signature line reading exactly: "Completed by: ${employee}". Use this exact name — never a placeholder such as [Your Name].`;

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
        let generatedNote =
          typeof raw === "string" && raw.trim()
            ? raw
            : "Unable to generate note. Please try again.";

        // Safety net: guarantee the caller's name appears even if the model omitted it.
        if (typeof raw === "string" && raw.trim() && !generatedNote.toLowerCase().includes(employee.toLowerCase())) {
          generatedNote = `${generatedNote.trimEnd()}\n\nCompleted by: ${employee}`;
        }

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

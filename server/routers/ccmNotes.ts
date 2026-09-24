import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { invokeLLM } from "../_core/llm";

export const ccmNotesRouter = router({
  generateNote: protectedProcedure
    .input(
      z.object({
        patientName: z.string(),
        localDateTime: z.string().optional(), // caller's local date+time string for the header
        // Which program this note documents — drives CCM vs BHI (99484) formatting.
        program: z.enum(["ccm", "bhi", "apcm"]).optional(),
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
        // BHI-only validated assessment context for the note.
        bhiAssessment: z.object({
          phq9Score: z.number().nullable().optional(),
          gad7Score: z.number().nullable().optional(),
          assessmentToolOther: z.string().optional(),
          assessmentScoreOther: z.number().nullable().optional(),
          behavioralStatus: z.string().optional(),
          carePlanUpdated: z.boolean().optional(),
          riskFlag: z.boolean().optional(),
        }).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // The staff member who made the call = whoever is logged in (authoritative).
      const employee = (ctx.user?.name && ctx.user.name.trim()) || ctx.user?.email || "CCM Staff";
      const dateTime = input.localDateTime || new Date().toLocaleString();
      // The three header lines, placed deterministically at the very top of the note.
      const header = `Patient Name: ${input.patientName}\nDate and time: ${dateTime}\nCompleted by: ${employee}`;

      const isBhi = input.program === "bhi";
      const a = input.bhiAssessment;
      const bhiPrompt = `Generate a professional, concise BHI (Behavioral Health Integration, CPT 99484) monthly care-management note based on the following patient call. The note must document behavioral-health care management, be clinically appropriate, and be suitable for the medical record.

Patient: ${input.patientName}

Behavioral Health Check-In:
- Mood / emotional wellbeing since last contact: ${input.responses.howFeeling || "Not reported"}
- Behavioral symptoms / changes (sleep, appetite, concentration, energy): ${input.responses.newSymptoms || "None reported"}
- Psychiatric medication adherence & side effects: ${input.responses.medicationAdherence || "Not discussed"}
- Refills needed: ${input.responses.refillsNeeded || "None"}
- Crisis events / ER / psychiatric hospitalization since last contact: ${input.responses.erHospitalizationSince || "None"}
- Therapy / psychiatry / counseling engagement: ${input.responses.recentSpecialistVisits || "None"}
- Upcoming behavioral-health appointments: ${input.responses.upcomingAppointments || "None scheduled"}
- Follow-up / coordination needed: ${input.responses.followUpNeeded || "None identified"}
- Patient concerns / psychosocial stressors: ${input.responses.patientConcerns || "None reported"}

Validated Rating Scales:
- PHQ-9 (depression, 0-27): ${a?.phq9Score ?? "Not administered"}
- GAD-7 (anxiety, 0-21): ${a?.gad7Score ?? "Not administered"}
- Other tool: ${a?.assessmentToolOther ? `${a.assessmentToolOther} = ${a.assessmentScoreOther ?? "n/a"}` : "None"}
- Behavioral trajectory: ${a?.behavioralStatus || "Not specified"}
- Behavioral care plan revised this month: ${a?.carePlanUpdated ? "Yes" : "No"}
- Safety risk flagged: ${a?.riskFlag ? "YES — provider review required" : "No"}

Generate a structured behavioral-health note with these sections:
1. REASON FOR CONTACT
2. BEHAVIORAL HEALTH STATUS (interval history)
3. VALIDATED ASSESSMENT RESULTS (interpret PHQ-9/GAD-7 severity)
4. MEDICATION & TREATMENT REVIEW
5. CARE PLAN (goals, interventions, coordination — note any revision)
6. RISK ASSESSMENT / SAFETY
7. FOLLOW-UP

The note should be professional, concise (300-500 words), and ready for the medical record. Begin directly with the first section heading — do NOT add a title, patient name, date, or "completed by" line, as those are added separately at the top of the note.`;

      const ccmPrompt = `Generate a professional and concise CCM (Chronic Care Management) monthly follow-up note based on the following patient call responses. The note should be well-organized, clinically appropriate, and suitable for medical records.

Patient: ${input.patientName}

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

The note should be professional, concise (300-500 words), and ready for inclusion in the patient's medical record. Begin directly with the first section heading — do NOT add a title, patient name, date, or "completed by" line, as those are added separately at the top of the note.`;

      const prompt = isBhi ? bhiPrompt : ccmPrompt;
      const systemContent = isBhi
        ? "You are an experienced behavioral-health documentation specialist. Generate professional, clinically appropriate Behavioral Health Integration (BHI) care-management notes based on call summaries and validated rating scales (PHQ-9, GAD-7). Notes must be well-organized, concise, and suitable for the medical record."
        : "You are an experienced medical documentation specialist. Generate professional, clinically appropriate CCM notes based on call summaries. Ensure notes are well-organized, concise, and suitable for medical records.";

      try {
        const response = await invokeLLM({
          messages: [
            {
              role: "system",
              content: systemContent,
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

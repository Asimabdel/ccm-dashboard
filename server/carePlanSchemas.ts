// Input checks for the condition library and care plans (sizes kept generous but bounded).
import { z } from "zod";

const line = z.string().trim().max(600);
const lines = (max: number) => z.array(line).max(max).transform((a) => a.filter(Boolean));
const para = z.string().trim().max(2000);

const educationDoc = z.object({
  title: z.string().trim().min(1).max(160),
  whatItIs: para,
  whyItMatters: para,
  whatYouCanDo: lines(15),
  numbers: lines(12),
  medicines: lines(10),
  callUs: lines(10),
  call911: lines(10),
});

/** A prevention & wellness handout (shared/wellness/types.ts). */
const wellnessDoc = z.object({
  title: z.string().trim().min(1).max(160),
  summary: para,
  whoFor: lines(10),
  howOften: z.string().trim().max(400),
  whatToDo: lines(15),
  whatToExpect: lines(10),
  talkToUs: lines(10),
});
export const wellnessEntrySchema = z.object({
  key: z.string().max(40),
  education: z.object({ en: wellnessDoc, es: wellnessDoc }),
  basis: lines(10),
});

export const carePlanTemplateSchema = z.object({
  problem: z.string().trim().min(1).max(400),
  expectedOutcome: para,
  goals: lines(12),
  monitoring: lines(15),
  interventions: lines(15),
  selfManagement: lines(12),
  symptomManagement: lines(12),
  coordination: lines(12),
});

export const libraryEntrySchema = z.object({
  key: z.string().max(40),
  education: z.object({ en: educationDoc, es: educationDoc }),
  talkingPoints: z.object({ teach: lines(12), ask: lines(10) }),
  carePlan: carePlanTemplateSchema,
  basis: lines(8),
});

export const planProblemSchema = carePlanTemplateSchema.extend({
  problem: z.string().trim().max(400),
  key: z.string().max(40).nullable(),
  diagnosis: z.string().trim().max(1000),
  templateVersion: z.number().int().nullable(),
  kind: z.enum(["condition", "addon"]).optional(),
  assumed: z.boolean().optional(),
  confirmType: z.boolean().optional(),
});

export const planGeneralSchema = z.object({
  patientGoals: para,
  medications: para,
  careTeam: para,
  community: para,
  advanceCare: para,
  followUp: para,
});

export const planSchema = z.object({
  problems: z.array(planProblemSchema).max(40),
  general: planGeneralSchema,
});

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

export const carePlanTemplateSchema = z.object({
  problem: z.string().trim().min(1).max(200),
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
  problem: z.string().trim().max(200),
  key: z.string().max(40).nullable(),
  diagnosis: z.string().trim().max(300),
  templateVersion: z.number().int().nullable(),
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

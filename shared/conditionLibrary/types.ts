// The condition library: for each chronic condition the program rules recognize (shared/programRules.ts
// CATEGORIES), a patient handout (English + Spanish), coordinator talking points for the CCM call, and a
// care-plan template. Everything here is a DRAFT until a provider approves it in MyPCP (Care plans &
// education); the approved version is what patients and care plans use.

export const LIBRARY_LANGS = ["en", "es"] as const;
export type LibraryLang = (typeof LIBRARY_LANGS)[number];

/** A plain-language patient handout (about a 6th-grade reading level). */
export interface EducationDoc {
  /** e.g. "Living with diabetes" */
  title: string;
  /** What the condition is: 2–3 short sentences. */
  whatItIs: string;
  /** Why it matters / what can happen if it isn't controlled: 1–2 sentences. */
  whyItMatters: string;
  /** Everyday things the patient can do: 5–7 short bullets. */
  whatYouCanDo: string[];
  /** "Know your numbers": what to track and the usual goals (empty when it doesn't apply). */
  numbers: string[];
  /** About their medicines: 2–4 bullets (general; never a specific drug or dose). */
  medicines: string[];
  /** When to call the care team: 3–5 bullets. */
  callUs: string[];
  /** When to call 911 (or 988 for a mental-health crisis): 2–4 bullets. */
  call911: string[];
}

/** Short points the care coordinator covers on the monthly CCM call (English, staff-facing). */
export interface TalkingPoints {
  /** What to teach / reinforce: 4–6 bullets. */
  teach: string[];
  /** What to ask the patient: 3–5 questions. */
  ask: string[];
}

/** One condition's section of a CMS comprehensive care plan. The provider individualizes it per patient. */
export interface CarePlanTemplate {
  /** The problem as written in the plan, e.g. "Type 2 diabetes mellitus". */
  problem: string;
  /** Expected outcome / prognosis wording, 1 sentence (provider adjusts per patient). */
  expectedOutcome: string;
  /** Measurable treatment goals, 2–4 (targets "or as individualized by the provider"). */
  goals: string[];
  /** What is monitored and how often (labs, vitals, exams, screenings): 3–6. */
  monitoring: string[];
  /** Planned interventions by the care team: 3–6. */
  interventions: string[];
  /** Patient self-management actions: 3–5. */
  selfManagement: string[];
  /** Symptoms to manage / watch for and the plan when they happen: 2–4. */
  symptomManagement: string[];
  /** Coordination with specialists, other providers and community resources: 1–4. */
  coordination: string[];
}

export interface ConditionLibraryEntry {
  /** The programRules category key (e.g. "diabetes"). */
  key: string;
  education: Record<LibraryLang, EducationDoc>;
  talkingPoints: TalkingPoints;
  carePlan: CarePlanTemplate;
  /** The guidance the draft follows (for the reviewing provider), e.g. "ADA Standards of Care in Diabetes 2025". */
  basis: string[];
}

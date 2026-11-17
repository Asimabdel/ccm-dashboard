// The guided CCM call, shaped by the patient's own conditions: a few check-in questions everyone gets,
// the readings that matter for their conditions (blood pressure, blood sugar, weight), and each
// condition's own questions (the condition library's "ask" talking points). Pure (server + client).

/** The questions every CCM call starts with (their answers go in the note's own columns). */
export const CORE_QUESTIONS = [
  { key: "howFeeling", question: "How have you been feeling since our last check-in?", placeholder: "General wellbeing, energy, mood…" },
  { key: "newSymptoms", question: "Any new or worsening symptoms?", placeholder: "Chest pain, shortness of breath, dizziness, swelling…" },
  { key: "medicationAdherence", question: "Are you taking all your medicines as prescribed? Any side effects or trouble paying for them?", placeholder: "Adherence, missed doses, side effects, cost…" },
  { key: "refillsNeeded", question: "Do you need any prescription refills?", placeholder: "Medicines needing a refill…" },
  { key: "erHospitalizationSince", question: "Any ER visits or hospital stays since we last talked?", placeholder: "Dates, reason, outcome…" },
  { key: "recentSpecialistVisits", question: "Any visits with a specialist?", placeholder: "Specialist, date, what they said…" },
  { key: "upcomingAppointments", question: "Any appointments coming up?", placeholder: "Provider, date…" },
  { key: "patientConcerns", question: "Anything else on your mind? Any trouble with food, rides, money or help at home?", placeholder: "Questions, social needs, barriers…" },
  { key: "followUpNeeded", question: "What follow-up does this patient need?", placeholder: "Labs, referrals, scheduling, education…" },
] as const;
export type CoreKey = (typeof CORE_QUESTIONS)[number]["key"];

export const READING_KEYS = ["bp", "sugar", "weight"] as const;
export type ReadingKey = (typeof READING_KEYS)[number];
export const READINGS: Record<ReadingKey, { label: string; question: string; placeholder: string }> = {
  bp: { label: "Blood pressure", question: "What was your most recent blood pressure?", placeholder: "e.g. 128/82, taken at home this morning" },
  sugar: { label: "Blood sugar", question: "What have your blood sugar numbers been?", placeholder: "e.g. 110–140 fasting, last A1c 7.2" },
  weight: { label: "Weight", question: "What do you weigh today? Any quick gain?", placeholder: "e.g. 182 lb, up 3 lb this week" },
};

const BP = /^(hypertension|htn_|hf_|heart_failure|cad|ckd|dm_kidney|dm_heart|cardiometabolic|stroke|afib|pvd)/;
const SUGAR = /^(diabetes_|dm_|smi_metabolic)/;
const WEIGHT = /^(heart_failure|hf_|obesity)/;

/** The readings that matter for these condition keys, in a fixed order. */
export function readingsFor(keys: string[]): ReadingKey[] {
  const out: ReadingKey[] = [];
  if (keys.some((k) => BP.test(k))) out.push("bp");
  if (keys.some((k) => SUGAR.test(k))) out.push("sugar");
  if (keys.some((k) => WEIGHT.test(k))) out.push("weight");
  return out;
}

/** One condition's questions and the patient's answers on this call. */
export interface ConditionAnswers { key: string; label: string; answers: { q: string; a: string }[] }
/** What the condition-shaped part of the call adds to the note. */
export interface CallExtras { readings: Partial<Record<ReadingKey, string>>; conditions: ConditionAnswers[] }

/** A call's extras as sent in: answered questions only, trimmed, bounded. */
export function cleanCallExtras(raw: unknown): CallExtras {
  const out: CallExtras = { readings: {}, conditions: [] };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const readings = (r.readings ?? {}) as Record<string, unknown>;
  for (const k of READING_KEYS) if (typeof readings[k] === "string" && (readings[k] as string).trim()) out.readings[k] = (readings[k] as string).trim().slice(0, 120);
  if (Array.isArray(r.conditions)) {
    for (const c of r.conditions.slice(0, 30)) {
      if (!c || typeof c !== "object") continue;
      const x = c as Record<string, unknown>;
      const key = typeof x.key === "string" ? x.key.slice(0, 40) : "";
      const answers = (Array.isArray(x.answers) ? x.answers : []).slice(0, 12).flatMap((qa) => {
        const y = (qa ?? {}) as Record<string, unknown>;
        const q = typeof y.q === "string" ? y.q.trim().slice(0, 400) : "";
        const a = typeof y.a === "string" ? y.a.trim().slice(0, 1000) : "";
        return q && a ? [{ q, a }] : [];
      });
      if (key && answers.length) out.conditions.push({ key, label: typeof x.label === "string" ? x.label.trim().slice(0, 160) : key, answers });
    }
  }
  return out;
}

/** The extras as lines for the AI note prompt and the plain-text note. */
export function callExtrasText(x: CallExtras): string[] {
  const out: string[] = [];
  for (const k of READING_KEYS) if (x.readings[k]) out.push(`${READINGS[k].label}: ${x.readings[k]}`);
  for (const c of x.conditions) {
    out.push(`${c.label}:`);
    for (const qa of c.answers) out.push(`  - ${qa.q} → ${qa.a}`);
  }
  return out;
}

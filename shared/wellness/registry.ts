// The prevention & wellness topics, grouped, and which patients each is suggested for (by age, sex,
// smoking and BMI from the chart). Suggestions only: staff pick what to give.

export const WELLNESS_GROUPS = {
  vaccines: { en: "Vaccines", es: "Vacunas" },
  screenings: { en: "Cancer screenings", es: "Pruebas de detección de cáncer" },
  checkups: { en: "Check-ups", es: "Chequeos" },
  living: { en: "Healthy living", es: "Vida saludable" },
} as const;
export type WellnessGroup = keyof typeof WELLNESS_GROUPS;

export interface WellnessPerson {
  age: number | null;
  sex: "F" | "M" | "X" | null;
  /** From the Practice Fusion chart (latest smoking status). */
  smoker: "current" | "former" | "never" | null;
  bmi: number | null;
}

export interface WellnessTopic {
  key: string;
  /** Staff-facing name. */
  label: string;
  group: WellnessGroup;
  /** When it's suggested for a patient, and why (shown to staff). */
  suggest?: (p: WellnessPerson) => boolean;
  /** The reason, in general (Wellness handouts list), and for this person when it depends on what's on file. */
  why?: string;
  whyFor?: (p: WellnessPerson) => string;
}

const between = (p: WellnessPerson, lo: number, hi = 200) => p.age !== null && p.age >= lo && p.age <= hi;

export const WELLNESS_TOPICS: WellnessTopic[] = [
  // Vaccines
  { key: "w_flu", label: "Flu shot", group: "vaccines", suggest: (p) => p.age !== null, why: "Everyone, every year" },
  { key: "w_covid", label: "COVID-19 vaccine", group: "vaccines", suggest: (p) => between(p, 65), why: "Age 65+" },
  { key: "w_shingles", label: "Shingles vaccine", group: "vaccines", suggest: (p) => between(p, 50), why: "Age 50+" },
  { key: "w_pneumonia", label: "Pneumonia (pneumococcal) vaccine", group: "vaccines", suggest: (p) => between(p, 50), why: "Age 50+" },
  { key: "w_rsv", label: "RSV vaccine", group: "vaccines", suggest: (p) => between(p, 75), why: "Age 75+" },
  { key: "w_tdap", label: "Tetanus, diphtheria & whooping cough (Tdap/Td)", group: "vaccines", suggest: (p) => between(p, 19), why: "Adults, every 10 years" },
  { key: "w_hepatitis_b", label: "Hepatitis B vaccine", group: "vaccines", suggest: (p) => between(p, 19, 59), why: "Age 19–59" },
  { key: "w_hpv", label: "HPV vaccine", group: "vaccines", suggest: (p) => between(p, 19, 26), why: "Age 19–26" },
  // Cancer screenings
  { key: "w_colon_cancer", label: "Colon cancer screening", group: "screenings", suggest: (p) => between(p, 45, 75), why: "Age 45–75" },
  { key: "w_breast_cancer", label: "Breast cancer screening (mammogram)", group: "screenings", suggest: (p) => p.sex === "F" && between(p, 40, 74), why: "Women 40–74" },
  { key: "w_cervical_cancer", label: "Cervical cancer screening (Pap / HPV test)", group: "screenings", suggest: (p) => p.sex === "F" && between(p, 21, 65), why: "Women 21–65" },
  { key: "w_lung_cancer", label: "Lung cancer screening", group: "screenings", suggest: (p) => between(p, 50, 80) && (p.smoker === "current" || p.smoker === "former"), why: "Age 50–80 who smoke or used to" },
  { key: "w_prostate_cancer", label: "Prostate cancer screening (PSA)", group: "screenings", suggest: (p) => p.sex === "M" && between(p, 55, 69), why: "Men 55–69 (a choice to talk over)" },
  // Check-ups
  { key: "w_wellness_visit", label: "Yearly wellness visit", group: "checkups", suggest: (p) => between(p, 18), why: "Adults, every year" },
  { key: "w_blood_pressure", label: "Blood pressure checks", group: "checkups", suggest: (p) => between(p, 18), why: "Adults" },
  { key: "w_cholesterol", label: "Cholesterol checks", group: "checkups", suggest: (p) => between(p, 40, 75), why: "Age 40–75" },
  { key: "w_diabetes_screening", label: "Diabetes & prediabetes screening", group: "checkups", suggest: (p) => between(p, 35, 70) && (p.bmi === null || p.bmi >= 25), why: "Age 35–70 with extra weight", whyFor: (p) => p.bmi === null ? "Age 35–70 (weight not on file)" : "Age 35–70 with extra weight" },
  { key: "w_bone_density", label: "Bone density (osteoporosis) test", group: "checkups", suggest: (p) => p.sex === "F" && between(p, 65), why: "Women 65+" },
  { key: "w_hepc_hiv", label: "Hepatitis C & HIV testing", group: "checkups", suggest: (p) => between(p, 18, 79), why: "Adults, at least once" },
  // Healthy living
  { key: "w_healthy_eating", label: "Healthy eating", group: "living" },
  { key: "w_physical_activity", label: "Staying active", group: "living" },
  { key: "w_healthy_weight", label: "Reaching a healthy weight", group: "living", suggest: (p) => p.bmi !== null && p.bmi >= 25, why: "BMI 25 or more" },
  { key: "w_sleep", label: "Better sleep", group: "living" },
  { key: "w_quit_smoking", label: "Quitting smoking & vaping", group: "living", suggest: (p) => p.smoker === "current", why: "Smokes now" },
  { key: "w_alcohol", label: "Alcohol and your health", group: "living" },
  { key: "w_stress", label: "Stress & emotional health", group: "living" },
  { key: "w_fall_prevention", label: "Preventing falls", group: "living", suggest: (p) => between(p, 65), why: "Age 65+" },
  { key: "w_sun_safety", label: "Sun safety & skin checks", group: "living" },
];

export const WELLNESS_BY_KEY: ReadonlyMap<string, WellnessTopic> = new Map(WELLNESS_TOPICS.map((t) => [t.key, t]));
export const WELLNESS_KEYS = WELLNESS_TOPICS.map((t) => t.key);
export const isWellnessKey = (key: string) => WELLNESS_BY_KEY.has(key);

/** Topics suggested for this person, with the reason. */
export function suggestWellness(p: WellnessPerson): { key: string; why: string }[] {
  return WELLNESS_TOPICS.filter((t) => t.suggest?.(p)).map((t) => ({ key: t.key, why: t.whyFor?.(p) ?? t.why ?? "" }));
}

/** Latest smoking status text from the chart → current / former / never. */
export function smokerFrom(text: string | null | undefined): WellnessPerson["smoker"] {
  const s = (text ?? "").toLowerCase();
  if (!s || /unknown|never assessed|not assessed/.test(s)) return null;
  if (/former|ex-?smoker|quit|past/.test(s)) return "former";
  if (/never|non-?smoker|no tobacco|not a smoker/.test(s)) return "never";
  if (/current|every day|some days|smoker|smokes|light|heavy/.test(s)) return "current";
  return null;
}

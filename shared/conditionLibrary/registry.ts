// The specialized condition library: which handout / care-plan template a patient gets.
//
// Each recognized condition group (programRules category) has one or more EXACT-DIAGNOSIS items
// (Type 1 vs Type 2 diabetes, heart failure reduced vs preserved, CKD by stage…). A diagnosis name picks
// the most specific item that matches it; a vague name ("Diabetes") gets the group's default item —
// the most common type (the practice's choice, 2026-10-01) — marked "assumed" so the provider can
// confirm it. Where the type changes treatment too much to assume (heart failure without an ejection
// fraction, kidney disease without a stage), the default is a general plan flagged "confirm the type".
//
// ADD-ONS cover complications and overlaps (diabetes with kidney disease, depression with anxiety,
// several cardiometabolic conditions together…): extra sections on top of the condition plans.
import { categoryLabel, classifyConditionName } from "../programRules";

export type ItemKind = "condition" | "addon";

export interface LibraryItem {
  key: string;
  /** Plain name, e.g. "Type 2 diabetes". */
  label: string;
  /** The programRules category it belongs to (add-ons: the main one). */
  category: string;
  kind: ItemKind;
  /** Condition items: matches the cleaned, lower-case diagnosis name. */
  match?: RegExp;
  /** Condition items: the group's item for vague names. */
  isDefault?: boolean;
  /** Default that is a general plan (type not documented): the provider should confirm the type. */
  general?: boolean;
  /** Condition items: when several match, the highest wins. */
  priority?: number;
  /** Add-ons: when it applies. */
  when?: (p: { cats: Set<string>; items: Set<string>; names: string[] }) => boolean;
}

const any = (names: string[], re: RegExp) => names.some((n) => re.test(n));
const has = (cats: Set<string>, ...k: string[]) => k.some((x) => cats.has(x));

export const LIBRARY_ITEMS: LibraryItem[] = [
  // Diabetes
  { key: "diabetes_t2", label: "Type 2 diabetes", category: "diabetes", kind: "condition", match: /type\s*(2|ii)\b|non.?insulin.dependent/, isDefault: true, priority: 1 },
  { key: "diabetes_t1", label: "Type 1 diabetes", category: "diabetes", kind: "condition", match: /type\s*(1|i)\b|insulin.dependent|juvenile|\blada\b/, priority: 2 },
  // High blood pressure
  { key: "hypertension", label: "High blood pressure", category: "hypertension", kind: "condition", isDefault: true },
  { key: "hypertension_heart", label: "Hypertensive heart disease", category: "hypertension", kind: "condition", match: /hypertensive heart/, priority: 2 },
  // Heart failure
  { key: "heart_failure", label: "Heart failure (type not documented)", category: "heart_failure", kind: "condition", isDefault: true, general: true },
  { key: "hf_reduced", label: "Heart failure with reduced ejection fraction", category: "heart_failure", kind: "condition", match: /systolic|reduced ejection|hfref|reduced ef\b/, priority: 2 },
  { key: "hf_preserved", label: "Heart failure with preserved ejection fraction", category: "heart_failure", kind: "condition", match: /diastolic|preserved ejection|hfpef|preserved ef\b/, priority: 2 },
  // Coronary disease
  { key: "cad", label: "Coronary artery disease", category: "cad", kind: "condition", isDefault: true },
  { key: "cad_post_event", label: "Coronary disease after a heart attack, stent or bypass", category: "cad", kind: "condition", match: /myocardial infarction|\bstemi\b|\bnstemi\b|angioplasty|\bpci\b|\bptca\b|stent|bypass|cabg/, priority: 2 },
  { key: "afib", label: "Atrial fibrillation", category: "afib", kind: "condition", isDefault: true },
  // Cholesterol
  { key: "lipids", label: "High cholesterol", category: "lipids", kind: "condition", isDefault: true },
  { key: "lipids_triglycerides", label: "High triglycerides", category: "lipids", kind: "condition", match: /hypertriglycerid/, priority: 2 },
  { key: "lipids_familial", label: "Familial hypercholesterolemia", category: "lipids", kind: "condition", match: /familial/, priority: 3 },
  // Lungs
  { key: "copd", label: "COPD", category: "copd", kind: "condition", isDefault: true },
  { key: "asthma", label: "Asthma", category: "asthma", kind: "condition", isDefault: true },
  // Kidneys
  { key: "ckd", label: "Chronic kidney disease (stage not documented)", category: "ckd", kind: "condition", isDefault: true, general: true },
  { key: "ckd_early", label: "Chronic kidney disease, stage 1–2", category: "ckd", kind: "condition", match: /stage\s*(1|2|i|ii)\b/, priority: 2 },
  { key: "ckd_3", label: "Chronic kidney disease, stage 3", category: "ckd", kind: "condition", match: /stage\s*(3|iii)(a|b)?\b/, priority: 3 },
  { key: "ckd_4", label: "Chronic kidney disease, stage 4", category: "ckd", kind: "condition", match: /stage\s*(4|iv)\b/, priority: 4 },
  { key: "ckd_5", label: "Chronic kidney disease, stage 5 / dialysis", category: "ckd", kind: "condition", match: /stage\s*(5|v)\b|end.stage|\besrd\b|\beskd\b|dialysis/, priority: 5 },
  // Thyroid
  { key: "thyroid_hypo", label: "Underactive thyroid (hypothyroidism)", category: "thyroid", kind: "condition", match: /hypothyroid|hashimoto|myxedema/, isDefault: true, priority: 1 },
  { key: "thyroid_hyper", label: "Overactive thyroid (hyperthyroidism)", category: "thyroid", kind: "condition", match: /hyperthyroid|graves|thyrotoxicosis/, priority: 2 },
  // Weight
  { key: "obesity", label: "Obesity", category: "obesity", kind: "condition", isDefault: true },
  { key: "obesity_severe", label: "Severe obesity", category: "obesity", kind: "condition", match: /severe obesity|morbid|class\s*(3|iii)\b|body mass index (4\d|5\d|6\d)/, priority: 2 },
  // Joints, bones, nerves, other
  { key: "osteoarthritis", label: "Osteoarthritis", category: "osteoarthritis", kind: "condition", isDefault: true },
  { key: "rheumatoid", label: "Rheumatoid arthritis", category: "rheumatoid", kind: "condition", isDefault: true },
  { key: "osteoporosis", label: "Osteoporosis", category: "osteoporosis", kind: "condition", isDefault: true },
  { key: "dementia", label: "Dementia", category: "dementia", kind: "condition", isDefault: true },
  { key: "parkinsons", label: "Parkinson's disease", category: "parkinsons", kind: "condition", isDefault: true },
  { key: "stroke", label: "Stroke (lasting effects)", category: "stroke", kind: "condition", isDefault: true },
  { key: "pvd", label: "Peripheral artery disease", category: "pvd", kind: "condition", isDefault: true },
  { key: "cancer", label: "Cancer", category: "cancer", kind: "condition", isDefault: true },
  // Liver
  { key: "liver", label: "Chronic liver disease", category: "liver", kind: "condition", isDefault: true, general: true },
  { key: "liver_fatty", label: "Fatty liver disease (MASLD)", category: "liver", kind: "condition", match: /fatty liver|nafld|\bnash\b|masld|\bmash\b|steatosis|steatohepatitis/, priority: 2 },
  { key: "liver_hepatitis", label: "Chronic hepatitis B or C", category: "liver", kind: "condition", match: /hepatitis/, priority: 3 },
  { key: "liver_alcohol", label: "Alcohol-related liver disease", category: "liver", kind: "condition", match: /(?<!non[- ]?)alcohol/, priority: 4 },
  { key: "hiv", label: "HIV", category: "hiv", kind: "condition", isDefault: true },
  { key: "sleep_apnea", label: "Sleep apnea", category: "sleep_apnea", kind: "condition", isDefault: true },
  { key: "epilepsy", label: "Epilepsy", category: "epilepsy", kind: "condition", isDefault: true },
  { key: "ms", label: "Multiple sclerosis", category: "ms", kind: "condition", isDefault: true },
  { key: "chronic_pain", label: "Chronic pain", category: "chronic_pain", kind: "condition", isDefault: true },
  // Behavioral health
  { key: "depression", label: "Depression", category: "depression", kind: "condition", isDefault: true },
  { key: "anxiety", label: "Anxiety", category: "anxiety", kind: "condition", isDefault: true },
  { key: "anxiety_panic", label: "Panic disorder", category: "anxiety", kind: "condition", match: /panic/, priority: 2 },
  { key: "ptsd", label: "PTSD", category: "ptsd", kind: "condition", isDefault: true },
  { key: "bipolar", label: "Bipolar disorder", category: "bipolar", kind: "condition", isDefault: true },
  { key: "psychotic", label: "Schizophrenia or another psychotic disorder", category: "bipolar", kind: "condition", match: /schizo|psychotic|psychosis/, priority: 2 },
  { key: "substance", label: "Substance use disorder", category: "substance", kind: "condition", isDefault: true },
  { key: "substance_alcohol", label: "Alcohol use disorder", category: "substance", kind: "condition", match: /alcohol/, priority: 2 },
  { key: "substance_opioid", label: "Opioid use disorder", category: "substance", kind: "condition", match: /opioid|opiate|heroin|fentanyl/, priority: 3 },
  { key: "adhd", label: "ADHD", category: "adhd", kind: "condition", isDefault: true },
  { key: "ocd", label: "OCD", category: "ocd", kind: "condition", isDefault: true },

  // Add-ons: complications and overlaps
  { key: "dm_kidney", label: "Diabetes with kidney disease", category: "diabetes", kind: "addon",
    when: ({ cats, names }) => cats.has("diabetes") && (cats.has("ckd") || any(names, /(diabet).*(kidney|nephropath|renal)|(kidney|nephropath).*(diabet)/)) },
  { key: "dm_neuropathy", label: "Diabetes nerve damage and foot care", category: "diabetes", kind: "addon",
    when: ({ cats, names }) => cats.has("diabetes") && any(names, /neuropath/) },
  { key: "dm_eye", label: "Diabetic eye disease", category: "diabetes", kind: "addon",
    when: ({ cats, names }) => cats.has("diabetes") && any(names, /retinopath|macular edema|(diabet).*\beye\b/) },
  { key: "dm_circulation", label: "Diabetes with poor circulation", category: "diabetes", kind: "addon",
    when: ({ cats, names }) => cats.has("diabetes") && (cats.has("pvd") || any(names, /peripheral circulatory|angiopath|(diabet).*(peripheral (arter|vascular))/)) },
  { key: "dm_above_goal", label: "Diabetes above goal", category: "diabetes", kind: "addon",
    when: ({ cats, names }) => cats.has("diabetes") && any(names, /hyperglycemia|uncontrolled|poorly controlled|out of control|with hyperosmolar/) },
  { key: "dm_heart", label: "Diabetes with heart or blood-vessel disease", category: "diabetes", kind: "addon",
    when: ({ cats }) => cats.has("diabetes") && has(cats, "cad", "heart_failure", "stroke") },
  { key: "cardiometabolic", label: "Heart-health risk reduction", category: "hypertension", kind: "addon",
    when: ({ cats }) => ["hypertension", "lipids", "diabetes", "obesity"].filter((c) => cats.has(c)).length >= 2 },
  { key: "htn_ckd", label: "High blood pressure with kidney disease", category: "hypertension", kind: "addon",
    when: ({ cats, names }) => !cats.has("diabetes") && ((cats.has("ckd") && cats.has("hypertension")) || any(names, /hypertensive.*(kidney|renal)/)) },
  { key: "hf_ckd", label: "Heart failure with kidney disease", category: "heart_failure", kind: "addon",
    when: ({ cats }) => cats.has("heart_failure") && cats.has("ckd") },
  { key: "liver_cirrhosis", label: "Cirrhosis", category: "liver", kind: "addon",
    when: ({ names }) => any(names, /cirrhosis/) },
  { key: "obesity_osa", label: "Weight and sleep apnea", category: "obesity", kind: "addon",
    when: ({ cats }) => cats.has("obesity") && cats.has("sleep_apnea") },
  { key: "dep_anx", label: "Depression and anxiety together", category: "depression", kind: "addon",
    when: ({ cats, names }) => (cats.has("depression") && cats.has("anxiety")) || any(names, /mixed anxiety and depress/) },
  { key: "pain_mood", label: "Chronic pain with depression or anxiety", category: "chronic_pain", kind: "addon",
    when: ({ cats }) => cats.has("chronic_pain") && has(cats, "depression", "anxiety", "ptsd") },
  { key: "smi_metabolic", label: "Mental-health medicines and metabolic health", category: "bipolar", kind: "addon",
    when: ({ cats }) => cats.has("bipolar") && has(cats, "diabetes", "obesity", "lipids") },
];

export const ITEM_BY_KEY: ReadonlyMap<string, LibraryItem> = new Map(LIBRARY_ITEMS.map((i) => [i.key, i]));
export const LIBRARY_KEYS = LIBRARY_ITEMS.map((i) => i.key);
export const itemLabel = (key: string) => ITEM_BY_KEY.get(key)?.label ?? categoryLabel(key);

/** One item the patient gets: a condition plan (exact diagnosis or the group default) or an add-on. */
export interface ResolvedItem {
  key: string;
  label: string;
  category: string;
  kind: ItemKind;
  /** The diagnosis name(s) on the patient's record it came from ("" for add-ons from a combination). */
  diagnosis: string;
  /** The exact type wasn't on the record: the most common type was assumed. */
  assumed: boolean;
  /** A general plan because the type isn't documented (heart failure EF, CKD stage, liver cause). */
  confirmType: boolean;
}

/**
 * A patient's diagnosis names (roster lists and/or Practice Fusion problems) → the specialized items:
 * one condition item per recognized group, then the add-ons that apply. Pure.
 */
export function resolveItems(names: (string | null | undefined)[]): ResolvedItem[] {
  const byCat = new Map<string, string[]>();
  const cleanNames: string[] = [];
  for (const raw of names) {
    if (!raw?.trim()) continue;
    const m = classifyConditionName(raw.trim());
    if (!m) continue;
    const lower = m.title.toLowerCase();
    cleanNames.push(lower);
    const display = m.icd ? `${m.title} (${m.icd})` : m.title;
    const l = byCat.get(m.category);
    if (l) { if (!l.includes(display)) l.push(display); } else byCat.set(m.category, [display]);
  }
  const out: ResolvedItem[] = [];
  const itemKeys = new Set<string>();
  for (const [cat, diagnoses] of Array.from(byCat.entries())) {
    const candidates = LIBRARY_ITEMS.filter((i) => i.kind === "condition" && i.category === cat);
    if (!candidates.length) continue;
    const lowers = diagnoses.map((d) => d.toLowerCase());
    let best: LibraryItem | null = null;
    for (const i of candidates) if (i.match && lowers.some((n) => i.match!.test(n)) && (!best || (i.priority ?? 0) > (best.priority ?? 0))) best = i;
    const def = candidates.find((i) => i.isDefault) ?? candidates[0]!;
    const item = best ?? def;
    // Assumed: the default exact type was picked without the name saying so (e.g. plain "Diabetes" → Type 2).
    const assumed = !best && !def.general && !!def.match;
    out.push({ key: item.key, label: item.label, category: cat, kind: "condition", diagnosis: diagnoses.join(" / "), assumed, confirmType: !best && !!def.general });
    itemKeys.add(item.key);
  }
  const cats = new Set(byCat.keys());
  for (const a of LIBRARY_ITEMS) {
    if (a.kind !== "addon" || !a.when?.({ cats, items: itemKeys, names: cleanNames })) continue;
    out.push({ key: a.key, label: a.label, category: a.category, kind: "addon", diagnosis: "", assumed: false, confirmType: false });
  }
  return out;
}

// Which care programs a patient's diagnoses qualify them for (suggestions for an approver, never
// automatic). Diagnoses come from the Practice Fusion problem list (ICD-10 when Practice Fusion sends
// it, else the diagnosis name) and the conditions already on a CCM-roster record. Nothing here
// diagnoses anyone: it only reads diagnoses the practice has already recorded.
//
// The practice's rules:
//   CCM  2 or more different chronic conditions
//   BHI  a behavioral-health diagnosis (insomnia alone doesn't count)
//   RPM  high blood pressure, diabetes or heart failure
//   APCM exactly 1 chronic condition (level 1, G0556); 2+ are covered by APCM's CCM mirror

export const SUGGEST_PROGRAMS = ["ccm", "bhi", "rpm", "apcm"] as const;
export type SuggestProgram = (typeof SUGGEST_PROGRAMS)[number];
export const SUGGEST_PROGRAM_LABELS: Record<SuggestProgram, string> = { ccm: "CCM", bhi: "BHI", rpm: "RPM", apcm: "APCM" };

/**
 * Program approvals and the Testing tab only consider patients seen on or after a start date (the
 * practice chose 2026-10-01: "start 2 weeks ago and go on from there"). Admins can move it; this is
 * the date until they do.
 */
export const DEFAULT_SEEN_SINCE = "2026-09-17";

interface Category {
  key: string;
  label: string;
  /** ICD-10-CM, dots removed. */
  icd: RegExp;
  text: RegExp;
  /** Names that look like a match but aren't (prediabetes, gestational, screening…). */
  notText?: RegExp;
  chronic: boolean;
  behavioral?: boolean;
  rpm?: boolean;
}

const CATEGORIES: Category[] = [
  { key: "diabetes", label: "Diabetes", icd: /^E(0[89]|1[0-3])/, text: /diabet/, notText: /pre-?diabet|gestational|insipidus|without diabet/, chronic: true, rpm: true },
  { key: "hypertension", label: "High blood pressure", icd: /^I1[0-6]/, text: /hypertens|\bhtn\b/, notText: /pulmonary|ocular|intracranial|gestational|pregnan|white coat|without hypertens|elevated blood pressure/, chronic: true, rpm: true },
  { key: "heart_failure", label: "Heart failure", icd: /^I50/, text: /heart failure|\bchf\b/, chronic: true, rpm: true },
  { key: "cad", label: "Coronary artery disease", icd: /^I2[0-5]/, text: /coronary|ischemic heart|angina|old myocardial infarction/, chronic: true },
  { key: "afib", label: "Atrial fibrillation", icd: /^I48/, text: /atrial fibrillation|atrial flutter/, chronic: true },
  { key: "lipids", label: "High cholesterol", icd: /^E78/, text: /hyperlipid|dyslipid|hypercholesterol|hypertriglycerid/, chronic: true },
  { key: "copd", label: "COPD", icd: /^J4[1-4]/, text: /\bcopd\b|chronic obstructive|emphysema|chronic bronchitis/, chronic: true },
  { key: "asthma", label: "Asthma", icd: /^J45/, text: /asthma/, chronic: true },
  { key: "ckd", label: "Chronic kidney disease", icd: /^N18/, text: /chronic kidney|\bckd\b|end.stage renal/, chronic: true },
  { key: "thyroid", label: "Thyroid disease", icd: /^E0[0-35]/, text: /hypothyroid|hyperthyroid|hashimoto|graves/, chronic: true },
  { key: "obesity", label: "Obesity", icd: /^E66(?!3)/, text: /obesity/, chronic: true },
  { key: "osteoarthritis", label: "Osteoarthritis", icd: /^M1[5-9]/, text: /osteoarthritis|degenerative joint/, chronic: true },
  { key: "rheumatoid", label: "Rheumatoid arthritis", icd: /^M0[56]/, text: /rheumatoid arthritis/, chronic: true },
  { key: "osteoporosis", label: "Osteoporosis", icd: /^M8[01]/, text: /osteoporosis/, chronic: true },
  { key: "dementia", label: "Dementia", icd: /^(F0[1-3]|G3[01])/, text: /dementia|alzheimer/, chronic: true },
  { key: "parkinsons", label: "Parkinson's disease", icd: /^G20/, text: /parkinson/, chronic: true },
  { key: "stroke", label: "Stroke (lasting effects)", icd: /^I69/, text: /sequela.*(stroke|cerebral infarction)|late effect.*stroke/, chronic: true },
  { key: "pvd", label: "Peripheral artery disease", icd: /^I7(0[2-9]|39)/, text: /peripheral (arterial|vascular|artery) disease/, chronic: true },
  { key: "cancer", label: "Cancer", icd: /^C(?!44)/, text: /cancer|carcinoma|malignan|lymphoma|leukemia|myeloma|melanoma/, notText: /basal cell|squamous cell carcinoma of skin|in situ/, chronic: true },
  { key: "liver", label: "Chronic liver disease", icd: /^(K7[0-46]|B18)/, text: /cirrhosis|chronic hepatitis|fatty liver|\bnafld\b|\bnash\b/, chronic: true },
  { key: "hiv", label: "HIV", icd: /^(B20|Z21)/, text: /\bhiv\b|human immunodeficiency/, chronic: true },
  { key: "sleep_apnea", label: "Sleep apnea", icd: /^G4733/, text: /sleep apnea/, chronic: true },
  { key: "epilepsy", label: "Epilepsy", icd: /^G40/, text: /epilep|seizure disorder/, chronic: true },
  { key: "ms", label: "Multiple sclerosis", icd: /^G35/, text: /multiple sclerosis/, chronic: true },
  { key: "chronic_pain", label: "Chronic pain", icd: /^G89[24]/, text: /chronic pain/, chronic: true },
  // Behavioral health (BHI). Depression, anxiety, PTSD, bipolar/psychotic and substance use are chronic too.
  { key: "depression", label: "Depression", icd: /^F3[23]/, text: /depress/, notText: /screening|without depress|negative/, chronic: true, behavioral: true },
  { key: "anxiety", label: "Anxiety", icd: /^F4[01]/, text: /anxiety|panic disorder|phobi/, chronic: true, behavioral: true },
  { key: "ptsd", label: "PTSD", icd: /^F431/, text: /\bptsd\b|post.?traumatic stress/, chronic: true, behavioral: true },
  { key: "bipolar", label: "Bipolar / psychotic disorder", icd: /^F(2\d|3[01])/, text: /bipolar|schizo|psychotic disorder/, chronic: true, behavioral: true },
  { key: "substance", label: "Substance use disorder", icd: /^F1[0-689]/, text: /(alcohol|opioid|cannabis|cocaine|stimulant|substance|drug) (use|abuse|dependence)|alcoholism/, chronic: true, behavioral: true },
  { key: "adjustment", label: "Adjustment disorder", icd: /^F432/, text: /adjustment disorder/, chronic: false, behavioral: true },
  { key: "ocd", label: "OCD", icd: /^F42/, text: /obsessive.compulsive/, chronic: false, behavioral: true },
  { key: "adhd", label: "ADHD", icd: /^F90/, text: /\badhd\b|attention.deficit/, chronic: false, behavioral: true },
  { key: "eating", label: "Eating disorder", icd: /^F50/, text: /anorexia nervosa|bulimia|binge eating/, chronic: false, behavioral: true },
];
const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

/** Problems that are over (or were never right) don't count. */
const NOT_CURRENT = /resolved|inactive|remission|refuted|entered.in.error|history/i;
const HISTORY_OF = /^\s*(history of|hx of|h\/o|family history|personal history|screening|rule out|r\/o)\b/i;

export interface DiagnosisFact {
  title: string | null;
  /** As stored from Practice Fusion ("icd-10-cm|E11.9", "sct|44054006") or a bare ICD-10 code. */
  code?: string | null;
  status?: string | null;
}
export interface MatchedDiagnosis {
  category: string;
  label: string;
  title: string;
  icd: string | null;
}

/** The ICD-10 code in a stored code, if it is one ("icd-10-cm|E11.9" → "E119"). */
export function icd10Of(code: string | null | undefined): string | null {
  if (!code) return null;
  const [system, value] = code.includes("|") ? code.split("|") : ["icd-10", code];
  if (!/icd-?10/i.test(system ?? "") && !/^[A-TV-Z]\d{2}/i.test(code)) return null;
  const v = (value ?? "").toUpperCase().replace(/\./g, "");
  return /^[A-TV-Z]\d{2}/.test(v) ? v : null;
}

/** One problem-list entry → its category (or null). ICD-10 decides when there is one; otherwise the name. */
export function classifyDiagnosis(f: DiagnosisFact): MatchedDiagnosis | null {
  const title = (f.title ?? "").trim();
  if (f.status && NOT_CURRENT.test(f.status)) return null;
  if (HISTORY_OF.test(title)) return null;
  const icd = icd10Of(f.code);
  const name = title.toLowerCase();
  let cat: Category | undefined;
  if (icd) cat = CATEGORIES.find((c) => c.icd.test(icd));
  else if (name) cat = CATEGORIES.find((c) => c.text.test(name) && !c.notText?.test(name));
  if (!cat) return null;
  return { category: cat.key, label: cat.label, title: title || cat.label, icd: icd ? `${icd.slice(0, 3)}${icd.length > 3 ? `.${icd.slice(3)}` : ""}` : null };
}

/** Where the patient stands in each program today (roster patients; everyone else is in none). */
export interface ProgramStanding {
  ccm: string | null;
  ccmConsent: string | null;
  bhi: string | null;
  bhiConsent: string | null;
  apcm: string | null;
  apcmConsent: string | null;
  rpm: string | null;
  rpmEnrolled: boolean;
  rpmConsent: string | null;
}
export const NOT_ON_ROSTER: ProgramStanding = { ccm: null, ccmConsent: null, bhi: null, bhiConsent: null, apcm: null, apcmConsent: null, rpm: null, rpmEnrolled: false, rpmConsent: null };

export interface ProgramSuggestion {
  program: SuggestProgram;
  reason: string;
  diagnoses: MatchedDiagnosis[];
}

/** One per category (the first one seen), in a stable order. */
export function distinctDiagnoses(matches: MatchedDiagnosis[]): MatchedDiagnosis[] {
  const seen = new Map<string, MatchedDiagnosis>();
  for (const m of matches) if (!seen.has(m.category)) seen.set(m.category, m);
  return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Programs this patient qualifies for and isn't in yet. Programs they declined (or said No to) are
 * never suggested again; someone already enrolled isn't suggested.
 */
export function suggestPrograms(matches: MatchedDiagnosis[], s: ProgramStanding): ProgramSuggestion[] {
  const dx = distinctDiagnoses(matches);
  const chronic = dx.filter((d) => BY_KEY.get(d.category)?.chronic);
  const behavioral = dx.filter((d) => BY_KEY.get(d.category)?.behavioral);
  const forRpm = dx.filter((d) => BY_KEY.get(d.category)?.rpm);
  const names = (list: MatchedDiagnosis[]) => list.map((d) => d.label).join(", ");
  const out: ProgramSuggestion[] = [];
  const ccmActive = s.ccm === "active";
  if (chronic.length >= 2 && !ccmActive && s.ccm !== "declined" && s.ccm !== "transferred" && s.ccmConsent !== "declined") {
    out.push({ program: "ccm", reason: `${chronic.length} chronic conditions: ${names(chronic)}`, diagnoses: chronic });
  }
  if (behavioral.length && s.bhi !== "active" && s.bhi !== "declined" && s.bhi !== "transferred" && s.bhiConsent !== "declined") {
    out.push({ program: "bhi", reason: `Behavioral-health diagnosis: ${names(behavioral)}`, diagnoses: behavioral });
  }
  const rpmOn = s.rpmEnrolled || s.rpm === "enrolled" || s.rpm === "active";
  if (forRpm.length && !rpmOn && s.rpm !== "declined" && s.rpmConsent !== "declined") {
    out.push({ program: "rpm", reason: `Suited to home monitoring: ${names(forRpm)}`, diagnoses: forRpm });
  }
  if (chronic.length === 1 && !ccmActive && s.apcm !== "active" && s.apcm !== "declined" && s.apcm !== "transferred" && s.apcmConsent !== "declined") {
    out.push({ program: "apcm", reason: `1 chronic condition (APCM level 1, G0556): ${names(chronic)}`, diagnoses: chronic });
  }
  return out;
}

/** A short fingerprint of the qualifying diagnoses: a "not now" stands until these change. */
export const diagnosesFingerprint = (dx: MatchedDiagnosis[]) => dx.map((d) => d.category).sort().join(",");

/** How many different recognized chronic conditions are in a list of condition names (APCM-only leveling). */
export function countChronicConditions(titles: string[]): number {
  const keys = new Set<string>();
  for (const t of titles) {
    const m = classifyDiagnosis({ title: t });
    if (m && BY_KEY.get(m.category)?.chronic) keys.add(m.category);
  }
  return keys.size;
}

// In-office testing (Testing tab): who qualifies for ABI-Q, PFT and RMR under the practice's criteria,
// and where each patient stands. Reads diagnoses, vitals and smoking status already in the chart (the
// Practice Fusion copy and the roster record). Nothing here diagnoses anyone: the provider orders each test.
//
// The practice's criteria:
//   Hyperlipidemia                       → ABI-Q, PFT, RMR
//   Type 2 diabetes                      → ABI-Q, PFT, RMR
//   Visceral fat / obesity               → RMR
//   Smoker                               → PFT
//   Age 55+                              → PFT
//   Asthma or any respiratory condition  → PFT
// Each test can be repeated once a year.

export const OFFICE_TESTS = ["abi_q", "pft", "rmr"] as const;
export type OfficeTest = (typeof OFFICE_TESTS)[number];
export const OFFICE_TEST_LABELS: Record<OfficeTest, string> = { abi_q: "ABI-Q", pft: "PFT", rmr: "RMR" };
export const OFFICE_TEST_NAMES: Record<OfficeTest, string> = {
  abi_q: "ABI-Q (ankle-brachial index)",
  pft: "PFT (pulmonary function test)",
  rmr: "RMR (resting metabolic rate)",
};
/** Months before the same test can be done again. */
export const OFFICE_TEST_REPEAT_MONTHS = 12;
/** Patients seen within this many days (or with an appointment booked) are listed. */
export const OFFICE_TEST_SEEN_DAYS = 365;

export const QUALIFIERS = ["hyperlipidemia", "t2dm", "obesity", "smoker", "age55", "respiratory"] as const;
export type Qualifier = (typeof QUALIFIERS)[number];
export const QUALIFIER_LABELS: Record<Qualifier, string> = {
  hyperlipidemia: "Hyperlipidemia",
  t2dm: "Type 2 diabetes",
  obesity: "Obesity",
  smoker: "Smoker",
  age55: "Age 55+",
  respiratory: "Respiratory condition",
};
export const TEST_QUALIFIERS: Record<OfficeTest, Qualifier[]> = {
  abi_q: ["hyperlipidemia", "t2dm"],
  pft: ["hyperlipidemia", "t2dm", "smoker", "age55", "respiratory"],
  rmr: ["hyperlipidemia", "t2dm", "obesity"],
};

/** Problems that are over don't count; nor do "history of" / screening entries. */
const NOT_CURRENT = /resolved|inactive|remission|refuted|entered.in.error/i;
const HISTORY_OF = /^\s*(history of|hx of|h\/o|family history|personal history|screening|rule out|r\/o)\b/i;

/** "icd-10-cm|E11.9" or "E11.9" → "E119" (null when it isn't an ICD-10 code). */
export function icdOf(code: string | null | undefined): string | null {
  if (!code) return null;
  const [system, value] = code.includes("|") ? code.split("|") : ["icd-10", code];
  if (!/icd-?10/i.test(system ?? "") && !/^[A-TV-Z]\d{2}/i.test(code)) return null;
  const v = (value ?? "").toUpperCase().replace(/\./g, "");
  return /^[A-TV-Z]\d{2}/.test(v) ? v : null;
}

interface Rule { q: Qualifier; icd: RegExp; text: RegExp; notText?: RegExp }
const RULES: Rule[] = [
  { q: "hyperlipidemia", icd: /^E78/, text: /hyperlipid|dyslipid|hypercholesterol|hypertriglycerid|high cholesterol/ },
  // Type 2 (E11). By name, "diabetes" counts unless it's type 1, gestational, pre-diabetes or insipidus.
  { q: "t2dm", icd: /^E11/, text: /diabet|\bt2dm\b|\bdm ?(2|ii)\b/, notText: /type ?(1|i)\b|juvenile|gestational|pre-?diabet|insipidus|without diabet/ },
  { q: "obesity", icd: /^(E66(?!3)|Z68(3|4))/, text: /obes|visceral (fat|adipos)|bmi (3\d|4\d|[5-9]\d)/, notText: /overweight/ },
  { q: "smoker", icd: /^(F17|Z720)/, text: /nicotine dependence|tobacco (use|dependence|abuse)|cigarette smoker|current (every day |some day )?smoker|\bsmoker\b|vap(e|ing)/, notText: /former|ex-?smoker|never|non-?smoker|quit|passive|second.?hand|exposure/ },
  // Any respiratory diagnosis (the practice's choice): the whole respiratory chapter, sleep apnea, cough and breathing problems.
  { q: "respiratory", icd: /^(J|G473|R05|R06)/, text: /asthma|copd|chronic obstructive|emphysema|bronch|pneumon|respiratory|lung disease|pulmonary (fibrosis|disease|nodule)|sinusit|pharyngit|laryngit|tonsillit|rhinit|influenza|\buri\b|cough|dyspnea|shortness of breath|wheez|sleep apnea/, notText: /pulmonary embol|cancer|carcinoma|malignan/ },
];

export interface DiagnosisFact { title: string | null; code?: string | null; status?: string | null }
export interface Reason { q: Qualifier; why: string }

/** One problem-list entry → the qualifier it meets (ICD-10 decides when there is one; else the name). */
export function qualifierOf(f: DiagnosisFact): Reason | null {
  const title = (f.title ?? "").trim();
  if (f.status && NOT_CURRENT.test(f.status)) return null;
  if (HISTORY_OF.test(title)) return null;
  const icd = icdOf(f.code);
  const name = title.toLowerCase();
  const rule = icd ? RULES.find((r) => r.icd.test(icd)) : name ? RULES.find((r) => r.text.test(name) && !r.notText?.test(name)) : undefined;
  if (!rule) return null;
  return { q: rule.q, why: `${title || QUALIFIER_LABELS[rule.q]}${icd ? ` (${icd.slice(0, 3)}${icd.length > 3 ? `.${icd.slice(3)}` : ""})` : ""}` };
}

/** Smoking status from the chart ("Current every day smoker" yes; "Former smoker" / "Never smoker" no). */
export function isCurrentSmoker(value: string | null | undefined): boolean {
  const v = (value ?? "").toLowerCase();
  if (!v || /former|ex-?smoker|never|non-?smoker|quit|unknown if ever/.test(v)) return false;
  return /current|every day|some ?day|daily|heavy|light|smoker|smokes|yes/.test(v);
}

/** "32.4 kg/m2" → 32.4. */
export function bmiOf(value: string | null | undefined): number | null {
  const m = (value ?? "").match(/(\d{2}(?:\.\d+)?)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 10 && n <= 100 ? n : null;
}

export interface TestFacts {
  age: number | null;
  diagnoses: DiagnosisFact[];
  /** Latest smoking status in the chart (value text) and when. */
  smoking?: { value: string | null; date: string | null } | null;
  /** Latest BMI in the chart. */
  bmi?: { value: string | null; date: string | null } | null;
}

/** Why the patient meets each qualifier (first reason per qualifier). */
export function qualifiersOf(f: TestFacts): Map<Qualifier, string> {
  const out = new Map<Qualifier, string>();
  const add = (q: Qualifier, why: string) => { if (!out.has(q)) out.set(q, why); };
  for (const d of f.diagnoses) { const r = qualifierOf(d); if (r) add(r.q, r.why); }
  if (f.age != null && f.age >= 55) add("age55", `Age ${f.age}`);
  if (f.smoking && isCurrentSmoker(f.smoking.value)) add("smoker", `Smoking status: ${f.smoking.value}${f.smoking.date ? ` (${f.smoking.date})` : ""}`);
  const bmi = bmiOf(f.bmi?.value);
  if (bmi != null && bmi >= 30) add("obesity", `BMI ${bmi}${f.bmi?.date ? ` (${f.bmi.date})` : ""}`);
  return out;
}

/** The tests this patient qualifies for, with the reasons (in the criteria's order). */
export function eligibleTests(f: TestFacts): { test: OfficeTest; reasons: { q: Qualifier; why: string }[] }[] {
  const qs = qualifiersOf(f);
  return OFFICE_TESTS.map((test) => ({ test, reasons: TEST_QUALIFIERS[test].filter((q) => qs.has(q)).map((q) => ({ q, why: qs.get(q)! })) }))
    .filter((t) => t.reasons.length > 0);
}

// ---- Where a patient stands on one test ----

export type OfficeTestRecordStatus = "scheduled" | "done" | "declined" | "not_applicable";
export interface OfficeTestRecord { id?: number; status: OfficeTestRecordStatus; date: string; note?: string | null }
export type OfficeTestState = "eligible" | "scheduled" | "done" | "declined" | "not_needed";
export const OFFICE_TEST_STATE_LABELS: Record<OfficeTestState, string> = {
  eligible: "Eligible", scheduled: "Scheduled", done: "Done this year", declined: "Declined", not_needed: "Not needed",
};

const addMonths = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Done in the last 12 months = done (eligible again a year later). A declined or "not needed" answer
 * stands for 12 months too. A scheduled date (after the last test) = scheduled. Otherwise eligible.
 */
export function officeTestState(records: OfficeTestRecord[], today: string): { state: OfficeTestState; lastDone: string | null; scheduledFor: string | null; eligibleAgainOn: string | null; record: OfficeTestRecord | null } {
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0));
  const done = sorted.find((r) => r.status === "done");
  const yearAgo = addMonths(today, -OFFICE_TEST_REPEAT_MONTHS);
  const lastDone = done?.date ?? null;
  const eligibleAgainOn = lastDone ? addMonths(lastDone, OFFICE_TEST_REPEAT_MONTHS) : null;
  const after = (r: OfficeTestRecord) => !done || r.date > done.date || (r.date === done.date && (r.id ?? 0) > (done.id ?? 0));
  const scheduled = sorted.find((r) => r.status === "scheduled" && after(r));
  if (scheduled) return { state: "scheduled", lastDone, scheduledFor: scheduled.date, eligibleAgainOn, record: scheduled };
  if (done && done.date > yearAgo) return { state: "done", lastDone, scheduledFor: null, eligibleAgainOn, record: done };
  const answer = sorted.find((r) => (r.status === "declined" || r.status === "not_applicable") && r.date > yearAgo && after(r));
  if (answer) return { state: answer.status === "declined" ? "declined" : "not_needed", lastDone, scheduledFor: null, eligibleAgainOn: addMonths(answer.date, OFFICE_TEST_REPEAT_MONTHS), record: answer };
  return { state: "eligible", lastDone, scheduledFor: null, eligibleAgainOn: null, record: null };
}

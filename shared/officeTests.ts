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
export type OfficeTestState = "eligible" | "scheduled" | "missed" | "done" | "declined" | "not_needed";
export const OFFICE_TEST_STATES: OfficeTestState[] = ["eligible", "scheduled", "missed", "done", "declined", "not_needed"];
export const OFFICE_TEST_STATE_LABELS: Record<OfficeTestState, string> = {
  eligible: "Eligible", scheduled: "Scheduled", missed: "Missed", done: "Done this year", declined: "Declined", not_needed: "Not needed",
};

const addMonths = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Done in the last 12 months = done (eligible again a year later). A declined or "not needed" answer
 * stands for 12 months too. The newest mark after the last test decides: scheduled for today or later =
 * scheduled; scheduled for a day that has passed with nothing marked done = missed (rebook it).
 * Otherwise eligible.
 */
export function officeTestState(records: OfficeTestRecord[], today: string): { state: OfficeTestState; lastDone: string | null; scheduledFor: string | null; eligibleAgainOn: string | null; record: OfficeTestRecord | null } {
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0));
  const done = sorted.find((r) => r.status === "done");
  const yearAgo = addMonths(today, -OFFICE_TEST_REPEAT_MONTHS);
  const lastDone = done?.date ?? null;
  const eligibleAgainOn = lastDone ? addMonths(lastDone, OFFICE_TEST_REPEAT_MONTHS) : null;
  const after = (r: OfficeTestRecord) => !done || r.date > done.date || (r.date === done.date && (r.id ?? 0) > (done.id ?? 0));
  // Marks made after the last test, newest first (by when they were made; by date when that isn't known).
  const marks = sorted.filter((r) => r.status !== "done" && after(r)).sort((a, b) => (b.id ?? 0) - (a.id ?? 0) || b.date.localeCompare(a.date));
  const latest = marks[0];
  if (latest?.status === "scheduled") return { state: latest.date < today ? "missed" : "scheduled", lastDone, scheduledFor: latest.date, eligibleAgainOn, record: latest };
  if (done && done.date > yearAgo) return { state: "done", lastDone, scheduledFor: null, eligibleAgainOn, record: done };
  const answer = latest && (latest.status === "declined" || latest.status === "not_applicable") && latest.date > yearAgo ? latest : null;
  if (answer) return { state: answer.status === "declined" ? "declined" : "not_needed", lastDone, scheduledFor: null, eligibleAgainOn: addMonths(answer.date, OFFICE_TEST_REPEAT_MONTHS), record: answer };
  return { state: "eligible", lastDone, scheduledFor: null, eligibleAgainOn: null, record: null };
}

/** Still to do: worth flagging while the patient is in the office. */
export const isOpenState = (s: OfficeTestState) => s === "eligible" || s === "scheduled" || s === "missed";

// ---- Results (what the machine reports), entered when a test is marked done ----

export interface ResultField {
  key: string;
  label: string;
  unit?: string;
  kind: "number" | "choice";
  min?: number;
  max?: number;
  step?: number;
  choices?: string[];
}
export const OFFICE_TEST_RESULT_FIELDS: Record<OfficeTest, ResultField[]> = {
  abi_q: [
    { key: "right", label: "Right ABI", kind: "number", min: 0, max: 3, step: 0.01 },
    { key: "left", label: "Left ABI", kind: "number", min: 0, max: 3, step: 0.01 },
  ],
  pft: [
    { key: "fev1", label: "FEV1", unit: "L", kind: "number", min: 0, max: 10, step: 0.01 },
    { key: "fvc", label: "FVC", unit: "L", kind: "number", min: 0, max: 10, step: 0.01 },
    { key: "ratio", label: "FEV1/FVC", unit: "%", kind: "number", min: 0, max: 100, step: 1 },
    { key: "reading", label: "Reading", kind: "choice", choices: ["Normal", "Abnormal"] },
  ],
  rmr: [
    { key: "kcal", label: "RMR", unit: "kcal/day", kind: "number", min: 200, max: 8000, step: 1 },
  ],
};
export type OfficeTestResults = Record<string, number | string>;

/** Keep only the fields this test has, numbers in range and known choices (null when nothing is left). */
export function cleanResults(test: OfficeTest, input: Record<string, unknown> | null | undefined): OfficeTestResults | null {
  if (!input) return null;
  const out: OfficeTestResults = {};
  for (const f of OFFICE_TEST_RESULT_FIELDS[test]) {
    const v = input[f.key];
    if (v == null || v === "") continue;
    if (f.kind === "number") {
      const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
      if (!Number.isFinite(n) || (f.min != null && n < f.min) || (f.max != null && n > f.max)) throw new Error(`${f.label} should be between ${f.min} and ${f.max}${f.unit ? ` ${f.unit}` : ""}.`);
      out[f.key] = Math.round(n * 1000) / 1000;
    } else {
      const c = f.choices?.find((x) => x.toLowerCase() === String(v).trim().toLowerCase());
      if (!c) throw new Error(`Pick ${f.choices?.join(" or ")} for ${f.label}.`);
      out[f.key] = c;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** "Right ABI 1.02 · Left ABI 0.98": the results on one line (null when there are none). */
export function resultSummary(test: OfficeTest, results: OfficeTestResults | null | undefined): string | null {
  if (!results) return null;
  const parts = OFFICE_TEST_RESULT_FIELDS[test].filter((f) => results[f.key] != null && results[f.key] !== "").map((f) => {
    const v = results[f.key]!;
    const shown = typeof v === "number" && f.key === "kcal" ? Math.round(v).toLocaleString("en-US") : String(v);
    return f.kind === "choice" ? shown : `${f.label} ${shown}${f.unit ? (f.unit === "%" ? "%" : ` ${f.unit}`) : ""}`;
  });
  return parts.length ? parts.join(" · ") : null;
}

// ---- Tests already in the Practice Fusion chart ----

const OFFICE_TEST_NAMES_RE: [RegExp, OfficeTest][] = [
  [/ankle.?brachial|\babi\b|abi-?q\b|toe.?brachial/i, "abi_q"],
  [/spirometr|pulmonary function|\bpfts?\b|\bfev ?1\b|forced vital capacity|\bfvc\b|flow.?volume loop|bronchodilator responsiveness|lung function test/i, "pft"],
  [/resting metabolic|indirect calorimetr|\brmr\b|resting energy expenditure|metabolic rate (test|measure)/i, "rmr"],
];
/** CPT codes: ABI 93922-93924; spirometry / PFT 94010, 94060, 94375, 94726-94729; RMR (indirect calorimetry) 94690. */
const OFFICE_TEST_CODES_RE: [RegExp, OfficeTest][] = [
  [/^cpt\|9392[234]$/i, "abi_q"],
  [/^cpt\|(94010|94060|94375|9472[6-9])$/i, "pft"],
  [/^cpt\|94690$/i, "rmr"],
];
/** Orders, plans and screening questions are not a test that was done. */
const NOT_A_TEST = /\b(order(ed)?|referral|refer(red)?|recommend(ed)?|plan(ned)?|schedul(e|ed)|due|declined|education|counsel(ing)?)\b/i;

/** A Practice Fusion chart line → the in-office test it shows was done (or null). */
export function recognizeOfficeTest(line: { title: string | null; code?: string | null; status?: string | null }): OfficeTest | null {
  if (line.status && /not-?done|cancel|entered.in.error|revoked|stopped|preliminary|registered/i.test(line.status)) return null;
  const byCode = line.code ? OFFICE_TEST_CODES_RE.find(([re]) => re.test(line.code!))?.[1] : undefined;
  if (byCode) return byCode;
  const title = (line.title ?? "").trim();
  if (!title || NOT_A_TEST.test(title)) return null;
  return OFFICE_TEST_NAMES_RE.find(([re]) => re.test(title))?.[1] ?? null;
}

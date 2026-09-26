// Testing & screenings — which tests a patient is due for under published guidelines, and what
// they've had. Pure logic shared by server and client (unit-tested in server/workspace.test.ts).
//
// These are reminders for the care team, not clinical decisions: the provider decides what to
// order. Every rule shows its guideline so staff can see why a test is listed.

export type TestGroup = "chronic" | "cancer" | "preventive";
export const TEST_GROUP_LABELS: Record<TestGroup, string> = { chronic: "Chronic care labs", cancer: "Cancer screenings", preventive: "Other preventive" };

export type Sex = "F" | "M" | "X";

export interface TestPerson {
  age: number | null;
  sex: Sex | null;
  conditions: string[];
  medicare: boolean;
}

interface TestDef {
  label: string;
  group: TestGroup;
  /** Who it's for, in plain words. */
  who: string;
  guideline: string;
  /** Months between tests; null = once in a lifetime. Methods can override (colorectal, cervical). */
  months: number | null;
  methods?: Record<string, { label: string; months: number }>;
  /** Needs the patient's sex to decide. */
  needsSex?: boolean;
  applies: (p: TestPerson) => boolean;
}

const DIABETES = /diabet|\bdm\b|dm2|t2dm|\bt2\b|\ba1c\b/i;
const HYPERTENSION = /hypertens|\bhtn\b|high blood pressure/i;
const has = (p: TestPerson, re: RegExp) => p.conditions.some((c) => re.test(c));
const ageIn = (p: TestPerson, lo: number, hi: number) => p.age != null && p.age >= lo && p.age <= hi;

export const TESTS = {
  a1c: { label: "A1c", group: "chronic", who: "Diabetes", guideline: "ADA Standards of Care: at least twice a year", months: 6, applies: (p) => has(p, DIABETES) },
  uacr: { label: "Urine albumin (uACR)", group: "chronic", who: "Diabetes", guideline: "ADA Standards of Care: at least yearly", months: 12, applies: (p) => has(p, DIABETES) },
  egfr: { label: "Kidney function (eGFR / metabolic panel)", group: "chronic", who: "Diabetes or high blood pressure", guideline: "ADA: at least yearly; common practice for hypertension", months: 12, applies: (p) => has(p, DIABETES) || has(p, HYPERTENSION) },
  lipid: { label: "Cholesterol (lipid panel)", group: "chronic", who: "Diabetes or high blood pressure", guideline: "ADA / ACC-AHA: periodically, commonly yearly", months: 12, applies: (p) => has(p, DIABETES) || has(p, HYPERTENSION) },
  eye: { label: "Diabetic eye exam", group: "chronic", who: "Diabetes", guideline: "ADA: every 1–2 years (tracked yearly)", months: 12, applies: (p) => has(p, DIABETES) },
  foot: { label: "Diabetic foot exam", group: "chronic", who: "Diabetes", guideline: "ADA: comprehensive foot exam yearly", months: 12, applies: (p) => has(p, DIABETES) },
  colorectal: {
    label: "Colorectal cancer screening", group: "cancer", who: "Ages 45–75", guideline: "USPSTF 2021", months: 12,
    methods: {
      colonoscopy: { label: "Colonoscopy", months: 120 },
      ct_colonography: { label: "CT colonography", months: 60 },
      flex_sig: { label: "Flexible sigmoidoscopy", months: 60 },
      stool_dna: { label: "Stool DNA (Cologuard)", months: 36 },
      fit: { label: "FIT / stool blood test", months: 12 },
    },
    applies: (p) => ageIn(p, 45, 75),
  },
  mammogram: { label: "Mammogram", group: "cancer", who: "Women 40–74", guideline: "USPSTF 2024: every 2 years", months: 24, needsSex: true, applies: (p) => p.sex === "F" && ageIn(p, 40, 74) },
  cervical: {
    label: "Cervical cancer screening", group: "cancer", who: "Women 21–65", guideline: "USPSTF 2018", months: 36, needsSex: true,
    methods: { pap: { label: "Pap test", months: 36 }, hpv: { label: "HPV test / co-test", months: 60 } },
    applies: (p) => p.sex === "F" && ageIn(p, 21, 65),
  },
  dexa: { label: "Bone density (DEXA)", group: "preventive", who: "Women 65+", guideline: "USPSTF: women 65+; Medicare covers every 2 years", months: 24, needsSex: true, applies: (p) => p.sex === "F" && p.age != null && p.age >= 65 },
  hcv: { label: "Hepatitis C screening", group: "preventive", who: "Ages 18–79, once", guideline: "USPSTF 2020", months: null, applies: (p) => ageIn(p, 18, 79) },
  hiv: { label: "HIV screening", group: "preventive", who: "Ages 15–65, at least once", guideline: "USPSTF 2019", months: null, applies: (p) => ageIn(p, 15, 65) },
  depression: { label: "Depression screening (PHQ)", group: "preventive", who: "All adults", guideline: "USPSTF 2023; Medicare covers yearly", months: 12, applies: (p) => p.age != null && p.age >= 18 },
  awv: { label: "Annual wellness visit", group: "preventive", who: "Medicare patients", guideline: "Medicare: once a year", months: 12, applies: (p) => p.medicare || (p.age != null && p.age >= 65) },
} satisfies Record<string, TestDef>;

export type TestKey = keyof typeof TESTS;
export const TEST_KEYS = Object.keys(TESTS) as TestKey[];
export const testDef = (k: TestKey): TestDef => TESTS[k];

/** Recognize a test from the name in a Practice Fusion / lab export (method where it matters). */
const ALIASES: [RegExp, TestKey, string?][] = [
  [/colonoscopy/i, "colorectal", "colonoscopy"],
  [/cologuard|stool dna|\bs?dna[- ]?fit\b|mt-?sdna/i, "colorectal", "stool_dna"],
  [/ct colonograph|virtual colonoscopy/i, "colorectal", "ct_colonography"],
  [/sigmoidoscopy/i, "colorectal", "flex_sig"],
  [/\bfit\b|fecal immuno|\bi?fobt\b|occult blood|hemoccult/i, "colorectal", "fit"],
  [/mammo/i, "mammogram"],
  [/\bhpv\b|papilloma/i, "cervical", "hpv"],
  [/\bpap\b|cervical cytology|thinprep|surepath/i, "cervical", "pap"],
  [/dexa|\bdxa\b|bone densit|densitometry/i, "dexa"],
  [/hepatitis c|\bhcv\b/i, "hcv"],
  [/\bhiv\b/i, "hiv"],
  [/phq[- ]?[29]|depression screen/i, "depression"],
  [/annual wellness|\bawv\b|g0438|g0439/i, "awv"],
  [/micro ?albumin|albumin.{0,25}creatinine|\bu?acr\b/i, "uacr"],
  [/\bh(b|g)?a1c\b|hemoglobin a1c|glyco(sylated)? ?hemoglobin|\ba1c\b/i, "a1c"],
  [/retina|diabetic eye|ophthalm|dilated eye|fundus/i, "eye"],
  [/foot exam|monofilament|diabetic foot/i, "foot"],
  [/lipid|cholesterol|\bldl\b|triglycer/i, "lipid"],
  [/\be?gfr\b|metabolic panel|\bcmp\b|\bbmp\b|renal (function )?panel|creatinine/i, "egfr"],
];

export function recognizeTest(name: string): { key: TestKey; method: string | null } | null {
  for (const [re, key, method] of ALIASES) if (re.test(name)) return { key, method: method ?? null };
  return null;
}

export interface TestRecord {
  testKey: TestKey;
  performedOn: string; // YYYY-MM-DD
  status: "done" | "not_applicable" | "declined";
  method?: string | null;
  result?: string | null;
  source?: string | null;
}

export type TestState = "no_record" | "due" | "due_soon" | "current" | "declined" | "not_applicable" | "needs_info";
export const TEST_STATE_LABELS: Record<TestState, string> = {
  no_record: "No record", due: "Due", due_soon: "Due soon", current: "Up to date", declined: "Declined", not_applicable: "Not needed", needs_info: "Needs sex",
};

export interface TestStatus {
  key: TestKey;
  label: string;
  group: TestGroup;
  who: string;
  guideline: string;
  state: TestState;
  lastDone: { date: string; method: string | null; result: string | null; source: string | null } | null;
  dueOn: string | null;
}

const addMonths = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const addDaysYmd = (ymd: string, n: number) => new Date(new Date(`${ymd}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** Age in whole years on a clinic-local date. */
export function ageOn(dob: string | null, today: string): number | null {
  if (!dob) return null;
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty! - y! - (tm! < m! || (tm === m && td! < d!) ? 1 : 0);
}

/**
 * Every test that applies to this person, with where they stand. Declined counts for 12 months;
 * "not needed" is permanent until someone records the test. Sex-specific tests with no sex on
 * file come back as needs_info instead of guessing.
 */
export function evaluateTesting(p: TestPerson, records: TestRecord[], today: string): TestStatus[] {
  const out: TestStatus[] = [];
  for (const key of TEST_KEYS) {
    const def: TestDef = TESTS[key];
    const base = { key, label: def.label, group: def.group, who: def.who, guideline: def.guideline };
    if (def.needsSex && !p.sex) {
      // Only worth asking if the age would qualify.
      const asF = def.applies({ ...p, sex: "F" });
      if (asF) out.push({ ...base, state: "needs_info", lastDone: null, dueOn: null });
      continue;
    }
    if (!def.applies(p)) continue;
    const mine = records.filter((r) => r.testKey === key).sort((a, b) => b.performedOn.localeCompare(a.performedOn));
    const done = mine.find((r) => r.status === "done");
    const notNeeded = mine.find((r) => r.status === "not_applicable");
    const declined = mine.find((r) => r.status === "declined");
    const lastDone = done ? { date: done.performedOn, method: done.method ?? null, result: done.result ?? null, source: done.source ?? null } : null;
    if (notNeeded && (!done || notNeeded.performedOn >= done.performedOn)) { out.push({ ...base, state: "not_applicable", lastDone, dueOn: null }); continue; }
    const months = done ? (done.method && def.methods?.[done.method]?.months) || def.months : def.months;
    const dueOn = done ? (months == null ? null : addMonths(done.performedOn, months)) : null;
    let state: TestState;
    if (!done) state = "no_record";
    else if (dueOn == null || dueOn > addDaysYmd(today, 30)) state = "current";
    else if (dueOn > today) state = "due_soon";
    else state = "due";
    if ((state === "no_record" || state === "due") && declined && declined.performedOn >= addMonths(today, -12) && (!done || declined.performedOn >= done.performedOn)) state = "declined";
    out.push({ ...base, state, lastDone, dueOn });
  }
  return out;
}

/** Medicare on the insurance line (for the wellness visit). */
export const isMedicare = (insurance: string | null | undefined) => /medicare|mcr\b|humana gold|aarp|advantage/i.test(insurance ?? "");

/** "Female" / "f" / "Woman" → "F". */
export function parseSex(raw: string | null | undefined): Sex | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (/^(f|female|woman|w)$/.test(v)) return "F";
  if (/^(m|male|man)$/.test(v)) return "M";
  if (/^(x|other|non-?binary|unknown)$/.test(v)) return v === "unknown" ? null : "X";
  return null;
}

// Facts read from the Practice Fusion chart copy for many patients at once (diagnoses, latest
// smoking status, latest BMI), for the rules that decide program and testing eligibility.
// Counts and short labels only leave this module through those rules.
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, chartFacts, fhirPatients, fhirResources, patients } from "../drizzle/schema";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export interface ConditionFact { title: string | null; code: string | null; status: string | null; date: string | null }

/** Every problem-list entry per patient key (Practice Fusion), plus a roster record's conditions (as names). */
export async function conditionFacts(keys: Set<string>): Promise<Map<string, ConditionFact[]>> {
  const d = await db();
  const out = new Map<string, ConditionFact[]>();
  const add = (key: string, f: ConditionFact) => { const l = out.get(key); if (l) l.push(f); else out.set(key, [f]); };
  const rows = await d.select({ key: fhirResources.subjectKey, title: fhirResources.title, code: fhirResources.code, status: fhirResources.status, date: fhirResources.date })
    .from(fhirResources).where(and(eq(fhirResources.resourceType, "Condition"), isNotNull(fhirResources.subjectKey)));
  for (const r of rows) if (r.key && keys.has(r.key)) add(r.key, { title: r.title, code: r.code, status: r.status, date: r.date });
  const roster = await d.select({ id: patients.id, chronic: patients.chronicConditions, bhi: patients.bhiConditions }).from(patients);
  for (const r of roster) {
    const key = `p:${r.id}`;
    if (!keys.has(key)) continue;
    for (const t of [...(r.chronic ?? []), ...(r.bhi ?? [])]) if (t) add(key, { title: t, code: null, status: null, date: null });
  }
  return out;
}

export interface ObservationFact { value: string | null; date: string | null }

/** Is this chart line a smoking status or a BMI? (LOINC when Practice Fusion sends it, else the name.) */
export function factKindOf(o: { section: string | null; title: string | null; code: string | null }): "smoking" | "bmi" | null {
  const code = o.code ?? "";
  const title = (o.title ?? "").toLowerCase();
  if (code.endsWith("|72166-2") || (o.section === "Observation:other" && /smok|tobacco/.test(title))) return "smoking";
  if (code.endsWith("|39156-5") || (o.section === "Observation:vital-signs" && /body mass|\bbmi\b/.test(title))) return "bmi";
  return null;
}

/** Keep the newer value of each kind per Practice Fusion patient (one multi-row upsert per 500 patients). */
export async function saveChartFacts(items: { patientFhirId: string; kind: "smoking" | "bmi"; value: string | null; date: string | null }[]) {
  if (!items.length) return;
  const d = await db();
  // Newest of each kind per patient within this batch, merged into one row per patient.
  type Row = { patientFhirId: string; smokingValue: string | null; smokingDate: string | null; bmiValue: string | null; bmiDate: string | null };
  const rows = new Map<string, Row>();
  for (const it of items) {
    if (!it.value) continue;
    const r: Row = rows.get(it.patientFhirId) ?? { patientFhirId: it.patientFhirId, smokingValue: null, smokingDate: null, bmiValue: null, bmiDate: null };
    if (it.kind === "smoking" && (r.smokingValue == null || (it.date ?? "") >= (r.smokingDate ?? ""))) { r.smokingValue = it.value.slice(0, 160); r.smokingDate = it.date; }
    if (it.kind === "bmi" && (r.bmiValue == null || (it.date ?? "") >= (r.bmiDate ?? ""))) { r.bmiValue = it.value.slice(0, 60); r.bmiDate = it.date; }
    rows.set(it.patientFhirId, r);
  }
  const list = Array.from(rows.values());
  // An incoming value replaces the stored one only when it's there and at least as new. The value
  // column is set first, so its test still reads the stored (old) date.
  const smokingNewer = sql`VALUES(${chartFacts.smokingValue}) IS NOT NULL AND COALESCE(VALUES(${chartFacts.smokingDate}), '') >= COALESCE(${chartFacts.smokingDate}, '')`;
  const bmiNewer = sql`VALUES(${chartFacts.bmiValue}) IS NOT NULL AND COALESCE(VALUES(${chartFacts.bmiDate}), '') >= COALESCE(${chartFacts.bmiDate}, '')`;
  for (let i = 0; i < list.length; i += 500) {
    await d.insert(chartFacts).values(list.slice(i, i + 500)).onDuplicateKeyUpdate({ set: {
      smokingValue: sql`IF(${smokingNewer}, VALUES(${chartFacts.smokingValue}), ${chartFacts.smokingValue})`,
      smokingDate: sql`IF(VALUES(${chartFacts.smokingValue}) IS NOT NULL AND COALESCE(VALUES(${chartFacts.smokingDate}), '') >= COALESCE(${chartFacts.smokingDate}, ''), VALUES(${chartFacts.smokingDate}), ${chartFacts.smokingDate})`,
      bmiValue: sql`IF(${bmiNewer}, VALUES(${chartFacts.bmiValue}), ${chartFacts.bmiValue})`,
      bmiDate: sql`IF(VALUES(${chartFacts.bmiValue}) IS NOT NULL AND COALESCE(VALUES(${chartFacts.bmiDate}), '') >= COALESCE(${chartFacts.bmiDate}, ''), VALUES(${chartFacts.bmiDate}), ${chartFacts.bmiDate})`,
    } });
  }
}

const BACKFILL_KEY = "chart_facts_backfill";

/** One-time (and re-runnable) fill from the chart copy already loaded: walks observations in id order until the deadline. */
export async function backfillChartFacts(opts: { deadline: number; restart?: boolean }) {
  const d = await db();
  const [row] = await d.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, BACKFILL_KEY)).limit(1);
  let cursor = opts.restart ? 0 : Number((row?.value as { cursor?: number } | undefined)?.cursor ?? 0);
  let scanned = 0, saved = 0, done = false;
  while (Date.now() < opts.deadline) {
    const rows = await d.select({ id: fhirResources.id, pid: fhirResources.patientFhirId, section: fhirResources.section, title: fhirResources.title, value: fhirResources.value, date: fhirResources.date, code: fhirResources.code })
      .from(fhirResources).where(and(eq(fhirResources.resourceType, "Observation"), gt(fhirResources.id, cursor))).orderBy(asc(fhirResources.id)).limit(5000);
    if (!rows.length) { done = true; break; }
    const items = [];
    for (const r of rows) {
      const kind = r.pid ? factKindOf(r) : null;
      if (kind) items.push({ patientFhirId: r.pid!, kind, value: r.value, date: r.date });
    }
    await saveChartFacts(items);
    cursor = rows[rows.length - 1]!.id;
    scanned += rows.length;
    saved += items.length;
    const value = { cursor, done: false };
    await d.insert(appSettings).values({ key: BACKFILL_KEY, value }).onDuplicateKeyUpdate({ set: { value } });
  }
  if (done) {
    const value = { cursor, done: true, finishedAt: new Date().toISOString() };
    await d.insert(appSettings).values({ key: BACKFILL_KEY, value }).onDuplicateKeyUpdate({ set: { value } });
  }
  return { scanned, saved, cursor, done };
}

/** Latest smoking status and BMI per patient key (through each key's Practice Fusion record). */
export async function smokingAndBmi(keys: Set<string>): Promise<{ smoking: Map<string, ObservationFact>; bmi: Map<string, ObservationFact> }> {
  const d = await db();
  const rows = await d.select({ key: fhirPatients.subjectKey, sv: chartFacts.smokingValue, sd: chartFacts.smokingDate, bv: chartFacts.bmiValue, bd: chartFacts.bmiDate })
    .from(chartFacts).innerJoin(fhirPatients, eq(fhirPatients.fhirId, chartFacts.patientFhirId));
  const smoking = new Map<string, ObservationFact>();
  const bmi = new Map<string, ObservationFact>();
  for (const r of rows) {
    if (!keys.has(r.key)) continue;
    if (r.sv && (!smoking.get(r.key) || (r.sd ?? "") > (smoking.get(r.key)!.date ?? ""))) smoking.set(r.key, { value: r.sv, date: r.sd });
    if (r.bv && (!bmi.get(r.key) || (r.bd ?? "") > (bmi.get(r.key)!.date ?? ""))) bmi.set(r.key, { value: r.bv, date: r.bd });
  }
  return { smoking, bmi };
}

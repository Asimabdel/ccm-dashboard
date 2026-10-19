// How "testing" visits look in the Practice Fusion chart copy. The practice creates a testing encounter for
// patients who had an ABI-Q / PFT / RMR (2026-10-19), so before reading them as done tests we look at how
// they're labeled. IAM-only and read-only: labels, calendar names, counts and dates — never patient data.
import { gunzipSync } from "node:zlib";
import { and, eq, isNotNull, like, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appointments, fhirResources } from "../drizzle/schema";

const TEST_WORDS = /test|\babi\b|abi-?q|\bpfts?\b|\brmr\b|spiro|pulmonary function|metabolic|brachial|calorimetr|lung function/i;
const LIKE = ["%test%", "%ABI%", "%PFT%", "%RMR%", "%spiro%", "%pulmonary function%", "%metabolic%", "%brachial%", "%calorimetr%", "%lung function%"];

/** "2026-09-20; Testing; Mai Ismail; My PCP Dr; 9/20/2026" → "<date>; Testing; Mai Ismail; My PCP Dr; <date>". */
const noDates = (s: string) => s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>").replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "<date>").replace(/\s+/g, " ").trim();

type Tally = { n: number; people: Set<string>; first: string; last: string };
const tally = (m: Map<string, Tally>, key: string, person: string | null, date: string | null) => {
  const t = m.get(key) ?? { n: 0, people: new Set<string>(), first: "9999", last: "0000" };
  t.n++;
  if (person) t.people.add(person);
  if (date) { if (date < t.first) t.first = date; if (date > t.last) t.last = date; }
  m.set(key, t);
};
const top = (m: Map<string, Tally>, n: number) => Array.from(m.entries()).sort((a, b) => b[1].n - a[1].n).slice(0, n)
  .map(([label, t]) => ({ label: label.slice(0, 140), n: t.n, people: t.people.size, first: t.first === "9999" ? null : t.first, last: t.last === "0000" ? null : t.last }));

type RawEncounter = {
  type?: { text?: string; coding?: { system?: string; code?: string; display?: string }[] }[];
  serviceType?: { text?: string; coding?: { code?: string; display?: string }[] };
  class?: { code?: string; display?: string };
  reasonCode?: { text?: string; coding?: { code?: string; display?: string }[] }[];
};
const unpack = (raw: string | null): RawEncounter | null => {
  if (!raw) return null;
  try { return JSON.parse(gunzipSync(Buffer.from(raw, "base64")).toString("utf8")) as RawEncounter; } catch { return null; }
};

export async function officeTestEncounterProbe() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  // Every encounter's calendar (the 2nd part of the label), to see which calendars exist.
  const all = await d.select({ key: fhirResources.subjectKey, title: fhirResources.title, date: fhirResources.date })
    .from(fhirResources).where(eq(fhirResources.section, "Encounter"));
  const calendars = new Map<string, Tally>();
  for (const r of all) {
    const parts = (r.title ?? "").split(";").map((x) => x.trim());
    tally(calendars, parts.length >= 3 ? parts[1]! : noDates(r.title ?? "(none)"), r.key, r.date);
  }
  // Encounters whose label or reason mentions testing.
  const rows = await d.select({ key: fhirResources.subjectKey, title: fhirResources.title, value: fhirResources.value, status: fhirResources.status, date: fhirResources.date, raw: fhirResources.raw })
    .from(fhirResources)
    .where(and(eq(fhirResources.section, "Encounter"), or(...LIKE.map((p) => like(fhirResources.title, p)), ...LIKE.map((p) => like(fhirResources.value, p)))));
  const labels = new Map<string, Tally>();
  const reasons = new Map<string, Tally>();
  const fields = new Map<string, Tally>();
  const months = new Map<string, Tally>();
  const statuses = new Map<string, Tally>();
  let matched = 0;
  const people = new Set<string>();
  for (const r of rows) {
    const reason = (r.value ?? "").split(" · ")[0] ?? "";
    if (!TEST_WORDS.test(r.title ?? "") && !TEST_WORDS.test(reason)) continue;
    matched++;
    if (r.key) people.add(r.key);
    tally(labels, noDates(r.title ?? "(none)"), r.key, r.date);
    if (TEST_WORDS.test(reason)) tally(reasons, noDates(reason).slice(0, 80), r.key, r.date);
    tally(months, (r.date ?? "????-??").slice(0, 7), r.key, r.date);
    tally(statuses, r.status ?? "(none)", r.key, r.date);
    const e = unpack(r.raw);
    for (const t of e?.type ?? []) {
      if (t.text) tally(fields, `type.text: ${noDates(t.text)}`, r.key, r.date);
      for (const c of t.coding ?? []) tally(fields, `type.coding: ${c.system?.split("/").pop() ?? ""}|${c.code ?? ""} ${c.display ?? ""}`.trim(), r.key, r.date);
    }
    if (e?.serviceType?.text) tally(fields, `serviceType: ${e.serviceType.text}`, r.key, r.date);
    for (const c of e?.serviceType?.coding ?? []) tally(fields, `serviceType.coding: ${c.code ?? ""} ${c.display ?? ""}`.trim(), r.key, r.date);
    if (e?.class) tally(fields, `class: ${e.class.code ?? ""} ${e.class.display ?? ""}`.trim(), r.key, r.date);
    for (const rc of e?.reasonCode ?? []) {
      if (rc.text && TEST_WORDS.test(rc.text)) tally(fields, `reasonCode.text: ${noDates(rc.text).slice(0, 80)}`, r.key, r.date);
      for (const c of rc.coding ?? []) if (TEST_WORDS.test(c.display ?? "")) tally(fields, `reasonCode.coding: ${c.code ?? ""} ${c.display ?? ""}`.trim(), r.key, r.date);
    }
  }
  // The imported schedule's visit types that mention testing.
  const sched = await d.select({ visitType: appointments.visitType, status: appointments.status, n: sql<number>`count(*)`, first: sql<string>`min(${appointments.date})`, last: sql<string>`max(${appointments.date})` })
    .from(appointments).where(and(isNotNull(appointments.visitType), or(...LIKE.map((p) => like(appointments.visitType, p)))))
    .groupBy(appointments.visitType, appointments.status);
  return {
    encountersInChart: all.length,
    testingEncounters: matched,
    testingPatients: people.size,
    labels: top(labels, 30),
    reasons: top(reasons, 25),
    encounterFields: top(fields, 30),
    byMonth: top(months, 24).sort((a, b) => a.label.localeCompare(b.label)),
    statuses: top(statuses, 10),
    calendars: top(calendars, 40),
    scheduleVisitTypes: sched.map((s) => ({ visitType: (s.visitType ?? "").slice(0, 80), status: s.status, n: Number(s.n), first: s.first, last: s.last })),
  };
}

// IAM-only check: which exact diagnoses CCM-active patients have (to decide which specialized care
// plans and handouts to write). Counts only: ICD-10 codes, condition names as typed on the roster
// (no patient names or ids), and how often conditions occur together.
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { fhirResources, patients } from "../drizzle/schema";
import { classifyConditionName, classifyDiagnosis, icd10Of } from "../shared/programRules";

export async function ccmDiagnosisStats() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  const roster = await d.select({ id: patients.id, chronic: patients.chronicConditions, bhi: patients.bhiConditions })
    .from(patients).where(and(eq(patients.ccmEnrollmentStatus, "active"), sql`${patients.name} NOT LIKE '%(merged into #%'`));
  const keys = roster.map((r) => `p:${r.id}`);
  // Batches on the (section, subjectKey) index.
  const pf: { key: string | null; title: string | null; code: string | null; status: string | null }[] = [];
  for (let i = 0; i < keys.length; i += 150) {
    pf.push(...(await d.select({ key: fhirResources.subjectKey, title: fhirResources.title, code: fhirResources.code, status: fhirResources.status })
      .from(fhirResources).where(and(eq(fhirResources.section, "Condition"), inArray(fhirResources.subjectKey, keys.slice(i, i + 150))))));
  }
  const pfBy = new Map<string, typeof pf>();
  for (const r of pf) { const l = pfBy.get(r.key!); if (l) l.push(r); else pfBy.set(r.key!, [r]); }

  const byCat: Record<string, { patients: number; codes: Record<string, number>; uncoded: Record<string, number> }> = {};
  const otherCodes: Record<string, number> = {}; // ICD-10 codes that aren't a recognized chronic condition (Z79.4 insulin, etc.)
  const combos: Record<string, number> = {};
  let withCode = 0, onlyText = 0;
  for (const r of roster) {
    const cats = new Map<string, { codes: Set<string>; texts: Set<string> }>();
    const add = (cat: string, code: string | null, text: string | null) => {
      const e = cats.get(cat) ?? { codes: new Set<string>(), texts: new Set<string>() };
      if (code) e.codes.add(code); else if (text) e.texts.add(text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60));
      cats.set(cat, e);
    };
    for (const n of [...((r.chronic as string[] | null) ?? []), ...((r.bhi as string[] | null) ?? [])]) {
      if (!n?.trim()) continue;
      const m = classifyConditionName(n);
      const code = /\(([A-TV-Z]\d{2}(?:\.[0-9A-Z]{1,4})?)\)\s*$/i.exec(n)?.[1]?.toUpperCase() ?? null;
      if (m) add(m.category, code, code ? null : n);
      else if (code) otherCodes[code] = (otherCodes[code] ?? 0) + 1;
    }
    for (const c of pfBy.get(`p:${r.id}`) ?? []) {
      const icd = icd10Of(c.code);
      const m = classifyDiagnosis({ title: c.title, code: c.code, status: c.status });
      const dotted = icd ? `${icd.slice(0, 3)}${icd.length > 3 ? `.${icd.slice(3)}` : ""}` : null;
      if (m) add(m.category, dotted, dotted ? null : c.title);
      else if (dotted && !/resolved|inactive/i.test(c.status ?? "")) otherCodes[dotted] = (otherCodes[dotted] ?? 0) + 1;
    }
    let anyCode = false;
    for (const [cat, e] of Array.from(cats.entries())) {
      const b = byCat[cat] ?? (byCat[cat] = { patients: 0, codes: {}, uncoded: {} });
      b.patients++;
      if (e.codes.size) { anyCode = true; for (const c of Array.from(e.codes)) b.codes[c] = (b.codes[c] ?? 0) + 1; }
      else for (const t of Array.from(e.texts)) b.uncoded[t] = (b.uncoded[t] ?? 0) + 1;
    }
    if (anyCode) withCode++; else if (cats.size) onlyText++;
    const list = Array.from(cats.keys()).sort();
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const k = `${list[i]}+${list[j]}`; combos[k] = (combos[k] ?? 0) + 1; }
  }
  const top = (o: Record<string, number>, n: number) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));
  return {
    ccmActive: roster.length, patientsWithAnyIcdCode: withCode, patientsWithOnlyTypedNames: onlyText,
    byCategory: Object.fromEntries(Object.entries(byCat).sort((a, b) => b[1].patients - a[1].patients).map(([k, v]) => [k, { patients: v.patients, codes: top(v.codes, 40), uncoded: top(v.uncoded, 15) }])),
    otherCodes: top(otherCodes, 60),
    topPairs: top(combos, 40),
  };
}

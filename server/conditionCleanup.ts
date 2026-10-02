// One-time cleanup (2026-10-01) of roster condition lists filled from Practice Fusion before condition
// names were cleaned up. PF sends names like "Encounter diagnosis: Screening for malignant neoplasm of
// colon" and "Hyperlipidemia; Not applicable; Not applicable; Active; Dr …"; the prefix hid screenings
// and history from the rules, so the nightly condition sync copied some of them onto CCM records.
//
// Only entries in Practice Fusion's format are touched (staff-typed entries are left alone):
// - a real diagnosis is renamed to its clean name ("Hyperlipidemia");
// - a screening / history / counseling / prevention entry is removed.
// APCM-only patients' complexity level is recomputed from the cleaned list. Dry run unless apply.
// Counts only.
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { patients } from "../drizzle/schema";
import { classifyConditionName, cleanConditionTitle, countChronicConditions } from "../shared/programRules";
import { computeApcmLevel } from "./db";

const PF_FORMAT = /^(encounter|visit|problem[- ]list)\s+diagnosis\s*:|;\s*not applicable\b|;\s*(active|inactive|resolved)\s*(;|$)/i;
const REASONS: [string, RegExp][] = [
  ["screening", /screening/i], ["history", /history/i], ["counseling", /counseling/i], ["prevention (PrEP)", /pre-?exposure|prophyla/i],
  ["pregnancy-related", /maternal|gestational|pregnan/i],
];

/** One list → its cleaned version, and what happened. Pure. */
export function cleanList(list: string[]): { list: string[]; renamed: number; removed: string[] } {
  const out: string[] = [];
  const seen = new Set<string>();
  let renamed = 0;
  const removed: string[] = [];
  for (const raw of list) {
    const e = (raw ?? "").trim();
    if (!e) continue;
    let v = e;
    if (PF_FORMAT.test(e)) {
      const clean = cleanConditionTitle(e);
      if (!clean || !classifyConditionName(clean)) {
        removed.push(REASONS.find(([, re]) => re.test(clean))?.[0] ?? "not a recognized condition");
        continue;
      }
      if (clean !== e) { v = clean; renamed++; }
    }
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return { list: out, renamed, removed };
}

export async function cleanupRosterConditions(opts: { apply: boolean; deadline: number }) {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  const rows = await d.select({
    id: patients.id, chronic: patients.chronicConditions, bhi: patients.bhiConditions, ccm: patients.ccmEnrollmentStatus,
    apcm: patients.apcmEnrollmentStatus, apcmLevel: patients.apcmLevel, qmb: patients.isQMB, name: patients.name,
  }).from(patients);
  let patientsChanged = 0, renamed = 0, removed = 0, apcmLevelChanged = 0, ccmActiveBelowTwo = 0, done = true, written = 0;
  const reasons: Record<string, number> = {};
  for (const r of rows) {
    if (/\(merged into #\d+\)\s*$/.test(r.name)) continue;
    const before = ((r.chronic as string[] | null) ?? []).filter(Boolean);
    const beforeBhi = ((r.bhi as string[] | null) ?? []).filter(Boolean);
    const c = cleanList(before);
    const b = cleanList(beforeBhi);
    const changed = c.renamed || c.removed.length || b.renamed || b.removed.length || c.list.length !== before.length || b.list.length !== beforeBhi.length;
    // CCM needs 2+ chronic conditions: how many active CCM patients have fewer recognized ones now.
    if (r.ccm === "active" && countChronicConditions(c.list) < 2) ccmActiveBelowTwo++;
    if (!changed) continue;
    patientsChanged++;
    renamed += c.renamed + b.renamed;
    removed += c.removed.length + b.removed.length;
    for (const x of [...c.removed, ...b.removed]) reasons[x] = (reasons[x] ?? 0) + 1;
    const patch: Record<string, unknown> = { chronicConditions: c.list, bhiConditions: b.list };
    if (r.apcm === "active") {
      const lvl = computeApcmLevel(countChronicConditions(c.list), !!r.qmb, r.ccm === "active");
      if (lvl !== r.apcmLevel) { patch.apcmLevel = lvl; apcmLevelChanged++; }
    }
    if (opts.apply) {
      if (Date.now() > opts.deadline) { done = false; break; }
      await d.update(patients).set(patch).where(eq(patients.id, r.id));
      written++;
    }
  }
  const summary = {
    applied: opts.apply, patientsChanged, written: opts.apply ? written : null, done: opts.apply ? done : null,
    entriesRenamed: renamed, entriesRemoved: removed, removedBecause: reasons, apcmLevelChanged,
    ccmActiveWithFewerThan2RecognizedChronic: ccmActiveBelowTwo,
  };
  console.log(`[condition-cleanup] ${JSON.stringify(summary)}`); // counts only
  return summary;
}

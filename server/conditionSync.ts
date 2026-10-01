// Keep each CCM-roster record's "Chronic conditions" (and, for BHI patients, "BHI conditions") filled
// from their Practice Fusion problem list. The practice's choices (2026-10-01): add Practice Fusion's
// active chronic diagnoses with their ICD-10 code ("Type 2 diabetes mellitus (E11.9)"), keep whatever is
// already on the record, don't add a condition that's already listed under another name, and do it
// every night. Only diagnoses the program rules recognize as chronic (or behavioral) are added.
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { fhirPatients, patients } from "../drizzle/schema";
import { classifyDiagnosis, isBehavioralCategory, isChronicCategory, type MatchedDiagnosis } from "../shared/programRules";
import { conditionFacts } from "./chartFacts";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

/** "Type 2 diabetes mellitus without complications (E11.9)". */
const labelOf = (m: MatchedDiagnosis) => (m.icd && !m.title.includes(m.icd) ? `${m.title} (${m.icd})` : m.title).slice(0, 200);

/** Categories already on a list (so "Diabetes" typed by staff isn't joined by "Type 2 diabetes…"). */
const categoriesOf = (list: string[]) => new Set(list.map((t) => classifyDiagnosis({ title: t })?.category).filter((c): c is string => !!c));

/** One per category: the most recently dated active problem. */
function newestPerCategory(facts: { m: MatchedDiagnosis; date: string | null }[]) {
  const best = new Map<string, { m: MatchedDiagnosis; date: string | null }>();
  for (const f of facts) {
    const cur = best.get(f.m.category);
    if (!cur || (f.date ?? "") > (cur.date ?? "")) best.set(f.m.category, f);
  }
  return Array.from(best.values()).sort((a, b) => a.m.label.localeCompare(b.m.label)).map((f) => f.m);
}

/** What to add to one roster record, given its current lists and its Practice Fusion problems. */
export function conditionsToAdd(current: { chronic: string[]; bhi: string[]; bhiActive: boolean }, problems: { title: string | null; code: string | null; status: string | null; date: string | null }[]) {
  const matches = problems.map((f) => ({ m: classifyDiagnosis(f), date: f.date })).filter((x): x is { m: MatchedDiagnosis; date: string | null } => !!x.m);
  const pick = newestPerCategory(matches);
  const have = categoriesOf(current.chronic);
  const haveBhi = categoriesOf(current.bhi);
  return {
    chronic: pick.filter((m) => isChronicCategory(m.category) && !have.has(m.category)).map(labelOf),
    bhi: current.bhiActive ? pick.filter((m) => isBehavioralCategory(m.category) && !haveBhi.has(m.category)).map(labelOf) : [],
  };
}

export async function syncRosterConditions(opts: { apply: boolean; deadline: number }) {
  const d = await db();
  // Roster patients with a Practice Fusion record.
  const linked = await d.select({ key: fhirPatients.subjectKey }).from(fhirPatients);
  const keys = new Set(linked.map((l) => l.key).filter((k) => /^p:\d+$/.test(k)));
  const roster = await d.select({ id: patients.id, chronic: patients.chronicConditions, bhi: patients.bhiConditions, bhiStatus: patients.bhiEnrollmentStatus }).from(patients);
  const facts = await conditionFacts(keys, { pfOnly: true });
  let checked = 0, updated = 0, added = 0, bhiUpdated = 0, bhiAdded = 0, done = true;
  for (const r of roster) {
    const key = `p:${r.id}`;
    if (!keys.has(key)) continue;
    checked++;
    const chronicNow = (r.chronic ?? []).filter(Boolean);
    const bhiNow = (r.bhi ?? []).filter(Boolean);
    const { chronic: addChronic, bhi: addBhi } = conditionsToAdd({ chronic: chronicNow, bhi: bhiNow, bhiActive: r.bhiStatus === "active" }, facts.get(key) ?? []);
    if (!addChronic.length && !addBhi.length) continue;
    if (opts.apply) {
      if (Date.now() > opts.deadline) { done = false; break; }
      await d.update(patients).set({
        ...(addChronic.length ? { chronicConditions: [...chronicNow, ...addChronic] } : {}),
        ...(addBhi.length ? { bhiConditions: [...bhiNow, ...addBhi] } : {}),
      }).where(eq(patients.id, r.id));
    }
    if (addChronic.length) { updated++; added += addChronic.length; }
    if (addBhi.length) { bhiUpdated++; bhiAdded += addBhi.length; }
  }
  const summary = { applied: opts.apply, rosterWithPf: checked, patientsGainingConditions: updated, conditionsAdded: added, bhiPatientsUpdated: bhiUpdated, bhiConditionsAdded: bhiAdded, done };
  console.log(`[condition-sync] ${JSON.stringify(summary)}`); // counts only
  return summary;
}

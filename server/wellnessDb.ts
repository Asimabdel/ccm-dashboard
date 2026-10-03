// Prevention & wellness handouts (shared/wellness): the admin reviews, edits and approves each topic;
// patients only ever get an approved version. An edit to an approved topic waits for approval while the
// last approved version stays in use. Stored like the condition library (conditionContent + history).
import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { chartFacts, conditionContent, conditionContentHistory, fhirPatients, personDemographics } from "../drizzle/schema";
import { WorkspaceError, audit, type WorkspaceActor } from "./workspaceDb";
import {
  DEFAULT_WELLNESS, WELLNESS_BY_KEY, WELLNESS_GROUPS, WELLNESS_KEYS, WELLNESS_REVIEW_NOTES, WELLNESS_TOPICS, smokerFrom, suggestWellness,
  type WellnessEntry, type WellnessPerson,
} from "../shared/wellness";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const assertKey = (key: string) => {
  if (!WELLNESS_BY_KEY.has(key)) throw new WorkspaceError("That topic wasn't found.", "NOT_FOUND");
};
export const wellnessLabel = (key: string) => WELLNESS_BY_KEY.get(key)?.label ?? key;

async function rows(keys: string[] = WELLNESS_KEYS) {
  if (!keys.length) return new Map<string, typeof conditionContent.$inferSelect>();
  const r = await (await db()).select().from(conditionContent).where(inArray(conditionContent.conditionKey, keys));
  return new Map(r.map((x) => [x.conditionKey, x]));
}

/** The approved version of each topic (the current row if approved, else the last approved copy). Drafts never show. */
export async function approvedWellness(keys: string[]) {
  const out = new Map<string, { entry: WellnessEntry; version: number; approvedByName: string | null; approvedAt: Date | null }>();
  const want = keys.filter((k) => WELLNESS_BY_KEY.has(k));
  if (!want.length) return out;
  const current = await rows(want);
  const needHistory = want.filter((k) => current.get(k)?.status !== "approved");
  const hist = needHistory.length
    ? await (await db()).select().from(conditionContentHistory).where(inArray(conditionContentHistory.conditionKey, needHistory)).orderBy(desc(conditionContentHistory.version))
    : [];
  for (const k of want) {
    const r = current.get(k);
    if (r?.status === "approved") { out.set(k, { entry: r.content as WellnessEntry, version: r.version, approvedByName: r.approvedByName, approvedAt: r.approvedAt }); continue; }
    const h = hist.find((x) => x.conditionKey === k);
    if (h) out.set(k, { entry: h.content as WellnessEntry, version: h.version, approvedByName: h.approvedByName, approvedAt: h.approvedAt });
  }
  return out;
}

/** Every topic with its review status (admins see drafts; everyone else only what's approved). */
export async function wellnessList(actor: WorkspaceActor) {
  const r = await rows();
  const approved = await approvedWellness(WELLNESS_KEYS);
  const admin = actor.role === "admin";
  return WELLNESS_TOPICS.filter((t) => admin || approved.has(t.key)).map((t) => {
    const row = r.get(t.key);
    const a = approved.get(t.key);
    const entry = admin ? ((row?.content as WellnessEntry | undefined) ?? DEFAULT_WELLNESS.get(t.key)) : a?.entry;
    return {
      key: t.key, label: t.label, group: t.group, groupLabel: WELLNESS_GROUPS[t.group].en, why: t.why ?? null,
      // approved = live as it stands; changed = edited since its last approval (the approved version stays live); draft = never approved.
      status: (row?.status === "approved" ? "approved" : a ? "changed" : "draft") as "approved" | "changed" | "draft",
      live: !!a, approvedByName: a?.approvedByName ?? null, approvedAt: a?.approvedAt ?? null,
      titles: entry ? { en: entry.education.en.title, es: entry.education.es.title } : null,
    };
  });
}

export async function wellnessGet(actor: WorkspaceActor, key: string) {
  assertKey(key);
  const row = (await rows([key])).get(key);
  const a = (await approvedWellness([key])).get(key);
  if (actor.role !== "admin") {
    if (!a) throw new WorkspaceError("That topic isn't approved yet.", "NOT_FOUND");
    return { key, label: wellnessLabel(key), entry: a.entry, approved: a.entry, status: "approved" as const, approvedByName: a.approvedByName, approvedAt: a.approvedAt, reviewNotes: [], history: [] };
  }
  const entry = (row?.content as WellnessEntry | undefined) ?? DEFAULT_WELLNESS.get(key);
  if (!entry) throw new WorkspaceError("There's no content for this topic yet.", "NOT_FOUND");
  const history = await (await db()).select({ version: conditionContentHistory.version, approvedByName: conditionContentHistory.approvedByName, approvedAt: conditionContentHistory.approvedAt })
    .from(conditionContentHistory).where(eq(conditionContentHistory.conditionKey, key)).orderBy(desc(conditionContentHistory.version));
  return {
    key, label: wellnessLabel(key), entry, approved: a?.entry ?? null,
    status: (row?.status === "approved" ? "approved" : a ? "changed" : "draft") as "approved" | "changed" | "draft",
    approvedByName: a?.approvedByName ?? null, approvedAt: a?.approvedAt ?? null,
    reviewNotes: WELLNESS_REVIEW_NOTES[key] ?? [], history,
  };
}

/** Save an edit (admin). It waits for approval; the last approved version stays in use meanwhile. */
export async function wellnessSave(actor: WorkspaceActor, key: string, entry: WellnessEntry) {
  assertKey(key);
  if (actor.role !== "admin") throw new WorkspaceError("Only an admin can edit wellness handouts.", "FORBIDDEN");
  const d = await db();
  const row = (await rows([key])).get(key);
  const content = { ...entry, key };
  if (!row) await d.insert(conditionContent).values({ conditionKey: key, content, status: "draft", version: 1, updatedByUserId: actor.id });
  else await d.update(conditionContent).set({ content, status: "draft", version: row.status === "approved" ? row.version + 1 : row.version, approvedByUserId: null, approvedByName: null, approvedAt: null, updatedByUserId: actor.id }).where(eq(conditionContent.id, row.id));
  await audit(actor, "manage_document", { entityType: "wellnessContent", description: `Wellness handout edited: ${wellnessLabel(key)} (waiting for approval)` });
  return wellnessGet(actor, key);
}

/** Approve a topic as it stands (admin): from now on patients get this version. */
export async function wellnessApprove(actor: WorkspaceActor, key: string) {
  assertKey(key);
  if (actor.role !== "admin") throw new WorkspaceError("Only an admin can approve wellness handouts.", "FORBIDDEN");
  const d = await db();
  const row = (await rows([key])).get(key);
  if (row?.status === "approved") return wellnessGet(actor, key);
  const entry = (row?.content as WellnessEntry | undefined) ?? DEFAULT_WELLNESS.get(key);
  if (!entry) throw new WorkspaceError("There's no content to approve.");
  const now = new Date();
  const name = actor.name ?? "Admin";
  const version = row?.version ?? 1;
  if (!row) await d.insert(conditionContent).values({ conditionKey: key, content: entry, status: "approved", version, approvedByUserId: actor.id, approvedByName: name, approvedAt: now, updatedByUserId: actor.id });
  else await d.update(conditionContent).set({ status: "approved", approvedByUserId: actor.id, approvedByName: name, approvedAt: now }).where(eq(conditionContent.id, row.id));
  await d.insert(conditionContentHistory).values({ conditionKey: key, version, content: entry, approvedByUserId: actor.id, approvedByName: name, approvedAt: now });
  await audit(actor, "manage_document", { entityType: "wellnessContent", description: `Wellness handout approved: ${wellnessLabel(key)} v${version}` });
  return wellnessGet(actor, key);
}

/** Age, sex, smoking and BMI for suggestions (from the patient directory, Practice Fusion and the chart facts). */
async function personFor(subjectKey: string): Promise<WellnessPerson> {
  const { directoryEntry } = await import("./directoryDb");
  const e = await directoryEntry(subjectKey);
  const d = await db();
  const [demo] = await d.select({ sex: personDemographics.sex }).from(personDemographics).where(eq(personDemographics.subjectKey, subjectKey)).limit(1);
  const pf = await d.select({ fhirId: fhirPatients.fhirId, sex: fhirPatients.sex }).from(fhirPatients).where(eq(fhirPatients.subjectKey, subjectKey)).limit(1);
  const facts = pf[0] ? (await d.select().from(chartFacts).where(eq(chartFacts.patientFhirId, pf[0].fhirId)).limit(1))[0] : undefined;
  let age: number | null = null;
  if (e?.dob) {
    const b = new Date(`${e.dob}T12:00:00Z`);
    const now = new Date();
    age = now.getUTCFullYear() - b.getUTCFullYear() - (now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate()) ? 1 : 0);
  }
  const bmi = facts?.bmiValue ? Number.parseFloat(facts.bmiValue) : NaN;
  return { age, sex: demo?.sex ?? pf[0]?.sex ?? null, smoker: smokerFrom(facts?.smokingValue), bmi: Number.isFinite(bmi) ? bmi : null };
}

/** Patient 360 → Education: approved wellness topics, the ones suggested for this patient first. */
export async function wellnessForPatient(actor: WorkspaceActor, subjectKey: string) {
  const person = await personFor(subjectKey);
  const suggested = new Map(suggestWellness(person).map((s) => [s.key, s.why]));
  const approved = await approvedWellness(WELLNESS_KEYS);
  const topics = WELLNESS_TOPICS.filter((t) => approved.has(t.key)).map((t) => {
    const e = approved.get(t.key)!.entry;
    return { key: t.key, label: t.label, group: t.group, titles: { en: e.education.en.title, es: e.education.es.title }, suggested: suggested.has(t.key), why: suggested.get(t.key) ?? null };
  });
  return { person, topics, waitingApproval: WELLNESS_KEYS.length - approved.size };
}


// CCM care plans and patient education.
//
// - The condition library: the built-in drafts (shared/conditionLibrary) until a provider approves a
//   condition in MyPCP; any edit returns it to draft. Only approved content reaches patients, the CCM
//   call and new care plans.
// - Care plans: one living plan per CCM-roster patient, built from the approved templates for their
//   chronic conditions, individualized by the care team, signed by a provider (every signature keeps a
//   copy). Signing also refreshes the patient's plan text (the APCM care plan field).
// - Education: handouts sent by text / email / link (a random code: the link names no condition),
//   printed, or covered on the CCM call, all logged on the patient.
import { WELLNESS_KEYS, WELLNESS_TOPICS, isWellnessKey } from "../shared/wellness";
import { approvedWellness, wellnessLabel } from "./wellnessDb";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  ccmTasks, clinics, conditionContent, conditionContentHistory, educationSends, fhirResources, patientCarePlanSignatures,
  patientCarePlans, patients, providers, users,
} from "../drizzle/schema";
import {
  DEFAULT_LIBRARY, ITEM_BY_KEY, LIBRARY_ITEMS, LIBRARY_KEYS, REVIEW_NOTES, itemLabel, resolveItems,
  type ConditionLibraryEntry, type LibraryLang, type ResolvedItem,
} from "../shared/conditionLibrary";
import {
  defaultGeneral, emptyProblem, planGaps, problemFromTemplate, renderPlanText, type PlanGeneral, type PlanProblem,
} from "../shared/carePlanDoc";
import { categoryLabel, classifyDiagnosis } from "../shared/programRules";
import { formatUsPhone, langFromPreferred } from "../shared/intake";
import { localDateStr } from "../shared/workforce";
import { WorkspaceError, audit, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const LIBRARY_SET = new Set(LIBRARY_KEYS);
/** Condition handouts and prevention & wellness handouts share sending, printing and the public pages. */
const isTopic = (k: string) => LIBRARY_SET.has(k) || isWellnessKey(k);
const topicLabel = (k: string) => (isWellnessKey(k) ? wellnessLabel(k) : itemLabel(k));

/** The approved content of each topic, condition or wellness, with its kind. */
async function approvedTopics(keys: string[]) {
  const out = new Map<string, { kind: "condition" | "wellness"; education: unknown; version: number; approvedAt: Date | null }>();
  const cond = await approvedContent(keys.filter((k) => LIBRARY_SET.has(k)));
  for (const [k, a] of Array.from(cond)) out.set(k, { kind: "condition", education: a.entry.education, version: a.version, approvedAt: a.approvedAt });
  const well = await approvedWellness(keys.filter(isWellnessKey));
  for (const [k, a] of Array.from(well)) out.set(k, { kind: "wellness", education: a.entry.education, version: a.version, approvedAt: a.approvedAt });
  return out;
}
const assertKey = (key: string) => { if (!LIBRARY_SET.has(key)) throw new WorkspaceError("Unknown condition.", "NOT_FOUND"); };

// ---------------------------------------------------------------------------
// Who may approve content and sign plans: providers (or an admin linked to a provider record)
// ---------------------------------------------------------------------------

export async function isSigningProvider(userId: number, role: string): Promise<boolean> {
  if (role === "provider") return true;
  const [p] = await (await db()).select({ id: providers.id }).from(providers).where(eq(providers.userId, userId)).limit(1);
  return !!p;
}
async function assertSigner(actor: WorkspaceActor, what: string) {
  if (!(await isSigningProvider(actor.id, actor.role))) throw new WorkspaceError(`Only a provider can ${what}.`, "FORBIDDEN");
}
/** The signer's name as it goes on the plan (their provider record's name and title when they have one). */
async function signerName(actor: WorkspaceActor): Promise<string> {
  const [p] = await (await db()).select({ name: providers.name, title: providers.title }).from(providers).where(eq(providers.userId, actor.id)).limit(1);
  if (p) return [p.name, p.title].filter(Boolean).join(", ");
  return actor.name ?? `User #${actor.id}`;
}

// ---------------------------------------------------------------------------
// Condition library
// ---------------------------------------------------------------------------

type ContentRow = typeof conditionContent.$inferSelect;

async function contentRows(keys?: string[]): Promise<Map<string, ContentRow>> {
  const d = await db();
  const rows = await (keys ? d.select().from(conditionContent).where(inArray(conditionContent.conditionKey, keys.length ? keys : ["-"])) : d.select().from(conditionContent));
  return new Map(rows.map((r) => [r.conditionKey, r]));
}

const entryOf = (key: string, row: ContentRow | undefined): ConditionLibraryEntry | null =>
  (row ? (row.content as ConditionLibraryEntry) : DEFAULT_LIBRARY.get(key)) ?? null;

/**
 * The content in use for these items: the practice's edited copy if there is one, else the built-in
 * draft. The practice decided (2026-10-01) to use the library as approved: nothing waits for a provider
 * review; a provider can still edit an item or mark it reviewed (approvedByName / approvedAt).
 */
export async function approvedContent(keys: string[]): Promise<Map<string, { entry: ConditionLibraryEntry; version: number; approvedByName: string | null; approvedAt: Date | null }>> {
  const out = new Map<string, { entry: ConditionLibraryEntry; version: number; approvedByName: string | null; approvedAt: Date | null }>();
  const want = keys.filter((k) => LIBRARY_SET.has(k));
  if (!want.length) return out;
  const rows = await contentRows(want);
  for (const k of want) {
    const r = rows.get(k);
    const entry = entryOf(k, r);
    if (!entry) continue;
    out.set(k, { entry, version: r?.version ?? 1, approvedByName: r?.status === "approved" ? r.approvedByName : null, approvedAt: r?.status === "approved" ? r.approvedAt : null });
  }
  return out;
}

export async function libraryList() {
  const rows = await contentRows();
  const approved = await approvedContent(LIBRARY_KEYS);
  return LIBRARY_ITEMS.map((c) => {
    const r = rows.get(c.key);
    const a = approved.get(c.key);
    return {
      key: c.key, label: c.label, category: c.category, categoryLabel: categoryLabel(c.category), kind: c.kind, general: !!c.general, isDefault: !!c.isDefault,
      // approved = a provider marked it reviewed; changed = edited since a review; draft = in use, not reviewed yet.
      status: (r?.status === "approved" ? "approved" : r && r.version > 1 ? "changed" : "draft") as "approved" | "changed" | "draft",
      version: r?.version ?? 1, edited: !!r, hasContent: !!a,
      approvedVersion: a?.approvedByName ? a.version : null, approvedByName: a?.approvedByName ?? null, approvedAt: a?.approvedAt ?? null,
    };
  });
}

export async function libraryGet(key: string) {
  assertKey(key);
  const r = (await contentRows([key])).get(key);
  const entry = entryOf(key, r);
  if (!entry) throw new WorkspaceError("There's no content for this condition yet.", "NOT_FOUND");
  const history = await (await db()).select({ version: conditionContentHistory.version, approvedByName: conditionContentHistory.approvedByName, approvedAt: conditionContentHistory.approvedAt })
    .from(conditionContentHistory).where(eq(conditionContentHistory.conditionKey, key)).orderBy(desc(conditionContentHistory.version));
  return {
    key, label: itemLabel(key), kind: ITEM_BY_KEY.get(key)?.kind ?? "condition", categoryLabel: categoryLabel(ITEM_BY_KEY.get(key)?.category ?? key), entry, status: (r?.status ?? "draft") as "approved" | "draft", version: r?.version ?? 1, edited: !!r,
    approvedByName: r?.status === "approved" ? r.approvedByName : null, approvedAt: r?.status === "approved" ? r.approvedAt : null, history,
    /** Points in the built-in draft to check before approving. */
    reviewNotes: REVIEW_NOTES[key] ?? [],
  };
}

/** Save an edit (providers and admins). An approved condition goes back to draft as the next version. */
export async function librarySave(actor: WorkspaceActor, key: string, entry: ConditionLibraryEntry) {
  assertKey(key);
  const d = await db();
  const r = (await contentRows([key])).get(key);
  const content = { ...entry, key };
  if (!r) await d.insert(conditionContent).values({ conditionKey: key, content, status: "draft", version: 1, updatedByUserId: actor.id });
  else await d.update(conditionContent).set({ content, status: "draft", version: r.status === "approved" ? r.version + 1 : r.version, approvedByUserId: null, approvedByName: null, approvedAt: null, updatedByUserId: actor.id }).where(eq(conditionContent.id, r.id));
  await audit(actor, "manage_document", { entityType: "conditionContent", description: `Condition library edited: ${itemLabel(key)} (back to draft)` });
  return libraryGet(key);
}

/** A provider approves a condition's content as it stands. */
export async function libraryApprove(actor: WorkspaceActor, key: string) {
  assertKey(key);
  await assertSigner(actor, "approve condition content");
  const d = await db();
  const r = (await contentRows([key])).get(key);
  const entry = entryOf(key, r);
  if (!entry) throw new WorkspaceError("There's no content to approve.");
  if (r?.status === "approved") return libraryGet(key);
  const name = await signerName(actor);
  const now = new Date();
  const version = r?.version ?? 1;
  if (!r) await d.insert(conditionContent).values({ conditionKey: key, content: entry, status: "approved", version, approvedByUserId: actor.id, approvedByName: name, approvedAt: now, updatedByUserId: actor.id });
  else await d.update(conditionContent).set({ status: "approved", approvedByUserId: actor.id, approvedByName: name, approvedAt: now }).where(eq(conditionContent.id, r.id));
  await d.insert(conditionContentHistory).values({ conditionKey: key, version, content: entry, approvedByUserId: actor.id, approvedByName: name, approvedAt: now });
  await audit(actor, "manage_document", { entityType: "conditionContent", description: `Condition library approved: ${itemLabel(key)} v${version}` });
  return libraryGet(key);
}

// ---------------------------------------------------------------------------
// A patient's conditions
// ---------------------------------------------------------------------------

/** The active diagnoses on a patient's Practice Fusion problem list (names only). */
async function pfDiagnosisNames(subjectKey: string): Promise<string[]> {
  const rows = await (await db()).select({ title: fhirResources.title, code: fhirResources.code, status: fhirResources.status }).from(fhirResources)
    .where(and(eq(fhirResources.section, "Condition"), eq(fhirResources.subjectKey, subjectKey)));
  return rows.filter((r) => classifyDiagnosis({ title: r.title, code: r.code, status: r.status })).map((r) => r.title!);
}

/** The roster lists of a CCM patient (as typed or synced). */
const rosterNames = (p: { chronic: unknown; bhi: unknown }) => [...((p.chronic as string[] | null) ?? []), ...((p.bhi as string[] | null) ?? [])];

/** Roster patient: the CCM/BHI condition lists plus their Practice Fusion problem list → specialized items. */
async function rosterItems(patientId: number): Promise<ResolvedItem[]> {
  const [p] = await (await db()).select({ chronic: patients.chronicConditions, bhi: patients.bhiConditions }).from(patients).where(eq(patients.id, patientId)).limit(1);
  if (!p) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
  return resolveItems([...rosterNames(p), ...(await pfDiagnosisNames(`p:${patientId}`))]).filter((i) => LIBRARY_SET.has(i.key));
}

/** Anyone: roster patients as above, everyone else from their Practice Fusion problem list. */
export async function itemsFor(subjectKey: string): Promise<ResolvedItem[]> {
  const m = /^p:(\d+)$/.exec(subjectKey);
  if (m) return rosterItems(Number(m[1]));
  return resolveItems(await pfDiagnosisNames(subjectKey)).filter((i) => LIBRARY_SET.has(i.key));
}

// ---------------------------------------------------------------------------
// Care plans
// ---------------------------------------------------------------------------

type PlanRow = typeof patientCarePlans.$inferSelect;
export type PlanStatus = "none" | "draft" | "changed" | "signed";
const statusOf = (p: Pick<PlanRow, "version" | "signedVersion"> | null | undefined): PlanStatus =>
  !p ? "none" : p.signedVersion == null ? "draft" : p.signedVersion === p.version ? "signed" : "changed";

async function patientBasics(patientId: number) {
  const d = await db();
  const [p] = await d.select({
    id: patients.id, name: patients.name, clinicId: patients.clinicId, providerId: patients.providerId, staffId: patients.assignedStaffId,
    ccm: patients.ccmEnrollmentStatus, apcmCarePlan: patients.apcmCarePlan, preferredLanguage: patients.preferredLanguage,
  }).from(patients).where(eq(patients.id, patientId)).limit(1);
  if (!p) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
  const [prov] = p.providerId ? await d.select({ name: providers.name, title: providers.title, userId: providers.userId }).from(providers).where(eq(providers.id, p.providerId)).limit(1) : [];
  const [coord] = p.staffId ? await d.select({ name: users.name }).from(users).where(eq(users.id, p.staffId)).limit(1) : [];
  const [clinic] = p.clinicId ? await d.select({ name: clinics.name, phone: clinics.phone }).from(clinics).where(eq(clinics.id, p.clinicId)).limit(1) : [];
  return {
    ...p, providerName: prov ? [prov.name, prov.title].filter(Boolean).join(", ") : null, providerUserId: prov?.userId ?? null,
    coordinatorName: coord?.name ?? null, clinicName: clinic?.name ?? null, clinicPhone: clinic?.phone ? formatUsPhone(clinic.phone) : null,
  };
}

function assertInClinic(actor: WorkspaceActor, clinicId: number | null) {
  if (actor.clinicIds && (clinicId == null || !actor.clinicIds.includes(clinicId))) throw new WorkspaceError("This patient isn't at your clinic.", "FORBIDDEN");
}

/** Everything the care-plan screen needs for one roster patient. */
export async function planFor(actor: WorkspaceActor, patientId: number) {
  const p = await patientBasics(patientId);
  const d = await db();
  const [row] = await d.select().from(patientCarePlans).where(eq(patientCarePlans.patientId, patientId)).limit(1);
  const items = await rosterItems(patientId);
  const approved = await approvedContent(items.map((c) => c.key));
  const onPlan = new Set(((row?.problems as PlanProblem[] | undefined) ?? []).map((x) => x.key).filter(Boolean));
  const planKeys = ((row?.problems as PlanProblem[] | undefined) ?? []).map((x) => x.key).filter((k): k is string => !!k);
  const handoutContent = await approvedContent(planKeys);
  const signatures = row ? await d.select({ version: patientCarePlanSignatures.version, signedByName: patientCarePlanSignatures.signedByName, signedAt: patientCarePlanSignatures.signedAt })
    .from(patientCarePlanSignatures).where(eq(patientCarePlanSignatures.planId, row.id)).orderBy(desc(patientCarePlanSignatures.signedAt)).limit(10) : [];
  await audit(actor, "view_patient", { entityType: "carePlan", entityId: patientId, description: "Care plan viewed" });
  return {
    patient: {
      id: p.id, name: p.name, ccm: p.ccm, providerName: p.providerName, coordinatorName: p.coordinatorName, clinicName: p.clinicName, clinicPhone: p.clinicPhone,
      language: (langFromPreferred(p.preferredLanguage) === "es" ? "es" : "en") as LibraryLang,
    },
    /** The patient handouts for the items on the plan (the patient's copy uses their plain wording). */
    handouts: Object.fromEntries(Array.from(handoutContent.entries()).map(([k, v]) => [k, v.entry.education])),
    plan: row ? {
      id: row.id, problems: row.problems as PlanProblem[], general: row.general as PlanGeneral, version: row.version, status: statusOf(row),
      signedByName: row.signedByName, signedAt: row.signedAt, signedVersion: row.signedVersion, lastReviewedAt: row.lastReviewedAt, lastReviewedMonth: row.lastReviewedMonth, updatedAt: row.updatedAt,
    } : null,
    /** The specialized items this patient's diagnoses call for (exact diagnoses, then add-ons). */
    conditions: items.map((c) => ({ ...c, onPlan: onPlan.has(c.key), templateApproved: approved.has(c.key) })),
    signatures,
    canSign: await isSigningProvider(actor.id, actor.role),
    gaps: row ? planGaps({ problems: row.problems as PlanProblem[] }) : [],
  };
}

/** The approved care-plan section for one condition (adding a newly diagnosed condition to a plan). */
export async function templateSection(key: string, diagnosis: string): Promise<PlanProblem> {
  assertKey(key);
  const a = (await approvedContent([key])).get(key);
  const item = ITEM_BY_KEY.get(key)!;
  const section = a ? problemFromTemplate(key, diagnosis, a.entry.carePlan, a.version) : emptyProblem(key, diagnosis, itemLabel(key));
  return { ...section, kind: item.kind };
}

/** One section per specialized item: its approved template (or an empty section), with the item's flags. */
function sectionFor(c: ResolvedItem, approved: Awaited<ReturnType<typeof approvedContent>>): PlanProblem {
  const a = approved.get(c.key);
  const base = a ? problemFromTemplate(c.key, c.diagnosis, a.entry.carePlan, a.version) : emptyProblem(c.key, c.diagnosis, c.label);
  return { ...base, kind: c.kind, assumed: c.assumed || undefined, confirmType: c.confirmType || undefined };
}

function newPlanFor(p: Awaited<ReturnType<typeof patientBasics>>, items: ResolvedItem[], approved: Awaited<ReturnType<typeof approvedContent>>) {
  const problems = items.map((c) => sectionFor(c, approved));
  return { problems, general: defaultGeneral({ providerName: p.providerName, coordinatorName: p.coordinatorName, clinicPhone: p.clinicPhone }) };
}

/** Start a draft plan from the approved templates for the patient's conditions. */
export async function buildDraft(actor: WorkspaceActor, patientId: number) {
  const p = await patientBasics(patientId);
  assertInClinic(actor, p.clinicId);
  const d = await db();
  const [existing] = await d.select({ id: patientCarePlans.id }).from(patientCarePlans).where(eq(patientCarePlans.patientId, patientId)).limit(1);
  if (existing) throw new WorkspaceError("This patient already has a care plan.");
  const items = await rosterItems(patientId);
  if (!items.length) throw new WorkspaceError("No chronic conditions on this patient's record to build a plan from. Add their conditions first.");
  const plan = newPlanFor(p, items, await approvedContent(items.map((c) => c.key)));
  await d.insert(patientCarePlans).values({ patientId, problems: plan.problems, general: plan.general, version: 1, createdByUserId: actor.id, updatedByUserId: actor.id });
  await audit(actor, "update_patient", { entityType: "carePlan", entityId: patientId, description: "Care plan draft started" });
  return planFor(actor, patientId);
}

/** Save the care team's edits. `version` is the one they were editing (someone else saving first is caught). */
export async function savePlan(actor: WorkspaceActor, patientId: number, version: number, plan: { problems: PlanProblem[]; general: PlanGeneral }) {
  const p = await patientBasics(patientId);
  assertInClinic(actor, p.clinicId);
  const d = await db();
  const [row] = await d.select().from(patientCarePlans).where(eq(patientCarePlans.patientId, patientId)).limit(1);
  if (!row) throw new WorkspaceError("Start the plan first.");
  if (row.version !== version) throw new WorkspaceError("Someone else changed this plan while you were editing. Reload to see their changes.");
  await d.update(patientCarePlans).set({ problems: plan.problems, general: plan.general, version: row.version + 1, updatedByUserId: actor.id }).where(eq(patientCarePlans.id, row.id));
  await audit(actor, "update_patient", { entityType: "carePlan", entityId: patientId, description: `Care plan edited (v${row.version + 1})` });
  return planFor(actor, patientId);
}

const GENERIC_PLAN = /^(ADVANCED PRIMARY CARE MANAGEMENT \(APCM\) — COMPREHENSIVE CARE PLAN|COMPREHENSIVE CARE PLAN \(CHRONIC CARE MANAGEMENT\))/;

/** A provider signs the plan as it stands. The patient's plan text (APCM care plan) is refreshed unless staff wrote their own. */
export async function signPlan(actor: WorkspaceActor, patientId: number, version: number) {
  await assertSigner(actor, "sign a care plan");
  const p = await patientBasics(patientId);
  const d = await db();
  const [row] = await d.select().from(patientCarePlans).where(eq(patientCarePlans.patientId, patientId)).limit(1);
  if (!row) throw new WorkspaceError("There's no plan to sign.");
  if (row.version !== version) throw new WorkspaceError("The plan changed since you opened it. Reload and review it before signing.");
  if (row.signedVersion === row.version) throw new WorkspaceError("This version is already signed.");
  const gaps = planGaps({ problems: row.problems as PlanProblem[] });
  if (gaps.length) throw new WorkspaceError(`Finish the plan before signing: ${gaps.slice(0, 3).join(" ")}`);
  await signRow(actor, await signerName(actor), row, p);
  return planFor(actor, patientId);
}

/** Record one signature: the plan's signed version, a signed copy, and the patient's plan text. */
async function signRow(actor: WorkspaceActor, name: string, row: PlanRow, p: { name: string; apcmCarePlan: string | null }) {
  const d = await db();
  const now = new Date();
  const snapshot = { problems: row.problems, general: row.general };
  await d.transaction(async (tx) => {
    await tx.update(patientCarePlans).set({ signedVersion: row.version, signedByUserId: actor.id, signedByName: name, signedAt: now }).where(eq(patientCarePlans.id, row.id));
    await tx.insert(patientCarePlanSignatures).values({ planId: row.id, patientId: row.patientId, version: row.version, snapshot, signedByUserId: actor.id, signedByName: name, signedAt: now });
    if (!p.apcmCarePlan?.trim() || GENERIC_PLAN.test(p.apcmCarePlan.trim())) {
      const text = renderPlanText({ problems: row.problems as PlanProblem[], general: row.general as PlanGeneral }, { patientName: p.name, signedBy: name, signedAt: now });
      await tx.update(patients).set({ apcmCarePlan: text, updatedAt: now }).where(eq(patients.id, row.patientId));
    }
  });
  await audit(actor, "update_patient", { entityType: "carePlan", entityId: row.patientId, description: `Care plan signed (v${row.version})` });
}

/**
 * A provider signs, in one step, every unsigned (or changed) complete plan for the CCM patients
 * assigned to them. Their own signature, recorded on each plan like a single signing.
 */
export async function signAllMine(actor: WorkspaceActor, opts: { deadline: number }) {
  await assertSigner(actor, "sign care plans");
  const d = await db();
  const mine = (await d.select({ id: providers.id }).from(providers).where(eq(providers.userId, actor.id))).map((x) => x.id);
  if (!mine.length) throw new WorkspaceError("Your login isn't linked to a provider record, so MyPCP can't tell which patients are yours. An admin links it in Admin → Providers.");
  const rows = await d.select({ plan: patientCarePlans, name: patients.name, apcmCarePlan: patients.apcmCarePlan }).from(patientCarePlans)
    .innerJoin(patients, eq(patients.id, patientCarePlans.patientId))
    .where(and(inArray(patients.providerId, mine), eq(patients.ccmEnrollmentStatus, "active"), sql`(${patientCarePlans.signedVersion} IS NULL OR ${patientCarePlans.signedVersion} <> ${patientCarePlans.version})`));
  const name = await signerName(actor);
  let signed = 0, incomplete = 0, done = true;
  for (const r of rows) {
    if (Date.now() > opts.deadline) { done = false; break; }
    if (planGaps({ problems: r.plan.problems as PlanProblem[] }).length) { incomplete++; continue; }
    await signRow(actor, name, r.plan, { name: r.name, apcmCarePlan: r.apcmCarePlan });
    signed++;
  }
  return { signed, incomplete, done };
}

/** Old keys from the first (per-group) library. */
const LEGACY_KEYS: Record<string, string> = { diabetes: "diabetes_t2", thyroid: "thyroid_hypo" };

/**
 * Plans started before the specialized templates were in use: an untouched draft is rebuilt from the
 * patient's specialized items; any other plan gets only its empty sections filled (a signed plan then
 * shows "changed since signed"). Dry run unless apply; counts only.
 */
export async function refreshPlans(opts: { apply: boolean; deadline: number }) {
  const d = await db();
  const plans = await d.select().from(patientCarePlans);
  const content = await approvedContent(LIBRARY_KEYS);
  let rebuilt = 0, filledPlans = 0, sectionsFilled = 0, done = true;
  for (const pl of plans) {
    if (Date.now() > opts.deadline) { done = false; break; }
    if (pl.signedVersion == null && pl.version === 1) {
      const items = await rosterItems(pl.patientId);
      if (!items.length) continue;
      const fresh = newPlanFor(await patientBasics(pl.patientId), items, content);
      if (opts.apply) await d.update(patientCarePlans).set({ problems: fresh.problems, general: fresh.general, version: pl.version + 1 }).where(eq(patientCarePlans.id, pl.id));
      rebuilt++;
      continue;
    }
    let n = 0;
    const next = (pl.problems as PlanProblem[]).map((x) => {
      if (x.goals.some((g) => g.trim()) || x.interventions.some((g) => g.trim())) return x;
      const key = x.key ? LEGACY_KEYS[x.key] ?? x.key : null;
      const a = key ? content.get(key) : undefined;
      if (!key || !a) return x;
      n++;
      return { ...problemFromTemplate(key, x.diagnosis, a.entry.carePlan, a.version), kind: ITEM_BY_KEY.get(key)?.kind };
    });
    if (!n) continue;
    if (opts.apply) await d.update(patientCarePlans).set({ problems: next, version: pl.version + 1 }).where(eq(patientCarePlans.id, pl.id));
    filledPlans++; sectionsFilled += n;
  }
  const summary = { applied: opts.apply, plans: plans.length, rebuiltDrafts: rebuilt, plansWithSectionsFilled: filledPlans, sectionsFilled, done };
  console.log(`[careplan-refresh] ${JSON.stringify(summary)}`); // counts only
  return summary;
}

/** The care plan was reviewed with the patient (CCM call). */
export async function markReviewed(userId: number, patientId: number) {
  const now = new Date();
  await (await db()).update(patientCarePlans).set({ lastReviewedAt: now, lastReviewedByUserId: userId, lastReviewedMonth: localDateStr().slice(0, 7) }).where(eq(patientCarePlans.patientId, patientId));
}

export type PlanFilter = "to_sign" | "none" | "signed" | "all";

/** The Care plans page: CCM-active patients and where their plan stands. Clinic-limited roles see their clinic. */
export async function planQueue(actor: WorkspaceActor, opts: { filter: PlanFilter; mine?: boolean }) {
  const d = await db();
  const where = [eq(patients.ccmEnrollmentStatus, "active"), sql`${patients.name} NOT LIKE '%(merged into #%'`];
  if (actor.clinicIds) where.push(actor.clinicIds.length ? inArray(patients.clinicId, actor.clinicIds) : sql`false`);
  const rows = await d.select({
    id: patients.id, name: patients.name, dob: patients.dateOfBirth, clinicId: patients.clinicId, providerId: patients.providerId, staffId: patients.assignedStaffId,
    chronic: patients.chronicConditions, bhi: patients.bhiConditions,
    planVersion: patientCarePlans.version, signedVersion: patientCarePlans.signedVersion, signedByName: patientCarePlans.signedByName, signedAt: patientCarePlans.signedAt,
    lastReviewedMonth: patientCarePlans.lastReviewedMonth, planUpdatedAt: patientCarePlans.updatedAt,
  }).from(patients).leftJoin(patientCarePlans, eq(patientCarePlans.patientId, patients.id)).where(and(...where));
  const provs = new Map((await d.select({ id: providers.id, name: providers.name, userId: providers.userId }).from(providers)).map((p) => [p.id, p]));
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));
  const staffName = new Map((await d.select({ id: users.id, name: users.name }).from(users)).map((u) => [u.id, u.name]));
  const all = rows.map((r) => {
    const status = statusOf(r.planVersion == null ? null : { version: r.planVersion, signedVersion: r.signedVersion });
    const prov = r.providerId ? provs.get(r.providerId) : undefined;
    return {
      patientId: r.id, name: r.name, dob: r.dob ? r.dob.toISOString().slice(0, 10) : null, clinic: r.clinicId ? clinicName.get(r.clinicId) ?? null : null,
      provider: prov?.name ?? null, providerUserId: prov?.userId ?? null, coordinator: r.staffId ? staffName.get(r.staffId) ?? null : null,
      conditions: resolveItems(rosterNames(r)).filter((i) => i.kind === "condition").map((c) => c.label),
      status, signedByName: r.signedByName, signedAt: r.signedAt, lastReviewedMonth: r.lastReviewedMonth, updatedAt: r.planUpdatedAt,
    };
  });
  const counts = { to_sign: 0, none: 0, signed: 0, all: all.length };
  for (const r of all) { if (r.status === "draft" || r.status === "changed") counts.to_sign++; else if (r.status === "none") counts.none++; else counts.signed++; }
  let list = all.filter((r) => opts.filter === "all" || (opts.filter === "to_sign" ? r.status === "draft" || r.status === "changed" : r.status === opts.filter));
  if (opts.mine) list = list.filter((r) => r.providerUserId === actor.id);
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { counts, rows: list.slice(0, 500), total: list.length, canSign: await isSigningProvider(actor.id, actor.role) };
}

/** Start draft plans for CCM-active patients who don't have one (clinic-limited roles: their clinic). Re-run until done. */
export async function buildMissingDrafts(actor: WorkspaceActor, opts: { deadline: number }) {
  const d = await db();
  const where = [eq(patients.ccmEnrollmentStatus, "active"), isNull(patientCarePlans.id), sql`${patients.name} NOT LIKE '%(merged into #%'`];
  if (actor.clinicIds) where.push(actor.clinicIds.length ? inArray(patients.clinicId, actor.clinicIds) : sql`false`);
  const rows = await d.select({ id: patients.id, chronic: patients.chronicConditions, bhi: patients.bhiConditions })
    .from(patients).leftJoin(patientCarePlans, eq(patientCarePlans.patientId, patients.id)).where(and(...where));
  const approved = await approvedContent(LIBRARY_KEYS);
  let built = 0, noConditions = 0, done = true;
  for (const r of rows) {
    if (Date.now() > opts.deadline) { done = false; break; }
    const items = await rosterItems(r.id);
    if (!items.length) { noConditions++; continue; }
    const p = await patientBasics(r.id);
    const plan = newPlanFor(p, items, approved);
    await d.insert(patientCarePlans).values({ patientId: r.id, problems: plan.problems, general: plan.general, version: 1, createdByUserId: actor.id, updatedByUserId: actor.id });
    built++;
  }
  if (built) await audit(actor, "update_patient", { entityType: "carePlan", description: `${built} care plan drafts started` });
  return { built, noConditions, done, approvedConditions: approved.size };
}

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
function newCode(): string {
  const b = randomBytes(10);
  return Array.from(b, (x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
}

/** The education tab: the patient's conditions, which handouts are approved, and what they've been given. */
export async function educationFor(actor: WorkspaceActor, subjectKey: string) {
  const conditions = await itemsFor(subjectKey);
  const approved = await approvedContent(conditions.map((c) => c.key));
  const d = await db();
  const sends = await d.select({ id: educationSends.id, keys: educationSends.conditionKeys, language: educationSends.language, channel: educationSends.channel, createdAt: educationSends.createdAt, openedAt: educationSends.openedAt, by: users.name })
    .from(educationSends).leftJoin(users, eq(users.id, educationSends.sentByUserId)).where(eq(educationSends.subjectKey, subjectKey)).orderBy(desc(educationSends.createdAt)).limit(30);
  return {
    conditions: conditions.map((c) => {
      const a = approved.get(c.key);
      return { ...c, approved: !!a, titles: a ? { en: a.entry.education.en.title, es: a.entry.education.es.title } : null };
    }),
    history: sends.map((s) => ({ ...s, labels: (s.keys as string[]).map(topicLabel) })),
  };
}

async function patientIdOf(subjectKey: string) {
  const m = /^p:(\d+)$/.exec(subjectKey);
  return m ? Number(m[1]) : null;
}

/** Log handouts given to a patient. Text / email / link sends get a code (the link the patient opens). */
export async function recordEducation(actor: WorkspaceActor, input: { subjectKey: string; keys: string[]; language: LibraryLang; channel: "text" | "email" | "link" | "print" | "call"; ccmTaskId?: number | null }) {
  const keys = Array.from(new Set(input.keys)).filter(isTopic);
  if (!keys.length) throw new WorkspaceError("Pick at least one topic.");
  const approved = await approvedTopics(keys);
  const missing = keys.filter((k) => !approved.has(k));
  if (missing.length && input.channel !== "call") throw new WorkspaceError(`There is no approved handout yet for: ${missing.map(topicLabel).join(", ")}.`);
  const code = input.channel === "text" || input.channel === "email" || input.channel === "link" ? newCode() : null;
  const versions = Object.fromEntries(keys.filter((k) => approved.has(k)).map((k) => [k, approved.get(k)!.version]));
  await (await db()).insert(educationSends).values({
    code, subjectKey: input.subjectKey, patientId: await patientIdOf(input.subjectKey), conditionKeys: keys, versions, language: input.language,
    channel: input.channel, ccmTaskId: input.ccmTaskId ?? null, sentByUserId: actor.id,
  });
  await audit(actor, "update_patient", { entityType: "education", description: `Education ${input.channel === "print" ? "printed" : input.channel === "call" ? "covered on call" : `sent (${input.channel})`}: ${keys.map(topicLabel).join(", ")}` });
  return { code };
}

/** The patient's clinic phone (for the message), when known. */
async function phoneFor(subjectKey: string): Promise<string | null> {
  const id = await patientIdOf(subjectKey);
  if (!id) return null;
  const [r] = await (await db()).select({ phone: clinics.phone }).from(patients).leftJoin(clinics, eq(clinics.id, patients.clinicId)).where(eq(patients.id, id)).limit(1);
  return r?.phone ? formatUsPhone(r.phone) : null;
}

export async function prepareSend(actor: WorkspaceActor, input: { subjectKey: string; keys: string[]; language: LibraryLang; channel: "text" | "link" }, base: string) {
  const { code } = await recordEducation(actor, input);
  const { educationMessage, sentLearnPath } = await import("../shared/conditionLibrary");
  const url = `${base}${sentLearnPath(code!)}`;
  return { url, message: educationMessage(input.language, url, await phoneFor(input.subjectKey)) };
}

export async function emailEducation(actor: WorkspaceActor, input: { subjectKey: string; keys: string[]; language: LibraryLang; to: string }, base: string) {
  const to = input.to.trim();
  if (!/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/.test(to)) throw new WorkspaceError("That email address doesn't look right.");
  const { sendPracticeEmail } = await import("./gmailSync");
  const { code } = await recordEducation(actor, { ...input, channel: "email" });
  const { educationMessage, sentLearnPath } = await import("../shared/conditionLibrary");
  const url = `${base}${sentLearnPath(code!)}`;
  const text = educationMessage(input.language, url, await phoneFor(input.subjectKey));
  const es = input.language === "es";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc"><div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.5;color:#0f172a">
    <p style="margin:0 0 20px;font-size:20px;font-weight:bold;color:#0e7490">MyPCP Dr</p>
    <p style="margin:0 0 20px">${esc(es ? "Su equipo de cuidado le envió información sobre su salud." : "Your care team sent you information about your health.")}</p>
    <p style="margin:0 0 20px"><a href="${esc(url)}" style="display:inline-block;background:#0e7490;color:#fff;text-decoration:none;font-weight:bold;font-size:20px;padding:16px 28px;border-radius:10px">${esc(es ? "Abrir la información" : "Open the information")}</a></p>
    <p style="margin:0;color:#334155">${esc(text.split("\n").slice(1).join(" "))}</p></div></body></html>`;
  await sendPracticeEmail({ to, fromName: "MyPCP Dr", subject: es ? "Información de salud de MyPCP Dr" : "Health information from MyPCP Dr", text, html });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Public pages (no login): approved handouts only, never a patient's name
// ---------------------------------------------------------------------------

export async function publicClinics() {
  return (await db()).select({ id: clinics.id, name: clinics.name, address: clinics.address, phone: clinics.phone }).from(clinics).orderBy(clinics.name);
}

export async function publicTopics() {
  const approved = await approvedContent(LIBRARY_KEYS);
  const conditions = LIBRARY_ITEMS.filter((c) => approved.has(c.key)).map((c) => {
    const e = approved.get(c.key)!.entry;
    return { key: c.key, kind: "condition" as const, group: null as string | null, titles: { en: e.education.en.title, es: e.education.es.title } };
  });
  const well = await approvedWellness(WELLNESS_KEYS);
  const wellness = WELLNESS_TOPICS.filter((t) => well.has(t.key)).map((t) => {
    const e = well.get(t.key)!.entry;
    return { key: t.key, kind: "wellness" as const, group: t.group as string | null, titles: { en: e.education.en.title, es: e.education.es.title } };
  });
  return [...conditions, ...wellness];
}

export async function publicTopic(key: string) {
  if (!isTopic(key)) return null;
  const a = (await approvedTopics([key])).get(key);
  return a ? { key, kind: a.kind, education: a.education, approvedAt: a.approvedAt } : null;
}

/** A sent set (/learn/s/<code>): its handouts and the clinic phone. Marks it opened the first time. */
export async function publicSent(code: string) {
  if (!/^[A-Za-z0-9]{6,16}$/.test(code)) return null;
  const d = await db();
  const [s] = await d.select().from(educationSends).where(eq(educationSends.code, code)).limit(1);
  if (!s) return null;
  if (!s.openedAt) await d.update(educationSends).set({ openedAt: new Date() }).where(eq(educationSends.id, s.id));
  const keys = s.conditionKeys as string[];
  const approved = await approvedTopics(keys);
  return {
    language: (s.language === "es" ? "es" : "en") as LibraryLang,
    topics: keys.filter((k) => approved.has(k)).map((k) => ({ key: k, kind: approved.get(k)!.kind, education: approved.get(k)!.education })),
    phone: await phoneFor(s.subjectKey),
  };
}

// ---------------------------------------------------------------------------
// CCM call
// ---------------------------------------------------------------------------

/** For the guided CCM call: the plan's state and each condition's approved teaching points. */
export async function callContext(actor: WorkspaceActor, patientId: number) {
  const conditions = await rosterItems(patientId);
  const approved = await approvedContent(conditions.map((c) => c.key));
  const d = await db();
  const [row] = await d.select().from(patientCarePlans).where(eq(patientCarePlans.patientId, patientId)).limit(1);
  const month = localDateStr().slice(0, 7);
  const recent = await d.select({ keys: educationSends.conditionKeys, createdAt: educationSends.createdAt }).from(educationSends)
    .where(eq(educationSends.patientId, patientId)).orderBy(desc(educationSends.createdAt)).limit(40);
  const lastCovered = new Map<string, Date>();
  for (const s of recent) for (const k of s.keys as string[]) if (!lastCovered.has(k)) lastCovered.set(k, s.createdAt);
  return {
    plan: row ? {
      status: statusOf(row), signedByName: row.signedByName, signedAt: row.signedAt, reviewedThisMonth: row.lastReviewedMonth === month,
      problems: (row.problems as PlanProblem[]).map((p) => ({ key: p.key, problem: p.problem, goals: p.goals, selfManagement: p.selfManagement })),
    } : null,
    conditions: conditions.map((c) => {
      const a = approved.get(c.key);
      return { key: c.key, label: c.label, kind: c.kind, diagnosis: c.diagnosis, talkingPoints: a?.entry.talkingPoints ?? null, lastCovered: lastCovered.get(c.key) ?? null };
    }),
  };
}

/** Called when a CCM note is saved: plan reviewed + education covered on this call. */
export async function recordCallEducation(actor: WorkspaceActor, input: { patientId: number; ccmTaskId: number; covered: string[]; planReviewed: boolean }) {
  if (input.planReviewed) await markReviewed(actor.id, input.patientId);
  const keys = input.covered.filter((k) => LIBRARY_SET.has(k));
  if (!keys.length) return;
  const d = await db();
  // One "call" entry per task: replace the earlier one when the note is saved again.
  await d.delete(educationSends).where(and(eq(educationSends.ccmTaskId, input.ccmTaskId), eq(educationSends.channel, "call")));
  await recordEducation(actor, { subjectKey: `p:${input.patientId}`, keys, language: "en", channel: "call", ccmTaskId: input.ccmTaskId });
}

/** Whether a CCM task's patient exists (guards the call endpoints). */
export async function taskPatient(taskId: number) {
  const [t] = await (await db()).select({ patientId: ccmTasks.patientId }).from(ccmTasks).where(eq(ccmTasks.id, taskId)).limit(1);
  return t?.patientId ?? null;
}

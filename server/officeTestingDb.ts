// The Testing tab: patients seen since the start date (seenSince.ts), or booked, who qualify for the in-office tests
// (ABI-Q, PFT, RMR) under the practice's criteria (shared/officeTests.ts), and where each stands.
// Staff schedule them: a call task, or mark Scheduled / Done / Declined / Not needed. The provider
// orders each test; nothing here contacts patients or makes a clinical decision.
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { clinics, opportunityActions, patientTests } from "../drizzle/schema";
import {
  OFFICE_TESTS, OFFICE_TEST_LABELS, eligibleTests, officeTestState,
  type OfficeTest, type OfficeTestRecord, type OfficeTestRecordStatus, type OfficeTestState, type Qualifier,
} from "../shared/officeTests";
import { ageOn } from "../shared/testing";
import { nameKey } from "../shared/workspace";
import { addDays, localDateStr } from "../shared/workforce";
import { conditionFacts, smokingAndBmi } from "./chartFacts";
import { loadDirectory, type DirectoryEntry } from "./directoryDb";
import { WorkspaceError, audit, createTask, frontDeskFor, type WorkspaceActor } from "./workspaceDb";
import { getSeenSince } from "./seenSince";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const TASK_CATEGORY = "office_test";

export interface Eligible {
  entry: DirectoryEntry;
  age: number | null;
  tests: { test: OfficeTest; reasons: { q: Qualifier; why: string }[] }[];
}

// Who qualifies changes only when the chart or schedule does: kept for 10 minutes per Lambda instance.
let cache: { at: number; since: string; build: Promise<Map<string, Eligible>> } | null = null;
const CACHE_MS = 10 * 60_000;

async function loadEligible(): Promise<Map<string, Eligible>> {
  const since = await getSeenSince();
  if (cache && cache.since === since && Date.now() - cache.at < CACHE_MS) return cache.build;
  const build = buildEligible(since);
  cache = { at: Date.now(), since, build };
  build.catch(() => { if (cache?.build === build) cache = null; });
  return build;
}

/** Seen on or after the start date, or with a visit booked (the test can be done at that visit). */
async function buildEligible(since: string): Promise<Map<string, Eligible>> {
  const today = localDateStr();
  const people = Array.from((await loadDirectory()).values()).filter((e) => (e.lastVisit && e.lastVisit >= since) || e.nextVisit);
  const keys = new Set(people.map((p) => p.key));
  const [dx, { smoking, bmi }] = await Promise.all([conditionFacts(keys), smokingAndBmi(keys)]);
  const out = new Map<string, Eligible>();
  for (const e of people) {
    const age = ageOn(e.dob, today);
    const tests = eligibleTests({ age, diagnoses: dx.get(e.key) ?? [], smoking: smoking.get(e.key) ?? null, bmi: bmi.get(e.key) ?? null });
    if (tests.length) out.set(e.key, { entry: e, age, tests });
  }
  return out;
}

async function recordsFor(keys?: string[]): Promise<Map<string, (OfficeTestRecord & { test: OfficeTest })[]>> {
  const d = await db();
  const rows = await d.select({ id: patientTests.id, key: patientTests.subjectKey, test: patientTests.testKey, status: patientTests.status, date: patientTests.performedOn, note: patientTests.note })
    .from(patientTests).where(keys ? and(inArray(patientTests.testKey, [...OFFICE_TESTS]), inArray(patientTests.subjectKey, keys)) : inArray(patientTests.testKey, [...OFFICE_TESTS]));
  const out = new Map<string, (OfficeTestRecord & { test: OfficeTest })[]>();
  for (const r of rows) {
    const l = out.get(r.key) ?? [];
    l.push({ id: r.id, test: r.test as OfficeTest, status: r.status as OfficeTestRecordStatus, date: r.date, note: r.note });
    out.set(r.key, l);
  }
  return out;
}

/** Call tasks made from this tab in the last 30 days (so a row shows "task made"). */
async function recentTasks(): Promise<Map<string, Date>> {
  const d = await db();
  const rows = await d.select({ key: opportunityActions.subjectKey, at: opportunityActions.createdAt }).from(opportunityActions)
    .where(and(eq(opportunityActions.category, TASK_CATEGORY), gte(opportunityActions.createdAt, new Date(Date.now() - 30 * 86_400_000))))
    .orderBy(desc(opportunityActions.createdAt));
  const out = new Map<string, Date>();
  for (const r of rows) if (r.key && !out.has(r.key)) out.set(r.key, r.at);
  return out;
}

export interface OfficeTestFilters {
  test?: OfficeTest | null;
  state: OfficeTestState;
  clinicId?: number | null;
  providerId?: number | null;
  /** Only patients with an appointment within this many days. */
  comingWithinDays?: number | null;
  q?: string | null;
  page: number;
}
const PAGE = 50;

export async function listOfficeTesting(actor: WorkspaceActor, f: OfficeTestFilters) {
  const today = localDateStr();
  const [eligible, records, tasks] = await Promise.all([loadEligible(), recordsFor(), recentTasks()]);
  const d = await db();
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));
  const words = nameKey(f.q ?? "").split(" ").filter(Boolean);
  const until = f.comingWithinDays ? addDays(today, f.comingWithinDays) : null;
  // A work list: clinic-limited staff see their clinic's patients.
  const all = Array.from(eligible.values()).filter((p) => !actor.clinicIds || (p.entry.clinicId != null && actor.clinicIds.includes(p.entry.clinicId)));
  const counts: Record<OfficeTest, Record<OfficeTestState, number>> = Object.fromEntries(OFFICE_TESTS.map((t) => [t, { eligible: 0, scheduled: 0, done: 0, declined: 0, not_needed: 0 }])) as Record<OfficeTest, Record<OfficeTestState, number>>;
  // With "all tests": how many patients have at least one test in each state.
  const patientCounts: Record<OfficeTestState, number> = { eligible: 0, scheduled: 0, done: 0, declined: 0, not_needed: 0 };
  const rows = [];
  for (const p of all) {
    const e = p.entry;
    const mine = records.get(e.key) ?? [];
    const tests = p.tests.map((t) => ({ ...t, ...officeTestState(mine.filter((r) => r.test === t.test), today) }));
    const inFilters = (!f.clinicId || e.clinicId === f.clinicId) && (!f.providerId || e.providerId === f.providerId)
      && (!until || (e.nextVisit != null && e.nextVisit.slice(0, 10) <= until))
      && (!words.length || words.every((w) => e.nameKey.includes(w)));
    if (!inFilters) continue;
    for (const t of tests) counts[t.test][t.state]++;
    for (const st of Array.from(new Set(tests.map((t) => t.state)))) patientCounts[st]++;
    const shown = tests.filter((t) => t.state === f.state && (!f.test || t.test === f.test));
    if (!shown.length) continue;
    rows.push({
      key: e.key, patientId: e.patientId, name: e.name, dob: e.dob, age: p.age, phone: e.phone,
      clinicId: e.clinicId, clinicName: e.clinicId ? clinicName.get(e.clinicId) ?? null : null, providerName: e.providerName,
      lastVisit: e.lastVisit, nextVisit: e.nextVisit, taskMadeAt: tasks.get(e.key) ?? null,
      tests: tests.map((t) => ({ test: t.test, reasons: t.reasons, state: t.state, lastDone: t.lastDone, scheduledFor: t.scheduledFor, eligibleAgainOn: t.eligibleAgainOn, recordId: t.record?.id ?? null, shown: shown.some((s) => s.test === t.test) })),
    });
  }
  // Coming in soonest first (the test can be done at that visit), then by name.
  rows.sort((a, b) => (a.nextVisit ?? "~").localeCompare(b.nextVisit ?? "~") || a.name.localeCompare(b.name));
  const page = Math.max(1, f.page);
  const providers = new Map<number, string>();
  for (const p of all) if (p.entry.providerId && p.entry.providerName) providers.set(p.entry.providerId, p.entry.providerName);
  return {
    rows: rows.slice((page - 1) * PAGE, page * PAGE),
    total: rows.length,
    page,
    pageSize: PAGE,
    counts,
    patientCounts,
    since: await getSeenSince(),
    clinics: Array.from(new Set(all.map((p) => p.entry.clinicId).filter((c): c is number => c != null))).map((id) => ({ id, name: clinicName.get(id) ?? "Clinic" })).sort((a, b) => a.name.localeCompare(b.name)),
    providers: Array.from(providers.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Patient 360: the in-office tests this patient qualifies for and where each stands. */
export async function officeTestingFor(subjectKey: string) {
  const today = localDateStr();
  const p = (await loadEligible()).get(subjectKey);
  const mine = (await recordsFor([subjectKey])).get(subjectKey) ?? [];
  const tests = (p?.tests ?? []).map((t) => ({ ...t, ...officeTestState(mine.filter((r) => r.test === t.test), today) }))
    .map((t) => ({ test: t.test, reasons: t.reasons, state: t.state, lastDone: t.lastDone, scheduledFor: t.scheduledFor, eligibleAgainOn: t.eligibleAgainOn, recordId: t.record?.id ?? null }));
  return {
    tests,
    history: mine.sort((a, b) => b.date.localeCompare(a.date)).map((r) => ({ id: r.id!, test: r.test, label: OFFICE_TEST_LABELS[r.test], status: r.status, date: r.date, note: r.note ?? null })),
  };
}

/** Scheduled (for a date), done (on a date), declined or not needed: one record per test. */
export async function recordOfficeTest(actor: WorkspaceActor, input: { subjectKey: string; tests: OfficeTest[]; status: OfficeTestRecordStatus; date: string; note?: string | null }) {
  const today = localDateStr();
  if (input.status === "done" && input.date > today) throw new WorkspaceError("A test can't be done in the future. Mark it Scheduled instead.");
  if (input.status === "scheduled" && input.date < today) throw new WorkspaceError("Pick today or a later date for the appointment.");
  const entry = (await loadDirectory()).get(input.subjectKey);
  if (!entry) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
  if (actor.clinicIds && !(entry.clinicId != null && actor.clinicIds.includes(entry.clinicId))) throw new WorkspaceError("That patient isn't at your office.", "FORBIDDEN");
  const d = await db();
  for (const test of input.tests) {
    await d.insert(patientTests).values({
      subjectKey: input.subjectKey, patientId: entry.patientId, testKey: test, status: input.status, performedOn: input.date,
      note: input.note?.trim().slice(0, 1000) || null, source: "manual", createdByUserId: actor.id,
    }).onDuplicateKeyUpdate({ set: { note: input.note?.trim().slice(0, 1000) || null, createdByUserId: actor.id } });
  }
  await audit(actor, "update_task", { entityType: "patientTest", entityId: entry.patientId ?? undefined, description: `In-office test ${input.tests.map((t) => OFFICE_TEST_LABELS[t]).join(", ")}: ${input.status} ${input.date}` });
  return { ok: true };
}

/** Undo a mark (e.g. a wrong date). */
export async function undoOfficeTest(actor: WorkspaceActor, id: number) {
  const d = await db();
  const [r] = await d.select().from(patientTests).where(eq(patientTests.id, id)).limit(1);
  if (!r || !(OFFICE_TESTS as readonly string[]).includes(r.testKey)) throw new WorkspaceError("Record not found.", "NOT_FOUND");
  const entry = (await loadDirectory()).get(r.subjectKey);
  if (actor.clinicIds && !(entry?.clinicId != null && actor.clinicIds.includes(entry.clinicId))) throw new WorkspaceError("That patient isn't at your office.", "FORBIDDEN");
  await d.delete(patientTests).where(eq(patientTests.id, id));
  await audit(actor, "update_task", { entityType: "patientTest", description: `Removed in-office test mark (${r.testKey} ${r.status} ${r.performedOn})` });
  return { ok: true };
}

/** One call task per patient to book their tests (front desk at their clinic, unless someone is picked). */
export async function createOfficeTestTasks(actor: WorkspaceActor, input: { items: { subjectKey: string; tests: OfficeTest[] }[]; assigneeId?: number | null }) {
  if (input.items.length > 50) throw new WorkspaceError("At most 50 patients at a time.");
  const eligible = await loadEligible();
  const d = await db();
  let made = 0;
  for (const it of input.items) {
    const p = eligible.get(it.subjectKey);
    if (!p || !it.tests.length) continue;
    const e = p.entry;
    if (actor.clinicIds && !(e.clinicId != null && actor.clinicIds.includes(e.clinicId))) continue;
    const tests = p.tests.filter((t) => it.tests.includes(t.test));
    if (!tests.length) continue;
    const labels = tests.map((t) => OFFICE_TEST_LABELS[t.test]).join(", ");
    const desk = input.assigneeId ? { assignedUserId: input.assigneeId, assignedRole: null } : await frontDeskFor(e.clinicId);
    const t = await createTask(actor, {
      title: `Schedule ${labels} — ${e.name}`.slice(0, 250),
      description: [
        `${e.name} qualifies for in-office testing under the practice's criteria:`,
        ...tests.map((x) => `• ${OFFICE_TEST_LABELS[x.test]}: ${x.reasons.map((r) => r.why).join("; ")}`),
        e.nextVisit ? `They're booked ${new Date(e.nextVisit).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}: the test(s) can be done at that visit if their provider orders it.` : "No appointment booked yet.",
        "Their provider orders each test. When it's booked or done, mark it in the Testing tab.",
      ].join("\n"),
      patientId: e.patientId, subjectKey: e.patientId ? null : e.key, subjectName: e.patientId ? null : e.name, clinicId: e.clinicId,
      assignedUserId: desk.assignedUserId, assignedRole: desk.assignedRole, priority: "normal", category: "patient_call",
      dueDate: localDateStr(), sourceType: "office_test", sourceRef: tests.map((x) => x.test).join(","),
    });
    await d.insert(opportunityActions).values({ patientId: e.patientId, subjectKey: e.key, category: TASK_CATEGORY, action: "task_created", userId: actor.id, taskId: t.id });
    made++;
  }
  return { made };
}

/** IAM-only check: how long each piece of the Testing list takes to build (counts only). */
export async function officeTestingSummary() {
  const steps: Record<string, number> = {};
  let t = Date.now();
  const dir = await loadDirectory(); steps.directory = Date.now() - t;
  const keys = new Set(Array.from(dir.keys()));
  t = Date.now(); const c = await conditionFacts(keys); steps.conditions = Date.now() - t;
  t = Date.now(); const f = await smokingAndBmi(keys); steps.smokingAndBmi = Date.now() - t;
  t = Date.now(); cache = null; const eligible = await loadEligible(); steps.wholeList = Date.now() - t;
  const counts = Object.fromEntries(OFFICE_TESTS.map((x) => [x, 0])) as Record<OfficeTest, number>;
  for (const p of Array.from(eligible.values())) for (const x of p.tests) counts[x.test]++;
  return { steps, sizes: { people: dir.size, withConditions: c.size, withSmoking: f.smoking.size, withBmi: f.bmi.size }, patientsWithAnyTest: eligible.size, eligibleByTest: counts };
}

/** IAM-only check: where "last visit since the start date" comes from (counts and visit-type names only). */
export async function seenSinceBreakdown() {
  const d = await db();
  const since = await getSeenSince();
  const { fhirResources, patients } = await import("../drizzle/schema");
  const { sql: s, and: a, eq: e, gte: g, isNotNull: nn } = await import("drizzle-orm");
  const { loadScheduleSubjects } = await import("./workspaceDb");
  const { SEEN_STATUSES } = await import("../shared/workspace");
  const enc = await d.select({ title: fhirResources.title, status: fhirResources.status, n: s<number>`count(*)`, people: s<number>`count(distinct ${fhirResources.subjectKey})` })
    .from(fhirResources).where(a(e(fhirResources.section, "Encounter"), g(fhirResources.date, since), nn(fhirResources.subjectKey)))
    .groupBy(fhirResources.title, fhirResources.status).orderBy(s`count(*) desc`).limit(25);
  const byDay = await d.select({ day: fhirResources.date, n: s<number>`count(*)` }).from(fhirResources)
    .where(a(e(fhirResources.section, "Encounter"), g(fhirResources.date, since))).groupBy(fhirResources.date).orderBy(fhirResources.date);
  const [pfPeople] = await d.select({ n: s<number>`count(distinct ${fhirResources.subjectKey})` }).from(fhirResources)
    .where(a(e(fhirResources.section, "Encounter"), g(fhirResources.date, since), s`${fhirResources.date} <= ${localDateStr()}`));
  const [roster] = await d.select({ n: s<number>`count(*)` }).from(patients).where(g(patients.lastOfficeVisit, new Date(`${since}T00:00:00Z`)));
  let sched = 0;
  const now = new Date();
  for (const x of Array.from((await loadScheduleSubjects()).values())) if (x.visits.some((v) => v.startsAt <= now && localDateStr(v.startsAt) >= since && SEEN_STATUSES.includes(v.status))) sched++;
  return { since, peopleWithPfEncounterSince: Number(pfPeople?.n ?? 0), rosterLastOfficeVisitSince: Number(roster?.n ?? 0), scheduleSeenSince: sched, encounterTypes: enc.map((r) => ({ title: r.title, status: r.status, n: Number(r.n), people: Number(r.people) })), encountersPerDay: byDay.map((r) => `${r.day}:${r.n}`) };
}

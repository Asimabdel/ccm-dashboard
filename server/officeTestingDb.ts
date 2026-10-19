// The Testing tab: patients seen since the start date (seenSince.ts), or booked, who qualify for the in-office tests
// (ABI-Q, PFT, RMR) under the practice's criteria (shared/officeTests.ts), and where each stands.
// Staff schedule them: a call task, or mark Scheduled / Done / Declined / Not needed. A scheduled day that
// passes with nothing marked done is Missed (a rebook call task is made the next morning). Done tests keep
// the machine's numbers, who did it and the report (in the patient's folder, Test results). The provider
// orders each test; nothing here contacts patients or makes a clinical decision.
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lte, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, clinics, fhirResources, opportunityActions, patientFiles, patientTests, users } from "../drizzle/schema";
import {
  OFFICE_TESTS, OFFICE_TEST_LABELS, OFFICE_TEST_STATES, cleanResults, eligibleTests, isOpenState, officeTestState, recognizeOfficeTest, resultSummary,
  type OfficeTest, type OfficeTestRecord, type OfficeTestRecordStatus, type OfficeTestResults, type OfficeTestState, type Qualifier,
} from "../shared/officeTests";
import { ageOn } from "../shared/testing";
import { SEEN_STATUSES, nameKey } from "../shared/workspace";
import { addDays, isValidDateStr, localDateStr } from "../shared/workforce";
import { conditionFacts, smokingAndBmi } from "./chartFacts";
import { loadDirectory, type DirectoryEntry } from "./directoryDb";
import { WorkspaceError, audit, createTask, frontDeskFor, loadScheduleSubjects, type WorkspaceActor } from "./workspaceDb";
import { getSeenSince } from "./seenSince";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const TASK_CATEGORY = "office_test";
/** "Was it done?" answers, one per patient and visit day: category "office_test_check:YYYY-MM-DD". */
const CHECK_CATEGORY = "office_test_check:";
/** Visits this many days back still count: they're on the Testing list, and "Was it done?" asks about them. */
const RECENT_DAYS = 7;
const pidOf = (key: string) => { const m = /^p:(\d+)$/.exec(key); return m ? Number(m[1]) : null; };
const inClinics = (actor: WorkspaceActor, clinicId: number | null | undefined) => !actor.clinicIds || (clinicId != null && actor.clinicIds.includes(clinicId));

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

const keptVisit = (status: string) => status !== "cancelled" && status !== "no_show";

/** Seen on or after the start date, booked, or on the schedule in the last week (the test can be done at that visit). */
async function buildEligible(since: string): Promise<Map<string, Eligible>> {
  const today = localDateStr();
  const weekAgo = addDays(today, -RECENT_DAYS);
  const recent = new Set<string>();
  for (const s of Array.from((await loadScheduleSubjects()).values())) {
    if (s.visits.some((v) => { const day = localDateStr(v.startsAt); return day >= weekAgo && day <= today && keptVisit(v.status); })) recent.add(s.key);
  }
  const people = Array.from((await loadDirectory()).values()).filter((e) => (e.lastVisit && e.lastVisit >= since) || e.nextVisit || recent.has(e.key));
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

/** One mark on one test, with what was saved alongside it. */
export interface Mark extends OfficeTestRecord {
  id: number;
  key: string;
  test: OfficeTest;
  source: string;
  results: OfficeTestResults | null;
  performedByUserId: number | null;
  fileId: number | null;
  rebookTaskId: number | null;
}

async function recordsFor(keys?: string[]): Promise<Map<string, Mark[]>> {
  const d = await db();
  if (keys && !keys.length) return new Map();
  const rows = await d.select({
    id: patientTests.id, key: patientTests.subjectKey, test: patientTests.testKey, status: patientTests.status, date: patientTests.performedOn, note: patientTests.note,
    source: patientTests.source, results: patientTests.results, performedByUserId: patientTests.performedByUserId, fileId: patientTests.fileId, rebookTaskId: patientTests.rebookTaskId,
  }).from(patientTests).where(keys ? and(inArray(patientTests.testKey, [...OFFICE_TESTS]), inArray(patientTests.subjectKey, keys)) : inArray(patientTests.testKey, [...OFFICE_TESTS]));
  const out = new Map<string, Mark[]>();
  for (const r of rows) {
    const l = out.get(r.key) ?? [];
    l.push({ ...r, test: r.test as OfficeTest, status: r.status as OfficeTestRecordStatus, results: (r.results as OfficeTestResults | null) ?? null });
    out.set(r.key, l);
  }
  return out;
}

/** Where each of a patient's tests stands today, with the mark behind it. */
function statesOf(p: Eligible, mine: Mark[], today: string) {
  return p.tests.map((t) => {
    const s = officeTestState(mine.filter((r) => r.test === t.test), today);
    return { ...t, ...s, mark: s.record as Mark | null };
  });
}

async function userNames(ids: (number | null | undefined)[]): Promise<Map<number, string>> {
  const want = Array.from(new Set(ids.filter((x): x is number => !!x)));
  if (!want.length) return new Map();
  const rows = await (await db()).select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, want));
  return new Map(rows.map((u) => [u.id, u.name ?? "Staff"]));
}

/** What a list row shows about one test. */
function testView(t: ReturnType<typeof statesOf>[number], names: Map<number, string>) {
  const m = t.mark;
  return {
    test: t.test, reasons: t.reasons, state: t.state, lastDone: t.lastDone, scheduledFor: t.scheduledFor, eligibleAgainOn: t.eligibleAgainOn,
    recordId: m?.id ?? null, source: m?.source ?? null,
    results: t.state === "done" && m ? resultSummary(t.test, m.results) : null,
    performedBy: t.state === "done" && m?.performedByUserId ? names.get(m.performedByUserId) ?? null : null,
    resultValues: t.state === "done" ? m?.results ?? null : null,
    performedByUserId: t.state === "done" ? m?.performedByUserId ?? null : null,
    fileId: t.state === "done" ? m?.fileId ?? null : null,
    rebookTaskId: t.state === "missed" ? m?.rebookTaskId ?? null : null,
  };
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

const emptyCounts = () => Object.fromEntries(OFFICE_TEST_STATES.map((s) => [s, 0])) as Record<OfficeTestState, number>;

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
  const all = Array.from(eligible.values()).filter((p) => inClinics(actor, p.entry.clinicId));
  const counts = Object.fromEntries(OFFICE_TESTS.map((t) => [t, emptyCounts()])) as Record<OfficeTest, Record<OfficeTestState, number>>;
  // With "all tests": how many patients have at least one test in each state.
  const patientCounts = emptyCounts();
  const picked: { p: Eligible; tests: ReturnType<typeof statesOf>; shown: ReturnType<typeof statesOf> }[] = [];
  for (const p of all) {
    const e = p.entry;
    const tests = statesOf(p, records.get(e.key) ?? [], today);
    const inFilters = (!f.clinicId || e.clinicId === f.clinicId) && (!f.providerId || e.providerId === f.providerId)
      && (!until || (e.nextVisit != null && e.nextVisit.slice(0, 10) <= until))
      && (!words.length || words.every((w) => e.nameKey.includes(w)));
    if (!inFilters) continue;
    for (const t of tests) counts[t.test][t.state]++;
    for (const st of Array.from(new Set(tests.map((t) => t.state)))) patientCounts[st]++;
    const shown = tests.filter((t) => t.state === f.state && (!f.test || t.test === f.test));
    if (shown.length) picked.push({ p, tests, shown });
  }
  // Missed: the longest-missed first. Otherwise: coming in soonest first (the test can be done at that visit), then by name.
  const missedOn = (x: (typeof picked)[number]) => x.shown.map((t) => t.scheduledFor ?? "~").sort()[0] ?? "~";
  picked.sort((a, b) => (f.state === "missed" ? missedOn(a).localeCompare(missedOn(b)) : 0)
    || (a.p.entry.nextVisit ?? "~").localeCompare(b.p.entry.nextVisit ?? "~") || a.p.entry.name.localeCompare(b.p.entry.name));
  const page = Math.max(1, f.page);
  const slice = picked.slice((page - 1) * PAGE, page * PAGE);
  const names = await userNames(slice.flatMap((x) => x.tests.map((t) => t.mark?.performedByUserId)));
  const rows = slice.map(({ p: { entry: e, age }, tests, shown }) => ({
    key: e.key, patientId: e.patientId, name: e.name, dob: e.dob, age, phone: e.phone,
    clinicId: e.clinicId, clinicName: e.clinicId ? clinicName.get(e.clinicId) ?? null : null, providerName: e.providerName,
    lastVisit: e.lastVisit, nextVisit: e.nextVisit, taskMadeAt: tasks.get(e.key) ?? null,
    tests: tests.map((t) => ({ ...testView(t, names), shown: shown.some((s) => s.test === t.test) })),
  }));
  const providers = new Map<number, string>();
  for (const p of all) if (p.entry.providerId && p.entry.providerName) providers.set(p.entry.providerId, p.entry.providerName);
  return {
    rows,
    total: picked.length,
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
  const names = await userNames(mine.map((r) => r.performedByUserId));
  const tests = p ? statesOf(p, mine, today).map((t) => testView(t, names)) : [];
  return {
    tests,
    history: mine.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).map((r) => ({
      id: r.id, test: r.test, label: OFFICE_TEST_LABELS[r.test], status: r.status, date: r.date, note: r.note ?? null, source: r.source,
      results: resultSummary(r.test, r.results), resultValues: r.results, performedByUserId: r.performedByUserId,
      performedBy: r.performedByUserId ? names.get(r.performedByUserId) ?? null : null, fileId: r.fileId,
    })),
  };
}

const asWorkspaceError = <T>(fn: () => T): T => {
  try { return fn(); } catch (e) { throw new WorkspaceError((e as Error).message); }
};

async function assertPerformer(id: number | null | undefined) {
  if (!id) return;
  const [u] = await (await db()).select({ id: users.id, role: users.role }).from(users).where(eq(users.id, id)).limit(1);
  if (!u || u.role === "user") throw new WorkspaceError("Pick who performed the test from the staff list.");
}

/** A report in the patient's folder (Test results) that this mark can point to. */
async function assertReport(subjectKey: string, fileId: number) {
  const [f] = await (await db()).select({ subjectKey: patientFiles.subjectKey, patientId: patientFiles.patientId, fileType: patientFiles.fileType, status: patientFiles.status, removedAt: patientFiles.removedAt })
    .from(patientFiles).where(eq(patientFiles.id, fileId)).limit(1);
  const pid = pidOf(subjectKey);
  if (!f || f.status !== "ready" || f.removedAt || f.fileType !== "test_result" || !(f.subjectKey === subjectKey || (pid && f.patientId === pid))) {
    throw new WorkspaceError("That report wasn't found in this patient's folder.");
  }
}

/**
 * Scheduled (for a date), done (on a date), declined or not needed: one record per test. A done test can
 * carry the machine's numbers and who performed it; the report is attached after it's uploaded.
 */
export async function recordOfficeTest(actor: WorkspaceActor, input: {
  subjectKey: string; tests: OfficeTest[]; status: OfficeTestRecordStatus; date: string; note?: string | null;
  results?: Partial<Record<OfficeTest, Record<string, unknown> | null>> | null; performedByUserId?: number | null;
}) {
  const today = localDateStr();
  if (input.status === "done" && input.date > today) throw new WorkspaceError("A test can't be done in the future. Mark it Scheduled instead.");
  if (input.status === "scheduled" && input.date < today) throw new WorkspaceError("Pick today or a later date for the appointment.");
  const entry = (await loadDirectory()).get(input.subjectKey);
  if (!entry) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
  if (!inClinics(actor, entry.clinicId)) throw new WorkspaceError("That patient isn't at your office.", "FORBIDDEN");
  const done = input.status === "done";
  const performedByUserId = done ? input.performedByUserId ?? actor.id : null;
  if (done) await assertPerformer(performedByUserId);
  const note = input.note?.trim().slice(0, 1000) || null;
  const d = await db();
  const ids: Partial<Record<OfficeTest, number>> = {};
  for (const test of input.tests) {
    const results = done ? asWorkspaceError(() => cleanResults(test, input.results?.[test] ?? null)) : null;
    await d.insert(patientTests).values({
      subjectKey: input.subjectKey, patientId: entry.patientId, testKey: test, status: input.status, performedOn: input.date,
      note, source: "manual", createdByUserId: actor.id, results, performedByUserId,
    }).onDuplicateKeyUpdate({ set: { note, createdByUserId: actor.id, ...(done ? { performedByUserId, ...(results ? { results } : {}) } : {}) } });
    const [row] = await d.select({ id: patientTests.id }).from(patientTests)
      .where(and(eq(patientTests.subjectKey, input.subjectKey), eq(patientTests.testKey, test), eq(patientTests.performedOn, input.date), eq(patientTests.status, input.status))).limit(1);
    if (row) ids[test] = row.id;
  }
  await audit(actor, "update_task", { entityType: "patientTest", entityId: entry.patientId ?? undefined, description: `In-office test ${input.tests.map((t) => OFFICE_TEST_LABELS[t]).join(", ")}: ${input.status} ${input.date}` });
  return { ok: true, ids };
}

/** A done test: add or correct the numbers, who did it, or the report (in the patient's folder). */
export async function saveOfficeTestDetails(actor: WorkspaceActor, input: { id: number; results?: Record<string, unknown> | null; performedByUserId?: number | null; fileId?: number | null; note?: string | null }) {
  const d = await db();
  const [r] = await d.select().from(patientTests).where(eq(patientTests.id, input.id)).limit(1);
  if (!r || !(OFFICE_TESTS as readonly string[]).includes(r.testKey)) throw new WorkspaceError("Record not found.", "NOT_FOUND");
  if (r.status !== "done") throw new WorkspaceError("Results go on a test that was done.");
  const entry = (await loadDirectory()).get(r.subjectKey);
  if (!inClinics(actor, entry?.clinicId)) throw new WorkspaceError("That patient isn't at your office.", "FORBIDDEN");
  const set: Partial<typeof patientTests.$inferInsert> = {};
  if (input.results !== undefined) set.results = asWorkspaceError(() => cleanResults(r.testKey as OfficeTest, input.results));
  if (input.performedByUserId !== undefined) { await assertPerformer(input.performedByUserId); set.performedByUserId = input.performedByUserId; }
  if (input.fileId !== undefined) { if (input.fileId) await assertReport(r.subjectKey, input.fileId); set.fileId = input.fileId; }
  if (input.note !== undefined) set.note = input.note?.trim().slice(0, 1000) || null;
  if (!Object.keys(set).length) return { ok: true };
  await d.update(patientTests).set(set).where(eq(patientTests.id, r.id));
  await audit(actor, "update_task", { entityType: "patientTest", entityId: r.patientId ?? undefined, description: `In-office test ${OFFICE_TEST_LABELS[r.testKey as OfficeTest]} ${r.performedOn}: ${Object.keys(set).join(", ")} saved` });
  return { ok: true };
}

/** Undo a mark (e.g. a wrong date). Tests that came from the Practice Fusion chart stay. */
export async function undoOfficeTest(actor: WorkspaceActor, id: number) {
  const d = await db();
  const [r] = await d.select().from(patientTests).where(eq(patientTests.id, id)).limit(1);
  if (!r || !(OFFICE_TESTS as readonly string[]).includes(r.testKey)) throw new WorkspaceError("Record not found.", "NOT_FOUND");
  if (r.source === "import") throw new WorkspaceError("This test came from the Practice Fusion chart. Correct it there; it updates here with the next chart sync.");
  const entry = (await loadDirectory()).get(r.subjectKey);
  if (!inClinics(actor, entry?.clinicId)) throw new WorkspaceError("That patient isn't at your office.", "FORBIDDEN");
  await d.delete(patientTests).where(eq(patientTests.id, id));
  await audit(actor, "update_task", { entityType: "patientTest", description: `Removed in-office test mark (${r.testKey} ${r.status} ${r.performedOn})` });
  return { ok: true };
}

/** One call task per patient to book (or rebook) their tests: front desk at their clinic, unless someone is picked. */
export async function createOfficeTestTasks(actor: WorkspaceActor, input: { items: { subjectKey: string; tests: OfficeTest[] }[]; assigneeId?: number | null }) {
  if (input.items.length > 50) throw new WorkspaceError("At most 50 patients at a time.");
  const eligible = await loadEligible();
  const records = await recordsFor(input.items.map((i) => i.subjectKey));
  const today = localDateStr();
  let made = 0;
  for (const it of input.items) {
    const p = eligible.get(it.subjectKey);
    if (!p || !it.tests.length) continue;
    if (!inClinics(actor, p.entry.clinicId)) continue;
    const tests = statesOf(p, records.get(it.subjectKey) ?? [], today).filter((t) => it.tests.includes(t.test));
    if (!tests.length) continue;
    await makeCallTask(actor, p, tests, input.assigneeId ?? null);
    made++;
  }
  return { made };
}

async function makeCallTask(actor: WorkspaceActor, p: Eligible, tests: ReturnType<typeof statesOf>, assigneeId: number | null) {
  const e = p.entry;
  const missed = tests.filter((t) => t.state === "missed");
  const labels = tests.map((t) => OFFICE_TEST_LABELS[t.test]).join(", ");
  const desk = assigneeId ? { assignedUserId: assigneeId, assignedRole: null } : await frontDeskFor(e.clinicId);
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  const t = await createTask(actor, {
    title: `${missed.length === tests.length ? "Rebook" : "Schedule"} ${labels} — ${e.name}`.slice(0, 250),
    description: [
      missed.length ? `Missed: ${missed.map((x) => `${OFFICE_TEST_LABELS[x.test]} (booked ${day(x.scheduledFor!)})`).join(", ")}. Nothing was marked done that day.` : null,
      `${e.name} qualifies for in-office testing under the practice's criteria:`,
      ...tests.map((x) => `• ${OFFICE_TEST_LABELS[x.test]}: ${x.reasons.map((r) => r.why).join("; ")}`),
      e.nextVisit ? `They're booked ${when(e.nextVisit)}: the test(s) can be done at that visit if their provider orders it.` : "No appointment booked yet.",
      "Their provider orders each test. When it's booked or done, mark it in the Testing tab.",
    ].filter(Boolean).join("\n"),
    patientId: e.patientId, subjectKey: e.patientId ? null : e.key, subjectName: e.patientId ? null : e.name, clinicId: e.clinicId,
    assignedUserId: desk.assignedUserId, assignedRole: desk.assignedRole, priority: missed.length ? "high" : "normal", category: "patient_call",
    dueDate: localDateStr(), sourceType: "office_test", sourceRef: tests.map((x) => x.test).join(","),
  });
  const d = await db();
  await d.insert(opportunityActions).values({ patientId: e.patientId, subjectKey: e.key, category: TASK_CATEGORY, action: "task_created", userId: actor.id, taskId: t.id });
  const rebooked = missed.map((x) => x.mark?.id).filter((x): x is number => !!x);
  if (rebooked.length) await d.update(patientTests).set({ rebookTaskId: t.id }).where(inArray(patientTests.id, rebooked));
  return t.id;
}

// ---------------------------------------------------------------------------
// The visit day: who's on the schedule with a test due (Patient Flow badges, Testing → Today),
// and "Was it done?" for visits in the last week
// ---------------------------------------------------------------------------

interface DayVisit { key: string; startsAt: Date; status: string; providerName: string | null; clinicId: number | null }

/** Each person's first kept visit on each day in the range. */
async function visitsBetween(from: string, to: string): Promise<DayVisit[]> {
  const out: DayVisit[] = [];
  for (const s of Array.from((await loadScheduleSubjects()).values())) {
    const days = new Map<string, DayVisit>();
    for (const v of s.visits) {
      const day = localDateStr(v.startsAt);
      if (day < from || day > to || !keptVisit(v.status)) continue;
      const had = days.get(day);
      // A visit they came to wins over one still on the books; else the earliest.
      const seen = (x: { status: string }) => SEEN_STATUSES.includes(x.status);
      if (!had || (seen(v) && !seen(had)) || (seen(v) === seen(had) && v.startsAt < had.startsAt)) days.set(day, { key: s.key, startsAt: v.startsAt, status: v.status, providerName: v.providerName ?? s.providerName, clinicId: v.clinicId ?? s.clinicId });
    }
    out.push(...Array.from(days.values()));
  }
  return out;
}

async function answeredChecks(from: string, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await (await db()).select({ key: opportunityActions.subjectKey, category: opportunityActions.category }).from(opportunityActions)
    .where(and(like(opportunityActions.category, `${CHECK_CATEGORY}%`), inArray(opportunityActions.subjectKey, keys), gte(opportunityActions.createdAt, new Date(`${addDays(from, -1)}T00:00:00Z`))));
  return new Set(rows.map((r) => `${r.key}|${r.category.slice(CHECK_CATEGORY.length)}`));
}

async function dayRows(actor: WorkspaceActor, visits: DayVisit[], opts: { onlyUnanswered?: boolean } = {}) {
  const today = localDateStr();
  const eligible = await loadEligible();
  const mine = visits.filter((v) => eligible.has(v.key) && inClinics(actor, v.clinicId ?? eligible.get(v.key)!.entry.clinicId));
  const keys = Array.from(new Set(mine.map((v) => v.key)));
  const [records, clinicRows] = await Promise.all([recordsFor(keys), (await db()).select({ id: clinics.id, name: clinics.name }).from(clinics)]);
  const clinicName = new Map(clinicRows.map((c) => [c.id, c.name]));
  const from = visits.reduce((m, v) => (localDateStr(v.startsAt) < m ? localDateStr(v.startsAt) : m), today);
  const answered = await answeredChecks(from, keys);
  const names = await userNames(Array.from(records.values()).flat().map((r) => r.performedByUserId));
  const rows = [];
  for (const v of mine) {
    const p = eligible.get(v.key)!;
    const day = localDateStr(v.startsAt);
    const marks = records.get(v.key) ?? [];
    const tests = statesOf(p, marks, today);
    // To do at this visit: still open, and not booked for a later day.
    const open = tests.filter((t) => isOpenState(t.state) && !(t.state === "scheduled" && t.scheduledFor! > day));
    const doneThatDay = marks.filter((r) => r.status === "done" && r.date === day).map((r) => r.test);
    const notDone = answered.has(`${v.key}|${day}`);
    if (!open.length && !doneThatDay.length) continue;
    if (opts.onlyUnanswered && (notDone || !open.length)) continue;
    const e = p.entry;
    rows.push({
      key: e.key, patientId: e.patientId, name: e.name, dob: e.dob, age: p.age, phone: e.phone,
      day, startsAt: v.startsAt.toISOString(), visitStatus: v.status, providerName: v.providerName ?? e.providerName,
      clinicId: v.clinicId ?? e.clinicId, clinicName: (v.clinicId ?? e.clinicId) ? clinicName.get((v.clinicId ?? e.clinicId)!) ?? null : null,
      due: open.map((t) => t.test), doneThatDay, notDone,
      tests: tests.map((t) => testView(t, names)),
    });
  }
  return rows;
}

/** Everyone on the schedule that day who has an ABI-Q / PFT / RMR to do (or done that day). */
export async function officeTestsDay(actor: WorkspaceActor, input: { date: string }) {
  if (!isValidDateStr(input.date)) throw new WorkspaceError("Pick a date.");
  const rows = await dayRows(actor, await visitsBetween(input.date, input.date));
  rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.name.localeCompare(b.name));
  return { date: input.date, rows };
}

/** Patient Flow: the tests due for the people on the board that day (subject key → tests). */
export async function officeTestBadges(actor: WorkspaceActor, input: { date: string }) {
  const { rows } = await officeTestsDay(actor, input);
  return Object.fromEntries(rows.map((r) => [r.key, { due: r.due, doneThatDay: r.doneThatDay, scheduledToday: r.tests.filter((t) => t.state === "scheduled" && t.scheduledFor === input.date).map((t) => t.test) }]));
}

/** Seen in the last week with a test still open and no answer yet: was it done at that visit? */
export async function officeTestChecks(actor: WorkspaceActor) {
  const today = localDateStr();
  const visits = (await visitsBetween(addDays(today, -RECENT_DAYS), today))
    // Today's only once they've finished the visit.
    .filter((v) => SEEN_STATUSES.includes(v.status) && (localDateStr(v.startsAt) < today || v.status === "checkout" || v.status === "completed"));
  const rows = await dayRows(actor, visits, { onlyUnanswered: true });
  rows.sort((a, b) => b.day.localeCompare(a.day) || a.startsAt.localeCompare(b.startsAt));
  return { rows, days: RECENT_DAYS };
}

/** "Not done at that visit": stops asking about it (the tests stay on the list to book). */
export async function answerOfficeTestChecks(actor: WorkspaceActor, input: { items: { subjectKey: string; date: string }[] }) {
  if (input.items.length > 100) throw new WorkspaceError("At most 100 at a time.");
  const directory = await loadDirectory();
  const rows: (typeof opportunityActions.$inferInsert)[] = [];
  for (const it of input.items) {
    if (!isValidDateStr(it.date)) continue;
    const e = directory.get(it.subjectKey);
    if (!e || !inClinics(actor, e.clinicId)) continue;
    rows.push({ patientId: e.patientId, subjectKey: e.key, category: `${CHECK_CATEGORY}${it.date}`, action: "dismissed", userId: actor.id });
  }
  if (rows.length) await (await db()).insert(opportunityActions).values(rows);
  return { count: rows.length };
}

// ---------------------------------------------------------------------------
// Monthly report: per clinic and provider — booked, done, missed, declined, and still due now
// ---------------------------------------------------------------------------

type Tally = Record<OfficeTest, { booked: number; done: number; missed: number; declined: number; dueNow: number }>;
const emptyTally = (): Tally => Object.fromEntries(OFFICE_TESTS.map((t) => [t, { booked: 0, done: 0, missed: 0, declined: 0, dueNow: 0 }])) as Tally;

export async function officeTestingReport(actor: WorkspaceActor, input: { month: string; clinicId?: number | null }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw new WorkspaceError("Pick a month.");
  const today = localDateStr();
  const first = `${input.month}-01`;
  const last = `${input.month}-31`;
  const d = await db();
  const [directory, subjects, eligible, all, clinicRows] = await Promise.all([
    loadDirectory(), loadScheduleSubjects(), loadEligible(), recordsFor(), d.select({ id: clinics.id, name: clinics.name }).from(clinics),
  ]);
  const clinicName = new Map(clinicRows.map((c) => [c.id, c.name]));
  /** Where a test counts: the visit that day (provider and clinic), else the patient's own provider and clinic. */
  const placeOf = (key: string, day: string | null) => {
    const v = day ? subjects.get(key)?.visits.find((x) => localDateStr(x.startsAt) === day && keptVisit(x.status)) : undefined;
    const e = directory.get(key);
    return { clinicId: v?.clinicId ?? e?.clinicId ?? null, provider: v?.providerName ?? e?.providerName ?? "No provider" };
  };
  const totals = emptyTally();
  const byClinic = new Map<string, Tally>();
  const byProvider = new Map<string, Tally>();
  const byStaff = new Map<string, Record<OfficeTest, number>>();
  let fromChart = 0;
  let withReport = 0;
  let withResults = 0;
  const add = (key: string, day: string | null, test: OfficeTest, field: keyof Tally[OfficeTest]) => {
    const at = placeOf(key, day);
    if (actor.clinicIds && !(at.clinicId != null && actor.clinicIds.includes(at.clinicId))) return false;
    if (input.clinicId && at.clinicId !== input.clinicId) return false;
    const cName = at.clinicId ? clinicName.get(at.clinicId) ?? "Clinic" : "No clinic";
    for (const [m, k] of [[byClinic, cName], [byProvider, at.provider]] as const) {
      const t = m.get(k) ?? emptyTally();
      t[test][field]++;
      m.set(k, t);
    }
    totals[test][field]++;
    return true;
  };
  const performers = await userNames(Array.from(all.values()).flat().map((r) => r.performedByUserId));
  for (const [key, marks] of Array.from(all.entries())) {
    for (const r of marks) {
      if (r.date < first || r.date > last) continue;
      if (r.status === "done") {
        if (!add(key, r.date, r.test, "done")) continue;
        if (r.source === "import") fromChart++;
        if (r.fileId) withReport++;
        if (r.results) withResults++;
        const who = r.performedByUserId ? performers.get(r.performedByUserId) ?? "Staff" : r.source === "import" ? "From Practice Fusion" : "Not recorded";
        const s = byStaff.get(who) ?? (Object.fromEntries(OFFICE_TESTS.map((t) => [t, 0])) as Record<OfficeTest, number>);
        s[r.test]++;
        byStaff.set(who, s);
      } else if (r.status === "scheduled") {
        add(key, null, r.test, "booked");
        // Missed: that day passed and the test hasn't been done since.
        if (r.date < today && !marks.some((x) => x.test === r.test && x.status === "done" && x.date >= r.date)) add(key, null, r.test, "missed");
      } else if (r.status === "declined") {
        add(key, null, r.test, "declined");
      }
    }
  }
  // Still due now (eligible or missed today), on the patient's own provider and clinic.
  for (const p of Array.from(eligible.values())) {
    for (const t of statesOf(p, all.get(p.entry.key) ?? [], today)) if (t.state === "eligible" || t.state === "missed") add(p.entry.key, null, t.test, "dueNow");
  }
  const list = (m: Map<string, Tally>) => Array.from(m.entries()).map(([name, tally]) => ({ name, tally })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    month: input.month, totals, fromChart, withReport, withResults,
    byClinic: list(byClinic), byProvider: list(byProvider),
    byStaff: Array.from(byStaff.entries()).map(([name, done]) => ({ name, done })).sort((a, b) => a.name.localeCompare(b.name)),
    clinics: actor.clinicIds ? clinicRows.filter((c) => actor.clinicIds!.includes(c.id)) : clinicRows,
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Who automatic actions are recorded under (the first admin, named for what it is). */
async function systemActor(): Promise<WorkspaceActor> {
  const [a] = await (await db()).select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  if (!a) throw new Error("No admin user to record automatic tasks under.");
  return { id: a.id, name: "Testing (automatic)", role: "admin", clinicIds: null };
}

/** Rebook call tasks look back this many days: older misses are on the Missed list to call by hand. */
const REBOOK_LOOKBACK_DAYS = 3;

/**
 * Each morning (dailyRebookTick): a scheduled ABI-Q / PFT / RMR whose day has passed with nothing marked done gets one rebook call
 * task per patient (front desk at their clinic). Dry run unless apply; counts only.
 */
export async function rebookMissedOfficeTests(opts: { apply: boolean; lookbackDays?: number }) {
  const today = localDateStr();
  const from = addDays(today, -(opts.lookbackDays ?? REBOOK_LOOKBACK_DAYS));
  const d = await db();
  const due = await d.select({ key: patientTests.subjectKey }).from(patientTests)
    .where(and(inArray(patientTests.testKey, [...OFFICE_TESTS]), eq(patientTests.status, "scheduled"), gte(patientTests.performedOn, from), lte(patientTests.performedOn, addDays(today, -1)), isNull(patientTests.rebookTaskId)));
  const keys = Array.from(new Set(due.map((r) => r.key)));
  const stats = { checked: keys.length, missedPatients: 0, missedTests: 0, tasks: 0, notOnList: 0 };
  if (!keys.length) return { ...stats, apply: opts.apply };
  const [eligible, records] = await Promise.all([loadEligible(), recordsFor(keys)]);
  const actor = opts.apply ? await systemActor() : null;
  for (const key of keys) {
    const p = eligible.get(key);
    if (!p) { stats.notOnList++; continue; }
    const missed = statesOf(p, records.get(key) ?? [], today).filter((t) => t.state === "missed" && t.mark && !t.mark.rebookTaskId && t.scheduledFor! >= from);
    if (!missed.length) continue;
    stats.missedPatients++;
    stats.missedTests += missed.length;
    if (actor && stats.tasks < 100) { await makeCallTask(actor, p, missed, null); stats.tasks++; }
  }
  return { ...stats, apply: opts.apply };
}

const REBOOK_STATE_KEY = "office_test_rebook";

/**
 * Once a day from 6 AM (clinic time), on a quiet chart-sync tick: the rebook call tasks above. The day is saved
 * only after a run finishes, so a run cut off by the time limit is tried again on the next tick.
 */
export async function dailyRebookTick() {
  const today = localDateStr();
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }));
  if (hour < 6) return null;
  const d = await db();
  const [row] = await d.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, REBOOK_STATE_KEY)).limit(1);
  if ((row?.value as { day?: string } | undefined)?.day === today) return null;
  const out = await rebookMissedOfficeTests({ apply: true });
  const value = { day: today, at: new Date().toISOString(), tasks: out.tasks, missedTests: out.missedTests };
  await d.insert(appSettings).values({ key: REBOOK_STATE_KEY, value }).onDuplicateKeyUpdate({ set: { value } });
  return out;
}

const CHART_TEST_TYPES = ["Procedure", "DiagnosticReport", "Observation"];
/** A first cut in SQL (the chart copy is large); recognizeOfficeTest decides. */
const CHART_TEST_LIKE = ["%brachial%", "%ABI%", "%spirom%", "%pulmonary function%", "%PFT%", "%FEV%", "%FVC%", "%vital capacity%", "%flow%volume%", "%lung function%", "%metabolic rate%", "%calorimetr%", "%RMR%", "%energy expenditure%"];

/**
 * ABI-Q / PFT / RMR already in the Practice Fusion chart copy → done tests (so nobody is booked twice). Dry run
 * unless apply. Counts and test NAMES only (never patient data). New chart data is picked up by the sync itself.
 */
export async function officeTestsFromChart(opts: { apply: boolean }) {
  const d = await db();
  const today = localDateStr();
  const rows = await d.select({ key: fhirResources.subjectKey, type: fhirResources.resourceType, section: fhirResources.section, title: fhirResources.title, code: fhirResources.code, status: fhirResources.status, date: fhirResources.date })
    .from(fhirResources)
    .where(and(inArray(fhirResources.resourceType, CHART_TEST_TYPES), isNotNull(fhirResources.subjectKey), isNotNull(fhirResources.date),
      or(...CHART_TEST_LIKE.map((p) => like(fhirResources.title, p)), like(fhirResources.code, "cpt|939%"), like(fhirResources.code, "cpt|94%"))));
  const names = new Map<string, { test: OfficeTest | null; section: string; n: number }>();
  const found: (typeof patientTests.$inferInsert)[] = [];
  const people = new Set<string>();
  for (const r of rows) {
    const test = recognizeOfficeTest({ title: r.title, code: r.code, status: r.status });
    const label = `${r.title ?? "(no name)"}${r.code ? ` [${r.code}]` : ""}`.slice(0, 120);
    const n = names.get(label) ?? { test, section: r.section ?? r.type, n: 0 };
    n.n++;
    names.set(label, n);
    if (!test || !r.key || !r.date || r.date > today) continue;
    people.add(r.key);
    found.push({ subjectKey: r.key, patientId: pidOf(r.key), testKey: test, performedOn: r.date, status: "done", source: "import" });
  }
  const byTest = Object.fromEntries(OFFICE_TESTS.map((t) => [t, found.filter((f) => f.testKey === t).length])) as Record<OfficeTest, number>;
  let added = 0;
  if (opts.apply) {
    for (let i = 0; i < found.length; i += 400) {
      const chunk = found.slice(i, i + 400);
      const res = await d.insert(patientTests).ignore().values(chunk);
      added += Number((res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
    }
  }
  const [already] = await d.select({ n: sql<number>`count(*)` }).from(patientTests).where(and(inArray(patientTests.testKey, [...OFFICE_TESTS]), eq(patientTests.source, "import")));
  return {
    apply: opts.apply, chartRowsLookedAt: rows.length, testsFound: found.length, patients: people.size, byTest, added, importedOnFile: Number(already?.n ?? 0),
    names: Array.from(names.entries()).sort((a, b) => b[1].n - a[1].n).slice(0, 40).map(([name, v]) => ({ name, section: v.section, test: v.test, n: v.n })),
  };
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
  const records = await recordsFor();
  const today = localDateStr();
  const states = Object.fromEntries(OFFICE_TESTS.map((x) => [x, emptyCounts()])) as Record<OfficeTest, Record<OfficeTestState, number>>;
  for (const p of Array.from(eligible.values())) for (const s of statesOf(p, records.get(p.entry.key) ?? [], today)) states[s.test][s.state]++;
  return { steps, sizes: { people: dir.size, withConditions: c.size, withSmoking: f.smoking.size, withBmi: f.bmi.size }, patientsWithAnyTest: eligible.size, eligibleByTest: counts, states };
}

/** IAM-only check: where "last visit since the start date" comes from (counts and visit-type names only). */
export async function seenSinceBreakdown() {
  const d = await db();
  const since = await getSeenSince();
  const { patients } = await import("../drizzle/schema");
  const { sql: s, and: a, eq: e, gte: g, isNotNull: nn } = await import("drizzle-orm");
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

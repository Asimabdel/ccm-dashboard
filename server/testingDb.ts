// Testing & screenings: which tests each active patient is due for (shared/testing.ts rules),
// what they've had (Practice Fusion imports + staff entries), and scheduling tasks for the
// ones who are due. Reminders for the care team only — the provider decides what to order.
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { emailContacts, opportunityActions, patientTests, personDemographics } from "../drizzle/schema";
import {
  TESTS, TEST_KEYS, ageOn, evaluateTesting, isMedicare, parseSex, recognizeTest,
  type Sex, type TestKey, type TestRecord, type TestState, type TestStatus,
} from "../shared/testing";
import { parseFromHeader } from "../shared/email";
import { nameKey, nextClinicDay, parseCsvRows, parseDateValue } from "../shared/workspace";
import { localDateStr } from "../shared/workforce";
import {
  WorkspaceError, audit, buildNameDobIndex, careTeamAssignee, createTask, loadPeople, subjectCare, type Person, type WorkspaceActor,
} from "./workspaceDb";

const ACTION_CATEGORY = "testing_due";
const LIST_LIMIT = 1000;

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

async function loadRecords(keys?: string[]) {
  const d = await db();
  const rows = keys?.length
    ? await d.select().from(patientTests).where(inArray(patientTests.subjectKey, keys))
    : await d.select().from(patientTests);
  const by = new Map<string, (TestRecord & { id: number; note: string | null; createdAt: Date })[]>();
  for (const r of rows) {
    if (!(TEST_KEYS as string[]).includes(r.testKey)) continue;
    const list = by.get(r.subjectKey) ?? [];
    list.push({ id: r.id, testKey: r.testKey as TestKey, performedOn: r.performedOn, status: r.status, method: r.method, result: r.result, source: r.source, note: r.note, createdAt: r.createdAt });
    by.set(r.subjectKey, list);
  }
  return by;
}

async function loadSexes(keys?: string[]) {
  const d = await db();
  const rows = keys?.length
    ? await d.select().from(personDemographics).where(inArray(personDemographics.subjectKey, keys))
    : await d.select().from(personDemographics);
  return new Map(rows.map((r) => [r.subjectKey, r.sex]));
}

function evaluatePerson(p: Person, sex: Sex | null, records: TestRecord[], today: string): TestStatus[] {
  return evaluateTesting({ age: ageOn(p.dob, today), sex, conditions: p.conditions, medicare: isMedicare(p.insurance) }, records, today);
}

const ACTIONABLE: TestState[] = ["due", "no_record", "due_soon", "needs_info"];

/** The Testing due list: everyone with at least one test in the chosen states. */
export async function testingOverview(actor: WorkspaceActor, input: { clinicId?: number | null; test?: TestKey | null; states: TestState[]; upcomingDays?: number | null; includeActioned: boolean }) {
  const d = await db();
  const today = localDateStr();
  const [people, records, sexes] = await Promise.all([loadPeople(actor, input.clinicId), loadRecords(), loadSexes()]);
  const acted = await d.select({ subjectKey: opportunityActions.subjectKey, action: opportunityActions.action, createdAt: opportunityActions.createdAt })
    .from(opportunityActions)
    .where(and(eq(opportunityActions.category, ACTION_CATEGORY), gte(opportunityActions.createdAt, new Date(Date.now() - 30 * 86_400_000))))
    .orderBy(desc(opportunityActions.createdAt));
  const actedBy = new Map<string, (typeof acted)[number]>();
  for (const a of acted) if (a.subjectKey && !actedBy.has(a.subjectKey)) actedBy.set(a.subjectKey, a);

  const counts = Object.fromEntries(TEST_KEYS.map((k) => [k, { due: 0, due_soon: 0, no_record: 0, needs_info: 0, current: 0 }])) as Record<TestKey, Record<"due" | "due_soon" | "no_record" | "needs_info" | "current", number>>;
  const soon = input.upcomingDays != null ? Date.now() + input.upcomingDays * 86_400_000 : null;
  const rows = [];
  let unknownSex = 0;
  for (const p of people) {
    const sex = (sexes.get(p.key) as Sex | undefined) ?? null;
    if (!sex) unknownSex++;
    const statuses = evaluatePerson(p, sex, records.get(p.key) ?? [], today);
    for (const s of statuses) if (s.state in counts[s.key]) counts[s.key][s.state as keyof (typeof counts)[TestKey]]++;
    const hits = statuses.filter((s) => input.states.includes(s.state) && (!input.test || s.key === input.test));
    if (!hits.length) continue;
    if (soon && (!p.nextVisit || p.nextVisit.getTime() > soon)) continue;
    const a = actedBy.get(p.key);
    if (a && !input.includeActioned) continue;
    rows.push({
      key: p.key, patientId: p.patientId, name: p.name, dob: p.dob, age: ageOn(p.dob, today), sex, phone: p.phone,
      clinicName: p.clinicName, providerName: p.providerName, lastSeen: p.lastSeen, nextVisit: p.nextVisit,
      tests: hits.map((h) => ({ key: h.key, label: h.label, state: h.state, dueOn: h.dueOn, lastDone: h.lastDone?.date ?? null })),
      dueCount: hits.filter((h) => h.state === "due").length,
      lastAction: a?.action ?? null, lastActionAt: a?.createdAt ?? null,
    });
  }
  // Truly due first, then whoever is coming in soonest (tests can be done at that visit), then name.
  rows.sort((a, b) => b.dueCount - a.dueCount || (a.nextVisit?.getTime() ?? Infinity) - (b.nextVisit?.getTime() ?? Infinity) || a.name.localeCompare(b.name));
  const [recordCount] = await d.select({ id: patientTests.id }).from(patientTests).where(eq(patientTests.source, "import")).limit(1);
  return { people: people.length, unknownSex, hasImportedResults: !!recordCount, counts, total: rows.length, rows: rows.slice(0, LIST_LIMIT) };
}

/** One person's testing: every applicable test, their history, and sex on file. */
export async function personTesting(subjectKey: string) {
  const today = localDateStr();
  const care = await subjectCare(subjectKey);
  if (!care) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
  const d = await db();
  const [records, sexes] = await Promise.all([loadRecords([subjectKey]), loadSexes([subjectKey])]);
  const { patients } = await import("../drizzle/schema");
  const [roster] = care.patientId ? await d.select({ dob: patients.dateOfBirth, chronicConditions: patients.chronicConditions, bhiConditions: patients.bhiConditions, insurance: patients.insurance }).from(patients).where(eq(patients.id, care.patientId)).limit(1) : [];
  const dob = roster?.dob ? roster.dob.toISOString().slice(0, 10) : subjectKey.startsWith("s:") ? subjectKey.split("|")[1] ?? null : null;
  const sex = (sexes.get(subjectKey) as Sex | undefined) ?? null;
  const mine = records.get(subjectKey) ?? [];
  const statuses = evaluateTesting({ age: ageOn(dob, today), sex, conditions: [...(roster?.chronicConditions ?? []), ...(roster?.bhiConditions ?? [])], medicare: isMedicare(roster?.insurance) }, mine, today);
  return {
    subjectKey, patientId: care.patientId, name: care.name, dob, age: ageOn(dob, today), sex, statuses,
    history: mine.sort((a, b) => b.performedOn.localeCompare(a.performedOn)).map((r) => ({ ...r, label: TESTS[r.testKey].label })),
  };
}

export async function recordTest(actor: WorkspaceActor, input: { subjectKey: string; testKey: TestKey; status: "done" | "not_applicable" | "declined"; performedOn: string; method?: string | null; result?: string | null; note?: string | null }) {
  const care = await subjectCare(input.subjectKey);
  if (!care) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
  const def = TESTS[input.testKey];
  if (input.method && !("methods" in def && def.methods && input.method in def.methods)) throw new WorkspaceError("Unknown method for that test.");
  if (input.performedOn > localDateStr()) throw new WorkspaceError("The date can't be in the future.");
  const d = await db();
  await d.insert(patientTests).values({
    subjectKey: input.subjectKey, patientId: care.patientId, testKey: input.testKey, status: input.status, performedOn: input.performedOn,
    method: input.method ?? null, result: input.result?.trim().slice(0, 120) || null, note: input.note?.trim() || null, source: "manual", createdByUserId: actor.id,
  }).onDuplicateKeyUpdate({ set: { method: input.method ?? null, result: input.result?.trim().slice(0, 120) || null, note: input.note?.trim() || null, source: "manual", createdByUserId: actor.id } });
  await audit(actor, "update_task", { entityType: "patientTest", description: `${input.testKey} ${input.status} ${input.performedOn}` });
  return { ok: true };
}

export async function deleteTestRecord(actor: WorkspaceActor, id: number) {
  const d = await db();
  const [r] = await d.select().from(patientTests).where(eq(patientTests.id, id)).limit(1);
  if (!r) throw new WorkspaceError("Record not found.", "NOT_FOUND");
  if (r.source !== "manual") throw new WorkspaceError("Imported results can't be deleted here; correct them in Practice Fusion and re-import.");
  await d.delete(patientTests).where(eq(patientTests.id, id));
  await audit(actor, "update_task", { entityType: "patientTest", entityId: id, description: `deleted ${r.testKey} ${r.status}` });
  return { ok: true };
}

export async function setSex(actor: WorkspaceActor, input: { subjectKey: string; sex: Sex | null }) {
  const care = await subjectCare(input.subjectKey);
  if (!care) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
  const d = await db();
  await d.insert(personDemographics).values({ subjectKey: input.subjectKey, patientId: care.patientId, sex: input.sex, source: "manual", updatedByUserId: actor.id })
    .onDuplicateKeyUpdate({ set: { sex: input.sex, source: "manual", updatedByUserId: actor.id } });
  return { ok: true };
}

// ---- Scheduling tasks / reviewed / dismissed ----

export async function actOnTesting(actor: WorkspaceActor, input: { keys: string[]; action: "reviewed" | "task_created" | "dismissed"; assigneeId?: number | null }) {
  const d = await db();
  const today = localDateStr();
  const [records, sexes, people] = await Promise.all([loadRecords(input.keys), loadSexes(input.keys), loadPeople(actor, null)]);
  const byKey = new Map(people.map((p) => [p.key, p]));
  let tasks = 0;
  const rows: (typeof opportunityActions.$inferInsert)[] = [];
  for (const key of input.keys) {
    const p = byKey.get(key);
    if (!p) continue;
    let taskId: number | null = null;
    if (input.action === "task_created") {
      const due = evaluatePerson(p, (sexes.get(key) as Sex | undefined) ?? null, records.get(key) ?? [], today).filter((s) => ["due", "no_record", "due_soon"].includes(s.state));
      if (!due.length) continue;
      const who = input.assigneeId ? { assignedUserId: input.assigneeId, assignedRole: null, clinicId: p.clinicId } : await careTeamAssignee(key);
      const lines = due.map((s) => `• ${s.label} — ${s.state === "no_record" ? "no record on file" : s.state === "due_soon" ? `due ${s.dueOn}` : `due since ${s.dueOn}`} (${s.who}; ${s.guideline})`);
      const t = await createTask(actor, {
        title: `Schedule testing — ${p.name}: ${due.map((s) => s.label.split(" (")[0]).join(", ")}`.slice(0, 250),
        description: `${lines.join("\n")}\n\n${p.nextVisit ? `Next visit: ${p.nextVisit.toLocaleDateString("en-US", { timeZone: "America/Chicago" })} — these can be done then.` : "Nothing booked: call to schedule a visit."}${p.patientId ? "" : `\nDOB ${p.dob ?? "unknown"}${p.phone ? `, phone ${p.phone}` : ""}. Not on the CCM roster.`}\nGuideline reminder for the care team; the provider decides what to order.`,
        patientId: p.patientId, clinicId: who.clinicId, assignedUserId: who.assignedUserId, assignedRole: who.assignedRole,
        priority: due.some((s) => s.state === "due") ? "normal" : "low", category: "patient_call", dueDate: nextClinicDay(today), sourceType: "testing", sourceRef: ACTION_CATEGORY,
      });
      taskId = t.id;
      tasks++;
    }
    rows.push({ patientId: p.patientId, subjectKey: key, category: ACTION_CATEGORY, action: input.action, userId: actor.id, taskId });
  }
  for (let i = 0; i < rows.length; i += 400) await d.insert(opportunityActions).values(rows.slice(i, i + 400));
  await audit(actor, "opportunity_action", { entityType: "opportunity", description: `${ACTION_CATEGORY}: ${input.action} x${rows.length}` });
  return { count: rows.length, tasks };
}

// ---- Practice Fusion imports ----

function columns(header: string[]) {
  const head = header.map((h) => h.trim().toLowerCase());
  const col = (...res: RegExp[]) => head.findIndex((h) => res.some((r) => r.test(h)));
  return {
    name: col(/^patient( name)?$/, /^(full )?name$/, /^patient full name$/),
    first: col(/^first( name)?$/, /^patient first name$/),
    last: col(/^last( name)?$/, /^patient last name$/),
    dob: col(/^dob$/, /birth/),
    sex: col(/^sex$/, /gender/, /^birth sex$/),
    email: col(/e-?mail/),
    test: col(/^(test|lab|order|procedure|observation|result)( ?name| ?description| ?code)?$/, /^description$/, /test name|order name|lab name/),
    date: col(/(result|collection|collected|service|performed|completed|order|observation|report)( ?date)?$/, /^date$/, /date of service/),
    result: col(/^(result|value|result value)$/, /^result (value|text)$/),
  };
}
const nameOf = (r: string[], c: ReturnType<typeof columns>) => (c.name >= 0 ? r[c.name] ?? "" : `${r[c.first] ?? ""} ${r[c.last] ?? ""}`);

/** Lab / order / procedure export → test records (matched by patient name + DOB and test name). */
export async function importTestResults(actor: WorkspaceActor, csv: string) {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) throw new WorkspaceError("That file has no rows.");
  const c = columns(rows[0]!);
  if (c.dob < 0 || c.test < 0 || c.date < 0 || (c.name < 0 && (c.first < 0 || c.last < 0))) {
    throw new WorkspaceError(`Couldn't find the columns. Need: patient name (or first + last), DOB, test/order name, and a date. Found: ${rows[0]!.join(", ").slice(0, 300)}`);
  }
  const people = await buildNameDobIndex();
  const d = await db();
  const today = localDateStr();
  const stats = { rows: rows.length - 1, saved: 0, duplicates: 0, patientNotFound: 0, testNotRecognized: 0, badDate: 0 };
  const unknownTests = new Map<string, number>();
  const batch: (typeof patientTests.$inferInsert)[] = [];
  for (const r of rows.slice(1)) {
    const dob = parseDateValue(r[c.dob] ?? "", { dob: true });
    const who = dob ? people.get(`${nameKey(nameOf(r, c))}|${dob}`) : undefined;
    if (!who) { stats.patientNotFound++; continue; }
    const testName = (r[c.test] ?? "").trim();
    const test = recognizeTest(testName);
    if (!test) { stats.testNotRecognized++; if (testName) unknownTests.set(testName, (unknownTests.get(testName) ?? 0) + 1); continue; }
    const date = parseDateValue(r[c.date] ?? "");
    if (!date || date > today) { stats.badDate++; continue; }
    batch.push({ subjectKey: who.key, patientId: who.patientId, testKey: test.key, method: test.method, performedOn: date, status: "done", result: c.result >= 0 ? (r[c.result] ?? "").trim().slice(0, 120) || null : null, source: "import", createdByUserId: actor.id });
  }
  for (let i = 0; i < batch.length; i += 400) {
    const chunk = batch.slice(i, i + 400);
    const res = await d.insert(patientTests).ignore().values(chunk);
    const inserted = Number((res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? chunk.length);
    stats.saved += inserted;
    stats.duplicates += chunk.length - inserted;
  }
  await audit(actor, "import_schedule", { entityType: "patientTest", description: `Imported test results: ${stats.saved} saved of ${stats.rows}` });
  // Test NAMES only (never patient data), so the user can tell us what to add.
  const unrecognized = Array.from(unknownTests.entries()).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, n]) => ({ name, n }));
  return { ...stats, unrecognized };
}

/** Patient list export → sex (and email addresses for the practice mailbox). */
export async function importPatientList(actor: WorkspaceActor, csv: string) {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) throw new WorkspaceError("That file has no rows.");
  const c = columns(rows[0]!);
  if (c.dob < 0 || (c.sex < 0 && c.email < 0) || (c.name < 0 && (c.first < 0 || c.last < 0))) {
    throw new WorkspaceError(`Couldn't find the columns. Need: patient name (or first + last), DOB, and Sex/Gender (and/or Email). Found: ${rows[0]!.join(", ").slice(0, 300)}`);
  }
  const people = await buildNameDobIndex();
  const d = await db();
  const manual = new Set((await d.select({ k: personDemographics.subjectKey }).from(personDemographics).where(eq(personDemographics.source, "manual"))).map((r) => r.k));
  const linked = new Set((await d.select({ e: emailContacts.email }).from(emailContacts).where(eq(emailContacts.source, "linked"))).map((r) => r.e));
  const stats = { rows: rows.length - 1, matched: 0, notFound: 0, sexSaved: 0, emailsSaved: 0 };
  for (const r of rows.slice(1)) {
    const dob = parseDateValue(r[c.dob] ?? "", { dob: true });
    const who = dob ? people.get(`${nameKey(nameOf(r, c))}|${dob}`) : undefined;
    if (!who) { stats.notFound++; continue; }
    stats.matched++;
    const sex = c.sex >= 0 ? parseSex(r[c.sex]) : null;
    if (sex && !manual.has(who.key)) { // staff corrections win
      await d.insert(personDemographics).values({ subjectKey: who.key, patientId: who.patientId, sex, source: "import", updatedByUserId: actor.id })
        .onDuplicateKeyUpdate({ set: { sex, source: "import", updatedByUserId: actor.id } });
      stats.sexSaved++;
    }
    const email = c.email >= 0 ? parseFromHeader(r[c.email] ?? "").email : null;
    if (email && !linked.has(email)) {
      await d.insert(emailContacts).values({ email, kind: "patient", patientId: who.patientId, subjectKey: who.key, name: who.name.slice(0, 255), source: "import", createdByUserId: actor.id })
        .onDuplicateKeyUpdate({ set: { kind: "patient", patientId: who.patientId, subjectKey: who.key, name: who.name.slice(0, 255), source: "import" } });
      stats.emailsSaved++;
    }
  }
  await audit(actor, "import_schedule", { entityType: "patient", description: `Imported patient list: ${stats.matched} matched, ${stats.sexSaved} sex, ${stats.emailsSaved} emails` });
  return stats;
}

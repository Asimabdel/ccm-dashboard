// Providers' daily reports and the injection log (see shared/dailyReport.ts for the format and rules).
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appointments, clinics, injections, patientTests, patients, programSuggestions, providers, users } from "../drizzle/schema";
import { WorkspaceError, audit, subjectCare, type WorkspaceActor } from "./workspaceDb";
import { INJECTION_KINDS, formatProviderReport, injectionTag, type InjectionKind } from "../shared/dailyReport";
import { OFFICE_TESTS, OFFICE_TEST_LABELS, type OfficeTest } from "../shared/officeTests";
import { SEEN_STATUSES, nameKey } from "../shared/workspace";
import { isValidDateStr, localDateStr } from "../shared/workforce";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const ymd = (dt: Date | null | undefined) => (dt ? dt.toISOString().slice(0, 10) : null);
/** One key per person across the schedule, the roster and Practice Fusion: roster id, else name + date of birth. */
const personOf = (p: { patientId: number | null; name: string; dob: string | null }) => (p.patientId ? `p:${p.patientId}` : `n:${nameKey(p.name)}|${p.dob ?? ""}`);
/** "Park, Sang Woan" → "Sang Woan Park" (schedules sometimes list last name first). */
const displayName = (name: string) => {
  const s = name.replace(/\s+/g, " ").trim();
  if (!s.includes(",")) return s;
  const [last, first] = s.split(",").map((x) => x.trim());
  return first ? `${first} ${last}` : last!;
};

async function lookup(subjectKey: string): Promise<{ patientId: number | null; name: string; dob: string | null; clinicId: number | null; providerId: number | null } | null> {
  const { directoryEntry } = await import("./directoryDb");
  const e = await directoryEntry(subjectKey);
  if (e) return { patientId: e.patientId, name: e.name, dob: e.dob, clinicId: e.clinicId, providerId: e.providerId };
  const c = await subjectCare(subjectKey);
  return c ? { patientId: c.patientId, name: c.name, dob: null, clinicId: c.clinicId, providerId: null } : null;
}

// ---------------------------------------------------------------------------
// Daily reports
// ---------------------------------------------------------------------------

export async function dailyReports(actor: WorkspaceActor, input: { date: string; clinicId?: number | null }) {
  if (!isValidDateStr(input.date)) throw new WorkspaceError("Pick a date.");
  const d = await db();
  const date = input.date;
  // Office managers: their office only. Everyone else (admins): all clinics, or the one picked.
  const scope = actor.clinicIds ? (input.clinicId ? actor.clinicIds.filter((c) => c === input.clinicId) : actor.clinicIds) : input.clinicId ? [input.clinicId] : null;
  const inScope = (clinicId: number | null) => !scope || (clinicId != null && scope.includes(clinicId));

  const provRows = await d.select({ id: providers.id, name: providers.name, clinicId: providers.clinicId }).from(providers);
  const provName = new Map(provRows.map((p) => [p.id, p.name]));
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));

  type Bucket = { key: string; provider: string; clinics: Set<string>; seen: Set<string>; testing: Map<string, { name: string; tests: Set<string> }>; ccm: Map<string, string>; rpm: Map<string, string>; injections: { id: number; name: string; tag: string; by: string | null }[] };
  const buckets = new Map<string, Bucket>();
  const bucket = (providerId: number | null, providerName: string | null) => {
    const key = providerId ? `p${providerId}` : providerName ? `n:${providerName.toLowerCase()}` : "none";
    let b = buckets.get(key);
    if (!b) {
      b = { key, provider: (providerId ? provName.get(providerId) : null) ?? providerName ?? "No provider", clinics: new Set(), seen: new Set(), testing: new Map(), ccm: new Map(), rpm: new Map(), injections: [] };
      buckets.set(key, b);
    }
    return b;
  };

  // Seen: that day's visits marked arrived … seen / checked out. Each person goes on the provider they saw.
  const visits = await d.select({ patientId: appointments.patientId, name: appointments.patientName, dob: appointments.dateOfBirth, providerId: appointments.providerId, providerName: appointments.providerName, clinicId: appointments.clinicId, status: appointments.status, startsAt: appointments.startsAt })
    .from(appointments).where(eq(appointments.date, date)).orderBy(asc(appointments.startsAt));
  const seenBy = new Map<string, { b: Bucket; name: string; key: string }>();
  const anyVisitBy = new Map<string, Bucket>();
  for (const v of visits) {
    if (!inScope(v.clinicId)) continue;
    const person = personOf({ patientId: v.patientId, name: v.name, dob: ymd(v.dob) });
    const subjectKey = v.patientId ? `p:${v.patientId}` : `s:${nameKey(v.name)}|${ymd(v.dob) ?? ""}`;
    const b = bucket(v.providerId, v.providerName);
    if (!anyVisitBy.has(person)) anyVisitBy.set(person, b);
    if (!(SEEN_STATUSES as string[]).includes(v.status)) continue;
    if (v.clinicId) b.clinics.add(clinicName.get(v.clinicId) ?? "");
    b.seen.add(person);
    if (!seenBy.has(person)) seenBy.set(person, { b, name: displayName(v.name), key: subjectKey });
  }
  /** The provider a person counts on that day: the one they were seen by, else any visit that day, else their own provider. */
  const providerFor = async (person: string, fallback: { providerId: number | null } | null) =>
    seenBy.get(person)?.b ?? anyVisitBy.get(person) ?? (fallback?.providerId ? bucket(fallback.providerId, null) : bucket(null, null));

  // Testing: in-office tests marked done that day.
  const tests = await d.select({ subjectKey: patientTests.subjectKey, patientId: patientTests.patientId, testKey: patientTests.testKey })
    .from(patientTests).where(and(eq(patientTests.performedOn, date), eq(patientTests.status, "done"), inArray(patientTests.testKey, [...OFFICE_TESTS])));
  for (const t of tests) {
    const who = await lookup(t.subjectKey);
    if (!who || (!inScope(who.clinicId ?? null) && !seenBy.has(personOf(who)))) continue;
    const person = personOf(who);
    const b = await providerFor(person, who);
    const row = b.testing.get(person) ?? { name: seenBy.get(person)?.name ?? displayName(who.name), tests: new Set<string>() };
    row.tests.add(OFFICE_TEST_LABELS[t.testKey as OfficeTest] ?? t.testKey);
    b.testing.set(person, row);
  }

  // New CCMs / RPMs: NEW patients only (that day was their first visit with the practice: no earlier seen
  // visit on any imported schedule or in the Practice Fusion chart), who qualify (Program approvals, from
  // their diagnoses) or signed that consent that day.
  const { loadDirectory } = await import("./directoryDb");
  const dir = await loadDirectory();
  const isNewPatient = (key: string) => {
    const first = dir.get(key)?.firstVisit ?? null;
    return !first || first >= date;
  };
  const qualifies = { ccm: new Set<string>(), rpm: new Set<string>() };
  const sugg = await d.select({ patientId: programSuggestions.patientId, name: programSuggestions.name, dob: programSuggestions.dob, program: programSuggestions.program })
    .from(programSuggestions).where(and(inArray(programSuggestions.program, ["ccm", "rpm"]), ne(programSuggestions.status, "withdrawn")));
  for (const s of sugg) qualifies[s.program as "ccm" | "rpm"].add(personOf({ patientId: s.patientId, name: s.name, dob: s.dob }));
  const consented = await d.select({ id: patients.id, ccm: patients.ccmConsentDate, rpm: patients.rpmConsentDate }).from(patients)
    .where(sql`DATE(${patients.ccmConsentDate}) = ${date} OR DATE(${patients.rpmConsentDate}) = ${date}`);
  for (const c of consented) {
    if (ymd(c.ccm) === date) qualifies.ccm.add(`p:${c.id}`);
    if (ymd(c.rpm) === date) qualifies.rpm.add(`p:${c.id}`);
  }
  for (const [person, { b, name, key }] of Array.from(seenBy)) {
    if (!isNewPatient(key)) continue;
    if (qualifies.ccm.has(person)) b.ccm.set(person, name);
    if (qualifies.rpm.has(person)) b.rpm.set(person, name);
  }

  // Injections logged that day.
  const shots = await d.select({ i: injections, by: users.name }).from(injections).leftJoin(users, eq(users.id, injections.givenByUserId))
    .where(and(eq(injections.givenOn, date), isNull(injections.removedAt))).orderBy(asc(injections.id));
  for (const { i, by } of shots) {
    const person = personOf({ patientId: i.patientId, name: i.patientName, dob: i.dob });
    if (!inScope(i.clinicId) && !seenBy.has(person)) continue;
    const b = i.providerId ? bucket(i.providerId, null) : await providerFor(person, null);
    b.injections.push({ id: i.id, name: seenBy.get(person)?.name ?? displayName(i.patientName), tag: injectionTag(i.kind, i.label, i.seriesNumber), by });
  }

  const reports = Array.from(buckets.values())
    .filter((b) => b.seen.size || b.testing.size || b.injections.length)
    .map((b) => {
      const testing = Array.from(b.testing.values()).map((t) => ({ name: t.name, tests: OFFICE_TESTS.map((k) => OFFICE_TEST_LABELS[k]).filter((l) => t.tests.has(l)) }));
      const day = { date, provider: b.provider, seen: b.seen.size, testing, newCcm: b.ccm.size, newRpm: b.rpm.size, injections: b.injections.map(({ name, tag }) => ({ name, tag })) };
      return { key: b.key, ...day, clinics: Array.from(b.clinics).filter(Boolean), newCcmNames: Array.from(b.ccm.values()), newRpmNames: Array.from(b.rpm.values()), injectionRows: b.injections, text: formatProviderReport(day) };
    })
    .sort((a, b) => b.seen - a.seen || a.provider.localeCompare(b.provider));
  const statuses = visits.filter((v) => inScope(v.clinicId));
  return {
    date,
    reports,
    visitsOnSchedule: statuses.length,
    visitsWithStatus: statuses.filter((v) => v.status !== "scheduled").length,
  };
}

// ---------------------------------------------------------------------------
// Injection log
// ---------------------------------------------------------------------------

async function nextNumbers(subjectKey: string, patientId: number | null) {
  const d = await db();
  const rows = await d.select({ kind: injections.kind, n: sql<number>`count(*)`, top: sql<number | null>`max(${injections.seriesNumber})` }).from(injections)
    .where(and(patientId ? sql`(${injections.subjectKey} = ${subjectKey} OR ${injections.patientId} = ${patientId})` : eq(injections.subjectKey, subjectKey), isNull(injections.removedAt)))
    .groupBy(injections.kind);
  const next: Record<string, number> = {};
  for (const k of Object.keys(INJECTION_KINDS)) next[k] = 1;
  for (const r of rows) next[r.kind] = Math.max(Number(r.n), Number(r.top ?? 0)) + 1;
  return next;
}

/** For the "Injection given" box: providers, who they saw that day, the next number of each kind, recent ones. */
export async function injectionContext(actor: WorkspaceActor, input: { subjectKey: string; date: string }) {
  const who = await lookup(input.subjectKey);
  if (!who) throw new WorkspaceError("That patient wasn't found.", "NOT_FOUND");
  const d = await db();
  const provs = await d.select({ id: providers.id, name: providers.name }).from(providers).orderBy(asc(providers.name));
  // That day's visit (for the default provider).
  const todays = await d.select({ patientId: appointments.patientId, name: appointments.patientName, dob: appointments.dateOfBirth, providerId: appointments.providerId })
    .from(appointments).where(eq(appointments.date, input.date));
  const person = personOf(who);
  const visit = todays.find((v) => personOf({ patientId: v.patientId, name: v.name, dob: ymd(v.dob) }) === person && v.providerId);
  const recent = await d.select({ i: injections, by: users.name }).from(injections).leftJoin(users, eq(users.id, injections.givenByUserId))
    .where(and(who.patientId ? sql`(${injections.subjectKey} = ${input.subjectKey} OR ${injections.patientId} = ${who.patientId})` : eq(injections.subjectKey, input.subjectKey), isNull(injections.removedAt)))
    .orderBy(desc(injections.givenOn), desc(injections.id)).limit(8);
  return {
    providers: provs,
    defaultProviderId: visit?.providerId ?? who.providerId ?? null,
    next: await nextNumbers(input.subjectKey, who.patientId),
    recent: recent.map(({ i, by }) => ({ id: i.id, tag: injectionTag(i.kind, i.label, i.seriesNumber), givenOn: i.givenOn, by, canRemove: i.givenByUserId === actor.id || actor.role === "admin" || actor.role === "office_manager" })),
  };
}

export async function logInjection(actor: WorkspaceActor, input: { subjectKey: string; kind: InjectionKind; label?: string | null; seriesNumber?: number | null; givenOn: string; providerId?: number | null; note?: string | null }) {
  if (!isValidDateStr(input.givenOn) || input.givenOn > localDateStr()) throw new WorkspaceError("Pick the day it was given (not in the future).");
  if (!INJECTION_KINDS[input.kind]) throw new WorkspaceError("Pick the kind of injection.");
  const label = input.label?.trim().slice(0, 80) || null;
  if (input.kind === "other" && !label) throw new WorkspaceError("Type what was given.");
  const who = await lookup(input.subjectKey);
  if (!who) throw new WorkspaceError("That patient wasn't found.", "NOT_FOUND");
  if (actor.clinicIds && who.clinicId && !actor.clinicIds.includes(who.clinicId)) {
    // Clinic-limited staff log for patients at their clinic (or seen there that day).
    const [here] = await (await db()).select({ id: appointments.id }).from(appointments)
      .where(and(eq(appointments.date, input.givenOn), inArray(appointments.clinicId, actor.clinicIds), who.patientId ? eq(appointments.patientId, who.patientId) : sql`1=0`)).limit(1);
    if (!here) throw new WorkspaceError("You can log injections for patients at your clinic.", "FORBIDDEN");
  }
  const n = input.kind === "other" ? input.seriesNumber ?? null : input.seriesNumber ?? (await nextNumbers(input.subjectKey, who.patientId))[input.kind] ?? 1;
  const res = await (await db()).insert(injections).values({
    subjectKey: input.subjectKey, patientId: who.patientId, patientName: who.name.slice(0, 255), dob: who.dob, clinicId: who.clinicId,
    providerId: input.providerId ?? null, kind: input.kind, label, seriesNumber: n, givenOn: input.givenOn, note: input.note?.trim().slice(0, 255) || null, givenByUserId: actor.id,
  });
  const id = Number((res as unknown as [{ insertId: number }])[0]?.insertId);
  await audit(actor, "update_patient", { entityType: "injection", entityId: id, description: `Injection logged: ${injectionTag(input.kind, label, n)}` });
  return { id, tag: injectionTag(input.kind, label, n) };
}

export async function removeInjection(actor: WorkspaceActor, id: number) {
  const d = await db();
  const [i] = await d.select().from(injections).where(eq(injections.id, id)).limit(1);
  if (!i || i.removedAt) throw new WorkspaceError("That injection wasn't found.", "NOT_FOUND");
  if (i.givenByUserId !== actor.id && actor.role !== "admin" && actor.role !== "office_manager") throw new WorkspaceError("Only the person who logged it (or an admin) can remove it.", "FORBIDDEN");
  await d.update(injections).set({ removedAt: new Date(), removedByUserId: actor.id }).where(eq(injections.id, id));
  await audit(actor, "update_patient", { entityType: "injection", entityId: id, description: `Injection removed: ${injectionTag(i.kind, i.label, i.seriesNumber)}` });
  return { ok: true };
}

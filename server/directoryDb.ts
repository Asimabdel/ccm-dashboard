// The clinic's patient list (Patients tab) and Patient 360 for every patient.
//
// One row per person MyPCP knows about: CCM-roster patients ("p:"), people on the imported
// schedule ("s:") and people who are only in Practice Fusion ("f:"; Practice Fusion records that
// match a roster or schedule person are folded into that person). The list is built in memory
// (around ten thousand people) and kept for a minute per Lambda instance; searching, filtering
// and paging run on that copy.
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appointments, clinics, emailMessages, faxes, fhirPatients, fhirResources, opportunityActions, patients, providers, users, workTasks } from "../drizzle/schema";
import {
  DIRECTORY_PAGE_SIZE, directoryStatus, inStatus, isEmptyQuery, matchesQuery, parseDirectoryQuery,
  type DirectoryProgram, type DirectorySort, type DirectoryStatus,
} from "../shared/directory";
import { normalizePersonName } from "../shared/csvImport";
import { OPEN_TASK_STATUSES, SEEN_STATUSES, nameKey, sameProviderName, type TaskStatus } from "../shared/workspace";
import { addDays, localDateStr } from "../shared/workforce";
import { WorkspaceError, audit, loadScheduleSubjects, subjectKeyFor, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const ymd = (dt: Date | null | undefined) => (dt ? dt.toISOString().slice(0, 10) : null);
const maxStr = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
const minStr = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);

/** "SMITH, JOHN A" → "John A Smith"; mixed-case names are kept as written. */
export function displayName(raw: string): string {
  const n = normalizePersonName(raw);
  if (n !== n.toUpperCase()) return n;
  return n.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

export interface DirectoryEntry {
  key: string;
  patientId: number | null;
  name: string;
  nameKey: string;
  /** Last name first, for sorting. */
  sortName: string;
  dob: string | null;
  phone: string | null;
  phoneDigits: string;
  mrn: string | null;
  clinicId: number | null;
  providerId: number | null;
  providerName: string | null;
  lastVisit: string | null;
  firstVisit: string | null;
  nextVisit: string | null;
  programs: DirectoryProgram[];
  sources: { roster: boolean; schedule: boolean; practiceFusion: boolean };
}

let cache: { at: number; build: Promise<Map<string, DirectoryEntry>> } | null = null;
const CACHE_MS = 60_000;

export function clearDirectoryCache() {
  cache = null;
}

export async function loadDirectory(): Promise<Map<string, DirectoryEntry>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.build;
  const build = buildDirectory();
  cache = { at: Date.now(), build };
  build.catch(() => { if (cache?.build === build) cache = null; });
  return build;
}

async function buildDirectory(): Promise<Map<string, DirectoryEntry>> {
  const d = await db();
  const today = localDateStr();
  const now = new Date();
  const out = new Map<string, DirectoryEntry>();
  const provs = await d.select({ id: providers.id, name: providers.name, clinicId: providers.clinicId, aliases: providers.aliases }).from(providers);
  const provById = new Map(provs.map((p) => [p.id, p]));
  const providerByDisplay = new Map<string, (typeof provs)[number] | null>();
  const findProvider = (display: string | null | undefined) => {
    const k = display?.trim();
    if (!k) return null;
    if (!providerByDisplay.has(k)) providerByDisplay.set(k, provs.find((p) => sameProviderName(p.name, k) || (p.aliases ?? []).some((a) => sameProviderName(a, k))) ?? null);
    return providerByDisplay.get(k) ?? null;
  };
  const entry = (key: string, name: string, patientId: number | null): DirectoryEntry => {
    const shown = displayName(name);
    const words = nameKey(shown).split(" ").filter(Boolean);
    return {
      key, patientId, name: shown, nameKey: words.join(" "), sortName: `${words[words.length - 1] ?? ""} ${words.slice(0, -1).join(" ")}`.trim(),
      dob: null, phone: null, phoneDigits: "", mrn: null, clinicId: null, providerId: null, providerName: null,
      lastVisit: null, firstVisit: null, nextVisit: null, programs: [], sources: { roster: false, schedule: false, practiceFusion: false },
    };
  };
  const setPhone = (e: DirectoryEntry, phone: string | null | undefined) => {
    if (e.phone || !phone?.trim()) return;
    e.phone = phone.trim();
    e.phoneDigits = e.phone.replace(/\D/g, "");
  };

  // 1) The CCM roster.
  const roster = await d.select({
    id: patients.id, name: patients.name, dob: patients.dateOfBirth, phone: patients.phoneNumber, clinicId: patients.clinicId, providerId: patients.providerId,
    ccm: patients.ccmEnrollmentStatus, bhi: patients.bhiEnrollmentStatus, apcm: patients.apcmEnrollmentStatus, rpm: patients.rpmStatus,
    lastOfficeVisit: patients.lastOfficeVisit, nextAppointment: patients.nextAppointment,
  }).from(patients);
  for (const r of roster) {
    const e = entry(`p:${r.id}`, r.name, r.id);
    e.dob = ymd(r.dob);
    setPhone(e, r.phone);
    e.clinicId = r.clinicId ?? null;
    const prov = r.providerId ? provById.get(r.providerId) : undefined;
    if (prov) { e.providerId = prov.id; e.providerName = prov.name; e.clinicId ??= prov.clinicId ?? null; }
    e.lastVisit = r.lastOfficeVisit ? localDateStr(r.lastOfficeVisit) : null;
    if (r.nextAppointment && r.nextAppointment > now) e.nextVisit = r.nextAppointment.toISOString();
    if (r.ccm === "active") e.programs.push("ccm");
    if (r.bhi === "active") e.programs.push("bhi");
    if (r.apcm === "active") e.programs.push("apcm");
    if (r.rpm === "enrolled" || r.rpm === "active") e.programs.push("rpm");
    e.sources.roster = true;
    out.set(e.key, e);
  }

  // 2) The imported schedule (the last ~13 months of visits and everything booked).
  for (const s of Array.from((await loadScheduleSubjects()).values())) {
    let e = out.get(s.key);
    if (!e) {
      if (s.key.startsWith("p:")) continue; // a roster patient that no longer exists
      e = entry(s.key, s.name, null);
      e.dob = ymd(s.dob);
      out.set(s.key, e);
    }
    e.sources.schedule = true;
    setPhone(e, s.phone);
    e.clinicId ??= s.clinicId;
    if (!e.providerName && s.providerName) { e.providerId = s.providerId; e.providerName = s.providerName; }
    let next: Date | null = null;
    for (const v of s.visits) {
      if (v.startsAt <= now && SEEN_STATUSES.includes(v.status)) {
        const day = localDateStr(v.startsAt);
        e.lastVisit = maxStr(e.lastVisit, day);
        e.firstVisit = minStr(e.firstVisit, day);
      }
      if (v.startsAt > now && v.status !== "cancelled" && v.status !== "no_show" && (!next || v.startsAt < next)) next = v.startsAt;
    }
    if (next) e.nextVisit = next.toISOString();
  }

  // 3) Practice Fusion: contact details for everyone matched, and the people only PF knows.
  const pf = await d.select({ key: fhirPatients.subjectKey, name: fhirPatients.name, dob: fhirPatients.dob, phone: fhirPatients.phone, mrn: fhirPatients.mrn }).from(fhirPatients);
  for (const p of pf) {
    let e = out.get(p.key);
    if (!e) {
      if (!p.key.startsWith("f:") || !p.name) continue;
      e = entry(p.key, p.name, null);
      out.set(p.key, e);
    }
    e.sources.practiceFusion = true;
    e.dob ??= p.dob;
    setPhone(e, p.phone);
    e.mrn ??= p.mrn;
  }

  // Visits from the chart copy (all the way back), and the provider for people only PF knows. Encounters
  // with no visit type ("Unknown") are not visits: Practice Fusion created ~5,600 of them on 2026-09-28/29.
  const realVisit = and(isNotNull(fhirResources.title), ne(fhirResources.title, "Unknown"));
  const enc = await d.select({ key: fhirResources.subjectKey, last: sql<string | null>`max(${fhirResources.date})`, first: sql<string | null>`min(${fhirResources.date})` })
    .from(fhirResources)
    .where(and(eq(fhirResources.section, "Encounter"), isNotNull(fhirResources.subjectKey), lte(fhirResources.date, today), realVisit, or(isNull(fhirResources.status), notInArray(fhirResources.status, ["cancelled", "entered-in-error"]))))
    .groupBy(fhirResources.subjectKey);
  for (const v of enc) {
    const e = v.key ? out.get(v.key) : undefined;
    if (!e) continue;
    e.lastVisit = maxStr(e.lastVisit, v.last);
    e.firstVisit = minStr(e.firstVisit, v.first);
  }
  const pfOnly = await d.select({ key: fhirResources.subjectKey, date: fhirResources.date, value: fhirResources.value })
    .from(fhirResources)
    .where(and(eq(fhirResources.section, "Encounter"), like(fhirResources.subjectKey, "f:%"), lte(fhirResources.date, today), realVisit));
  const latest = new Map<string, { date: string; who: string | null }>();
  for (const v of pfOnly) {
    if (!v.key || !v.date) continue;
    const who = v.value ? v.value.split(" · ").pop() ?? null : null;
    const cur = latest.get(v.key);
    if (!cur || v.date > cur.date || (v.date === cur.date && !cur.who)) latest.set(v.key, { date: v.date, who });
  }
  for (const [key, v] of Array.from(latest.entries())) {
    const e = out.get(key);
    const prov = findProvider(v.who);
    if (!e || !prov) continue;
    e.providerId = prov.id;
    e.providerName = prov.name;
    e.clinicId ??= prov.clinicId ?? null;
  }
  return out;
}

export async function directoryEntry(key: string): Promise<DirectoryEntry | null> {
  return (await loadDirectory()).get(key) ?? null;
}

// ---------------------------------------------------------------------------
// The Patients tab
// ---------------------------------------------------------------------------

export interface DirectoryFilters {
  q?: string | null;
  status: DirectoryStatus;
  clinicId?: number | "none" | null;
  providerId?: number | null;
  program?: DirectoryProgram | null;
  sort: DirectorySort;
  page: number;
}

export async function listDirectory(actor: WorkspaceActor, f: DirectoryFilters) {
  const all = Array.from((await loadDirectory()).values());
  const today = localDateStr();
  const d = await db();
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));
  // Every staff member can look up any patient of the practice (2026-10-01: forms and charts for anyone).
  const scoped = all;
  const q = parseDirectoryQuery(f.q ?? "");
  const searching = !isEmptyQuery(q);
  const base = scoped.filter((e) =>
    (!searching || matchesQuery(e, q)) &&
    (f.clinicId == null || (f.clinicId === "none" ? e.clinicId == null : e.clinicId === f.clinicId)) &&
    (!f.providerId || e.providerId === f.providerId) &&
    (!f.program || e.programs.includes(f.program)),
  );
  const withStatus = base.map((e) => ({ e, s: directoryStatus({ ...e, established: e.sources.roster }, today) }));
  const counts: Record<DirectoryStatus, number> = { active: 0, new: 0, inactive: 0, all: withStatus.length };
  for (const { s } of withStatus) { if (s.active) counts.active++; else counts.inactive++; if (s.isNew) counts.new++; }
  // A search looks through everyone (staff are usually looking for one person).
  const status: DirectoryStatus = searching ? "all" : f.status;
  const rows = withStatus.filter(({ s }) => inStatus(status, s));
  const byName = (a: DirectoryEntry, b: DirectoryEntry) => a.sortName.localeCompare(b.sortName) || (a.dob ?? "").localeCompare(b.dob ?? "");
  rows.sort(({ e: a }, { e: b }) => {
    if (f.sort === "lastVisit") return (b.lastVisit ?? "").localeCompare(a.lastVisit ?? "") || byName(a, b);
    if (f.sort === "nextVisit") return (a.nextVisit ?? "~").localeCompare(b.nextVisit ?? "~") || byName(a, b);
    return byName(a, b);
  });
  const page = Math.max(1, f.page);
  const slice = rows.slice((page - 1) * DIRECTORY_PAGE_SIZE, page * DIRECTORY_PAGE_SIZE);
  if (searching && page === 1) await audit(actor, "view_patient", { entityType: "patientList", description: `Searched the patient list (${rows.length} found)` });

  // Filter choices, from the people this person can see.
  const clinicCounts = new Map<number | null, number>();
  const providerCounts = new Map<number, { name: string; n: number }>();
  for (const e of scoped) {
    clinicCounts.set(e.clinicId, (clinicCounts.get(e.clinicId) ?? 0) + 1);
    if (e.providerId) providerCounts.set(e.providerId, { name: e.providerName ?? "Provider", n: (providerCounts.get(e.providerId)?.n ?? 0) + 1 });
  }
  return {
    rows: slice.map(({ e, s }) => ({
      key: e.key, patientId: e.patientId, name: e.name, dob: e.dob, phone: e.phone,
      clinicId: e.clinicId, clinicName: e.clinicId ? clinicName.get(e.clinicId) ?? null : null, providerName: e.providerName,
      lastVisit: e.lastVisit, nextVisit: e.nextVisit, programs: e.programs, active: s.active, isNew: s.isNew, sources: e.sources,
    })),
    total: rows.length,
    page,
    pageSize: DIRECTORY_PAGE_SIZE,
    status,
    searching,
    counts,
    clinics: Array.from(clinicCounts.entries()).filter(([id]) => id != null).map(([id, n]) => ({ id: id as number, name: clinicName.get(id as number) ?? "Clinic", count: n })).sort((a, b) => a.name.localeCompare(b.name)),
    noClinic: clinicCounts.get(null) ?? 0,
    providers: Array.from(providerCounts.entries()).map(([id, v]) => ({ id, name: v.name, count: v.n })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Find patients for a picker (sending forms, attaching a document, linking an email…): every patient
 * the practice has, matched like the Patients tab (any name order, date of birth, phone or MRN).
 * clinicIds limits it to some clinics (null = everyone); people with no clinic on file are then left out.
 */
export async function searchPatients(q: string, limit = 20, clinicIds: number[] | null = null) {
  const query = parseDirectoryQuery(q);
  if (isEmptyQuery(query) || (!query.dob && !query.digits && query.words.join("").length < 2)) return [];
  const all = Array.from((await loadDirectory()).values());
  const d = await db();
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));
  return all
    .filter((e) => matchesQuery(e, query) && (!clinicIds || (e.clinicId != null && clinicIds.includes(e.clinicId))))
    .sort((a, b) => a.sortName.localeCompare(b.sortName) || (a.dob ?? "").localeCompare(b.dob ?? ""))
    .slice(0, limit)
    .map((e) => ({
      key: e.key, patientId: e.patientId, name: e.name, dob: e.dob, clinicId: e.clinicId,
      clinicName: e.clinicId ? clinicName.get(e.clinicId) ?? null : null, phoneLast4: e.phoneDigits ? e.phoneDigits.slice(-4) : null,
    }));
}

// ---------------------------------------------------------------------------
// Patient 360 for anyone (roster patients keep their CCM record as an extra tab)
// ---------------------------------------------------------------------------

const apptSelect = {
  id: appointments.id, startsAt: appointments.startsAt, date: appointments.date, status: appointments.status, visitType: appointments.visitType, reason: appointments.reason,
  providerName: appointments.providerName, providerDisplay: providers.name, clinicId: appointments.clinicId, clinicName: clinics.name,
};
const taskCols = {
  id: workTasks.id, title: workTasks.title, status: workTasks.status, priority: workTasks.priority, category: workTasks.category, dueDate: workTasks.dueDate,
  createdAt: workTasks.createdAt, completedAt: workTasks.completedAt, assigneeName: users.name, assignedRole: workTasks.assignedRole,
};

/** Everything Patient 360 shows above its tabs, for any patient key. */
export async function patient360(actor: WorkspaceActor, key: string) {
  const d = await db();
  const pid = /^p:(\d+)$/.exec(key) ? Number(key.slice(2)) : null;
  const e = await directoryEntry(key);
  if (!e) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
  const today = localDateStr();

  // Visits on the imported schedule.
  let appts: { id: number; startsAt: Date; date: string; status: string; visitType: string | null; reason: string | null; providerName: string | null; providerDisplay: string | null; clinicId: number | null; clinicName: string | null }[] = [];
  if (pid) {
    appts = await d.select(apptSelect).from(appointments).leftJoin(providers, eq(appointments.providerId, providers.id)).leftJoin(clinics, eq(appointments.clinicId, clinics.id))
      .where(eq(appointments.patientId, pid)).orderBy(desc(appointments.startsAt)).limit(50);
  } else if (key.startsWith("s:")) {
    const dob = key.slice(key.lastIndexOf("|") + 1);
    const byDob = /^\d{4}-\d{2}-\d{2}$/.test(dob)
      ? and(gte(appointments.dateOfBirth, new Date(`${addDays(dob, -1)}T00:00:00Z`)), lte(appointments.dateOfBirth, new Date(`${addDays(dob, 1)}T23:59:59Z`)))
      : isNull(appointments.dateOfBirth);
    const rows = await d.select({ ...apptSelect, patientName: appointments.patientName, dateOfBirth: appointments.dateOfBirth }).from(appointments)
      .leftJoin(providers, eq(appointments.providerId, providers.id)).leftJoin(clinics, eq(appointments.clinicId, clinics.id))
      .where(and(isNull(appointments.patientId), byDob)).orderBy(desc(appointments.startsAt)).limit(2000);
    appts = rows.filter((r) => subjectKeyFor(null, r.patientName, r.dateOfBirth) === key).slice(0, 50).map(({ patientName: _n, dateOfBirth: _d, ...r }) => r);
  }

  // Any staff member can open any patient (forms and charts for patients at every clinic).

  // Tasks: about this patient, or made from their emails, faxes and Opportunity Finder.
  const linked = [
    ...(await d.select({ id: emailMessages.taskId }).from(emailMessages).where(and(eq(emailMessages.subjectKey, key), isNotNull(emailMessages.taskId)))),
    ...(await d.select({ id: faxes.taskId }).from(faxes).where(and(eq(faxes.subjectKey, key), isNotNull(faxes.taskId)))),
    ...(pid ? [] : await d.select({ id: opportunityActions.taskId }).from(opportunityActions).where(and(eq(opportunityActions.subjectKey, key), isNotNull(opportunityActions.taskId)))),
  ].map((x) => x.id).filter((x): x is number => !!x);
  const conds = [eq(workTasks.subjectKey, key), ...(pid ? [eq(workTasks.patientId, pid)] : []), ...(linked.length ? [inArray(workTasks.id, linked)] : [])];
  const tasks = await d.select(taskCols).from(workTasks).leftJoin(users, eq(workTasks.assignedUserId, users.id)).where(or(...conds)).orderBy(desc(workTasks.createdAt)).limit(50);

  const [roster] = pid ? await d.select({ insurance: patients.insurance, preferredLanguage: patients.preferredLanguage }).from(patients).where(eq(patients.id, pid)).limit(1) : [];
  const clinicName = e.clinicId ? (await d.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, e.clinicId)).limit(1))[0]?.name ?? null : null;
  await audit(actor, "view_patient", { entityType: "patient", entityId: pid ?? undefined, description: `Patient 360 (${key.slice(0, 2)})` });
  const now = new Date();
  const upcoming = appts.filter((a) => a.startsAt > now && a.status === "scheduled").sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return {
    key,
    patient: {
      id: pid, key, name: e.name, dateOfBirth: e.dob, phoneNumber: e.phone, mrn: e.mrn, clinicId: e.clinicId, clinicName, providerName: e.providerName,
      preferredLanguage: roster?.preferredLanguage ?? null, insurance: roster?.insurance ?? null, lastVisit: e.lastVisit, programs: e.programs, sources: e.sources,
    },
    appointments: appts.map((a) => ({ ...a, provider: a.providerDisplay ?? a.providerName })),
    nextAppointment: upcoming[0] ?? null,
    today: appts.find((a) => a.date === today && a.status !== "cancelled") ?? null,
    tasks,
    openTasks: tasks.filter((t) => OPEN_TASK_STATUSES.includes(t.status as TaskStatus)),
  };
}

/** Name and clinic for a task about someone who isn't on the roster. */
export async function subjectForTask(key: string): Promise<{ name: string; clinicId: number | null } | null> {
  const e = await directoryEntry(key);
  return e ? { name: e.name, clinicId: e.clinicId } : null;
}

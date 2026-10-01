// Program approvals: patients whose Practice Fusion diagnoses qualify them for CCM / BHI / RPM / APCM.
//
// Every morning (and on "Check now") everyone seen since the start date (seenSince.ts) is checked against the
// practice's rules (shared/programRules.ts). New matches wait in programSuggestions for an approver:
// only the people named in the "program approvers" setting see them (office managers only their
// office's patients). Approving enrolls the patient (adding them to the CCM roster first if they
// aren't on it), with consent pending: a "get consent" task goes to their coordinator, and CCM, BHI
// and APCM don't bill until consent is signed. "Not now" stands until their qualifying diagnoses change.
// Nothing here diagnoses anyone or contacts patients: it reads diagnoses already on file.
import { and, asc, eq, inArray, isNotNull, isNull, lte, gte, sql } from "drizzle-orm";
import { getDb, ensureMonthlyTask, getPatientById, updatePatientAPCM, updatePatientBHI, updatePatientRPM } from "./db";
import { currentMonth } from "./seed";
import { appSettings, appointments, clinics, fhirResources, notifications, patients, programSuggestions, users } from "../drizzle/schema";
import {
  NOT_ON_ROSTER, SUGGEST_PROGRAMS, SUGGEST_PROGRAM_LABELS, classifyDiagnosis, diagnosesFingerprint, suggestPrograms,
  type MatchedDiagnosis, type ProgramStanding, type SuggestProgram,
} from "../shared/programRules";
import { nameKey } from "../shared/workspace";
import { addDays, localDateStr } from "../shared/workforce";
import { clearDirectoryCache, loadDirectory, type DirectoryEntry } from "./directoryDb";
import { WorkspaceError, audit, buildNameDobIndex, clearScheduleCache, createTask, officeClinicIds, subjectKeyFor, type WorkspaceActor } from "./workspaceDb";
import { checkEnrollmentsFor } from "./enrollDb";
import { getSeenSince } from "./seenSince";
import { conditionFacts } from "./chartFacts";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

// ---------------------------------------------------------------------------
// Who approves (named people, not a role)
// ---------------------------------------------------------------------------

const APPROVERS_KEY = "program_approvers";

export async function programApproverIds(): Promise<number[]> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, APPROVERS_KEY)).limit(1);
  const ids = (row?.value as { userIds?: unknown } | undefined)?.userIds;
  return Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}

export async function isProgramApprover(userId: number): Promise<boolean> {
  return (await programApproverIds()).includes(userId);
}

/** IAM-only job: set who approves, by name (admins and office managers only). Dry run unless apply. */
export async function programApproversJob(input: { names: string[]; apply: boolean }) {
  const d = await db();
  const staff = await d.select({ id: users.id, name: users.name, role: users.role }).from(users).where(inArray(users.role, ["admin", "office_manager"]));
  const picked: { id: number; name: string | null; role: string }[] = [];
  const problems: string[] = [];
  for (const n of input.names) {
    const needle = n.trim().toLowerCase();
    const hits = staff.filter((u) => needle && (u.name ?? "").toLowerCase().includes(needle));
    if (hits.length === 1) picked.push(hits[0]!);
    else problems.push(`${n}: ${hits.length ? `matches ${hits.map((h) => h.name).join(", ")}` : "no admin or office manager by that name"}`);
  }
  const current = await programApproverIds();
  if (problems.length || !input.apply) return { wouldSet: picked.map((p) => `${p.name} (${p.role})`), problems, currentIds: current };
  const value = { userIds: picked.map((p) => p.id) };
  await d.insert(appSettings).values({ key: APPROVERS_KEY, value }).onDuplicateKeyUpdate({ set: { value } });
  return { set: picked.map((p) => `${p.name} (${p.role})`) };
}

// ---------------------------------------------------------------------------
// Finding who qualifies
// ---------------------------------------------------------------------------

type RosterRow = {
  id: number; chronicConditions: string[] | null; bhiConditions: string[] | null;
  ccmEnrollmentStatus: string | null; consentStatus: string | null; bhiEnrollmentStatus: string | null; bhiConsentStatus: string | null;
  apcmEnrollmentStatus: string | null; apcmConsentStatus: string | null; rpmStatus: string | null; rpmEnrolled: boolean | null; rpmConsentStatus: string | null;
};
const rosterCols = {
  id: patients.id, chronicConditions: patients.chronicConditions, bhiConditions: patients.bhiConditions,
  ccmEnrollmentStatus: patients.ccmEnrollmentStatus, consentStatus: patients.consentStatus, bhiEnrollmentStatus: patients.bhiEnrollmentStatus, bhiConsentStatus: patients.bhiConsentStatus,
  apcmEnrollmentStatus: patients.apcmEnrollmentStatus, apcmConsentStatus: patients.apcmConsentStatus, rpmStatus: patients.rpmStatus, rpmEnrolled: patients.rpmEnrolled, rpmConsentStatus: patients.rpmConsentStatus,
};
const standingOf = (r: RosterRow | undefined): ProgramStanding => r ? {
  ccm: r.ccmEnrollmentStatus, ccmConsent: r.consentStatus, bhi: r.bhiEnrollmentStatus, bhiConsent: r.bhiConsentStatus,
  apcm: r.apcmEnrollmentStatus, apcmConsent: r.apcmConsentStatus, rpm: r.rpmStatus, rpmEnrolled: !!r.rpmEnrolled, rpmConsent: r.rpmConsentStatus,
} : NOT_ON_ROSTER;

/** Every diagnosis on file for each person (Practice Fusion problem list + roster conditions), sorted into program categories. */
async function diagnosesByPerson(keys: Set<string>): Promise<Map<string, MatchedDiagnosis[]>> {
  const out = new Map<string, MatchedDiagnosis[]>();
  for (const [key, facts] of Array.from((await conditionFacts(keys)).entries())) {
    const matches = facts.map((f) => classifyDiagnosis(f)).filter((m): m is MatchedDiagnosis => !!m);
    if (matches.length) out.set(key, matches);
  }
  return out;
}

/** Check everyone seen since the start date; add new suggestions, refresh open ones, withdraw ones that no longer apply. */
export async function scanProgramSuggestions() {
  const d = await db();
  clearDirectoryCache();
  const dir = await loadDirectory();
  const since = await getSeenSince();
  const people = Array.from(dir.values()).filter((e) => e.lastVisit && e.lastVisit >= since);
  const keys = new Set(people.map((p) => p.key));
  const roster = new Map((await d.select(rosterCols).from(patients)).map((r) => [`p:${r.id}`, r as RosterRow]));
  const dx = await diagnosesByPerson(keys);

  const existing = await d.select({ id: programSuggestions.id, key: programSuggestions.subjectKey, program: programSuggestions.program, status: programSuggestions.status, fingerprint: programSuggestions.fingerprint, reason: programSuggestions.reason, clinicId: programSuggestions.clinicId, lastVisit: programSuggestions.lastVisit })
    .from(programSuggestions).where(inArray(programSuggestions.status, ["pending", "approved", "rejected"]));
  const pending = new Map<string, (typeof existing)[number]>();
  const decided = new Set<string>();
  for (const s of existing) {
    if (s.status === "pending") pending.set(`${s.key}#${s.program}`, s);
    else decided.add(`${s.key}#${s.program}#${s.fingerprint}`);
  }

  const inserts: (typeof programSuggestions.$inferInsert)[] = [];
  const stillPending = new Set<number>();
  let refreshed = 0;
  for (const e of people) {
    const matches = dx.get(e.key);
    if (!matches?.length) continue;
    for (const s of suggestPrograms(matches, standingOf(roster.get(e.key)))) {
      const fingerprint = diagnosesFingerprint(s.diagnoses);
      const open = pending.get(`${e.key}#${s.program}`);
      if (open) {
        stillPending.add(open.id);
        if (open.fingerprint !== fingerprint || open.reason !== s.reason || open.clinicId !== e.clinicId || open.lastVisit !== e.lastVisit) {
          await d.update(programSuggestions).set({ reason: s.reason.slice(0, 500), diagnoses: s.diagnoses, fingerprint, clinicId: e.clinicId, lastVisit: e.lastVisit, name: e.name.slice(0, 255) }).where(eq(programSuggestions.id, open.id));
          refreshed++;
        }
        continue;
      }
      if (decided.has(`${e.key}#${s.program}#${fingerprint}`)) continue; // approved or "not now" for these same diagnoses
      inserts.push({
        subjectKey: e.key, patientId: e.patientId, name: e.name.slice(0, 255), dob: e.dob, clinicId: e.clinicId, program: s.program, status: "pending",
        reason: s.reason.slice(0, 500), diagnoses: s.diagnoses, fingerprint, lastVisit: e.lastVisit,
      });
    }
  }
  for (let i = 0; i < inserts.length; i += 300) await d.insert(programSuggestions).values(inserts.slice(i, i + 300));
  // Waiting suggestions that no longer apply: outside the start date, or they no longer qualify / were enrolled another way.
  const gone = Array.from(pending.values()).filter((s) => !stillPending.has(s.id));
  const outside = gone.filter((s) => !keys.has(s.key)).map((s) => s.id);
  const other = gone.filter((s) => keys.has(s.key)).map((s) => s.id);
  for (const [ids, note] of [[outside, `Not seen since ${since}`], [other, "No longer qualifies (or enrolled another way)"]] as const) {
    for (let i = 0; i < ids.length; i += 500) {
      await d.update(programSuggestions).set({ status: "withdrawn", decisionNote: note, decidedAt: new Date() }).where(inArray(programSuggestions.id, ids.slice(i, i + 500)));
    }
  }
  const withdraw = gone;
  const newPatients = new Set(inserts.map((s) => s.subjectKey)).size;
  if (newPatients) await notifyApprovers(newPatients, inserts);
  const waiting = await d.select({ key: programSuggestions.subjectKey }).from(programSuggestions).where(eq(programSuggestions.status, "pending"));
  const summary = { since, checked: people.length, withDiagnoses: dx.size, added: inserts.length, newPatients, refreshed, withdrawn: withdraw.length, withdrawnOutsideDates: outside.length, waitingPatients: new Set(waiting.map((w) => w.key)).size, waitingSuggestions: waiting.length };
  console.log(`[program-suggest] ${JSON.stringify(summary)}`); // counts only
  return summary;
}

/** Tell each approver how many new patients are waiting for them (their office only, for an office manager). */
async function notifyApprovers(total: number, added: (typeof programSuggestions.$inferInsert)[]) {
  const d = await db();
  const ids = await programApproverIds();
  if (!ids.length) return;
  const approvers = await d.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, ids));
  for (const a of approvers) {
    const scope = a.role === "office_manager" ? await officeClinicIds(a.id) : null;
    const n = scope ? new Set(added.filter((s) => s.clinicId != null && scope.includes(s.clinicId)).map((s) => s.subjectKey)).size : total;
    if (!n) continue;
    await d.insert(notifications).values({
      userId: a.id, type: "task", title: `${n} patient${n === 1 ? "" : "s"} qualify for care programs`,
      content: "Their diagnoses qualify them for CCM, BHI, RPM or APCM. Review and approve them in Program approvals.",
    });
  }
}

// ---------------------------------------------------------------------------
// The approval tab
// ---------------------------------------------------------------------------

export interface SuggestionFilters {
  status: "pending" | "approved" | "rejected";
  program?: SuggestProgram | null;
  clinicId?: number | null;
  q?: string | null;
  page: number;
}
const PAGE = 25;

const inScope = (actor: WorkspaceActor, clinicId: number | null) => !actor.clinicIds || (clinicId != null && actor.clinicIds.includes(clinicId));

export async function listSuggestions(actor: WorkspaceActor, f: SuggestionFilters) {
  const d = await db();
  const rows = await d.select({ s: programSuggestions, decidedBy: users.name }).from(programSuggestions)
    .leftJoin(users, eq(users.id, programSuggestions.decidedByUserId))
    .where(eq(programSuggestions.status, f.status))
    .orderBy(asc(programSuggestions.name))
    .limit(20000);
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));
  const mine = rows.filter(({ s }) => inScope(actor, s.clinicId));
  // Counts per program (before the program / search filters), for the chips.
  const counts: Record<SuggestProgram, number> = { ccm: 0, bhi: 0, rpm: 0, apcm: 0 };
  for (const { s } of mine) if ((SUGGEST_PROGRAMS as readonly string[]).includes(s.program) && (!f.clinicId || s.clinicId === f.clinicId)) counts[s.program as SuggestProgram]++;
  const words = nameKey(f.q ?? "").split(" ").filter(Boolean);
  const groups = new Map<string, { key: string; patientId: number | null; name: string; dob: string | null; clinicId: number | null; clinicName: string | null; lastVisit: string | null; items: { id: number; program: SuggestProgram; reason: string; diagnoses: MatchedDiagnosis[]; decidedBy: string | null; decidedAt: Date | null; note: string | null }[] }>();
  for (const { s, decidedBy } of mine) {
    if (f.clinicId && s.clinicId !== f.clinicId) continue;
    if (words.length && !words.every((w) => nameKey(s.name).includes(w))) continue;
    let g = groups.get(s.subjectKey);
    if (!g) {
      g = { key: s.subjectKey, patientId: s.patientId, name: s.name, dob: s.dob, clinicId: s.clinicId, clinicName: s.clinicId ? clinicName.get(s.clinicId) ?? null : null, lastVisit: s.lastVisit, items: [] };
      groups.set(s.subjectKey, g);
    }
    g.items.push({ id: s.id, program: s.program as SuggestProgram, reason: s.reason, diagnoses: (s.diagnoses ?? []) as MatchedDiagnosis[], decidedBy, decidedAt: s.decidedAt, note: s.decisionNote });
  }
  const order: SuggestProgram[] = ["ccm", "bhi", "apcm", "rpm"];
  let list = Array.from(groups.values()).map((g) => ({ ...g, items: g.items.sort((a, b) => order.indexOf(a.program) - order.indexOf(b.program)) }));
  if (f.program) list = list.filter((g) => g.items.some((i) => i.program === f.program));
  if (f.status !== "pending") list.sort((a, b) => +(b.items[0]?.decidedAt ?? 0) - +(a.items[0]?.decidedAt ?? 0));
  const page = Math.max(1, f.page);
  const myClinics = Array.from(new Set(mine.map(({ s }) => s.clinicId).filter((c): c is number => c != null)))
    .map((id) => ({ id, name: clinicName.get(id) ?? "Clinic" })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    groups: list.slice((page - 1) * PAGE, page * PAGE),
    total: list.length,
    page,
    pageSize: PAGE,
    counts,
    clinics: myClinics,
    scope: actor.clinicIds ? "office" as const : "all" as const,
    since: await getSeenSince(),
  };
}

/** Patients waiting (for the sidebar badge). */
export async function pendingPatientCount(actor: WorkspaceActor): Promise<number> {
  const d = await db();
  const rows = await d.select({ key: programSuggestions.subjectKey, clinicId: programSuggestions.clinicId }).from(programSuggestions).where(eq(programSuggestions.status, "pending"));
  return new Set(rows.filter((r) => inScope(actor, r.clinicId)).map((r) => r.key)).size;
}

// ---------------------------------------------------------------------------
// Approving and "not now"
// ---------------------------------------------------------------------------

export interface Decision {
  subjectKey: string;
  approve: SuggestProgram[];
  reject: SuggestProgram[];
}

/** Up to 25 patients at a time (each approval enrolls, which takes a moment). */
export async function decideSuggestions(actor: WorkspaceActor, decisions: Decision[], note: string | null) {
  if (decisions.length > 25) throw new WorkspaceError("At most 25 patients at a time.");
  const d = await db();
  const results: { subjectKey: string; enrolled: string[]; notNow: string[]; error?: string }[] = [];
  for (const dec of decisions) {
    const open = await d.select().from(programSuggestions).where(and(eq(programSuggestions.subjectKey, dec.subjectKey), eq(programSuggestions.status, "pending")));
    if (!open.length) { results.push({ subjectKey: dec.subjectKey, enrolled: [], notNow: [], error: "Already decided" }); continue; }
    if (!open.every((s) => inScope(actor, s.clinicId))) throw new WorkspaceError("That patient isn't at your office.", "FORBIDDEN");
    const byProgram = new Map(open.map((s) => [s.program, s]));
    const approve = dec.approve.filter((p) => byProgram.has(p));
    const reject = dec.reject.filter((p) => byProgram.has(p) && !approve.includes(p));
    try {
      if (reject.length) {
        await d.update(programSuggestions).set({ status: "rejected", decidedByUserId: actor.id, decidedAt: new Date(), decisionNote: note?.slice(0, 255) ?? null })
          .where(inArray(programSuggestions.id, reject.map((p) => byProgram.get(p)!.id)));
        await audit(actor, "update_patient", { entityType: "programSuggestion", entityId: byProgram.get(reject[0]!)!.patientId ?? undefined, description: `Not now: ${reject.map((p) => SUGGEST_PROGRAM_LABELS[p]).join(", ")} (from diagnoses)` });
      }
      if (approve.length) await approveOne(actor, open.find((s) => approve.includes(s.program as SuggestProgram))!, approve.map((p) => byProgram.get(p)!), note);
      results.push({ subjectKey: dec.subjectKey, enrolled: approve.map((p) => SUGGEST_PROGRAM_LABELS[p]), notNow: reject.map((p) => SUGGEST_PROGRAM_LABELS[p]) });
    } catch (e) {
      results.push({ subjectKey: dec.subjectKey, enrolled: [], notNow: [], error: (e as Error).message });
    }
  }
  clearDirectoryCache();
  return { results };
}

type Suggestion = typeof programSuggestions.$inferSelect;

async function approveOne(actor: WorkspaceActor, first: Suggestion, items: Suggestion[], note: string | null) {
  const d = await db();
  const allDx = items.flatMap((s) => (s.diagnoses ?? []) as MatchedDiagnosis[]);
  const patientId = await rosterPatientFor(first, allDx);
  const p = await getPatientById(patientId);
  if (!p) throw new Error("Couldn't open their roster record.");
  const month = currentMonth();
  const programs = items.map((s) => s.program as SuggestProgram);
  const lastVisit = first.lastVisit ? new Date(`${first.lastVisit}T12:00:00Z`) : null;

  // Their diagnoses go on the record (chronic conditions; behavioral ones for BHI), and their latest visit.
  const chronic = mergeConditions((p.chronicConditions as string[]) ?? [], allDx.filter((x) => x.category !== "adjustment" && x.category !== "ocd" && x.category !== "adhd" && x.category !== "eating"));
  const visitPatch = lastVisit && (!p.lastOfficeVisit || new Date(p.lastOfficeVisit) < lastVisit) ? { lastOfficeVisit: lastVisit } : {};
  await d.update(patients).set({ chronicConditions: chronic, ...visitPatch, updatedAt: new Date() }).where(eq(patients.id, patientId));

  for (const program of programs) {
    if (program === "ccm") {
      await d.update(patients).set({ ccmEnrollmentStatus: "active", ccmConsentRequired: p.consentStatus !== "consented", updatedAt: new Date() }).where(eq(patients.id, patientId));
      await ensureMonthlyTask(patientId, month, "ccm");
      await ensureMonthlyTask(patientId, month, "apcm"); // APCM follows CCM (the monthly fallback)
    } else if (program === "bhi") {
      const behavioral = allDx.filter((x) => ["depression", "anxiety", "ptsd", "bipolar", "substance", "adjustment", "ocd", "adhd", "eating"].includes(x.category)).map((x) => x.title);
      await updatePatientBHI(patientId, {
        bhiEnrollmentStatus: "active",
        ...(((p.bhiConditions as string[]) ?? []).length ? {} : { bhiConditions: behavioral }),
        ...(lastVisit && !p.bhiInitiatingVisitDate ? { bhiInitiatingVisitDate: lastVisit } : {}),
      }, month);
    } else if (program === "apcm") {
      await updatePatientAPCM(patientId, { apcmEnrollmentStatus: "active", ...(lastVisit && !p.apcmInitiatingVisitDate ? { apcmInitiatingVisitDate: lastVisit } : {}) }, month);
    } else {
      await updatePatientRPM(patientId, { rpmEnrolled: true, rpmStatus: "enrolled" });
    }
  }

  // Consent: one task listing every program that still needs it. Nothing bills until it's signed.
  const fresh = await getPatientById(patientId);
  const needConsent = programs.filter((pr) =>
    pr === "ccm" ? fresh?.consentStatus !== "consented" : pr === "bhi" ? fresh?.bhiConsentStatus !== "consented" : pr === "apcm" ? fresh?.apcmConsentStatus !== "consented" : fresh?.rpmConsentStatus !== "consented");
  const labels = programs.map((pr) => SUGGEST_PROGRAM_LABELS[pr]).join(", ");
  if (needConsent.length) {
    await createTask(actor, {
      title: `Get consent: ${needConsent.map((pr) => SUGGEST_PROGRAM_LABELS[pr]).join(", ")} — ${p.name}`.slice(0, 250),
      description: [
        `${p.name} was approved for ${labels} by ${actor.name ?? "an approver"} on ${localDateStr()}, based on the diagnoses on file:`,
        ...items.map((s) => `• ${SUGGEST_PROGRAM_LABELS[s.program as SuggestProgram]}: ${s.reason}`),
        "",
        "Before anything is billed, they need to agree. Send the Patient Consent Form from their Forms tab (it has a Yes/No for each program), or record their verbal consent.",
        `Until consent is signed, ${needConsent.filter((pr) => pr !== "rpm").map((pr) => SUGGEST_PROGRAM_LABELS[pr]).join(", ") || "the program"} won't bill.`,
        needConsent.includes("rpm") ? "RPM: once they agree, their provider confirms the RPM order, then set up their device." : null,
        note ? `Approver's note: ${note}` : null,
      ].filter((x): x is string => x !== null).join("\n"),
      patientId, assignedUserId: fresh?.assignedStaffId ?? null, assignedRole: fresh?.assignedStaffId ? null : "staff",
      priority: "normal", category: "care_management", dueDate: localDateStr(), sourceType: "program_approval", sourceRef: String(first.id),
    });
  }
  await d.update(programSuggestions).set({ status: "approved", patientId, decidedByUserId: actor.id, decidedAt: new Date(), decisionNote: note?.slice(0, 255) ?? null })
    .where(inArray(programSuggestions.id, items.map((s) => s.id)));
  await audit(actor, "update_patient", { entityType: "patient", entityId: patientId, description: `Approved for ${labels} from diagnoses on file (consent pending)` });
}

/** Add the qualifying diagnoses to a roster record's conditions (skipping ones already there under another name). */
function mergeConditions(existing: string[], dx: MatchedDiagnosis[]): string[] {
  const out = existing.filter(Boolean);
  const have = new Set(out.map((t) => classifyDiagnosis({ title: t })?.category).filter(Boolean) as string[]);
  for (const x of dx) {
    if (have.has(x.category)) continue;
    have.add(x.category);
    out.push(x.title);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Adding someone to the CCM roster (schedule-only and Practice Fusion-only patients)
// ---------------------------------------------------------------------------

/** Tables that remember a patient by key; once someone is on the roster everything follows "p:<id>". */
const KEYED_TABLES = [
  "workTasks", "opportunityActions", "emailMessages", "emailContacts", "patientTests", "personDemographics", "phoneCalls", "faxes", "fhirPatients", "fhirResources",
  "bookingRequests", "intakePackets", "consentEnrollments", "documents", "coverageOnFile", "eligibilityChecks", "squareCustomers", "squarePayments", "squareRequests", "patientFiles", "programSuggestions",
];
let keyedColumns: Map<string, boolean> | null = null; // table → has a patientId column

async function rosterPatientFor(s: Suggestion, dx: MatchedDiagnosis[]): Promise<number> {
  if (s.patientId) return s.patientId;
  const m = /^p:(\d+)$/.exec(s.subjectKey);
  if (m) return Number(m[1]);
  const d = await db();
  const entry = (await loadDirectory()).get(s.subjectKey);
  // Added to the roster since (by name + date of birth)? Use that record.
  const idx = await buildNameDobIndex();
  const same = s.dob ? idx.get(`${nameKey(s.name)}|${s.dob}`) : undefined;
  let patientId = same?.patientId ?? null;
  if (!patientId) {
    const res = await d.insert(patients).values({
      name: s.name,
      dateOfBirth: s.dob ? new Date(`${s.dob}T00:00:00Z`) : null,
      phoneNumber: (entry?.phone ?? "").slice(0, 20),
      clinicId: entry?.clinicId ?? s.clinicId ?? null,
      providerId: entry?.providerId ?? null,
      chronicConditions: mergeConditions([], dx),
      // Only the programs approved get switched on (CCM included).
      ccmEnrollmentStatus: "inactive",
      consentStatus: "pending",
      ccmConsentRequired: true,
      lastOfficeVisit: s.lastVisit ? new Date(`${s.lastVisit}T12:00:00Z`) : null,
    });
    patientId = Number((res as unknown as [{ insertId: number }])[0].insertId);
  }
  await moveToRosterKey(s.subjectKey, patientId, entry);
  await checkEnrollmentsFor(patientId); // any Yes answers from consent forms they signed before
  return patientId;
}

/** Everything filed under their old key now belongs to the roster record. */
export async function moveToRosterKey(oldKey: string, patientId: number, entry: DirectoryEntry | undefined) {
  const d = await db();
  const newKey = `p:${patientId}`;
  if (!keyedColumns) {
    const cols = await d.execute(sql`SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('subjectKey', 'patientId')`);
    const list = ((cols as unknown as [{ t: string; c: string }[]])[0] ?? []);
    const has = (t: string, c: string) => list.some((r) => r.t.toLowerCase() === t.toLowerCase() && r.c === c);
    keyedColumns = new Map(KEYED_TABLES.filter((t) => has(t, "subjectKey")).map((t) => [t, has(t, "patientId")]));
  }
  for (const [table, hasPatientId] of Array.from(keyedColumns.entries())) {
    if (table === "workTasks") {
      await d.execute(sql`UPDATE \`workTasks\` SET \`patientId\` = ${patientId}, \`subjectKey\` = NULL, \`subjectName\` = NULL WHERE \`subjectKey\` = ${oldKey}`);
      continue;
    }
    if (table === "programSuggestions") {
      await d.update(programSuggestions).set({ subjectKey: newKey, patientId }).where(eq(programSuggestions.subjectKey, oldKey));
      continue;
    }
    // IGNORE: a row the roster record already has (same unique key) stays as it was.
    await d.execute(hasPatientId
      ? sql`UPDATE IGNORE ${sql.raw(`\`${table}\``)} SET \`subjectKey\` = ${newKey}, \`patientId\` = ${patientId} WHERE \`subjectKey\` = ${oldKey}`
      : sql`UPDATE IGNORE ${sql.raw(`\`${table}\``)} SET \`subjectKey\` = ${newKey} WHERE \`subjectKey\` = ${oldKey}`);
  }
  // Their visits on the imported schedule.
  if (oldKey.startsWith("s:") && entry?.dob) {
    const rows = await d.select({ id: appointments.id, name: appointments.patientName, dob: appointments.dateOfBirth }).from(appointments)
      .where(and(isNull(appointments.patientId), gte(appointments.dateOfBirth, new Date(`${addDays(entry.dob, -1)}T00:00:00Z`)), lte(appointments.dateOfBirth, new Date(`${addDays(entry.dob, 1)}T23:59:59Z`))));
    const ids = rows.filter((r) => subjectKeyFor(null, r.name, r.dob) === oldKey).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 500) await d.update(appointments).set({ patientId }).where(inArray(appointments.id, ids.slice(i, i + 500)));
  }
  clearScheduleCache();
  clearDirectoryCache();
}

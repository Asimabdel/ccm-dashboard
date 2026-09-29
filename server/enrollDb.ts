// Program consents from signed forms, and automatic enrollment.
//
// When a patient answers Yes to CCM / APCM / BHI / RPM on a consent form, their consent is recorded on the
// patient record and they're enrolled as soon as they're on the roster and their diagnoses on file qualify
// (the practice's rules: shared/workspace.ts enrollmentEligibility). Until then the Yes waits in
// consentEnrollments and is re-checked every half hour and whenever their record changes.
// A No marks the consent declined right away (so the program won't bill) and, if they're enrolled, asks their
// coordinator to confirm with them before anything is switched off.
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  ensureMonthlyTask, getCCMTaskByPatientAndMonth, getDb, getPatientById, recomputeBilling, updatePatientAPCM, updatePatientBHI, updatePatientRPM,
} from "./db";
import { currentMonth } from "./seed";
import { consentEnrollments, patients, users } from "../drizzle/schema";
import {
  ENROLL_PROGRAMS, ENROLL_PROGRAM_LABELS, behavioralConditions, enrollmentEligibility, type EnrollProgram,
} from "../shared/workspace";
import type { ChoiceAnswer, ConsentKind } from "../shared/intake";
import { matchFaxPatient, type PersonRef } from "../shared/fax";
import { localDateStr } from "../shared/workforce";
import { audit, buildNameDobIndex, createTask, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export const isEnrollProgram = (k: string | null | undefined): k is EnrollProgram => !!k && (ENROLL_PROGRAMS as readonly string[]).includes(k);

/** Who automatic actions are recorded under (the first admin, named for what it is). */
async function systemActor(): Promise<WorkspaceActor> {
  const [a] = await (await db()).select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  if (!a) throw new Error("No admin user to record automatic enrollment under.");
  return { id: a.id, name: "Automatic enrollment", role: "admin", clinicIds: null };
}

export interface ConsentEvent {
  kind: ConsentKind;
  answer: ChoiceAnswer;
  at: Date;
  packetId: number;
  /** Who the form belongs to. Forms not matched to anyone yet (e.g. unverified website forms) aren't recorded until staff link them. */
  subjectKey: string;
  patientId: number | null;
  name: string;
  dob: string | null;
}

/** One Yes / No from a signed form → the patient record and (for Yes) enrollment. Returns a short note of what happened. */
export async function recordConsent(e: ConsentEvent, actor?: WorkspaceActor | null): Promise<string | null> {
  if (!isEnrollProgram(e.kind)) return null; // texting consent lives on the form itself
  const program = e.kind;
  const who = actor ?? await systemActor();
  const d = await db();
  const patientId = e.patientId ?? pidOf(e.subjectKey);
  // The newest answer wins: an earlier Yes that's still waiting is replaced.
  await d.update(consentEnrollments).set({ status: "cancelled", note: e.answer === "no" ? "They said No on a later form" : "Replaced by a newer Yes" })
    .where(and(eq(consentEnrollments.status, "waiting"), eq(consentEnrollments.program, program),
      patientId ? or(eq(consentEnrollments.patientId, patientId), eq(consentEnrollments.subjectKey, e.subjectKey)) : eq(consentEnrollments.subjectKey, e.subjectKey)));
  if (patientId) await setConsent(patientId, program, e.answer, e.at);
  const label = ENROLL_PROGRAM_LABELS[program];
  if (e.answer === "no") {
    const asked = patientId ? await askToConfirmNo(patientId, program, e.packetId, who) : false;
    await audit(who, "update_patient", {
      entityType: patientId ? "patient" : "intakePacket", entityId: patientId ?? e.packetId,
      description: `${label} consent declined on a signed consent form (packet #${e.packetId})${asked ? "; coordinator asked to confirm (still enrolled)" : ""}`,
    });
    return `${label}: said No${asked ? " (coordinator asked to confirm)" : ""}`;
  }
  const res = await d.insert(consentEnrollments).values({
    subjectKey: e.subjectKey, patientId, name: e.name.slice(0, 255), dob: e.dob, program, status: "waiting", packetId: e.packetId, consentedAt: e.at,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  return tryEnroll(id, who);
}

const pidOf = (key: string | null | undefined) => { const m = /^p:(\d+)$/.exec(key ?? ""); return m ? Number(m[1]) : null; };

/** The consent fields billing checks (and the dates). */
async function setConsent(patientId: number, program: EnrollProgram, answer: ChoiceAnswer, at: Date) {
  const status = answer === "yes" ? "consented" as const : "declined" as const;
  const month = currentMonth();
  const d = await db();
  if (program === "ccm") {
    await d.update(patients).set({ consentStatus: status, ...(status === "consented" ? { ccmConsentDate: at } : {}), updatedAt: new Date() }).where(eq(patients.id, patientId));
    const task = await getCCMTaskByPatientAndMonth(patientId, month, "ccm");
    if (task) await recomputeBilling(task.id, month);
  } else if (program === "bhi") {
    await updatePatientBHI(patientId, { bhiConsentStatus: status, ...(status === "consented" ? { bhiConsentDate: at } : {}) }, month);
    const task = await getCCMTaskByPatientAndMonth(patientId, month, "bhi");
    if (task) await recomputeBilling(task.id, month);
  } else if (program === "apcm") {
    await updatePatientAPCM(patientId, { apcmConsentStatus: status, ...(status === "consented" ? { apcmConsentDate: at } : {}) }, month);
  } else {
    await d.update(patients).set({ rpmConsentStatus: status, ...(status === "consented" ? { rpmConsentDate: at } : {}), updatedAt: new Date() }).where(eq(patients.id, patientId));
  }
}

type Patient = NonNullable<Awaited<ReturnType<typeof getPatientById>>>;

/** Enrolled in the program. `covered` also counts APCM's CCM mirror (a CCM patient is on APCM as the fallback). */
function isEnrolled(p: Patient, program: EnrollProgram, covered = false) {
  if (program === "ccm") return p.ccmEnrollmentStatus === "active";
  if (program === "bhi") return p.bhiEnrollmentStatus === "active";
  if (program === "apcm") return p.apcmEnrollmentStatus === "active" || (covered && p.ccmEnrollmentStatus === "active");
  return !!p.rpmEnrolled || ["enrolled", "active"].includes(p.rpmStatus ?? "");
}

/** They said No but are enrolled: nothing is switched off; their coordinator confirms first. */
async function askToConfirmNo(patientId: number, program: EnrollProgram, packetId: number, actor: WorkspaceActor) {
  const p = await getPatientById(patientId);
  if (!p || !isEnrolled(p, program, true)) return false;
  const label = ENROLL_PROGRAM_LABELS[program];
  await createTask(actor, {
    title: `Confirm: ${p.name} said No to ${label} on their consent form`.slice(0, 250),
    description: [
      `${p.name} is enrolled in ${label} but answered No on a consent form.`,
      `Their ${label} consent is now marked declined, so ${label} won't bill until it's resolved.`,
      "",
      `Call to confirm. If they want to stop, change their ${label} enrollment. If it was a mistake, send the consent again or record their verbal consent.`,
      `Signed form: /intake-forms?p=${packetId}`,
    ].join("\n"),
    patientId, assignedUserId: p.assignedStaffId ?? null, assignedRole: p.assignedStaffId ? null : "staff",
    priority: "high", category: program === "rpm" ? "rpm" : "care_management", dueDate: localDateStr(), sourceType: "consent_no", sourceRef: String(packetId),
  });
  return true;
}

/** Roster people by name + date of birth (for Yes answers from people added to the roster later). */
async function rosterPeople(): Promise<PersonRef[]> {
  const idx = await buildNameDobIndex();
  return Array.from(idx.entries()).filter(([, v]) => v.patientId).map(([k, v]) => ({ ...v, dob: k.split("|")[1] ?? null }));
}

/** Enroll one waiting Yes if they're on the roster and qualify; otherwise note why it's still waiting. */
export async function tryEnroll(id: number, actor?: WorkspaceActor | null, people?: PersonRef[]): Promise<string | null> {
  const d = await db();
  const [row] = await d.select().from(consentEnrollments).where(eq(consentEnrollments.id, id)).limit(1);
  if (!row || row.status !== "waiting" || !isEnrollProgram(row.program)) return null;
  const program = row.program;
  const label = ENROLL_PROGRAM_LABELS[program];
  const now = new Date();
  let patientId = row.patientId ?? pidOf(row.subjectKey);
  if (!patientId) {
    const m = matchFaxPatient(row.name, row.dob, people ?? await rosterPeople());
    if (m?.sure && m.person.patientId) patientId = m.person.patientId;
  }
  const p = patientId ? await getPatientById(patientId) : undefined;
  if (!p) {
    await d.update(consentEnrollments).set({ lastCheckedAt: now, note: "Not on the CCM roster yet" }).where(eq(consentEnrollments.id, id));
    return `${label}: waiting (not on the roster yet)`;
  }
  if (!row.patientId) {
    // Found them on the roster now: their consent goes on the record first.
    await d.update(consentEnrollments).set({ patientId: p.id }).where(eq(consentEnrollments.id, id));
    await setConsent(p.id, program, "yes", row.consentedAt);
  }
  if (isEnrolled(p, program)) {
    await d.update(consentEnrollments).set({ status: "enrolled", enrolledAt: now, lastCheckedAt: now, note: "Already enrolled" }).where(eq(consentEnrollments.id, id));
    return `${label}: already enrolled`;
  }
  const elig = enrollmentEligibility(program, { chronicConditions: (p.chronicConditions as string[]) ?? [], bhiConditions: (p.bhiConditions as string[]) ?? [], rpmStatus: p.rpmStatus ?? null });
  if (!elig.eligible) {
    await d.update(consentEnrollments).set({ lastCheckedAt: now, note: elig.reason.slice(0, 255) }).where(eq(consentEnrollments.id, id));
    return `${label}: waiting (${elig.reason})`;
  }
  const who = actor ?? await systemActor();
  await enroll(p, program, row.consentedAt, row.packetId, who);
  await d.update(consentEnrollments).set({ status: "enrolled", enrolledAt: now, lastCheckedAt: now, note: elig.reason.slice(0, 255) }).where(eq(consentEnrollments.id, id));
  await audit(who, "update_patient", {
    entityType: "patient", entityId: p.id,
    description: `Enrolled in ${label} automatically: said Yes on a consent form${row.packetId ? ` (packet #${row.packetId})` : ""}; ${elig.reason}`,
  });
  return `${label}: enrolled`;
}

/** The same changes staff make when they enroll someone by hand. */
async function enroll(p: Patient, program: EnrollProgram, consentedAt: Date, packetId: number | null, actor: WorkspaceActor) {
  const month = currentMonth();
  const d = await db();
  if (program === "ccm") {
    await d.update(patients).set({ ccmEnrollmentStatus: "active", consentStatus: "consented", ccmConsentDate: consentedAt, updatedAt: new Date() }).where(eq(patients.id, p.id));
    await ensureMonthlyTask(p.id, month, "ccm");
  } else if (program === "apcm") {
    await updatePatientAPCM(p.id, { apcmEnrollmentStatus: "active", apcmConsentStatus: "consented", apcmConsentDate: consentedAt }, month);
  } else if (program === "bhi") {
    const bhiConditions = ((p.bhiConditions as string[]) ?? []).length ? undefined : behavioralConditions((p.chronicConditions as string[]) ?? []);
    await updatePatientBHI(p.id, { bhiEnrollmentStatus: "active", bhiConsentStatus: "consented", bhiConsentDate: consentedAt, ...(bhiConditions?.length ? { bhiConditions } : {}) }, month);
  } else {
    await updatePatientRPM(p.id, { rpmEnrolled: true, rpmStatus: "enrolled" });
    await d.update(patients).set({ rpmConsentStatus: "consented", rpmConsentDate: consentedAt }).where(eq(patients.id, p.id));
    await createTask(actor, {
      title: `Set up remote monitoring (RPM) for ${p.name}`.slice(0, 250),
      description: [
        `${p.name} said Yes to Remote Patient Monitoring on their consent form and was enrolled automatically.`,
        "Confirm their provider orders RPM. Then choose their device (blood pressure cuff, glucose meter or scale), get it to them, show them how to use it, and record the device type on their record.",
        packetId ? `Signed form: /intake-forms?p=${packetId}` : null,
      ].filter(Boolean).join("\n"),
      patientId: p.id, assignedUserId: p.assignedStaffId ?? null, assignedRole: p.assignedStaffId ? null : "staff",
      priority: "normal", category: "rpm", dueDate: localDateStr(), sourceType: "consent_rpm", sourceRef: packetId ? String(packetId) : null,
    });
  }
}

/** Re-check every waiting Yes (every half hour, IAM-only job "auto-enroll"). */
export async function sweepEnrollments() {
  const d = await db();
  const rows = await d.select({ id: consentEnrollments.id }).from(consentEnrollments).where(eq(consentEnrollments.status, "waiting"))
    .orderBy(sql`${consentEnrollments.lastCheckedAt} IS NOT NULL`, asc(consentEnrollments.lastCheckedAt)).limit(400);
  if (!rows.length) return { checked: 0, enrolled: 0 };
  const people = await rosterPeople();
  let enrolled = 0;
  for (const r of rows) {
    try {
      if ((await tryEnroll(r.id, null, people))?.endsWith(": enrolled")) enrolled++;
    } catch (e) {
      console.error("[auto-enroll] failed for row", r.id, (e as Error).message);
    }
  }
  const waiting = (await d.select({ n: sql<number>`COUNT(*)` }).from(consentEnrollments).where(eq(consentEnrollments.status, "waiting")))[0]?.n ?? 0;
  console.log(`[auto-enroll] ${JSON.stringify({ checked: rows.length, enrolled, waiting: Number(waiting) })}`); // counts only
  return { checked: rows.length, enrolled, waiting: Number(waiting) };
}

/** Right after staff add someone to the roster or change their conditions: check their waiting Yes answers now. */
export async function checkEnrollmentsFor(patientId: number) {
  const d = await db();
  const rows = await d.select({ id: consentEnrollments.id }).from(consentEnrollments)
    .where(and(eq(consentEnrollments.status, "waiting"), or(eq(consentEnrollments.patientId, patientId), isNull(consentEnrollments.patientId))));
  if (!rows.length) return;
  const people = await rosterPeople();
  for (const r of rows) await tryEnroll(r.id, null, people);
}

/** Patient 360: the latest Yes per program for this person (waiting or enrolled), with why. */
export async function enrollmentsForSubject(subjectKey: string) {
  const d = await db();
  const pid = pidOf(subjectKey);
  const rows = await d.select().from(consentEnrollments)
    .where(pid ? or(eq(consentEnrollments.subjectKey, subjectKey), eq(consentEnrollments.patientId, pid)) : eq(consentEnrollments.subjectKey, subjectKey))
    .orderBy(desc(consentEnrollments.consentedAt), desc(consentEnrollments.id)).limit(40);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.program) && r.status !== "cancelled") latest.set(r.program, r);
  return Object.fromEntries(Array.from(latest.entries()).map(([k, r]) => [k, { status: r.status as "waiting" | "enrolled", note: r.note, consentedAt: r.consentedAt, enrolledAt: r.enrolledAt, packetId: r.packetId }]));
}

/** Staff list: everyone who said Yes to a program on a form (waiting first). */
export async function listEnrollments(actor: WorkspaceActor, status: "waiting" | "enrolled" | "all") {
  const d = await db();
  const rows = await d.select({ e: consentEnrollments, clinicId: patients.clinicId }).from(consentEnrollments)
    .leftJoin(patients, eq(patients.id, consentEnrollments.patientId))
    .where(status === "all" ? inArray(consentEnrollments.status, ["waiting", "enrolled"]) : eq(consentEnrollments.status, status))
    .orderBy(desc(consentEnrollments.consentedAt)).limit(500);
  return rows
    .filter((r) => !actor.clinicIds || (r.clinicId != null && actor.clinicIds.includes(r.clinicId)))
    .map(({ e }) => ({
      id: e.id, name: e.name, program: e.program as EnrollProgram, status: e.status as "waiting" | "enrolled", note: e.note,
      consentedAt: e.consentedAt, enrolledAt: e.enrolledAt, lastCheckedAt: e.lastCheckedAt, packetId: e.packetId, patientId: e.patientId, subjectKey: e.subjectKey,
    }));
}

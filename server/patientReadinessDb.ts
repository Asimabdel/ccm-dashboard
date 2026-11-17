// Patient 360 → "Ready for the next visit?": gathers what the existing parts of MyPCP know about one
// patient (forms, insurance checks, Testing, in-office tests, care plan, high deductible) and turns it
// into one checklist (shared/readiness.ts). Each part only shows for the people allowed to see it, and
// a part that can't be read (out of someone's clinic, not set up) is simply left out.
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { coverageOnFile, patientCarePlans, patients } from "../drizzle/schema";
import { can, type WorkspaceCap } from "../shared/workspace";
import { buildReadiness, type ReadinessInput } from "../shared/readiness";
import { OFFICE_TEST_LABELS, isOpenState, type OfficeTest, type OfficeTestState } from "../shared/officeTests";
import { localDateStr } from "../shared/workforce";
import type { WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

/** Settled value, or null when that part couldn't be read. */
async function part<T>(on: boolean, f: () => Promise<T>): Promise<T | null> {
  if (!on) return null;
  try {
    return await f();
  } catch {
    return null;
  }
}

export async function patientReadiness(actor: WorkspaceActor, key: string) {
  const allowed = (cap: WorkspaceCap) => can(actor.role, cap);
  const pid = /^p:(\d+)$/.exec(key) ? Number(key.slice(2)) : null;
  const testable = /^(p:\d+|s:.+)$/.test(key);

  const [forms, testing, office, insurance, deductible, carePlan, collect] = await Promise.all([
    part(allowed("intakeForms"), async () => {
      const { subjectForms, listDocuments } = await import("./intakeDb");
      const [f, docs] = await Promise.all([subjectForms(actor, key), listDocuments()]);
      // The consent form is the library form with the Yes/No program questions in it.
      const consentKeys = docs.filter((x) => x.choices.length > 0).map((x) => x.key);
      return { packets: f.packets, consentKeys };
    }),
    part(allowed("patientFull") && testable, async () => {
      const { personTesting } = await import("./testingDb");
      const t = await personTesting(key);
      return t.statuses.map((s) => ({ key: s.key, label: s.label, state: s.state, lastDone: s.lastDone?.date ?? null, dueOn: s.dueOn ?? null }));
    }),
    part(allowed("flowView"), async () => {
      const { officeTestingFor } = await import("./officeTestingDb");
      const o = await officeTestingFor(key);
      return o.tests.filter((t) => isOpenState(t.state as OfficeTestState)).map((t) => ({
        label: OFFICE_TEST_LABELS[t.test as OfficeTest] ?? t.test, state: t.state, scheduledFor: t.scheduledFor ?? null, lastDone: t.lastDone ?? null,
      }));
    }),
    part(allowed("eligibility"), async () => {
      // Only once Availity is connected for real: demo answers are samples, not this patient's coverage.
      const { availityLive, checkHistory } = await import("./availityDb");
      if (!(await availityLive())) return null;
      const [history, [cov]] = await Promise.all([
        checkHistory(actor, key),
        (await db()).select({ key: coverageOnFile.subjectKey }).from(coverageOnFile).where(eq(coverageOnFile.subjectKey, key)).limit(1),
      ]);
      const c = history[0];
      return {
        onFile: !!cov,
        latest: c ? { status: c.status, createdAt: c.createdAt, active: c.summary?.active ?? null, statusText: c.summary?.statusText ?? null, payerName: c.summary?.payerName ?? c.payerName ?? null } : null,
      };
    }),
    part(allowed("flowView"), async () => {
      const { highDeductibleKeys } = await import("./masterBillingDb");
      const hit = (await highDeductibleKeys()).get(key);
      return hit ? { visits: hit.visits } : null;
    }),
    part(allowed("carePlans") && !!pid, async () => {
      const d = await db();
      const [pt] = await d.select({ ccm: patients.ccmEnrollmentStatus }).from(patients).where(eq(patients.id, pid!)).limit(1);
      if (pt?.ccm !== "active") return null;
      const [row] = await d.select({ version: patientCarePlans.version, signedVersion: patientCarePlans.signedVersion, signedByName: patientCarePlans.signedByName, signedAt: patientCarePlans.signedAt })
        .from(patientCarePlans).where(eq(patientCarePlans.patientId, pid!)).limit(1);
      const status = !row ? "none" : row.signedVersion == null ? "draft" : row.signedVersion === row.version ? "signed" : "changed";
      return { status, signedByName: row?.signedByName ?? null, signedAt: row?.signedAt ?? null } as const;
    }),
    part(allowed("eligibility"), async () => {
      const { visitCostForPatient } = await import("./visitCostDb");
      const note = (await visitCostForPatient(actor, key)).note;
      return note ? { kind: note.kind, label: note.label, detail: note.detail } : null;
    }),
  ]);

  const input: ReadinessInput = { today: localDateStr(), forms, testing, officeTests: office, insurance, highDeductible: deductible, carePlan, collect };
  return { items: buildReadiness(input) };
}

/**
 * The checklist's "Check now": an Availity check with the insurance already on file (no typing).
 * Without insurance on file, the Insurance tab is where it gets added.
 */
export async function quickInsuranceCheck(actor: WorkspaceActor, key: string) {
  const { checkDefaults, runCheck } = await import("./availityDb");
  const { WorkspaceError } = await import("./workspaceDb");
  const d = await checkDefaults(actor, key);
  if (!d.configured) throw new WorkspaceError("Availity isn't connected yet.", "BAD_REQUEST");
  if (!d.onFile) throw new WorkspaceError("There's no insurance on file for this patient. Add it on the Insurance tab.", "BAD_REQUEST");
  if (!d.firstName || !d.lastName || !d.dob) throw new WorkspaceError("The patient's name or date of birth is missing. Check them on the Insurance tab.", "BAD_REQUEST");
  const sex = d.sex === "F" || d.sex === "M" || d.sex === "X" ? d.sex : null;
  return runCheck(actor, {
    subjectKey: key, payerId: d.onFile.payerId, payerName: d.onFile.payerName, memberId: d.onFile.memberId, groupNumber: d.onFile.groupNumber,
    firstName: d.firstName, lastName: d.lastName, dob: d.dob, sex,
  });
}

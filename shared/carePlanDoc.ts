// A patient's CCM comprehensive care plan: one section per chronic condition (from the provider-approved
// condition templates, then individualized), plus the plan-wide parts CMS expects (patient goals,
// medication management, care team and 24/7 access, community resources, advance care planning,
// follow-up). Pure: used by the server (building, storing, the text copy) and the client (editor, print).
import type { CarePlanTemplate } from "./conditionLibrary/types";

export interface PlanProblem extends CarePlanTemplate {
  /** Condition key (programRules category), or null for a problem the provider added by hand. */
  key: string | null;
  /** The diagnosis as on the patient's record, e.g. "Type 2 diabetes mellitus without complications (E11.9)". */
  diagnosis: string;
  /** The approved template version this section started from (null: written by hand / no approved template yet). */
  templateVersion: number | null;
  /** A plan for an exact diagnosis, or an add-on for a complication / overlap of conditions. */
  kind?: "condition" | "addon";
  /** The exact type wasn't on the record, so the most common type was assumed (e.g. "Diabetes" → Type 2). */
  assumed?: boolean;
  /** A general plan because the type isn't documented (heart-failure EF, CKD stage, liver-disease cause). */
  confirmType?: boolean;
}

export interface PlanGeneral {
  /** What matters to the patient, in their words. */
  patientGoals: string;
  medications: string;
  careTeam: string;
  community: string;
  advanceCare: string;
  followUp: string;
}

export const PLAN_LIST_FIELDS = ["goals", "monitoring", "interventions", "selfManagement", "symptomManagement", "coordination"] as const;
export type PlanListField = (typeof PLAN_LIST_FIELDS)[number];
export const PLAN_FIELD_LABELS: Record<PlanListField | "expectedOutcome", string> = {
  expectedOutcome: "Expected outcome",
  goals: "Measurable goals",
  monitoring: "Monitoring",
  interventions: "Planned interventions",
  selfManagement: "Patient self-management",
  symptomManagement: "Symptom management",
  coordination: "Coordination & resources",
};
export const GENERAL_LABELS: Record<keyof PlanGeneral, string> = {
  patientGoals: "Patient's own goals and priorities",
  medications: "Medication management",
  careTeam: "Care team and 24/7 access",
  community: "Psychosocial needs and community resources",
  advanceCare: "Advance care planning",
  followUp: "Follow-up and plan review",
};

/** The plan-wide parts, ready for the care team to individualize. */
export function defaultGeneral(opts: { providerName?: string | null; coordinatorName?: string | null; clinicPhone?: string | null }): PlanGeneral {
  const provider = opts.providerName?.trim() || "the patient's primary care provider";
  const coord = opts.coordinatorName?.trim() || "the assigned MyPCP care coordinator";
  const phone = opts.clinicPhone?.trim() ? ` at ${opts.clinicPhone.trim()}` : "";
  return {
    patientGoals: "",
    medications: "Reconcile the full medication list (including over-the-counter medicines and supplements) at each monthly contact and after any hospital or ER visit. Review adherence, side effects and cost barriers; coordinate refills and prior authorizations; report concerns to the provider.",
    careTeam: `Primary provider: ${provider}. Care coordinator: ${coord}. The patient can reach the care team 24 hours a day, 7 days a week${phone} for urgent care needs, with continuity through the designated care team member.`,
    community: "Screen for social needs (food, housing, transportation, cost of care, caregiver support, safety) at least yearly and when circumstances change; connect the patient to community and home- and community-based services as needed.",
    advanceCare: "Discuss goals of care and advance directives (medical power of attorney, living will) and document the patient's preferences; revisit yearly or with a significant change in health.",
    followUp: "Monthly CCM contact with the care coordinator; office visits as scheduled by the provider. The plan is reviewed with the patient at least monthly during CCM contacts and revised by the provider at least yearly or when the patient's condition changes.",
  };
}

/**
 * A care-plan section for one of the patient's conditions, from the condition's approved template.
 * The section is headed by the patient's own diagnosis (the template's problem name carries
 * "specify …" guidance for the provider).
 */
export function problemFromTemplate(key: string, diagnosis: string, t: CarePlanTemplate, version: number | null): PlanProblem {
  return {
    key, diagnosis, templateVersion: version,
    problem: diagnosis.trim() || t.problem, expectedOutcome: t.expectedOutcome,
    goals: [...t.goals], monitoring: [...t.monitoring], interventions: [...t.interventions],
    selfManagement: [...t.selfManagement], symptomManagement: [...t.symptomManagement], coordination: [...t.coordination],
  };
}

/** A section for a condition with no approved template yet: the provider fills it in. */
export function emptyProblem(key: string | null, diagnosis: string, problem: string): PlanProblem {
  return { key, diagnosis, templateVersion: null, problem, expectedOutcome: "", goals: [], monitoring: [], interventions: [], selfManagement: [], symptomManagement: [], coordination: [] };
}

/** The plain-text copy of a plan (kept on the patient record, e.g. as the APCM care plan, and for notes). */
export function renderPlanText(plan: { problems: PlanProblem[]; general: PlanGeneral }, who: { patientName: string; signedBy?: string | null; signedAt?: Date | string | null }): string {
  const out: string[] = ["COMPREHENSIVE CARE PLAN (CHRONIC CARE MANAGEMENT)", `Patient: ${who.patientName}`, ""];
  out.push("PROBLEM LIST");
  plan.problems.forEach((p, i) => out.push(`  ${i + 1}. ${p.problem}${p.diagnosis && p.diagnosis !== p.problem ? ` (${p.diagnosis})` : ""}`));
  plan.problems.forEach((p, i) => {
    out.push("", `${i + 1}. ${p.problem.toUpperCase()}`);
    if (p.expectedOutcome.trim()) out.push(`  Expected outcome: ${p.expectedOutcome.trim()}`);
    for (const f of PLAN_LIST_FIELDS) {
      const items = p[f].map((x) => x.trim()).filter(Boolean);
      if (!items.length) continue;
      out.push(`  ${PLAN_FIELD_LABELS[f]}:`);
      for (const x of items) out.push(`    • ${x}`);
    }
  });
  for (const k of Object.keys(GENERAL_LABELS) as (keyof PlanGeneral)[]) {
    const v = plan.general[k]?.trim();
    if (v) out.push("", `${GENERAL_LABELS[k].toUpperCase()}`, `  ${v}`);
  }
  if (who.signedBy) {
    const when = who.signedAt ? new Date(who.signedAt).toISOString().slice(0, 10) : "";
    out.push("", `Established and signed by ${who.signedBy}${when ? ` on ${when}` : ""}.`);
  }
  return out.join("\n");
}

/** A rough "is this plan complete enough to sign" check: every section has goals and interventions. */
export function planGaps(plan: { problems: PlanProblem[] }): string[] {
  const gaps: string[] = [];
  if (!plan.problems.length) gaps.push("No problems on the plan.");
  for (const p of plan.problems) {
    if (!p.goals.some((g) => g.trim())) gaps.push(`${p.problem || p.diagnosis}: no measurable goal.`);
    if (!p.interventions.some((g) => g.trim())) gaps.push(`${p.problem || p.diagnosis}: no planned intervention.`);
  }
  return gaps;
}

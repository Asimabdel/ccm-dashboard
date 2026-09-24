export interface CarePlanInput {
  name?: string | null;
  conditions?: string[] | null;
  providerName?: string | null;
}

/**
 * A standard, comprehensive Advanced Primary Care Management (APCM) care plan,
 * personalized with the patient's name, chronic conditions, and provider. It is a
 * DOCUMENTED STARTING POINT the care team reviews and individualizes — it covers the
 * CMS-expected elements: problem list, goals, interventions, medication management,
 * care team + 24/7 access, preventive care, self-management, coordination/community
 * resources, follow-up, and advance care planning.
 */
export function buildStandardApcmCarePlan(p: CarePlanInput = {}): string {
  const name = (p.name || "").trim() || "This patient";
  const conds = (p.conditions || []).map((c) => String(c).trim()).filter(Boolean);
  const problems = conds.length
    ? conds.map((c, i) => `  ${i + 1}. ${c} — actively managed; monitor control, adherence, and complications.`).join("\n")
    : "  1. [Chronic condition #1 — confirm and document from chart]\n  2. [Chronic condition #2 — confirm and document from chart]";
  const provider = (p.providerName || "").trim();
  const providerLine = provider ? `Primary provider: ${provider}.` : "Primary provider: [assigned provider].";

  return `ADVANCED PRIMARY CARE MANAGEMENT (APCM) — COMPREHENSIVE CARE PLAN
Patient: ${name}

1. PROBLEM LIST (chronic conditions under management)
${problems}

2. HEALTH GOALS
  • Keep each chronic condition at goal (e.g., BP < 130/80; A1c < 8%; LDL at target) and prevent complications and avoidable hospitalizations.
  • Maintain medication adherence and up-to-date preventive care.
  • Support the patient's own priorities and quality-of-life goals.

3. INTERVENTIONS / MANAGEMENT PLAN
  • Regularly review each condition, symptoms, vitals, and relevant labs.
  • Adjust treatment with the provider as needed and close gaps in care.
  • Coordinate specialists, diagnostics, and referrals; reconcile care after each transition.

4. MEDICATION MANAGEMENT
  • Reconcile the full medication list at each contact; check adherence, side effects, and interactions.
  • Manage refills and prior authorizations; align the regimen with the goals above.

5. CARE TEAM & 24/7 ACCESS
  • ${providerLine} Care coordinator: assigned MyPCP care-team member.
  • The patient has 24/7 access to the care team for urgent needs, with continuity through a designated team member.

6. PREVENTIVE & CHRONIC-CARE SERVICES
  • Keep age- and condition-appropriate screenings and immunizations current (e.g., cancer screening, diabetic eye/foot exams, vaccinations).
  • Annual wellness visit and routine monitoring scheduled.

7. SELF-MANAGEMENT & PATIENT EDUCATION
  • Educate on each condition, warning signs, diet/activity, and when to seek care.
  • Support self-monitoring (e.g., home blood pressure/glucose) and healthy-lifestyle goals.

8. CARE COORDINATION & COMMUNITY RESOURCES
  • Coordinate across providers, facilities, and home- and community-based services.
  • Address social drivers of health and connect the patient to community resources as needed.

9. FOLLOW-UP & MONITORING
  • Monthly care-management outreach; more frequently if the patient is unstable.
  • Reassess goals and update this plan at least quarterly or after any significant change.

10. ADVANCE CARE PLANNING
  • Discuss goals of care and advance directives as appropriate; document the patient's preferences.

This plan is reviewed with the patient and individualized to their specific conditions, goals, and circumstances.`;
}

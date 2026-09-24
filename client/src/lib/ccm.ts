// Centralized CCM label maps and helpers - exact wording per spec.

export const STATUS_LABELS: Record<string, string> = {
  not_started: "Not Started",
  assigned: "Assigned",
  called_no_answer: "Called No Answer",
  voicemail_left: "Voicemail Left",
  wrong_number: "Wrong Number",
  needs_callback: "Needs Callback",
  in_progress: "In Progress",
  completed: "Completed",
  needs_provider_review: "Needs Provider Review",
  needs_appointment: "Needs Appointment",
  documentation_incomplete: "Documentation Incomplete",
  ready_for_billing: "Ready for Billing",
  billed: "Billed",
  cancelled: "Cancelled",
  unable_to_reach: "Unable to Reach",
  declined_ccm: "Declined CCM",
  inactive: "Inactive",
};

export const STATUS_OPTIONS = Object.keys(STATUS_LABELS);

/**
 * The only five statuses coordinators set from the worklist. "assigned" means
 * the call hasn't been started yet. Any other underlying status is collapsed into
 * one of these for display via worklistStatusValue() — the raw data is untouched.
 */
export const WORKLIST_STATUS_OPTIONS = [
  "assigned",
  "called_no_answer",
  "completed",
  "declined_ccm",
  "inactive",
] as const;

export const WORKLIST_STATUS_LABELS: Record<string, string> = {
  assigned: "Assigned (Not Started)",
  called_no_answer: "Called – No Answer",
  completed: "Completed",
  declined_ccm: "Declined CCM",
  inactive: "Inactive",
};

/** Collapse any task status into one of the five worklist buckets. */
export function worklistStatusValue(status?: string | null): string {
  switch (status) {
    case "completed":
    case "ready_for_billing":
    case "billed":
    case "needs_provider_review":
    case "needs_appointment":
    case "documentation_incomplete":
      return "completed";
    case "called_no_answer":
    case "voicemail_left":
    case "wrong_number":
    case "needs_callback":
    case "unable_to_reach":
      return "called_no_answer";
    case "declined_ccm":
      return "declined_ccm";
    case "inactive":
    case "cancelled":
      return "inactive";
    default: // not_started, assigned, in_progress, etc. → not yet started
      return "assigned";
  }
}

export const PRIORITY_LABELS: Record<string, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

// ---- Care-management programs (CCM = 99490, BHI = 99484, APCM = G0556/57/58) ----
export type Program = "ccm" | "bhi" | "apcm";

export const PROGRAM_LABELS: Record<Program, string> = {
  ccm: "CCM",
  bhi: "BHI",
  apcm: "APCM",
};

export const PROGRAM_CPT: Record<Program, string> = {
  ccm: "99490",
  bhi: "99484",
  apcm: "G0556–8",
};

export const PROGRAM_FULL_LABELS: Record<Program, string> = {
  ccm: "Chronic Care Management",
  bhi: "Behavioral Health Integration",
  apcm: "Advanced Primary Care Management",
};

export function programBadgeClass(program: string): string {
  if (program === "bhi") return "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200";
  if (program === "apcm") return "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200";
  return "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200";
}

export const BHI_STATUS_LABELS: Record<string, string> = {
  not_enrolled: "Not Enrolled",
  active: "Active",
  inactive: "Inactive",
  declined: "Declined",
  transferred: "Transferred",
};

/** Common behavioral-health conditions that qualify a patient for BHI (99484). */
export const BHI_CONDITION_OPTIONS = [
  "Depression",
  "Anxiety",
  "Bipolar disorder",
  "PTSD",
  "Substance use disorder",
  "Alcohol use disorder",
  "ADHD",
  "Insomnia",
  "Panic disorder",
  "Adjustment disorder",
  "Other behavioral health",
];

/** Reference ICD-10 codes for the BHI condition options (for the claim / care plan). */
export const BHI_CONDITION_ICD10: Record<string, string> = {
  "Depression": "F32.9",
  "Anxiety": "F41.9",
  "Bipolar disorder": "F31.9",
  "PTSD": "F43.10",
  "Substance use disorder": "F19.20",
  "Alcohol use disorder": "F10.20",
  "ADHD": "F90.9",
  "Insomnia": "G47.00",
  "Panic disorder": "F41.0",
  "Adjustment disorder": "F43.20",
  "Other behavioral health": "",
};

/**
 * The disclosures a patient must be told before BHI consent is documented (CMS):
 * cost-sharing applies, only one practitioner bills per month, may stop anytime.
 */
export const BHI_CONSENT_DISCLOSURES = [
  "You may receive behavioral-health care-management services from our team each month.",
  "Cost-sharing applies — a monthly copay (typically 20% under Medicare) may be billed.",
  "Only one practitioner can furnish and bill BHI for you in a given month.",
  "You may stop BHI services at any time.",
];

export type BhiComplianceItem = { key: string; label: string; ok: boolean };

/** Patient-level 99484 readiness checks (the per-month 20-min rule is checked separately). */
export function bhiCompliance(patient: any): BhiComplianceItem[] {
  const consent = patient?.bhiConsentStatus === "consented";
  const withinYear = patient?.lastOfficeVisit && (Date.now() - new Date(patient.lastOfficeVisit).getTime()) < 365 * 24 * 3600 * 1000;
  const initiating = !!(patient?.bhiInitiatingVisitDate || withinYear);
  const carePlan = !!(patient?.bhiCarePlan && String(patient.bhiCarePlan).trim());
  const conditions = ((patient?.bhiConditions as string[]) || []).length > 0;
  return [
    { key: "conditions", label: "Behavioral-health diagnosis on file", ok: conditions },
    { key: "consent", label: "Documented consent (cost-sharing disclosed)", ok: consent },
    { key: "initiating", label: "Initiating visit within 12 months", ok: initiating },
    { key: "carePlan", label: "Behavioral care plan documented", ok: carePlan },
  ];
}

// ---- APCM (Advanced Primary Care Management, G0556/G0557/G0558) ----
export const APCM_STATUS_LABELS: Record<string, string> = BHI_STATUS_LABELS; // same enrollment states

export const APCM_LEVEL_LABELS: Record<string, string> = {
  level_1: "Level 1 · G0556",
  level_2: "Level 2 · G0557",
  level_3: "Level 3 · G0558 (QMB)",
};

export const APCM_CPT_BY_LEVEL: Record<string, string> = {
  level_1: "G0556",
  level_2: "G0557",
  level_3: "G0558",
};

/**
 * Complexity level (mirrors server). APCM covers the CCM panel, and CCM requires
 * 2+ chronic conditions — so everyone is Level 2 minimum; QMB → Level 3. Level 1
 * (single condition) doesn't occur here, so the condition count isn't the floor.
 */
export function apcmLevelFrom(_conditionCount: number, isQMB: boolean): "level_1" | "level_2" | "level_3" {
  return isQMB ? "level_3" : "level_2";
}

export function apcmLevelBadgeClass(level?: string | null): string {
  if (level === "level_3") return "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200";
  if (level === "level_2") return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
  return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200";
}

/** The disclosures a patient must be told before APCM consent is documented. */
export const APCM_CONSENT_DISCLOSURES = [
  "You'll receive advanced primary care management from our care team each month, including 24/7 access and care coordination.",
  "Cost-sharing (a monthly copay) may apply — it is waived for Qualified Medicare Beneficiaries (QMB).",
  "Only one practitioner can furnish and bill APCM for you in a given month.",
  "APCM cannot be billed in the same month as CCM for you — you'll be in one or the other.",
  "You may stop APCM services at any time.",
];

/** Patient-level APCM readiness checks (APCM is NOT time-based — no minutes gate). */
export function apcmCompliance(patient: any): BhiComplianceItem[] {
  const consent = patient?.apcmConsentStatus === "consented";
  const within3yr = patient?.lastOfficeVisit && (Date.now() - new Date(patient.lastOfficeVisit).getTime()) < 3 * 365 * 24 * 3600 * 1000;
  const initiating = !!(patient?.apcmInitiatingVisitDate || within3yr);
  const carePlan = !!(patient?.apcmCarePlan && String(patient.apcmCarePlan).trim());
  return [
    { key: "consent", label: "Documented consent (cost-sharing disclosed)", ok: consent },
    { key: "initiating", label: "Initiating visit within 3 years", ok: initiating },
    { key: "carePlan", label: "Comprehensive care plan documented", ok: carePlan },
  ];
}

/** PHQ-9 depression severity band (0–27). */
export function phq9Severity(score?: number | null): { label: string; cls: string } | null {
  if (score == null) return null;
  if (score >= 20) return { label: "Severe", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200" };
  if (score >= 15) return { label: "Moderately severe", cls: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200" };
  if (score >= 10) return { label: "Moderate", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200" };
  if (score >= 5) return { label: "Mild", cls: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200" };
  return { label: "Minimal", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" };
}

/** GAD-7 anxiety severity band (0–21). */
export function gad7Severity(score?: number | null): { label: string; cls: string } | null {
  if (score == null) return null;
  if (score >= 15) return { label: "Severe", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200" };
  if (score >= 10) return { label: "Moderate", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200" };
  if (score >= 5) return { label: "Mild", cls: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200" };
  return { label: "Minimal", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" };
}

export const RPM_STATUS_LABELS: Record<string, string> = {
  not_enrolled: "Not Enrolled",
  eligible: "Eligible",
  enrolled: "Enrolled",
  active: "Active",
  declined: "Declined",
  inactive: "Inactive",
};

/** Normalize a name for duplicate comparison (mirrors server logic). */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

export const ESCALATION_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  reviewed: "Reviewed",
  action_needed: "Action Needed",
  completed: "Completed",
};

export const BILLING_STATUS_LABELS: Record<string, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  documentation_incomplete: "Documentation Incomplete",
  provider_review_pending: "Provider Review Pending",
  ready_for_billing: "Ready for Billing",
  billed: "Billed",
  denied: "Denied",
  needs_correction: "Needs Correction",
};

export const FOLLOWUP_TYPE_LABELS: Record<string, string> = {
  office_visit: "Office Visit",
  telemedicine_visit: "Telemedicine Visit",
  lab_work: "Lab Work",
  medication_refill: "Medication Refill",
  referral: "Referral",
  imaging: "Imaging",
  testing: "Testing",
  rpm_enrollment: "RPM Enrollment",
  dexa: "DEXA Scan",
  abi: "ABI Test",
  pft: "PFT",
  balance_test: "Balance Test",
  vaccination: "Vaccination",
  annual_wellness: "Annual Wellness Visit",
};

export const FOLLOWUP_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  scheduled: "Scheduled",
  completed: "Completed",
};

export function statusBadgeClass(status: string): string {
  switch (status) {
    case "completed":
    case "ready_for_billing":
    case "billed":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
    case "in_progress":
    case "assigned":
    case "needs_callback":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200";
    case "called_no_answer":
    case "voicemail_left":
    case "wrong_number":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
    case "needs_provider_review":
    case "documentation_incomplete":
    case "needs_appointment":
      return "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200";
    case "unable_to_reach":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
    case "cancelled":
    case "declined_ccm":
    case "inactive":
      return "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300";
    default:
      return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  }
}

export function priorityBadgeClass(priority: string): string {
  switch (priority) {
    case "high":
      return "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200";
    case "medium":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
    case "low":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

export function escalationBadgeClass(status: string): string {
  switch (status) {
    case "pending":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
    case "reviewed":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200";
    case "action_needed":
      return "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200";
    case "completed":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

export function currentMonthStr(): string {
  return new Date().toISOString().slice(0, 7);
}

export function fmtDate(d?: Date | string | null): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString();
}

export function fmtDateTime(d?: Date | string | null): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString();
}

/** Format a date as YYYY-MM-DD (local) for use in <input type="date"> values. */
export function toDateInput(d?: Date | string | null): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function billingBadgeClass(status: string): string {
  switch (status) {
    case "billed":
    case "ready_for_billing":
      return "bg-emerald-100 text-emerald-800";
    case "in_progress":
    case "provider_review_pending":
      return "bg-blue-100 text-blue-800";
    case "documentation_incomplete":
    case "needs_correction":
      return "bg-amber-100 text-amber-800";
    case "denied":
      return "bg-rose-100 text-rose-800";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

export function followupBadgeClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-100 text-emerald-800";
    case "scheduled":
      return "bg-blue-100 text-blue-800";
    case "pending":
      return "bg-amber-100 text-amber-800";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

/**
 * Client-side password strength check. Mirrors the server policy in server/password.ts
 * (>= 8 chars, <= 128, at least one letter and one number).
 * Returns an error message if invalid, or null if OK.
 */
export function validatePassword(plain: string): string | null {
  if (typeof plain !== "string" || plain.length < 8) {
    return "Password must be at least 8 characters long.";
  }
  if (plain.length > 128) {
    return "Password must be at most 128 characters long.";
  }
  if (!/[A-Za-z]/.test(plain) || !/[0-9]/.test(plain)) {
    return "Password must include at least one letter and one number.";
  }
  return null;
}

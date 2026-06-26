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

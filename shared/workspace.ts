// Workspace (clinic operations) — pure logic shared by server and client:
// task + patient-flow definitions, the Practice Fusion schedule CSV reader,
// Opportunity Finder rules, schedule-opening detection, role capabilities and
// the starter playbooks. No database or browser APIs here, so it is unit-tested
// directly (server/workspace.test.ts).
import { CLINIC_TZ, addDays } from "./workforce";
import { normalizePersonName } from "./csvImport";

// ---------------------------------------------------------------------------
// Roles & capabilities
// ---------------------------------------------------------------------------

export type WorkspaceRole = "admin" | "staff" | "provider" | "billing" | "front_desk" | "medical_assistant" | "user";

export const WORKSPACE_CAPS = {
  /** My Work task queue. */
  tasks: ["admin", "staff", "provider", "billing", "front_desk", "medical_assistant"],
  /** Assign tasks to other people. */
  assignTasks: ["admin", "staff", "provider", "front_desk"],
  /** See the Patient Flow board. */
  flowView: ["admin", "staff", "provider", "front_desk", "medical_assistant"],
  /** Move patients between flow columns. */
  flowUpdate: ["admin", "staff", "provider", "front_desk", "medical_assistant"],
  /** Upload the Practice Fusion schedule export. */
  scheduleImport: ["admin", "front_desk"],
  /** See Opportunity Finder lists. */
  opportunitiesView: ["admin", "staff", "provider", "front_desk"],
  /** Act on opportunities (create tasks, mark reviewed). */
  opportunitiesAct: ["admin", "staff", "front_desk"],
  /** Read playbooks. */
  playbooksView: ["admin", "staff", "provider", "billing", "front_desk", "medical_assistant"],
  /** Create / edit playbooks. */
  playbooksEdit: ["admin"],
  /** Full patient record incl. CCM/BHI/APCM detail. MAs get an operational view only. */
  patientFull: ["admin", "staff", "provider", "front_desk"],
} as const satisfies Record<string, readonly WorkspaceRole[]>;

export type WorkspaceCap = keyof typeof WORKSPACE_CAPS;

export function can(role: string | null | undefined, cap: WorkspaceCap): boolean {
  return !!role && (WORKSPACE_CAPS[cap] as readonly string[]).includes(role);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const TASK_STATUS_LABELS = {
  open: "Open",
  in_progress: "In progress",
  waiting: "Waiting",
  completed: "Completed",
  cancelled: "Cancelled",
} as const;
export type TaskStatus = keyof typeof TASK_STATUS_LABELS;

export const TASK_PRIORITY_LABELS = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" } as const;
export type TaskPriority = keyof typeof TASK_PRIORITY_LABELS;

export const TASK_CATEGORY_LABELS = {
  patient_call: "Patient call",
  referral: "Referral",
  prior_auth: "Prior auth",
  lab_followup: "Lab follow-up",
  form: "Form",
  medication_request: "Medication request",
  care_management: "Care management",
  rpm: "RPM",
  front_desk: "Front desk",
  provider_request: "Provider request",
  administrative: "Administrative",
  other: "Other",
} as const;
export type TaskCategory = keyof typeof TASK_CATEGORY_LABELS;

export const TASK_STATUSES = Object.keys(TASK_STATUS_LABELS) as TaskStatus[];
export const TASK_PRIORITIES = Object.keys(TASK_PRIORITY_LABELS) as TaskPriority[];
export const TASK_CATEGORIES = Object.keys(TASK_CATEGORY_LABELS) as TaskCategory[];
export const OPEN_TASK_STATUSES: TaskStatus[] = ["open", "in_progress", "waiting"];
export const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** A task is overdue once its (clinic-local) due date has passed and it is still open. */
export function isTaskOverdue(task: { status: string; dueDate: string | null }, today: string): boolean {
  return !!task.dueDate && OPEN_TASK_STATUSES.includes(task.status as TaskStatus) && task.dueDate < today;
}

export const WORKSPACE_ROLE_LABELS: Record<string, string> = {
  admin: "Admin / Practice Manager",
  staff: "Care Coordinator",
  provider: "Provider",
  billing: "Billing",
  front_desk: "Front Desk",
  medical_assistant: "Medical Assistant",
};

// ---------------------------------------------------------------------------
// Patient flow
// ---------------------------------------------------------------------------

export const FLOW_COLUMNS = ["scheduled", "arrived", "checked_in", "roomed", "with_provider", "checkout", "completed"] as const;
export type FlowStatus = (typeof FLOW_COLUMNS)[number] | "no_show" | "cancelled";

export const FLOW_LABELS: Record<FlowStatus, string> = {
  scheduled: "Scheduled",
  arrived: "Arrived",
  checked_in: "Checked in",
  roomed: "Roomed",
  with_provider: "With provider",
  checkout: "Checkout",
  completed: "Completed",
  no_show: "No-show",
  cancelled: "Cancelled",
};

export const IN_CLINIC_STATUSES: FlowStatus[] = ["arrived", "checked_in", "roomed", "with_provider", "checkout"];
export const WAITING_STATUSES: FlowStatus[] = ["arrived", "checked_in", "roomed"];

/** Timestamp column that records entry into each status. */
export const STATUS_TIMESTAMP = {
  arrived: "arrivedAt",
  checked_in: "checkedInAt",
  roomed: "roomedAt",
  with_provider: "withProviderAt",
  checkout: "checkoutAt",
  completed: "completedAt",
} as const;

export type FlowCheck = { allowed: false; reason: string } | { allowed: true; requiresConfirmation: boolean; reason?: string };

/**
 * Validate a patient-flow move. One step forward is free; moving backward,
 * skipping steps, completing, no-show and cancel all need an explicit confirm.
 */
export function checkFlowTransition(from: FlowStatus, to: FlowStatus): FlowCheck {
  if (from === to) return { allowed: false, reason: "Already in this status." };
  if (from === "cancelled") return { allowed: false, reason: "Cancelled appointments can't be moved." };
  if (from === "completed" && to !== "checkout") return { allowed: false, reason: "Completed visits can only be reopened to checkout." };
  if (to === "no_show") {
    return from === "scheduled"
      ? { allowed: true, requiresConfirmation: true, reason: "Mark this patient as a no-show?" }
      : { allowed: false, reason: "Only scheduled patients can be marked no-show." };
  }
  if (to === "cancelled") return { allowed: true, requiresConfirmation: true, reason: "Cancel this appointment?" };
  if (from === "no_show") {
    return to === "arrived" || to === "scheduled"
      ? { allowed: true, requiresConfirmation: true, reason: "Reverse the no-show?" }
      : { allowed: false, reason: "Move a no-show back to Arrived first." };
  }
  const fi = FLOW_COLUMNS.indexOf(from as (typeof FLOW_COLUMNS)[number]);
  const ti = FLOW_COLUMNS.indexOf(to as (typeof FLOW_COLUMNS)[number]);
  if (ti < fi) return { allowed: true, requiresConfirmation: true, reason: "Move this patient backward?" };
  if (to === "completed") return { allowed: true, requiresConfirmation: true, reason: "Complete this visit?" };
  if (ti - fi > 1) return { allowed: true, requiresConfirmation: true, reason: "Skip workflow steps?" };
  return { allowed: true, requiresConfirmation: false };
}

export function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));
}

// ---------------------------------------------------------------------------
// Clinic-local time
// ---------------------------------------------------------------------------

/** Offset (minutes) of CLINIC_TZ from UTC at the given instant, e.g. -300 for CDT. */
// Built once: creating an Intl formatter is slow, and big schedule imports convert thousands of times.
let clinicPartsFormatter: Intl.DateTimeFormat | null = null;

function tzOffsetMinutes(at: Date): number {
  clinicPartsFormatter ??= new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = clinicPartsFormatter.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** Clinic-local "YYYY-MM-DD" + "HH:MM" → the UTC instant. DST-safe. */
export function clinicLocalToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = new Date(Date.UTC(y!, m! - 1, d!, hh!, mm!));
  const offset = tzOffsetMinutes(guess);
  const first = new Date(guess.getTime() - offset * 60000);
  // Re-check once in case the guess and the result straddle a DST boundary.
  const offset2 = tzOffsetMinutes(first);
  return offset2 === offset ? first : new Date(guess.getTime() - offset2 * 60000);
}

// ---------------------------------------------------------------------------
// Practice Fusion schedule CSV
// ---------------------------------------------------------------------------

export type ScheduleField =
  | "date"
  | "time"
  | "datetime"
  | "endTime"
  | "duration"
  | "patientName"
  | "firstName"
  | "lastName"
  | "dob"
  | "phone"
  | "provider"
  | "location"
  | "visitType"
  | "reason"
  | "status";

export const SCHEDULE_FIELD_LABELS: Record<ScheduleField, string> = {
  date: "Appointment date",
  time: "Start time",
  datetime: "Date + time (one column)",
  endTime: "End time",
  duration: "Duration (min)",
  patientName: "Patient name",
  firstName: "Patient first name",
  lastName: "Patient last name",
  dob: "Date of birth",
  phone: "Phone",
  provider: "Provider",
  location: "Clinic / facility",
  visitType: "Visit type",
  reason: "Reason / complaint",
  status: "Status",
};

const FIELD_ALIASES: Record<ScheduleField, string[]> = {
  date: ["date", "appointment date", "appt date", "start date", "scheduled date", "service date", "visit date"],
  time: ["time", "start time", "appointment time", "appt time", "scheduled time", "begin time"],
  datetime: ["start date/time", "appointment date/time", "date/time", "datetime", "start", "appointment start", "scheduled start"],
  endTime: ["end time", "end", "appointment end"],
  duration: ["duration", "length", "minutes", "duration (min)", "duration (minutes)", "appt length"],
  patientName: ["patient", "patient name", "name", "patient full name", "full name"],
  firstName: ["patient first name", "first name", "first", "firstname"],
  lastName: ["patient last name", "last name", "last", "lastname"],
  dob: ["dob", "date of birth", "birth date", "patient dob", "birthdate", "patient date of birth"],
  phone: ["phone", "patient phone", "mobile", "cell", "home phone", "phone number", "primary phone", "mobile phone", "cell phone"],
  provider: ["provider", "rendering provider", "doctor", "physician", "provider name", "scheduled provider", "resource", "practitioner", "seen by", "scheduled with"],
  location: ["facility", "location", "service location", "clinic", "office", "site", "facility name"],
  visitType: ["appointment type", "type", "visit type", "appt type", "event type", "appointment reason type"],
  reason: ["reason", "chief complaint", "reason for visit", "notes", "comments", "description", "appointment notes"],
  status: ["status", "appointment status", "appt status", "confirmation status"],
};

export type ScheduleMapping = Partial<Record<ScheduleField, number>>;

/** Parse CSV text into rows (quoted fields, commas and newlines inside quotes). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Pick the header row (first row with ≥2 recognisable columns) and map columns. */
export function detectScheduleMapping(rows: string[][]): { headerRow: number; headers: string[]; mapping: ScheduleMapping } {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const headers = rows[r]!.map((h) => h.trim());
    // "AppointmentTime" / "Seen_By" / "Mobile  Phone" → "appointment time" / "seen by" / "mobile phone"
    const lower = headers.map((h) => h.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\s]+/g, " ").toLowerCase().trim());
    const mapping: ScheduleMapping = {};
    (Object.keys(FIELD_ALIASES) as ScheduleField[]).forEach((f) => {
      const idx = lower.findIndex((h, i) => FIELD_ALIASES[f].includes(h) && !Object.values(mapping).includes(i));
      if (idx >= 0) mapping[f] = idx;
    });
    // Practice Fusion's "AppointmentTime" holds the date too: treat a "time" column whose values
    // carry a date as the combined date + time column.
    if (mapping.date == null && mapping.datetime == null && mapping.time != null) {
      const sample = rows.slice(r + 1, r + 6).map((x) => x[mapping.time!] ?? "").find((v) => v.trim());
      if (sample && parseDateValue(sample)) {
        mapping.datetime = mapping.time;
        delete mapping.time;
      }
    }
    const hasWhen = mapping.datetime != null || mapping.date != null;
    const hasWho = mapping.patientName != null || mapping.lastName != null;
    if (hasWhen && hasWho) return { headerRow: r, headers, mapping };
  }
  return { headerRow: 0, headers: (rows[0] ?? []).map((h) => h.trim()), mapping: {} };
}

/** "3/4/1958", "1958-03-04", "03/04/58" → "1958-03-04". Two-digit years pivot so DOBs land in the past. */
export function parseDateValue(raw: string, { dob = false }: { dob?: boolean } = {}): string | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2]!.padStart(2, "0")}-${iso[3]!.padStart(2, "0")}`;
  const mdy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (!mdy) return null;
  const mm = Number(mdy[1]);
  const dd = Number(mdy[2]);
  let yy = Number(mdy[3]);
  if (mdy[3]!.length === 2) {
    const nowYY = new Date().getFullYear() % 100;
    yy = dob ? (yy > nowYY ? 1900 + yy : 2000 + yy) : 2000 + yy;
  }
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** "9:05 AM", "09:05", "14:30:00", "2:30pm" → "HH:MM" (24h). */
export function parseTimeValue(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  const m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3]?.replace(/\./g, "");
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Map Practice Fusion status text to a flow status (unknown → scheduled). */
export function mapScheduleStatus(raw: string | undefined): FlowStatus {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "scheduled";
  if (/cancel/.test(s)) return "cancelled";
  if (/no[\s-]?show|missed/.test(s)) return "no_show";
  if (/checked?[\s-]?out/.test(s)) return "checkout";
  if (/complete|seen|done|finished|signed/.test(s)) return "completed";
  if (/with provider|in progress|in session/.test(s)) return "with_provider";
  if (/room|exam/.test(s)) return "roomed";
  if (/checked?[\s-]?in/.test(s)) return "checked_in";
  if (/arriv|lobby/.test(s)) return "arrived";
  return "scheduled";
}

export interface ParsedAppointmentRow {
  rowNumber: number;
  date: string;
  time: string;
  durationMin: number;
  patientName: string;
  dob: string | null;
  phone: string | null;
  provider: string | null;
  location: string | null;
  visitType: string | null;
  reason: string | null;
  status: FlowStatus;
}

export interface ScheduleParseResult {
  headers: string[];
  mapping: ScheduleMapping;
  rows: ParsedAppointmentRow[];
  errors: { rowNumber: number; message: string }[];
}

/** Read a schedule export. `override` lets the user fix any column the auto-detect missed. */
export function parseScheduleCsv(text: string, override?: ScheduleMapping): ScheduleParseResult {
  const all = parseCsvRows(text);
  const detected = detectScheduleMapping(all);
  const mapping: ScheduleMapping = { ...detected.mapping, ...(override ?? {}) };
  for (const [k, v] of Object.entries(mapping)) if (v == null || v < 0) delete mapping[k as ScheduleField];
  const rows: ParsedAppointmentRow[] = [];
  const errors: { rowNumber: number; message: string }[] = [];
  const cell = (r: string[], f: ScheduleField) => (mapping[f] != null ? (r[mapping[f]!] ?? "").trim() : "");

  for (let i = detected.headerRow + 1; i < all.length; i++) {
    const r = all[i]!;
    const rowNumber = i + 1;
    let date = mapping.date != null ? parseDateValue(cell(r, "date")) : null;
    let time = mapping.time != null ? parseTimeValue(cell(r, "time")) : null;
    if (mapping.datetime != null) {
      const dt = cell(r, "datetime");
      date = date ?? parseDateValue(dt);
      time = time ?? parseTimeValue(dt);
    }
    if (!time && mapping.date != null) time = parseTimeValue(cell(r, "date"));
    const name =
      mapping.patientName != null
        ? normalizePersonName(cell(r, "patientName"))
        : `${cell(r, "firstName")} ${cell(r, "lastName")}`.replace(/\s+/g, " ").trim();
    if (!name && !date) continue; // blank / footer line
    if (!name) {
      errors.push({ rowNumber, message: "Missing patient name" });
      continue;
    }
    if (!date) {
      errors.push({ rowNumber, message: `Can't read the appointment date for ${name}` });
      continue;
    }
    if (!time) {
      errors.push({ rowNumber, message: `Can't read the start time for ${name}` });
      continue;
    }
    let durationMin = Number(cell(r, "duration").replace(/[^\d]/g, "")) || 0;
    if (!durationMin && mapping.endTime != null) {
      const end = parseTimeValue(cell(r, "endTime"));
      if (end) {
        const [sh, sm] = time.split(":").map(Number);
        const [eh, em] = end.split(":").map(Number);
        durationMin = Math.max(0, eh! * 60 + em! - (sh! * 60 + sm!));
      }
    }
    rows.push({
      rowNumber,
      date,
      time,
      durationMin: durationMin > 0 && durationMin <= 480 ? durationMin : 20,
      patientName: name.slice(0, 255),
      dob: parseDateValue(cell(r, "dob"), { dob: true }),
      phone: cell(r, "phone").slice(0, 30) || null,
      provider: cell(r, "provider").slice(0, 255) || null,
      location: cell(r, "location").slice(0, 255) || null,
      visitType: cell(r, "visitType").slice(0, 120) || null,
      reason: cell(r, "reason").slice(0, 255) || null,
      status: mapScheduleStatus(cell(r, "status")),
    });
  }
  return { headers: detected.headers, mapping, rows, errors };
}

/** Lowercased, punctuation-free name used to match schedule rows to patients. */
export function nameKey(name: string): string {
  return normalizePersonName(name)
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Schedule openings (estimated from the imported schedule)
// ---------------------------------------------------------------------------

export const CLINIC_DAY_START = "08:00";
export const CLINIC_DAY_END = "17:00";
export const SLOT_MINUTES = 20;

export interface Opening {
  date: string;
  clinicId: number | null;
  providerKey: string;
  providerName: string;
  start: string; // HH:MM
  minutes: number;
}

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h! * 60 + m!;
};
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * Gaps of at least one slot in each provider's day, between CLINIC_DAY_START and
 * CLINIC_DAY_END, ignoring cancelled / no-show visits (those slots are free).
 * Only days where the provider has at least one appointment are considered.
 * Grouped per provider (not per clinic): a provider can't be in two places, and
 * video visits have no clinic of their own. The opening takes the clinic of that
 * provider's first visit of the day.
 */
export function findOpenings(
  appts: { date: string; time: string; durationMin: number; clinicId: number | null; providerKey: string; providerName: string; status: string }[],
): Opening[] {
  const groups = new Map<string, typeof appts>();
  for (const a of appts) {
    if (a.status === "cancelled" || a.status === "no_show") continue;
    const k = `${a.date}|${a.providerKey}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(a);
  }
  const out: Opening[] = [];
  groups.forEach((list) => {
    list.sort((a, b) => toMin(a.time) - toMin(b.time));
    let cursor = toMin(CLINIC_DAY_START);
    const end = toMin(CLINIC_DAY_END);
    const push = (from: number, to: number) => {
      if (to - from >= SLOT_MINUTES) {
        out.push({ date: list[0]!.date, clinicId: list[0]!.clinicId, providerKey: list[0]!.providerKey, providerName: list[0]!.providerName, start: toHHMM(from), minutes: to - from });
      }
    };
    for (const a of list) {
      const s = toMin(a.time);
      if (s > cursor) push(cursor, Math.min(s, end));
      cursor = Math.max(cursor, s + a.durationMin);
    }
    if (cursor < end) push(cursor, end);
  });
  return out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

// ---------------------------------------------------------------------------
// Opportunity Finder
// ---------------------------------------------------------------------------

export const OPPORTUNITY_INFO = {
  // Schedule-based: work for everyone on the imported Practice Fusion schedule.
  missed_appointment: {
    label: "Missed appointment",
    description: "No-show in the last 60 days and nothing booked since.",
    action: "Call to reschedule",
  },
  cancelled_not_rebooked: {
    label: "Cancelled, not rebooked",
    description: "Cancelled a visit in the last 45 days and has nothing booked since.",
    action: "Call to rebook the visit",
  },
  new_patient_no_return: {
    label: "New patient, no follow-up",
    description: "Seen as a new patient 3 weeks to 6 months ago, never came back and has nothing booked.",
    action: "Call to schedule a follow-up visit",
  },
  lapsed_follow_up: {
    label: "No visit in 3+ months",
    description: "Last seen 3 to 12 months ago with nothing booked since.",
    action: "Call to schedule a follow-up visit",
  },
  // Roster-based: use the CCM roster's conditions and enrollment.
  overdue_follow_up: {
    label: "Chronic care overdue",
    description: "CCM-roster patients with a chronic condition, no visit in 6+ months and nothing scheduled.",
    action: "Call to schedule a follow-up visit",
  },
  diabetes_follow_up: {
    label: "Diabetes follow-up",
    description: "Diabetes on the condition list, no visit in 90+ days, nothing scheduled.",
    action: "Offer a diabetes follow-up appointment",
  },
  hypertension_follow_up: {
    label: "Hypertension follow-up",
    description: "Hypertension on the condition list, no visit in 4+ months, nothing scheduled.",
    action: "Offer a blood-pressure follow-up appointment",
  },
  ccm_eligible: {
    label: "CCM re-engagement",
    description: "Two or more chronic conditions but not currently active in CCM (and hasn't declined).",
    action: "Review for CCM enrollment",
  },
  bhi_candidate: {
    label: "BHI candidate",
    description: "Behavioral-health condition on file but not enrolled in BHI (and hasn't declined).",
    action: "Review for BHI enrollment",
  },
  rpm_eligible: {
    label: "RPM candidate",
    description: "Marked RPM-eligible, or active in CCM with hypertension / diabetes / heart failure and not in RPM.",
    action: "Offer remote monitoring",
  },
} as const;

export type OpportunityCategory = keyof typeof OPPORTUNITY_INFO;
export const OPPORTUNITY_CATEGORY_LIST = Object.keys(OPPORTUNITY_INFO) as OpportunityCategory[];

export interface OpportunityPatient {
  chronicConditions: string[];
  bhiConditions: string[];
  ccmEnrollmentStatus: string | null;
  bhiEnrollmentStatus: string | null;
  rpmStatus: string | null;
  rpmEnrolled: boolean | null;
  lastOfficeVisit: Date | null;
  nextVisit: Date | null;
}

export interface OpportunityMatch {
  category: OpportunityCategory;
  reason: string;
  score: number;
}

const DAY = 86_400_000;
const has = (list: string[], re: RegExp) => list.some((c) => re.test(c));
const DIABETES = /diabet|\bdm\b|dm2|t2dm|\bt2\b|a1c/i;
const HYPERTENSION = /hypertens|\bhtn\b|high blood pressure/i;
const HEART_FAILURE = /heart failure|\bchf\b|\bhf\b/i;
const BEHAVIORAL = /depress|anxiety|\bmdd\b|\bgad\b|ptsd|bipolar|substance|alcohol|insomnia|adhd/i;

function sinceText(days: number | null) {
  if (days == null) return "no office visit on record";
  if (days < 60) return `last visit ${days} days ago`;
  return `last visit ${Math.round(days / 30)} months ago`;
}

/** Transparent rules on the CCM roster — suggestions for staff review, never automatic actions. */
export function evaluateOpportunities(p: OpportunityPatient, now: Date = new Date()): OpportunityMatch[] {
  const out: OpportunityMatch[] = [];
  const since = p.lastOfficeVisit ? Math.floor((now.getTime() - p.lastOfficeVisit.getTime()) / DAY) : null;
  const unscheduled = !p.nextVisit || p.nextVisit.getTime() < now.getTime();
  const chronic = p.chronicConditions.filter(Boolean);
  const behavioral = [...p.bhiConditions, ...chronic].filter((c) => BEHAVIORAL.test(c));

  if (chronic.length && unscheduled && (since == null || since > 180)) {
    out.push({ category: "overdue_follow_up", reason: `${chronic.length} chronic condition${chronic.length > 1 ? "s" : ""}; ${sinceText(since)}; nothing scheduled`, score: 50 + Math.min(40, Math.floor((since ?? 400) / 15)) });
  }
  if (has(chronic, DIABETES) && unscheduled && (since == null || since > 90)) {
    out.push({ category: "diabetes_follow_up", reason: `Diabetes on file; ${sinceText(since)}`, score: 65 });
  }
  if (has(chronic, HYPERTENSION) && unscheduled && (since == null || since > 120)) {
    out.push({ category: "hypertension_follow_up", reason: `Hypertension on file; ${sinceText(since)}`, score: 55 });
  }
  if (chronic.length >= 2 && p.ccmEnrollmentStatus !== "active" && p.ccmEnrollmentStatus !== "declined") {
    out.push({ category: "ccm_eligible", reason: `${chronic.length} chronic conditions; CCM ${p.ccmEnrollmentStatus ?? "not enrolled"}`, score: 40 + chronic.length * 3 });
  }
  if (behavioral.length && (p.bhiEnrollmentStatus ?? "not_enrolled") === "not_enrolled") {
    out.push({ category: "bhi_candidate", reason: `Behavioral-health condition on file (${behavioral[0]}); not in BHI`, score: 45 });
  }
  const rpmActive = p.rpmEnrolled || ["enrolled", "active"].includes(p.rpmStatus ?? "");
  const rpmClosed = ["declined", "inactive"].includes(p.rpmStatus ?? "");
  if (!rpmActive && !rpmClosed) {
    if (p.rpmStatus === "eligible") {
      out.push({ category: "rpm_eligible", reason: "Marked RPM-eligible; not enrolled yet", score: 60 });
    } else if (p.ccmEnrollmentStatus === "active" && (has(chronic, HYPERTENSION) || has(chronic, DIABETES) || has(chronic, HEART_FAILURE))) {
      out.push({ category: "rpm_eligible", reason: "Active in CCM with a condition suited to home monitoring", score: 35 });
    }
  }
  return out;
}

/** One appointment in a patient's imported schedule history. */
export interface ScheduleVisit {
  startsAt: Date;
  status: string;
  visitType: string | null;
}

/** Statuses that mean the patient actually came in (or is in clinic now). */
export const SEEN_STATUSES = ["arrived", "checked_in", "roomed", "with_provider", "checkout", "completed"];

const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / DAY);
const agoText = (d: number) => (d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`);
const latest = (vs: ScheduleVisit[]) => vs.reduce<ScheduleVisit | null>((m, v) => (!m || v.startsAt > m.startsAt ? v : m), null);

/**
 * Schedule-based rules, run on one person's appointment history (CCM roster or not).
 * "Rebooked" means any later appointment that wasn't cancelled or a no-show.
 */
export function evaluateScheduleOpportunities(visits: ScheduleVisit[], now: Date = new Date()): OpportunityMatch[] {
  const out: OpportunityMatch[] = [];
  const kept = (v: ScheduleVisit) => v.status !== "cancelled" && v.status !== "no_show";
  const bookedAfter = (t: Date) => visits.some((v) => v.startsAt > t && kept(v));
  const upcoming = visits.some((v) => v.startsAt > now && kept(v));
  const seen = visits.filter((v) => v.startsAt <= now && SEEN_STATUSES.includes(v.status));
  const lastSeen = latest(seen);

  const noShow = latest(visits.filter((v) => v.status === "no_show" && v.startsAt <= now));
  let missed = false;
  if (noShow && !bookedAfter(noShow.startsAt)) {
    const d = daysBetween(noShow.startsAt, now);
    if (d <= 60) {
      missed = true;
      out.push({ category: "missed_appointment", reason: `No-show ${agoText(d)}; nothing booked since`, score: 75 - d / 2 });
    }
  }

  const cancelled = latest(visits.filter((v) => v.status === "cancelled" && v.startsAt <= now));
  if (!missed && cancelled && !bookedAfter(cancelled.startsAt)) {
    const d = daysBetween(cancelled.startsAt, now);
    if (d <= 45) out.push({ category: "cancelled_not_rebooked", reason: `Cancelled visit ${agoText(d)}; nothing booked since`, score: 60 - d / 2 });
  }

  let newNoReturn = false;
  const firstNew = seen.filter((v) => /new/i.test(v.visitType ?? "")).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
  if (firstNew && !upcoming && !seen.some((v) => v.startsAt > firstNew.startsAt)) {
    const d = daysBetween(firstNew.startsAt, now);
    if (d >= 21 && d <= 180) {
      newNoReturn = true;
      out.push({ category: "new_patient_no_return", reason: `New patient seen ${d} days ago; no follow-up since`, score: 65 - d / 6 });
    }
  }

  // The catch-all: only when no more specific schedule reason applies.
  if (!out.length && lastSeen && !bookedAfter(lastSeen.startsAt)) {
    const d = daysBetween(lastSeen.startsAt, now);
    if (d >= 90 && d <= 365) out.push({ category: "lapsed_follow_up", reason: `Last seen ${Math.round(d / 30)} months ago; nothing booked`, score: 50 + Math.min(30, (d - 90) / 7) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Starter playbooks (inserted once by the migration; editable afterwards)
// ---------------------------------------------------------------------------

export const DEFAULT_PLAYBOOKS: { slug: string; title: string; category: string; description: string; steps: { title: string; detail: string }[] }[] = [
  {
    slug: "morning-schedule-import",
    title: "Loading today's schedule into Patient Flow",
    category: "Front desk",
    description: "How the front desk brings the Practice Fusion schedule into MyPCP each morning.",
    steps: [
      { title: "Export from Practice Fusion", detail: "In Practice Fusion, open the schedule/appointments report for today (all providers, your location) and export it as CSV." },
      { title: "Upload it", detail: "In MyPCP go to Patient Flow → Import schedule, choose the file and check the preview. Fix any column the preview couldn't recognise." },
      { title: "Check unmatched patients", detail: "Rows without a patient link are fine — they still appear on the board. Linked rows open the full Patient 360." },
      { title: "Re-import during the day", detail: "Import again after adding or cancelling appointments in Practice Fusion. Existing visits are updated, never duplicated, and statuses already set in MyPCP are kept." },
    ],
  },
  {
    slug: "patient-flow-check-in",
    title: "Patient flow: arrival to checkout",
    category: "Front desk",
    description: "Who moves the patient card at each step so wait times are accurate.",
    steps: [
      { title: "Arrived", detail: "Front desk moves the card to Arrived the moment the patient walks in." },
      { title: "Checked in", detail: "After ID, insurance and forms are done, move to Checked in." },
      { title: "Roomed", detail: "The MA moves the card to Roomed when the patient is in the exam room (add the room number)." },
      { title: "With provider", detail: "The provider or MA moves it when the provider enters the room." },
      { title: "Checkout / Completed", detail: "Front desk moves to Checkout, then Completed once follow-up is booked." },
      { title: "No-shows", detail: "Mark a patient no-show 15 minutes after their start time. They will appear in Opportunity Finder → Missed appointment." },
    ],
  },
  {
    slug: "ccm-monthly-outreach",
    title: "CCM monthly outreach",
    category: "Care management",
    description: "Monthly touch for CCM patients using the guided call workflow.",
    steps: [
      { title: "Work your worklist", detail: "Open Care Management → Monthly Worklist. Start with patients not yet contacted this month." },
      { title: "Use the call workflow", detail: "Open the patient's task and follow the guided questions. Time is tracked for the 20-minute rule." },
      { title: "Escalate when needed", detail: "Flag anything for the provider in the workflow — it creates an escalation automatically." },
      { title: "Create follow-up tasks", detail: "Use Create task on the patient page for anything that needs front-desk or MA follow-up." },
    ],
  },
  {
    slug: "apcm-enrollment",
    title: "How to set up a patient for APCM",
    category: "Care management",
    description: "Consent, care plan and initiating visit so APCM can bill.",
    steps: [
      { title: "Confirm consent", detail: "Record APCM consent (verbal or written) on the patient's APCM section." },
      { title: "Apply the care plan", detail: "Use Apply standard care plan on the APCM page, then review it." },
      { title: "Initiating visit", detail: "Make sure an initiating visit within the last 3 years is on file." },
      { title: "Check readiness", detail: "The APCM page shows who is ready to bill and who still needs setup." },
    ],
  },
  {
    slug: "medication-refill",
    title: "Medication refill requests",
    category: "Clinical support",
    description: "Getting refill requests to the right provider without delays.",
    steps: [
      { title: "Log the request", detail: "Use the refill panel on the patient page (or the call workflow) to send it to the provider." },
      { title: "Provider decides", detail: "The provider approves, asks for a visit, or denies from Refill Requests. Prescribing happens in Practice Fusion." },
      { title: "Close the loop", detail: "Let the patient know the outcome and schedule a visit if the provider requested one." },
    ],
  },
  {
    slug: "no-show-follow-up",
    title: "No-show follow-up",
    category: "Front desk",
    description: "What to do when a patient misses an appointment.",
    steps: [
      { title: "Mark the no-show", detail: "On Patient Flow, use the card menu → Mark no-show (asks for confirmation)." },
      { title: "Same-day call", detail: "Call to reschedule. If you can't reach them, create a Patient call task for tomorrow." },
      { title: "Weekly sweep", detail: "Opportunity Finder → Missed appointment lists anyone not yet rescheduled." },
    ],
  },
  {
    slug: "my-work-tasks",
    title: "Using My Work",
    category: "Operations",
    description: "How tasks are created, assigned and closed.",
    steps: [
      { title: "One place for follow-ups", detail: "Anything that needs doing later becomes a task — from a patient page, Opportunity Finder, or New task." },
      { title: "Assign clearly", detail: "Assign to a person, or leave it in a role queue (e.g. Front desk) so whoever is on shift picks it up." },
      { title: "Keep it current", detail: "Use In progress / Waiting, add a comment when you touch it, and complete it when done." },
      { title: "Overdue", detail: "Managers review Overdue each afternoon and reassign anything stuck." },
    ],
  },
  {
    slug: "opening-closing",
    title: "Opening / closing checklist",
    category: "Operations",
    description: "Daily open and close for every location.",
    steps: [
      { title: "Opening", detail: "Log in to workstations, import today's schedule, check the Home dashboard priorities and huddle for 10 minutes." },
      { title: "During the day", detail: "Keep Patient Flow current so wait times and throughput are accurate." },
      { title: "Closing", detail: "Every appointment should be Completed, No-show or Cancelled. Review overdue tasks and log out of all workstations." },
    ],
  },
];

/** Tomorrow-or-next-weekday helper (clinics closed weekends). */
export function nextClinicDay(today: string): string {
  let d = addDays(today, 1);
  for (let i = 0; i < 3; i++) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) break;
    d = addDays(d, 1);
  }
  return d;
}

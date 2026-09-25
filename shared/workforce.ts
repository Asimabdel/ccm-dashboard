// Workforce helpers shared by server and client: clinic-local date math and the
// starter Medical Assistant job definition. All four clinics are in Houston, so
// one timezone covers every schedule and time-clock calculation.

export const CLINIC_TZ = "America/Chicago";

/** Clock-ins up to this many minutes after the shift start still count as on time. */
export const LATE_GRACE_MINUTES = 5;

/**
 * Is this person's attendance judged (late / no-show) on this date? Only for people
 * on the time clock, and only from their clock start date on — salaried staff and
 * providers are just "scheduled".
 */
export function attendanceTracked(profile: { usesTimeClock?: boolean | null; clockStartDate?: string | null } | null | undefined, date: string): boolean {
  return !!profile?.usesTimeClock && (!profile.clockStartDate || date >= profile.clockStartDate);
}

/** Roles that may use ONLY the workforce pages — never patient (PHI) endpoints. */
export const WORKFORCE_ONLY_ROLES = ["medical_assistant"] as const;

export type DutyFrequency = "daily" | "weekly" | "monthly" | "as_needed";

/** YYYY-MM-DD for an instant, in clinic-local time. */
export function localDateStr(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Minutes since clinic-local midnight for an instant. */
export function localMinutes(d: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: CLINIC_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** "HH:MM" -> minutes since midnight. */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Length of a shift in minutes (0 if the times are inverted). */
export function shiftMinutes(startTime: string, endTime: string): number {
  return Math.max(0, timeToMinutes(endTime) - timeToMinutes(startTime));
}

// Date-string arithmetic is done at UTC noon so DST changes can never shift the day.
function toUtcNoon(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00Z`);
}

export function addDays(dateStr: string, n: number): string {
  const d = toUtcNoon(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(dateStr: string): number {
  return (toUtcNoon(dateStr).getUTCDay() + 6) % 7;
}

/** The Monday on or before the given date. */
export function weekStart(dateStr: string): string {
  return addDays(dateStr, -weekdayIndex(dateStr));
}

/** The 7 dates (Mon–Sun) of the week containing dateStr. */
export function weekDates(dateStr: string): string[] {
  const start = weekStart(dateStr);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The completion bucket a duty belongs to on a given date. */
export function periodKey(frequency: DutyFrequency, dateStr: string): string {
  if (frequency === "weekly") return weekStart(dateStr);
  if (frequency === "monthly") return dateStr.slice(0, 7);
  return dateStr;
}

export function isValidDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(+toUtcNoon(s));
}

export function isValidTimeStr(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** "08:00" -> "8:00 AM". */
export function fmtTime(t: string): string {
  const mins = timeToMinutes(t);
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** 135 -> "2h 15m". */
export function fmtDuration(mins: number): string {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** "2026-09-21" -> "Mon, Sep 21". */
export function fmtDay(dateStr: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }): string {
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(toUtcNoon(dateStr));
}

// ---- Starter job definition ----
// A practical primary-care Medical Assistant role. Loaded once from the Roles tab
// ("Load MA starter template"); every line is editable afterwards.

export interface DutyTemplate {
  category: string;
  title: string;
  detail?: string;
  frequency: DutyFrequency;
}

export const MA_ROLE_TEMPLATE: { name: string; summary: string; duties: DutyTemplate[] } = {
  name: "Medical Assistant",
  summary:
    "Keeps the provider's clinic day moving: prepares rooms and charts, rooms patients accurately, " +
    "carries out provider orders, and closes every loop (labs, referrals, refills, messages) before leaving.",
  duties: [
    { category: "Opening", frequency: "daily", title: "Huddle with provider on today's schedule", detail: "Review the day's patients, flag AWVs, procedures, and anyone needing labs or forms." },
    { category: "Opening", frequency: "daily", title: "Stock and wipe down exam rooms", detail: "Gowns, table paper, gloves, otoscope tips, sharps container under the fill line." },
    { category: "Opening", frequency: "daily", title: "Log vaccine/medication refrigerator temperatures", detail: "Record min/max; report any out-of-range reading to the manager immediately." },
    { category: "Opening", frequency: "daily", title: "Run glucometer / point-of-care controls", detail: "Document QC results before the first patient test." },
    { category: "Patient flow", frequency: "daily", title: "Pre-chart the day's visits", detail: "Care gaps, outstanding labs/imaging, last visit follow-ups, needed screenings (PHQ-9, fall risk)." },
    { category: "Patient flow", frequency: "daily", title: "Room patients within 10 minutes of check-in", detail: "Full vitals, chief complaint, medication and allergy reconciliation, pharmacy confirmed." },
    { category: "Patient flow", frequency: "daily", title: "Turn rooms over between patients", detail: "Disinfect surfaces and equipment, change paper, restock what was used." },
    { category: "Clinical tasks", frequency: "as_needed", title: "Injections and immunizations", detail: "Verify order, lot and expiry; document site, lot, and VIS date; observe per protocol." },
    { category: "Clinical tasks", frequency: "as_needed", title: "In-office testing (EKG, PFT, ABI, urinalysis, rapid tests)", detail: "Perform per order and attach results to the chart the same day." },
    { category: "Clinical tasks", frequency: "as_needed", title: "Phlebotomy and specimen handling", detail: "Two patient identifiers, correct tubes, label at the chair, log the pickup." },
    { category: "Closing the loop", frequency: "daily", title: "Work the refill and patient-message queue to zero", detail: "Route to the provider what you can't close; note what was done." },
    { category: "Closing the loop", frequency: "daily", title: "Send today's referrals and orders", detail: "Every referral, imaging, and lab order from today's visits is sent with records attached." },
    { category: "Closing the loop", frequency: "daily", title: "Call patients with results the provider has signed", detail: "Document the call; schedule follow-up when the provider asked for one." },
    { category: "Closing", frequency: "daily", title: "Close out rooms and secure supplies", detail: "Lock medication/sample cabinets, remove specimens, log off workstations, no PHI left out." },
    { category: "Weekly", frequency: "weekly", title: "Check expiration dates and reorder supplies", detail: "Medications, vaccines, test kits; send the supply order to the manager." },
    { category: "Weekly", frequency: "weekly", title: "Chase outstanding referrals and results", detail: "Anything older than 7 days without a result or appointment gets a follow-up call." },
    { category: "Monthly", frequency: "monthly", title: "Emergency kit, oxygen, and AED check", detail: "Confirm contents, expiry dates, tank level, and AED pads/battery; sign the log." },
    { category: "Monthly", frequency: "monthly", title: "Complete assigned compliance training", detail: "HIPAA, OSHA/bloodborne pathogens, and any module assigned this month." },
  ],
};

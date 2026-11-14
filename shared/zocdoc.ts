// ZocDoc in Master Billing (owner only, 2026-11-13): reading ZocDoc's "Appointment report" download and the
// spend-vs-revenue math. Pure functions, shared by the browser (reading the file), the server and the tests.
import { sheetCents } from "./billSheet";
import { parseDateValue, parseTimeValue } from "./workspace";

/** Columns the report can have. Only the patient, the appointment date and the cost really matter. */
export const ZOCDOC_FIELDS = {
  appointmentId: "Appointment ID",
  patientName: "Patient (full name)",
  firstName: "Patient first name",
  lastName: "Patient last name",
  dob: "Date of birth",
  appointmentAt: "Appointment date & time",
  appointmentDate: "Appointment date",
  appointmentTime: "Appointment time (only)",
  bookedAt: "Booked on",
  status: "Status",
  patientType: "New / existing patient",
  cost: "Cost",
  costReason: "Cost reason",
  bookingSource: "Booking source",
  provider: "Provider",
  location: "Location",
  insuranceCarrier: "Insurance",
  insurancePlan: "Insurance plan",
  visitReason: "Visit reason",
} as const;
export type ZocdocField = keyof typeof ZOCDOC_FIELDS;
export const ZOCDOC_FIELD_KEYS = Object.keys(ZOCDOC_FIELDS) as ZocdocField[];
export type ZocdocMapping = Partial<Record<ZocdocField, number>>;

// A column is claimed by the first field (in FIELD_ORDER) that lists its header.
const ALIASES: Record<ZocdocField, string[]> = {
  appointmentId: ["appointment id", "appt id", "appointment #", "appointment number", "booking id", "zocdoc appointment id", "zocdoc id", "request id"],
  firstName: ["patient first name", "first name", "first", "firstname", "patient first"],
  lastName: ["patient last name", "last name", "last", "lastname", "patient last"],
  patientName: ["patient", "patient name", "name", "patient full name", "full name"],
  dob: ["dob", "date of birth", "birth date", "birthdate", "patient dob", "patient date of birth", "patient birthday", "birthday"],
  appointmentDate: ["appointment date", "appt date", "date of appointment", "visit date", "date"],
  appointmentAt: ["appointment time", "appointment date/time", "appointment date & time", "appointment datetime", "appointment date and time", "appt time", "appointment", "appointment start", "start time", "appointment start time"],
  appointmentTime: ["time", "start", "appt start"],
  bookedAt: ["booked", "booked on", "booked at", "booking date", "booking time", "booked date", "booked time", "date booked", "time booked", "created", "created at", "booking created", "booked date/time"],
  status: ["status", "appointment status", "booking status"],
  patientType: ["patient type", "new/existing", "new or existing", "new / existing", "new patient", "patient status"],
  cost: ["cost", "booking cost", "cost ($)", "fee", "booking fee", "charge", "price", "amount", "zocdoc fee", "cost usd"],
  costReason: ["cost reason", "charge reason", "fee reason", "billing reason", "cost type", "charge type"],
  bookingSource: ["booking source", "source", "source channel", "channel", "booked via", "booked through", "booking channel"],
  provider: ["professional", "provider", "doctor", "provider name", "professional name", "physician"],
  location: ["location", "office", "practice location", "location name", "address"],
  insuranceCarrier: ["insurance", "insurance carrier", "carrier", "insurance company", "payer", "insurance name"],
  insurancePlan: ["insurance plan", "plan", "plan name"],
  visitReason: ["appointment type", "visit reason", "reason for visit", "procedure", "visit type", "reason", "service"],
};
const FIELD_ORDER: ZocdocField[] = ["appointmentId", "firstName", "lastName", "patientName", "dob", "bookedAt", "appointmentDate", "appointmentAt", "appointmentTime", "status", "patientType", "costReason", "cost", "bookingSource", "provider", "location", "insurancePlan", "insuranceCarrier", "visitReason"];

const normHeader = (h: string) => h.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\s]+/g, " ").replace(/\s*#/g, " #").toLowerCase().trim();

/** Find the header row (in the first 15) and guess each column. */
export function detectZocdocMapping(rows: string[][]): { headerRow: number; headers: string[]; mapping: ZocdocMapping } {
  let best = { headerRow: 0, headers: (rows[0] ?? []).map((h) => String(h ?? "").trim()), mapping: {} as ZocdocMapping, score: 0 };
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const headers = rows[r]!.map((h) => String(h ?? "").trim());
    const lower = headers.map(normHeader);
    const mapping: ZocdocMapping = {};
    const used = new Set<number>();
    for (const f of FIELD_ORDER) {
      const idx = lower.findIndex((h, i) => !used.has(i) && ALIASES[f].includes(h));
      if (idx >= 0) { mapping[f] = idx; used.add(idx); }
    }
    const who = mapping.patientName != null || mapping.lastName != null;
    const when = mapping.appointmentAt != null || mapping.appointmentDate != null;
    const score = Object.keys(mapping).length;
    if (who && when && score > best.score) best = { headerRow: r, headers, mapping, score };
  }
  return { headerRow: best.headerRow, headers: best.headers, mapping: best.mapping };
}

export type ZocdocStatus = "confirmed" | "completed" | "patient_canceled" | "practice_canceled" | "patient_rescheduled" | "practice_rescheduled" | "no_show" | "other";
export const ZOCDOC_STATUS_LABELS: Record<ZocdocStatus, string> = {
  confirmed: "Confirmed", completed: "Completed", patient_canceled: "Patient canceled", practice_canceled: "Practice canceled",
  patient_rescheduled: "Patient rescheduled", practice_rescheduled: "Practice rescheduled", no_show: "No-show", other: "Other",
};

/** ZocDoc's status words ("PracticeCanceled", "Cancelled by patient", "No show"…) → one of ours. */
export function zocdocStatus(raw: string | null | undefined): ZocdocStatus {
  const s = String(raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return "other";
  if (/noshow|missed/.test(s)) return "no_show";
  if (/resched/.test(s)) return /patient/.test(s) ? "patient_rescheduled" : "practice_rescheduled";
  if (/cancel/.test(s)) return /practice|provider|office|doctor|professional/.test(s) ? "practice_canceled" : "patient_canceled";
  if (/complete|arrived|checkedin|seen|attended/.test(s)) return "completed";
  if (/confirm|scheduled|booked|upcoming|pending/.test(s)) return "confirmed";
  return "other";
}

export function zocdocPatientType(raw: string | null | undefined): "new" | "existing" | null {
  const s = String(raw ?? "").toLowerCase();
  if (/new/.test(s)) return "new";
  if (/exist|return|establish/.test(s)) return "existing";
  return null;
}

/** One booking as read from the file (the server adds the key and the patient match). */
export interface ZocdocRow {
  appointmentId: string | null;
  patientFirst: string | null;
  patientLast: string | null;
  patientDob: string | null;
  /** "YYYY-MM-DD HH:MM" (time 00:00 when the file has none). */
  appointmentAt: string;
  appointmentDate: string;
  bookedAt: string | null;
  status: ZocdocStatus;
  statusText: string | null;
  patientType: "new" | "existing" | null;
  costCents: number;
  costReason: string | null;
  bookingSource: string | null;
  providerName: string | null;
  locationName: string | null;
  insuranceCarrier: string | null;
  insurancePlan: string | null;
  visitReason: string | null;
}

export interface ZocdocParseResult {
  headerRow: number;
  headers: string[];
  mapping: ZocdocMapping;
  rows: ZocdocRow[];
  /** Data rows that couldn't be read (no patient name or no appointment date). */
  skipped: number;
  /** Fields the file seems to lack that the numbers need. */
  missing: ZocdocField[];
}

const cell = (r: string[], i: number | undefined) => (i == null ? "" : String(r[i] ?? "").trim());
const clip = (s: string, n: number) => (s ? s.slice(0, n) : null);

/** "Doe, Jane A" → Jane / Doe; "Jane Doe" → Jane / Doe; first line only (a cell can carry DOB, phone, email below). */
export function splitZocdocName(raw: string): { first: string | null; last: string | null } {
  const line = String(raw ?? "").split(/\r?\n/)[0]!.replace(/\s+/g, " ").trim();
  if (!line) return { first: null, last: null };
  if (line.includes(",")) {
    const [last, rest] = line.split(",", 2) as [string, string | undefined];
    const first = (rest ?? "").trim().split(" ")[0] ?? "";
    return { first: first || null, last: last.trim() || null };
  }
  const w = line.split(" ");
  return w.length === 1 ? { first: null, last: w[0]! } : { first: w[0]!, last: w[w.length - 1]! };
}

/** Read the report's rows. `override` = the owner's own column choices. */
export function parseZocdocRows(rows: string[][], override?: ZocdocMapping): ZocdocParseResult {
  const det = detectZocdocMapping(rows);
  const mapping: ZocdocMapping = override ?? det.mapping;
  const out: ZocdocRow[] = [];
  let skipped = 0;
  for (const r of rows.slice(det.headerRow + 1)) {
    if (!r.some((c) => String(c ?? "").trim())) continue;
    let first = cell(r, mapping.firstName) || null;
    let last = cell(r, mapping.lastName) || null;
    const whole = cell(r, mapping.patientName);
    if ((!first || !last) && whole) { const s = splitZocdocName(whole); first = first ?? s.first; last = last ?? s.last; }
    const dobRaw = cell(r, mapping.dob) || (/DOB:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(whole)?.[1] ?? "");
    const atRaw = cell(r, mapping.appointmentAt);
    const date = parseDateValue(cell(r, mapping.appointmentDate) || atRaw);
    if (!last || !date) { skipped++; continue; }
    const time = parseTimeValue(cell(r, mapping.appointmentTime) || atRaw) ?? "00:00";
    const bookedRaw = cell(r, mapping.bookedAt).replace(/^booked:?\s*/i, "");
    const bookedDate = parseDateValue(bookedRaw);
    const statusText = cell(r, mapping.status);
    out.push({
      appointmentId: clip(cell(r, mapping.appointmentId), 60),
      patientFirst: first ? first.slice(0, 100) : null,
      patientLast: last.slice(0, 100),
      patientDob: dobRaw ? parseDateValue(dobRaw, { dob: true }) : null,
      appointmentAt: `${date} ${time}`,
      appointmentDate: date,
      bookedAt: bookedDate ? `${bookedDate} ${parseTimeValue(bookedRaw) ?? "00:00"}` : null,
      status: zocdocStatus(statusText),
      statusText: clip(statusText, 80),
      patientType: zocdocPatientType(cell(r, mapping.patientType)),
      costCents: Math.max(0, sheetCents(cell(r, mapping.cost)) ?? 0),
      costReason: clip(cell(r, mapping.costReason), 80),
      bookingSource: clip(cell(r, mapping.bookingSource), 80),
      providerName: clip(cell(r, mapping.provider), 160),
      locationName: clip(cell(r, mapping.location), 160),
      insuranceCarrier: clip(cell(r, mapping.insuranceCarrier).split(/\r?\n/)[0]!, 160),
      insurancePlan: clip(cell(r, mapping.insurancePlan), 160),
      visitReason: clip(cell(r, mapping.visitReason), 160),
    });
  }
  const missing: ZocdocField[] = [];
  if (mapping.patientName == null && mapping.lastName == null) missing.push("patientName");
  if (mapping.appointmentAt == null && mapping.appointmentDate == null) missing.push("appointmentDate");
  if (mapping.cost == null) missing.push("cost");
  if (mapping.dob == null && !out.some((x) => x.patientDob)) missing.push("dob");
  return { headerRow: det.headerRow, headers: det.headers, mapping, rows: out, skipped, missing };
}

/** What makes a booking the same booking in a later file (the server hashes the long form). */
export function bookingKeySource(r: Pick<ZocdocRow, "appointmentId" | "patientFirst" | "patientLast" | "patientDob" | "appointmentAt" | "providerName">): string {
  if (r.appointmentId) return `id:${r.appointmentId}`;
  const n = (s: string | null) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `h:${n(r.patientFirst)}|${n(r.patientLast)}|${r.patientDob ?? ""}|${r.appointmentAt}|${n(r.providerName)}`;
}

// ── The numbers ──────────────────────────────────────────────────────────────

/** A patient "came in" when a claim for them starts within this many days after their first ZocDoc booking. */
export const CAME_IN_DAYS = 45;

export interface ZBooking {
  /** The person: MyPCP subjectKey when matched, else a name + DOB stand-in ("u:…"). */
  person: string;
  matched: boolean;
  appointmentDate: string;
  status: ZocdocStatus;
  patientType: "new" | "existing" | null;
  costCents: number;
  costReason: string | null;
  providerName: string | null;
  insuranceCarrier: string | null;
}
export interface ZClaim { date: string; paidCents: number; owesCents: number; billedCents: number }

export interface ZPerson {
  person: string;
  matched: boolean;
  firstDate: string;
  bookings: number;
  chargedBookings: number;
  costCents: number;
  /** New patient per ZocDoc (or charged when ZocDoc didn't say). */
  isNew: boolean;
  /** Had a claim before the first ZocDoc booking (already our patient). */
  alreadyOurs: boolean;
  cameIn: boolean;
  /** First booking is too recent to judge (inside the came-in window). */
  pending: boolean;
  paidFirstCents: number;
  paidLaterCents: number;
  owesCents: number;
  statuses: ZocdocStatus[];
  practiceCanceledCharged: number;
  provider: string | null;
  insurance: string | null;
}

export interface ZRow { key: string; bookings: number; chargedBookings: number; costCents: number; patients: number; cameIn: number; judged: number; paidCents: number; owesCents: number }

export interface ZocdocSummary {
  totals: {
    bookings: number; chargedBookings: number; spentCents: number; patients: number; newPatients: number; chargedPatients: number;
    matchedPatients: number; cameIn: number; judged: number; pending: number; alreadyOurs: number;
    paidFirstCents: number; paidLaterCents: number; paidCents: number; owesCents: number;
  };
  months: ZRow[];
  providers: ZRow[];
  insurances: ZRow[];
  leaks: {
    noVisit: { patients: number; notInMyPcp: number; costCents: number };
    practiceCanceled: { bookings: number; costCents: number };
    cancellationCharges: { bookings: number; costCents: number };
    noShow: { bookings: number; costCents: number };
  };
  people: ZPerson[];
}

const plusDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const blank = (key: string): ZRow => ({ key, bookings: 0, chargedBookings: 0, costCents: 0, patients: 0, cameIn: 0, judged: 0, paidCents: 0, owesCents: 0 });

/**
 * Spend vs. what the booked patients brought in. Spend counts every booking in range; revenue counts the claims of
 * patients ZocDoc charged for as new, from their first booking on (first `CAME_IN_DAYS` days vs. later).
 */
export function zocdocSummary(bookings: ZBooking[], claimsByPerson: Map<string, ZClaim[]>, today: string): ZocdocSummary {
  const byPerson = new Map<string, ZBooking[]>();
  for (const b of bookings) byPerson.set(b.person, [...(byPerson.get(b.person) ?? []), b]);

  const people: ZPerson[] = [];
  for (const [person, list] of Array.from(byPerson.entries())) {
    list.sort((a, b) => a.appointmentDate.localeCompare(b.appointmentDate));
    const first = list[0]!;
    const firstDate = first.appointmentDate;
    const charged = list.filter((b) => b.costCents > 0);
    const isNew = list.some((b) => b.patientType === "new") || (!list.some((b) => b.patientType === "existing") && charged.length > 0);
    const claims = claimsByPerson.get(person) ?? [];
    const from = plusDays(firstDate, -1);
    const windowEnd = plusDays(firstDate, CAME_IN_DAYS);
    const after = claims.filter((c) => c.date >= from);
    const inWindow = after.filter((c) => c.date <= windowEnd);
    people.push({
      person, matched: first.matched, firstDate, bookings: list.length, chargedBookings: charged.length,
      costCents: charged.reduce((s, b) => s + b.costCents, 0), isNew,
      alreadyOurs: claims.some((c) => c.date < from),
      cameIn: inWindow.length > 0,
      pending: windowEnd > today && inWindow.length === 0,
      paidFirstCents: inWindow.reduce((s, c) => s + c.paidCents, 0),
      paidLaterCents: after.filter((c) => c.date > windowEnd).reduce((s, c) => s + c.paidCents, 0),
      owesCents: after.reduce((s, c) => s + c.owesCents, 0),
      statuses: list.map((b) => b.status),
      practiceCanceledCharged: charged.filter((b) => b.status === "practice_canceled").length,
      provider: first.providerName, insurance: first.insuranceCarrier,
    });
  }

  const months = new Map<string, ZRow>();
  const providers = new Map<string, ZRow>();
  const insurances = new Map<string, ZRow>();
  const row = (m: Map<string, ZRow>, k: string) => { if (!m.has(k)) m.set(k, blank(k)); return m.get(k)!; };
  // Spend and booking counts: by each booking's own month / provider / insurance.
  for (const b of bookings) {
    for (const r of [row(months, b.appointmentDate.slice(0, 7)), row(providers, b.providerName || "(not in the file)"), row(insurances, b.insuranceCarrier || "(none / self-pay)")]) {
      r.bookings++;
      if (b.costCents > 0) { r.chargedBookings++; r.costCents += b.costCents; }
    }
  }
  // Patients and revenue: new patients ZocDoc charged for, by their first booking.
  const paying = people.filter((p) => p.isNew && p.chargedBookings > 0);
  for (const p of paying) {
    for (const r of [row(months, p.firstDate.slice(0, 7)), row(providers, p.provider || "(not in the file)"), row(insurances, p.insurance || "(none / self-pay)")]) {
      r.patients++;
      if (!p.pending) r.judged++;
      if (p.cameIn) r.cameIn++;
      r.paidCents += p.paidFirstCents + p.paidLaterCents;
      r.owesCents += p.owesCents;
    }
  }

  const sum = <T>(list: T[], f: (x: T) => number) => list.reduce((s, x) => s + f(x), 0);
  const noVisit = paying.filter((p) => !p.cameIn && !p.pending);
  const cancelCharged = bookings.filter((b) => b.costCents > 0 && /cancel/i.test(b.costReason ?? ""));
  const practiceCanceled = bookings.filter((b) => b.costCents > 0 && b.status === "practice_canceled");
  const noShow = bookings.filter((b) => b.costCents > 0 && b.status === "no_show");
  const byCost = (a: ZRow, b: ZRow) => b.costCents - a.costCents || b.bookings - a.bookings;

  return {
    totals: {
      bookings: bookings.length,
      chargedBookings: bookings.filter((b) => b.costCents > 0).length,
      spentCents: sum(bookings, (b) => b.costCents),
      patients: people.length,
      newPatients: people.filter((p) => p.isNew).length,
      chargedPatients: paying.length,
      matchedPatients: paying.filter((p) => p.matched).length,
      cameIn: paying.filter((p) => p.cameIn).length,
      judged: paying.filter((p) => !p.pending).length,
      pending: paying.filter((p) => p.pending).length,
      alreadyOurs: paying.filter((p) => p.alreadyOurs).length,
      paidFirstCents: sum(paying, (p) => p.paidFirstCents),
      paidLaterCents: sum(paying, (p) => p.paidLaterCents),
      paidCents: sum(paying, (p) => p.paidFirstCents + p.paidLaterCents),
      owesCents: sum(paying, (p) => p.owesCents),
    },
    months: Array.from(months.values()).sort((a, b) => a.key.localeCompare(b.key)),
    providers: Array.from(providers.values()).sort(byCost),
    insurances: Array.from(insurances.values()).sort(byCost),
    leaks: {
      noVisit: { patients: noVisit.length, notInMyPcp: noVisit.filter((p) => !p.matched).length, costCents: sum(noVisit, (p) => p.costCents) },
      practiceCanceled: { bookings: practiceCanceled.length, costCents: sum(practiceCanceled, (b) => b.costCents) },
      cancellationCharges: { bookings: cancelCharged.length, costCents: sum(cancelCharged, (b) => b.costCents) },
      noShow: { bookings: noShow.length, costCents: sum(noShow, (b) => b.costCents) },
    },
    people,
  };
}

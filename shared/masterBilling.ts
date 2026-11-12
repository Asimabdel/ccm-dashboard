// Master Billing (owner only, built 2026-11-11): bills that come back from the clearinghouse
// (Office Ally) are uploaded as payment files (ERA / 835), PDF EOBs or claim-report spreadsheets.
// Every file is turned into the same "claim event" shape below; the events of one claim are then
// joined into one claim (mergeClaim) so a claim seen in several files is counted once.
import { AdjustmentKind, adjustmentKind, BillStatus, isReversal, payerLevel } from "./billCodes";
import { nameKey } from "./workspace";

export type BillSource = "era835" | "pdf" | "sheet";
/** Which source wins for the same payment: the payment file, then a PDF, then a spreadsheet. */
export const SOURCE_RANK: Record<BillSource, number> = { era835: 3, pdf: 2, sheet: 1 };
export const SOURCE_LABELS: Record<BillSource, string> = { era835: "Payment file (835)", pdf: "PDF (read by AI)", sheet: "Spreadsheet" };

export interface BillAdjustment {
  /** CO / PR / OA / PI / CR */
  group: string;
  /** Reason code (CARC), e.g. "45", "97"; "" when a spreadsheet only gives an amount. */
  code: string;
  cents: number;
  /** Set when the file says what the amount is but gives no reason code (spreadsheets). */
  kind?: AdjustmentKind;
}

export interface BillLineInput {
  /** CPT / HCPCS as billed. */
  code: string;
  modifiers: string[];
  units: number;
  serviceDate: string | null;
  billedCents: number;
  /** Allowed amount when the file says it. */
  allowedCents: number | null;
  paidCents: number;
  adjustments: BillAdjustment[];
  /** Remark codes (RARC), e.g. "N130". */
  remarks: string[];
  /** The code the insurance paid under, when it changed it. */
  paidAsCode?: string | null;
}

export interface BillEventInput {
  source: BillSource;
  /** The practice's claim number (patient control / account number, CLP01). */
  claimNo: string | null;
  /** The insurance's own claim number (CLP07). */
  payerClaimNo: string | null;
  /** X12 claim status (CLP02) for payment files; null otherwise. */
  clpStatus: string | null;
  /** Status from a claim report / spreadsheet (or a PDF), when it says. */
  sheetStatus: BillStatus | null;
  payerName: string | null;
  payerId: string | null;
  /** CLP06 claim filing indicator (MB = Medicare Part B, CI = commercial…). */
  filingIndicator: string | null;
  patientName: string | null;
  patientDob: string | null;
  memberId: string | null;
  providerName: string | null;
  providerNpi: string | null;
  serviceFrom: string | null;
  serviceTo: string | null;
  paidDate: string | null;
  checkNumber: string | null;
  billedCents: number;
  paidCents: number;
  patientRespCents: number;
  claimAdjustments: BillAdjustment[];
  lines: BillLineInput[];
  /** Free-text denial note from a spreadsheet. */
  note: string | null;
}

export const NOT_LISTED = "(not listed)";
export const CLAIM_LEVEL = "(claim level)";

const upperAlnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
/** CPT codes in capitals; "(not listed)" / "(claim level)" as they are. */
const codeOf = (c: string) => (c.startsWith("(") ? c : c.toUpperCase());

/** Same claim, any file: the practice's claim number, else patient + first date of service + billed. */
export function claimRefOf(e: Pick<BillEventInput, "claimNo" | "patientName" | "serviceFrom" | "billedCents" | "lines">): string {
  const no = upperAlnum(e.claimNo ?? "");
  if (no) return `c:${no}`.slice(0, 80);
  return altKeyOf(e);
}

/** Patient + first date of service + billed: matches a claim-report row to its payment when the claim numbers differ. */
export function altKeyOf(e: Pick<BillEventInput, "patientName" | "serviceFrom" | "billedCents" | "lines">): string {
  const first = e.serviceFrom ?? e.lines.map((l) => l.serviceDate).filter(Boolean).sort()[0] ?? "";
  return `n:${nameKey(e.patientName ?? "")}|${first}|${Math.abs(e.billedCents)}`.slice(0, 120);
}

export interface MergedLine {
  code: string;
  modifiers: string[];
  units: number;
  serviceDate: string | null;
  billedCents: number;
  allowedCents: number;
  paidCents: number;
  patientOwesCents: number;
  writtenOffCents: number;
  deniedCents: number;
  /** The biggest denial reason on the line, "CO-97". */
  denialCode: string | null;
  /** Every adjustment from the deciding payment (for the claim view). */
  adjustments: BillAdjustment[];
  remarks: string[];
}

export interface MergedClaim {
  status: BillStatus;
  sourceUsed: BillSource;
  billedCents: number;
  allowedCents: number;
  paidCents: number;
  /** Paid by a second / third insurance. */
  laterPayersPaidCents: number;
  patientOwesCents: number;
  writtenOffCents: number;
  deniedCents: number;
  payerName: string | null;
  payerId: string | null;
  filingIndicator: string | null;
  otherPayers: string[];
  patientName: string | null;
  patientDob: string | null;
  memberId: string | null;
  providerName: string | null;
  providerNpi: string | null;
  claimNo: string | null;
  payerClaimNo: string | null;
  firstServiceDate: string | null;
  lastPaidDate: string | null;
  denialCodes: string[];
  lines: MergedLine[];
}

type Ev = BillEventInput & { id: number };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const lineKey = (l: BillLineInput) => `${l.code.toUpperCase()}|${l.modifiers.map((m) => m.toUpperCase()).join(",")}|${l.serviceDate ?? ""}`;

/** Lines of an event keyed "code|mods|date#n" (the n-th line with that code that day). */
function keyedLines(e: Ev): Map<string, BillLineInput> {
  const seen = new Map<string, number>();
  const out = new Map<string, BillLineInput>();
  const lines = e.lines.length ? e.lines : [claimAsLine(e)];
  for (const l of lines) {
    const k = lineKey(l);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    out.set(`${k}#${n}`, l);
  }
  return out;
}

/** A claim with no CPT lines (a claim-level spreadsheet row) becomes one "(not listed)" line. */
function claimAsLine(e: Ev): BillLineInput {
  return {
    code: NOT_LISTED, modifiers: [], units: 1, serviceDate: e.serviceFrom, billedCents: e.billedCents, allowedCents: null,
    paidCents: e.paidCents, adjustments: e.claimAdjustments, remarks: [],
  };
}

function split(adjs: BillAdjustment[]) {
  let patient = 0, writeoff = 0, denied = 0;
  let topDenial: BillAdjustment | null = null;
  for (const a of adjs) {
    const k = a.kind ?? adjustmentKind(a.group, a.code);
    if (k === "patient") patient += a.cents;
    else if (k === "writeoff") writeoff += a.cents;
    else {
      denied += a.cents;
      if (a.cents > 0 && (!topDenial || a.cents > topDenial.cents)) topDenial = a;
    }
  }
  return { patient, writeoff, denied, denialCode: topDenial ? adjustmentLabel(topDenial) : null };
}

/** "CO-97", or "CO" when there's no reason code. */
export const adjustmentLabel = (a: Pick<BillAdjustment, "group" | "code">) => `${a.group.toUpperCase()}${a.code ? `-${a.code.toUpperCase()}` : ""}`;

const byDate = (a: Ev, b: Ev) => (a.paidDate ?? "").localeCompare(b.paidDate ?? "") || a.id - b.id;

/** PDF payments already in a payment file (same claim, same amount, same check or payer) are dropped. */
function dropDuplicatePdfs(events: Ev[]): Ev[] {
  const era = events.filter((e) => e.source === "era835");
  if (!era.length) return events;
  return events.filter((e) => e.source !== "pdf" || !era.some((x) =>
    x.paidCents === e.paidCents && ((x.checkNumber && e.checkNumber && upperAlnum(x.checkNumber) === upperAlnum(e.checkNumber)) || nameKey(x.payerName ?? "") === nameKey(e.payerName ?? ""))));
}

/**
 * Join every event of one claim into the claim: billed counts once, payments from every insurance
 * add up, take-backs subtract. Payment events (835 / PDF) decide; a spreadsheet row only counts
 * when no payment for the claim has been uploaded.
 */
export function mergeClaim(all: Ev[]): MergedClaim {
  if (!all.length) throw new Error("mergeClaim needs at least one event");
  const payments = dropDuplicatePdfs(all.filter((e) => e.source !== "sheet")).sort(byDate);
  if (!payments.length) return mergeSheetOnly(all.slice().sort(byDate));

  const kept = payments.filter((e) => !isReversal(e.clpStatus));
  const reversals = payments.filter((e) => isReversal(e.clpStatus));
  // The deciding payment: the latest one from the first insurance; the latest from the last insurance sets what the patient owes.
  const minLevel = kept.length ? Math.min(...kept.map((e) => payerLevel(e.clpStatus))) : 1;
  const maxLevel = kept.length ? Math.max(...kept.map((e) => payerLevel(e.clpStatus))) : 1;
  const main = kept.filter((e) => payerLevel(e.clpStatus) === minLevel).at(-1) ?? payments.at(-1)!;
  const last = kept.filter((e) => payerLevel(e.clpStatus) === maxLevel).at(-1) ?? main;

  const mainLines = keyedLines(main);
  const lastLines = keyedLines(last);
  const order = Array.from(mainLines.keys());
  // Lines that only appear in another payment (a corrected claim added a line).
  for (const e of kept) for (const k of Array.from(keyedLines(e).keys())) if (!order.includes(k)) order.push(k);

  const lines: MergedLine[] = order.map((k) => {
    const base = mainLines.get(k) ?? kept.map((e) => keyedLines(e).get(k)).find(Boolean)!;
    const fromMain = split(base.adjustments);
    const lastLine = lastLines.get(k);
    const paid = sum(payments.map((e) => keyedLines(e).get(k)?.paidCents ?? 0));
    const patientOwes = lastLine && last !== main ? split(lastLine.adjustments).patient : fromMain.patient;
    return {
      code: codeOf(base.code), modifiers: base.modifiers.map((m) => m.toUpperCase()), units: base.units || 1, serviceDate: base.serviceDate ?? main.serviceFrom,
      billedCents: Math.abs(base.billedCents),
      allowedCents: base.allowedCents ?? Math.max(0, base.paidCents + fromMain.patient),
      paidCents: paid, patientOwesCents: patientOwes, writtenOffCents: fromMain.writeoff, deniedCents: fromMain.denied,
      denialCode: fromMain.denialCode, adjustments: base.adjustments, remarks: base.remarks,
    };
  });

  // Claim-level amounts (claim adjustments, and payments not tied to a line) as one extra line, so lines add up to the claim.
  const claimPaid = sum(payments.map((e) => e.paidCents));
  const linePaid = sum(lines.map((l) => l.paidCents));
  const hasLines = main.lines.length > 0;
  const claimAdj = hasLines ? split(main.claimAdjustments) : { patient: 0, writeoff: 0, denied: 0, denialCode: null };
  if (hasLines && (claimPaid !== linePaid || claimAdj.patient || claimAdj.writeoff || claimAdj.denied)) {
    lines.push({
      code: CLAIM_LEVEL, modifiers: [], units: 0, serviceDate: main.serviceFrom ?? lines[0]?.serviceDate ?? null, billedCents: 0,
      allowedCents: 0, paidCents: claimPaid - linePaid, patientOwesCents: claimAdj.patient, writtenOffCents: claimAdj.writeoff,
      deniedCents: claimAdj.denied, denialCode: claimAdj.denialCode, adjustments: main.claimAdjustments, remarks: [],
    });
  }

  let t = totals(lines);
  let status: BillStatus;
  const lastEvent = payments.at(-1)!;
  if (!kept.length || (reversals.length && isReversal(lastEvent.clpStatus) && t.paid <= 0)) {
    status = "taken_back";
    // Nothing stands from the reversed payment: no write-off, patient share or denial.
    for (const l of lines) l.patientOwesCents = l.writtenOffCents = l.deniedCents = 0;
    t = totals(lines);
  } else if (t.paid > 0) status = t.denied > 0 ? "partly_paid" : "paid";
  else if (t.denied > 0 || main.clpStatus === "4") status = "denied";
  else if (t.patientOwes > 0) status = "patient_owes";
  else status = main.sheetStatus ?? "paid";

  const otherPayers = Array.from(new Set(kept.filter((e) => e !== main && e.payerName && e.payerName !== main.payerName).map((e) => e.payerName!)));
  const denialCodes = Array.from(new Set(lines.map((l) => l.denialCode).filter((c): c is string => !!c)));
  return {
    status, sourceUsed: main.source,
    billedCents: t.billed, allowedCents: t.allowed, paidCents: t.paid,
    laterPayersPaidCents: sum(payments.filter((e) => payerLevel(e.clpStatus) > minLevel).map((e) => e.paidCents)),
    patientOwesCents: t.patientOwes, writtenOffCents: t.writtenOff, deniedCents: t.denied,
    payerName: main.payerName, payerId: main.payerId, filingIndicator: main.filingIndicator, otherPayers,
    ...who(payments, main),
    firstServiceDate: firstDate(lines, main), lastPaidDate: payments.map((e) => e.paidDate).filter(Boolean).sort().at(-1) ?? null,
    denialCodes, lines,
  };
}

function mergeSheetOnly(sheets: Ev[]): MergedClaim {
  const e = sheets.at(-1)!;
  const lines: MergedLine[] = Array.from(keyedLines(e).values()).map((l) => {
    const s = split(l.adjustments);
    return {
      code: codeOf(l.code), modifiers: l.modifiers, units: l.units || 1, serviceDate: l.serviceDate ?? e.serviceFrom,
      billedCents: Math.abs(l.billedCents), allowedCents: l.allowedCents ?? Math.max(0, l.paidCents + s.patient), paidCents: l.paidCents,
      patientOwesCents: s.patient, writtenOffCents: s.writeoff, deniedCents: s.denied, denialCode: s.denialCode,
      adjustments: l.adjustments, remarks: l.remarks,
    };
  });
  // A claim-level row's patient share comes from its own column.
  if (!e.lines.length && lines[0] && !lines[0].patientOwesCents) lines[0].patientOwesCents = e.patientRespCents;
  const t = totals(lines);
  let status: BillStatus = e.sheetStatus ?? (t.paid > 0 ? "paid" : "waiting");
  // A denied row with no denied amount: the unpaid charge is denied.
  if (status === "denied" && !t.denied) {
    for (const l of lines) l.deniedCents = Math.max(0, l.billedCents - l.paidCents - l.patientOwesCents - l.writtenOffCents);
    const code = e.note?.match(/\b(CO|PR|OA|PI)[-\s]?([A-Z]?\d{1,3})\b/i);
    for (const l of lines) l.denialCode ??= code ? `${code[1]!.toUpperCase()}-${code[2]!.toUpperCase()}` : "Denied";
  }
  if (status === "paid" && t.paid <= 0) status = "waiting";
  const t2 = totals(lines);
  return {
    status, sourceUsed: "sheet",
    billedCents: t2.billed, allowedCents: t2.allowed, paidCents: t2.paid, laterPayersPaidCents: 0,
    patientOwesCents: t2.patientOwes, writtenOffCents: t2.writtenOff, deniedCents: t2.denied,
    payerName: e.payerName, payerId: e.payerId, filingIndicator: e.filingIndicator, otherPayers: [],
    ...who(sheets, e),
    firstServiceDate: firstDate(lines, e), lastPaidDate: e.paidDate,
    denialCodes: Array.from(new Set(lines.map((l) => l.denialCode).filter((c): c is string => !!c))), lines,
  };
}

function totals(lines: MergedLine[]) {
  return {
    billed: sum(lines.map((l) => l.billedCents)), allowed: sum(lines.map((l) => l.allowedCents)), paid: sum(lines.map((l) => l.paidCents)),
    patientOwes: sum(lines.map((l) => l.patientOwesCents)), writtenOff: sum(lines.map((l) => l.writtenOffCents)), denied: sum(lines.map((l) => l.deniedCents)),
  };
}

/** Patient / provider details: the deciding event first, then any other event that has them. */
function who(events: Ev[], main: Ev) {
  const pick = <K extends keyof Ev>(k: K) => (main[k] ?? events.map((e) => e[k]).find((v) => v != null && v !== "") ?? null) as Ev[K] | null;
  return {
    patientName: pick("patientName") as string | null, patientDob: pick("patientDob") as string | null, memberId: pick("memberId") as string | null,
    providerName: pick("providerName") as string | null, providerNpi: pick("providerNpi") as string | null,
    claimNo: pick("claimNo") as string | null, payerClaimNo: pick("payerClaimNo") as string | null,
  };
}

function firstDate(lines: MergedLine[], e: Ev): string | null {
  return [e.serviceFrom, ...lines.map((l) => l.serviceDate)].filter((d): d is string => !!d).sort()[0] ?? null;
}

// ---- High-deductible patients (2026-11-12) ----
// Insurance marks the deductible part of a visit as patient responsibility, reason 1 ("PR-1",
// standard claim adjustment reason code 1 = deductible; 2 = coinsurance, 3 = copay). A patient whose
// deductible was applied on several separate visits likely has a high-deductible plan.

/** Staff see "High deductible" when the deductible was applied on this many visits in the last year. */
export const HIGH_DEDUCTIBLE_MIN_VISITS = 2;
export const HIGH_DEDUCTIBLE_WINDOW_DAYS = 365;

/**
 * The deductible a line still leaves to the patient: what the first insurance applied as deductible,
 * capped at what the patient owes after every insurance (a second insurance, e.g. Medicaid behind
 * Medicare, often pays it).
 */
export function deductibleOwedCents(adjustments: BillAdjustment[] | null | undefined, patientOwesCents: number): number {
  const ded = sum((adjustments ?? []).filter((a) => a.group.toUpperCase() === "PR" && a.code.replace(/^0+/, "") === "1").map((a) => a.cents));
  return Math.max(0, Math.min(patientOwesCents, ded));
}

export interface DeductibleLine { claimId: number; personKey: string; date: string | null; deductibleCents: number; payerName: string | null; providerId: number | null; clinicId: number | null }
export interface DeductiblePerson {
  personKey: string; visits: string[]; claimIds: number[]; deductibleCents: number;
  /** The latest visit with a deductible, and its insurance, provider and clinic. */
  lastDate: string | null; payerName: string | null; providerId: number | null; clinicId: number | null;
}

/** People whose deductible was applied on at least `minVisits` separate days (most visits first). */
export function groupDeductible(lines: DeductibleLine[], minVisits: number): DeductiblePerson[] {
  const by = new Map<string, DeductiblePerson & { days: Set<string>; ids: Set<number> }>();
  for (const l of lines) {
    if (l.deductibleCents <= 0) continue;
    let p = by.get(l.personKey);
    if (!p) {
      p = { personKey: l.personKey, visits: [], claimIds: [], deductibleCents: 0, lastDate: null, payerName: null, providerId: null, clinicId: null, days: new Set(), ids: new Set() };
      by.set(l.personKey, p);
    }
    p.days.add(l.date ?? `claim ${l.claimId}`);
    p.ids.add(l.claimId);
    p.deductibleCents += l.deductibleCents;
    if (l.date && (!p.lastDate || l.date >= p.lastDate)) {
      p.lastDate = l.date;
      p.payerName = l.payerName ?? p.payerName;
      p.providerId = l.providerId ?? p.providerId;
      p.clinicId = l.clinicId ?? p.clinicId;
    }
  }
  return Array.from(by.values())
    .filter((p) => p.days.size >= minVisits)
    .map(({ days, ids, ...p }) => ({ ...p, visits: Array.from(days).sort(), claimIds: Array.from(ids) }))
    .sort((x, y) => y.visits.length - x.visits.length || y.deductibleCents - x.deductibleCents);
}

// ---- Breakdown dimensions (shared by the server and the page) ----

export const BREAKDOWN_DIMS = {
  cpt: "CPT code",
  insurance: "Insurance",
  insuranceType: "Insurance type",
  patient: "Patient",
  provider: "Provider",
  clinic: "Clinic",
  status: "Status",
  reason: "Denial reason",
  month: "Month",
  week: "Week",
  day: "Day",
} as const;
export type BreakdownDim = keyof typeof BREAKDOWN_DIMS;
export const BREAKDOWN_DIM_KEYS = Object.keys(BREAKDOWN_DIMS) as BreakdownDim[];

/** Which date the range and the month / week / day groups use. */
export type DateBasis = "service" | "paid";

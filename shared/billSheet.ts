// Master Billing: claim reports as spreadsheets (CSV or Excel turned into rows in the browser).
// The columns are guessed from the header row; the owner can fix any guess, and his choice is
// remembered for that report layout. Rows with the same claim number (or the same patient and date
// of service) are one claim; each row with a CPT code is one line of it.
import { statusFromText } from "./billCodes";
import type { BillAdjustment, BillEventInput, BillLineInput } from "./masterBilling";
import { nameKey, parseDateValue } from "./workspace";
import { normalizePersonName } from "./csvImport";

export const SHEET_FIELDS = {
  claimNo: "Claim / account #",
  payerClaimNo: "Insurance claim #",
  patientName: "Patient name",
  firstName: "Patient first name",
  lastName: "Patient last name",
  dob: "Date of birth",
  memberId: "Member ID",
  serviceDate: "Date of service",
  cpt: "CPT code",
  modifiers: "Modifiers",
  units: "Units",
  billed: "Billed",
  allowed: "Allowed",
  paid: "Insurance paid",
  patientResp: "Patient owes",
  adjustment: "Adjustment / write-off",
  payer: "Insurance",
  provider: "Provider",
  status: "Status",
  reason: "Denial reason / message",
  paidDate: "Paid date",
  checkNumber: "Check / EFT #",
} as const;
export type SheetField = keyof typeof SHEET_FIELDS;
export const SHEET_FIELD_KEYS = Object.keys(SHEET_FIELDS) as SheetField[];
export type SheetMapping = Partial<Record<SheetField, number>>;

// Most specific first: a column is claimed by the first field that lists its header.
const ALIASES: Record<SheetField, string[]> = {
  payerClaimNo: ["payer claim #", "payer claim number", "payer claim no", "payer claim id", "icn", "payer icn", "claim control number", "payer claim control number", "dcn", "insurance claim #", "insurance claim number"],
  claimNo: ["patient account", "patient account #", "patient account number", "patient account no", "account #", "account number", "account no", "acct #", "acct", "pat acct #", "pat acct", "patient control number", "patient control #", "patient control no", "claim #", "claim number", "claim no", "claim id", "pcn", "encounter #", "encounter id", "claim"],
  patientName: ["patient", "patient name", "name", "patient full name", "full name", "member name", "patient (last, first)"],
  firstName: ["patient first name", "first name", "first", "firstname"],
  lastName: ["patient last name", "last name", "last", "lastname"],
  dob: ["dob", "date of birth", "birth date", "patient dob", "birthdate", "patient date of birth"],
  memberId: ["member id", "member #", "subscriber id", "subscriber #", "insured id", "insured's id", "policy #", "policy number", "policy id", "insurance id", "member number", "mbi", "hicn", "id #"],
  serviceDate: ["dos", "date of service", "service date", "from dos", "dos from", "from date", "service from", "service from date", "visit date", "date"],
  cpt: ["cpt", "cpt code", "cpt/hcpcs", "hcpcs", "procedure", "procedure code", "proc code", "proc", "code", "service code", "cpt codes"],
  modifiers: ["modifier", "modifiers", "mod", "mods", "modifier 1", "mod 1"],
  units: ["units", "unit", "qty", "quantity", "days/units"],
  billed: ["billed", "billed amount", "billed amt", "amount billed", "charge", "charges", "charge amount", "total charge", "total charges", "claim amount", "total billed", "claim charge"],
  allowed: ["allowed", "allowed amount", "allowed amt", "allowable", "approved amount"],
  paid: ["paid", "paid amount", "paid amt", "amount paid", "payment", "payment amount", "insurance paid", "ins paid", "ins payment", "total paid", "insurance payment", "plan paid"],
  patientResp: ["patient responsibility", "patient resp", "pt resp", "patient portion", "patient balance", "patient owes", "pr amount", "patient amount", "member responsibility"],
  adjustment: ["adjustment", "adjustments", "adj", "adj amount", "adjustment amount", "write off", "writeoff", "write-off", "contractual", "contractual adjustment"],
  payer: ["payer", "payer name", "insurance", "insurance name", "insurance company", "carrier", "plan", "plan name", "primary insurance", "ins", "payor", "payor name"],
  provider: ["provider", "rendering provider", "provider name", "rendering", "doctor", "physician", "rendering provider name", "billing provider"],
  status: ["status", "claim status", "current status", "file status"],
  reason: ["denial reason", "reason", "denial", "denial code", "reason code", "reason codes", "remark", "remarks", "message", "messages", "rejection reason", "error", "errors", "status message"],
  paidDate: ["paid date", "payment date", "check date", "date paid", "eft date", "remit date", "remittance date", "process date", "processed date"],
  checkNumber: ["check #", "check number", "check no", "check", "eft #", "eft number", "trace number", "trace #", "check/eft #", "check/eft number"],
};

const FIELD_ORDER: SheetField[] = ["payerClaimNo", "claimNo", "firstName", "lastName", "patientName", "dob", "memberId", "paidDate", "serviceDate", "cpt", "modifiers", "units", "billed", "allowed", "paid", "patientResp", "adjustment", "payer", "provider", "status", "reason", "checkNumber"];

const normHeader = (h: string) => h.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\s]+/g, " ").replace(/\s*#/g, " #").toLowerCase().trim();

/** "Patient Account #|DOS|CPT…" — what a saved column choice is remembered by. */
export function headerSignature(headers: string[]): string {
  return headers.map(normHeader).join("|").slice(0, 500);
}

/** Find the header row (in the first 15) and guess each column. */
export function detectSheetMapping(rows: string[][]): { headerRow: number; headers: string[]; mapping: SheetMapping } {
  let best = { headerRow: 0, headers: (rows[0] ?? []).map((h) => String(h ?? "").trim()), mapping: {} as SheetMapping, score: 0 };
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const headers = rows[r]!.map((h) => String(h ?? "").trim());
    const lower = headers.map(normHeader);
    const mapping: SheetMapping = {};
    const used = new Set<number>();
    for (const f of FIELD_ORDER) {
      const idx = lower.findIndex((h, i) => !used.has(i) && ALIASES[f].includes(h));
      if (idx >= 0) {
        mapping[f] = idx;
        used.add(idx);
      }
    }
    const who = mapping.patientName != null || mapping.lastName != null || mapping.claimNo != null;
    const what = mapping.billed != null || mapping.paid != null || mapping.cpt != null || mapping.status != null;
    const score = Object.keys(mapping).length;
    if (who && what && score > best.score) best = { headerRow: r, headers, mapping, score };
  }
  return { headerRow: best.headerRow, headers: best.headers, mapping: best.mapping };
}

/** "$1,234.50", "(12.00)", "-12", "0" → cents; null when blank or not a number. */
export function sheetCents(raw: string | undefined): number | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()$,\s-]/g, "");
  if (!/^\d*(\.\d+)?$/.test(s) || s === "" || s === ".") return null;
  const cents = Math.round(Number(s) * 100);
  return neg ? -cents : cents;
}

export interface SheetParseResult {
  headerRow: number;
  headers: string[];
  mapping: SheetMapping;
  events: BillEventInput[];
  rowsRead: number;
  skipped: { rowNumber: number; why: string }[];
}

/** Turn spreadsheet rows into claim events. `override` = the owner's column choices (-1 clears one). */
export function parseBillSheet(rows: string[][], override?: SheetMapping): SheetParseResult {
  const detected = detectSheetMapping(rows);
  const mapping: SheetMapping = { ...detected.mapping, ...(override ?? {}) };
  for (const [k, v] of Object.entries(mapping)) if (v == null || v < 0) delete mapping[k as SheetField];
  const cell = (r: string[], f: SheetField) => (mapping[f] != null ? String(r[mapping[f]!] ?? "").trim() : "");
  const skipped: { rowNumber: number; why: string }[] = [];
  const groups = new Map<string, { rowNumber: number; r: string[] }[]>();
  let rowsRead = 0;

  for (let i = detected.headerRow + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.some((c) => String(c ?? "").trim())) continue;
    const name = patientNameOf(r, cell);
    const claimNo = cell(r, "claimNo");
    const dos = parseDateValue(cell(r, "serviceDate"));
    const money = ["billed", "paid", "patientResp"].some((f) => sheetCents(cell(r, f as SheetField)) != null);
    // Totals / footer lines: no patient, no claim number.
    if (!name && !claimNo) {
      if (money || cell(r, "cpt")) skipped.push({ rowNumber: i + 1, why: "No patient name or claim number" });
      continue;
    }
    if (/^(total|grand total|subtotal)/i.test(name || claimNo)) continue;
    rowsRead++;
    const key = claimNo ? `c:${claimNo.toUpperCase()}` : `n:${nameKey(name)}|${dos ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push({ rowNumber: i + 1, r });
    groups.set(key, list);
  }

  const events: BillEventInput[] = [];
  for (const list of Array.from(groups.values())) {
    const first = list[0]!.r;
    const pick = (f: SheetField) => list.map((x) => cell(x.r, f)).find(Boolean) ?? "";
    const statusText = pick("status");
    const sheetStatus = statusFromText(statusText);
    const note = [pick("reason"), sheetStatus ? "" : statusText].filter(Boolean).join(" · ").slice(0, 500) || null;
    const denied = sheetStatus === "denied" || sheetStatus === "partly_paid";
    const lines: BillLineInput[] = [];
    let billed = 0, paid = 0, pr = 0;
    const claimAdjustments: BillAdjustment[] = [];
    for (const { r } of list) {
      const b = sheetCents(cell(r, "billed")) ?? 0;
      const p = sheetCents(cell(r, "paid")) ?? 0;
      const resp = sheetCents(cell(r, "patientResp")) ?? 0;
      const allowed = sheetCents(cell(r, "allowed"));
      const adj = sheetCents(cell(r, "adjustment"));
      const reasonCode = cell(r, "reason").match(/\b(CO|PR|OA|PI)[-\s]?([A-Z]?\d{1,3})\b/i);
      const adjustments: BillAdjustment[] = [];
      if (resp) adjustments.push({ group: "PR", code: "", cents: resp, kind: "patient" });
      const other = adj ?? (allowed != null && !denied ? Math.max(0, b - allowed) : null);
      if (other) {
        if (reasonCode) adjustments.push({ group: reasonCode[1]!.toUpperCase(), code: reasonCode[2]!.toUpperCase(), cents: other });
        else adjustments.push({ group: "CO", code: "", cents: other, kind: denied && p <= 0 ? "denied" : "writeoff" });
      }
      const cpt = cell(r, "cpt").toUpperCase().replace(/\s+/g, "");
      billed += b;
      paid += p;
      pr += resp;
      if (cpt) {
        const mods = cell(r, "modifiers").toUpperCase().split(/[\s,;:/-]+/).filter((m) => /^[A-Z0-9]{2}$/.test(m));
        lines.push({
          code: cpt.slice(0, 10), modifiers: mods, units: Number(cell(r, "units")) || 1, serviceDate: parseDateValue(cell(r, "serviceDate")),
          billedCents: b, allowedCents: allowed, paidCents: p, adjustments, remarks: [],
        });
      } else claimAdjustments.push(...adjustments);
    }
    const dates = list.map((x) => parseDateValue(cell(x.r, "serviceDate"))).filter((x): x is string => !!x).sort();
    events.push({
      source: "sheet",
      claimNo: pick("claimNo") || null, payerClaimNo: pick("payerClaimNo") || null, clpStatus: null, sheetStatus,
      payerName: pick("payer") || null, payerId: null, filingIndicator: null,
      patientName: patientNameOf(first, cell) || null, patientDob: parseDateValue(pick("dob"), { dob: true }), memberId: pick("memberId") || null,
      providerName: pick("provider") || null, providerNpi: null,
      serviceFrom: dates[0] ?? null, serviceTo: dates.at(-1) ?? null,
      paidDate: parseDateValue(pick("paidDate")), checkNumber: pick("checkNumber") || null,
      // With CPT lines, rows without a code (a report's claim-total row) are left out so nothing counts twice.
      billedCents: lines.length ? lines.reduce((a, l) => a + l.billedCents, 0) : billed,
      paidCents: lines.length ? lines.reduce((a, l) => a + l.paidCents, 0) : paid,
      patientRespCents: pr, claimAdjustments: lines.length ? [] : claimAdjustments,
      lines, note,
    });
  }
  return { headerRow: detected.headerRow, headers: detected.headers, mapping, events, rowsRead, skipped };
}

function patientNameOf(r: string[], cell: (r: string[], f: SheetField) => string): string {
  const full = cell(r, "patientName");
  if (full) return normalizePersonName(full).slice(0, 255);
  return `${cell(r, "firstName")} ${cell(r, "lastName")}`.replace(/\s+/g, " ").trim().slice(0, 255);
}

// Reads ERA payment files (X12 835, version 5010): what Office Ally's "Download EOB/ERA 835" gives.
// Runs in the browser (and in tests). One file can hold several payments (ST…SE), each with its
// claims (CLP) and their CPT lines (SVC). Only what the file says is used; nothing is guessed.
import type { BillAdjustment, BillEventInput, BillLineInput } from "./masterBilling";

export interface EraLine {
  qualifier: string;
  code: string;
  modifiers: string[];
  /** The code as billed, when the insurance paid it under another code. */
  submittedCode: string | null;
  submittedModifiers: string[] | null;
  billedCents: number;
  paidCents: number;
  units: number;
  serviceDate: string | null;
  allowedCents: number | null;
  adjustments: BillAdjustment[];
  remarks: string[];
  controlNo: string | null;
}

export interface EraClaim {
  patientControlNo: string;
  status: string;
  billedCents: number;
  paidCents: number;
  patientRespCents: number;
  filingIndicator: string | null;
  payerClaimNo: string | null;
  patientLast: string | null;
  patientFirst: string | null;
  memberId: string | null;
  renderingName: string | null;
  renderingNpi: string | null;
  serviceFrom: string | null;
  serviceTo: string | null;
  receivedDate: string | null;
  adjustments: BillAdjustment[];
  remarks: string[];
  lines: EraLine[];
}

export interface EraProviderAdjustment {
  /** PLB reason, e.g. "WO" (overpayment taken back), "L6" (interest), "FB" (forward balance). */
  code: string;
  ref: string | null;
  /** Positive = taken off the check. */
  cents: number;
}

export interface EraCheck {
  payerName: string | null;
  payerId: string | null;
  payeeName: string | null;
  payeeNpi: string | null;
  /** ACH, CHK (paper check), NON (no payment), BOP, FWT. */
  method: string | null;
  /** C = paid to the practice, D = the practice owes. */
  creditDebit: string | null;
  amountCents: number;
  paymentDate: string | null;
  /** The check or EFT trace number. */
  checkNumber: string | null;
  claims: EraClaim[];
  providerAdjustments: EraProviderAdjustment[];
  /** Σ claim payments − Σ check adjustments = the check amount (to the cent). */
  balanced: boolean;
  balanceDiffCents: number;
}

export interface EraFile {
  checks: EraCheck[];
  warnings: string[];
}

/** Does this text look like an X12 file (starts with an ISA segment)? */
export function isX12(text: string): boolean {
  return /^\s*ISA./.test(text.slice(0, 200));
}

/** "150", "-80.5", ".5" → cents. */
export function x12Cents(raw: string | undefined): number {
  const s = (raw ?? "").trim();
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** CCYYMMDD → YYYY-MM-DD. */
export function x12Date(raw: string | undefined): string | null {
  const m = (raw ?? "").trim().match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

interface Delims {
  element: string;
  component: string;
  segment: string;
}

/**
 * Separators come from the ISA segment: the element separator is its 4th character, ISA16 (one
 * character after the 16th element separator) is the component separator, and the character right
 * after that ends every segment (a line break when the file uses one segment per line).
 */
function delimiters(text: string): Delims {
  const start = text.indexOf("ISA");
  const element = text[start + 3]!;
  let pos = start + 3;
  for (let seen = 0; pos < text.length; pos++) if (text[pos] === element && ++seen === 16) break;
  const component = text[pos + 1] ?? ":";
  const end = text[pos + 2];
  const segment = !end || end === "\r" || end === "\n" ? "\n" : end;
  return { element, component, segment };
}

/** Read one 835 file. Throws only if it isn't an X12 file at all. */
export function parseEra835(text: string): EraFile {
  if (!isX12(text)) throw new Error("This doesn't look like an 835 payment file.");
  const d = delimiters(text);
  const segments = text
    .slice(text.indexOf("ISA"))
    .split(d.segment)
    .map((s) => s.replace(/^[\r\n]+|[\r\n]+$/g, "").trim())
    .filter(Boolean)
    .map((s) => s.split(d.element));

  const checks: EraCheck[] = [];
  const warnings: string[] = [];
  let check: EraCheck | null = null;
  let claim: EraClaim | null = null;
  let line: EraLine | null = null;
  let n1: string | null = null;
  let inTransaction = false;

  const closeCheck = () => {
    if (!check) return;
    const claimsPaid = check.claims.reduce((a, c) => a + c.paidCents, 0);
    const plb = check.providerAdjustments.reduce((a, p) => a + p.cents, 0);
    const expected = check.creditDebit === "D" ? -check.amountCents : check.amountCents;
    check.balanceDiffCents = claimsPaid - plb - expected;
    check.balanced = Math.abs(check.balanceDiffCents) <= 1;
    checks.push(check);
    check = null;
    claim = null;
    line = null;
  };

  for (const el of segments) {
    const id = el[0]!.toUpperCase();
    switch (id) {
      case "ST":
        if (el[1] === "835") {
          closeCheck();
          inTransaction = true;
          check = {
            payerName: null, payerId: null, payeeName: null, payeeNpi: null, method: null, creditDebit: null, amountCents: 0,
            paymentDate: null, checkNumber: null, claims: [], providerAdjustments: [], balanced: false, balanceDiffCents: 0,
          };
          n1 = null;
        } else inTransaction = false;
        break;
      case "SE":
        if (inTransaction) closeCheck();
        inTransaction = false;
        break;
      default:
        if (!inTransaction || !check) break;
        handle(id, el);
    }
  }
  if (check) {
    warnings.push("The file ended before the payment's closing segment (SE).");
    closeCheck();
  }
  if (!checks.length) warnings.push("No 835 payments were found in this file.");
  return { checks, warnings };

  function handle(id: string, el: string[]) {
    const c = check!;
    switch (id) {
      case "BPR":
        c.amountCents = x12Cents(el[2]);
        c.creditDebit = el[3] || null;
        c.method = el[4] || null;
        c.paymentDate = x12Date(el[16]);
        break;
      case "TRN":
        if (el[1] === "1") c.checkNumber = el[2] || null;
        break;
      case "N1":
        n1 = el[1] ?? null;
        if (n1 === "PR") c.payerName = el[2] || null;
        if (n1 === "PE") {
          c.payeeName = el[2] || null;
          if (el[3] === "XX") c.payeeNpi = el[4] || null;
        }
        break;
      case "REF":
        if (line && el[1] === "6R") line.controlNo = el[2] || null;
        else if (!claim && n1 === "PR" && (el[1] === "2U" || el[1] === "EO")) c.payerId ??= el[2] || null;
        break;
      case "CLP":
        line = null;
        n1 = null;
        claim = {
          patientControlNo: el[1] ?? "", status: el[2] ?? "", billedCents: x12Cents(el[3]), paidCents: x12Cents(el[4]),
          patientRespCents: x12Cents(el[5]), filingIndicator: el[6] || null, payerClaimNo: el[7] || null,
          patientLast: null, patientFirst: null, memberId: null, renderingName: null, renderingNpi: null,
          serviceFrom: null, serviceTo: null, receivedDate: null, adjustments: [], remarks: [], lines: [],
        };
        c.claims.push(claim);
        break;
      case "NM1": {
        if (!claim) break;
        const who = el[1];
        const name = (last?: string, first?: string) => [first, last].filter((s) => s && s.trim()).join(" ") || null;
        if (who === "QC") {
          claim.patientLast = el[3] || null;
          claim.patientFirst = el[4] || null;
          if (el[9]) claim.memberId = el[9];
        } else if (who === "IL" && !claim.memberId && el[9]) claim.memberId = el[9];
        else if (who === "82") {
          claim.renderingName = el[2] === "2" ? el[3] || null : name(el[3], el[4]);
          if (el[8] === "XX") claim.renderingNpi = el[9] || null;
        }
        break;
      }
      case "MOA":
      case "MIA":
        if (claim) for (const r of el.slice(id === "MOA" ? 3 : 5)) if (/^[A-Z]{1,2}\d+$/.test(r)) claim.remarks.push(r);
        break;
      case "DTM": {
        const when = x12Date(el[2]);
        if (line && (el[1] === "472" || el[1] === "150")) line.serviceDate = when;
        else if (claim && !line) {
          if (el[1] === "232") claim.serviceFrom = when;
          else if (el[1] === "233") claim.serviceTo = when;
          else if (el[1] === "050") claim.receivedDate = when;
        }
        break;
      }
      case "CAS": {
        const target = line ?? claim;
        if (!target) break;
        const group = el[1] ?? "";
        for (let i = 2; i + 1 < el.length; i += 3) {
          if (!el[i]) continue;
          target.adjustments.push({ group, code: el[i]!, cents: x12Cents(el[i + 1]) });
        }
        break;
      }
      case "SVC": {
        if (!claim) break;
        const comp = (el[1] ?? "").split(d.component);
        const orig = el[6] ? el[6].split(d.component) : null;
        line = {
          qualifier: comp[0] ?? "", code: comp[1] ?? "", modifiers: comp.slice(2, 6).filter(Boolean),
          submittedCode: orig?.[1] || null, submittedModifiers: orig ? orig.slice(2, 6).filter(Boolean) : null,
          billedCents: x12Cents(el[2]), paidCents: x12Cents(el[3]),
          units: Number(el[7] || el[5] || 1) || 1,
          serviceDate: null, allowedCents: null, adjustments: [], remarks: [], controlNo: null,
        };
        claim.lines.push(line);
        break;
      }
      case "AMT":
        if (line && el[1] === "B6") line.allowedCents = x12Cents(el[2]);
        break;
      case "LQ":
        if (line && el[1] === "HE" && el[2]) line.remarks.push(el[2]);
        break;
      case "PLB":
        line = null;
        claim = null;
        for (let i = 3; i + 1 < el.length; i += 2) {
          if (!el[i]) continue;
          const [code, ref] = el[i]!.split(d.component);
          c.providerAdjustments.push({ code: code ?? "", ref: ref || null, cents: x12Cents(el[i + 1]) });
        }
        break;
      case "LX":
      case "TS3":
      case "TS2":
        line = null;
        claim = null;
        break;
      default:
        break;
    }
  }
}

/** One claim event per claim per payment, in the shape every upload is saved in. */
export function eraToEvents(file: EraFile): BillEventInput[] {
  const out: BillEventInput[] = [];
  for (const c of file.checks) {
    for (const cl of c.claims) {
      const lines: BillLineInput[] = cl.lines.map((l) => ({
        code: (l.submittedCode ?? l.code).toUpperCase(),
        modifiers: l.submittedCode ? (l.submittedModifiers ?? []) : l.modifiers,
        units: l.units, serviceDate: l.serviceDate ?? cl.serviceFrom, billedCents: l.billedCents, allowedCents: l.allowedCents,
        paidCents: l.paidCents, adjustments: l.adjustments, remarks: l.remarks,
        paidAsCode: l.submittedCode && l.submittedCode !== l.code ? l.code : null,
      }));
      const serviceDates = lines.map((l) => l.serviceDate).filter((x): x is string => !!x).sort();
      out.push({
        source: "era835",
        claimNo: cl.patientControlNo || null, payerClaimNo: cl.payerClaimNo, clpStatus: cl.status || null, sheetStatus: null,
        payerName: c.payerName, payerId: c.payerId, filingIndicator: cl.filingIndicator,
        patientName: [cl.patientFirst, cl.patientLast].filter(Boolean).join(" ") || null, patientDob: null, memberId: cl.memberId,
        providerName: cl.renderingName, providerNpi: cl.renderingNpi,
        serviceFrom: cl.serviceFrom ?? serviceDates[0] ?? null, serviceTo: cl.serviceTo ?? serviceDates.at(-1) ?? null,
        paidDate: c.paymentDate, checkNumber: c.checkNumber,
        billedCents: cl.billedCents, paidCents: cl.paidCents, patientRespCents: cl.patientRespCents,
        claimAdjustments: cl.adjustments, lines, note: null,
      });
    }
  }
  return out;
}

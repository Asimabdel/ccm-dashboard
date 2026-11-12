// Master Billing: what the AI is asked when it reads an EOB / remittance PDF, and how its answer
// becomes claim events. The AI only copies what is printed (no guessing, no decisions); every row
// it read is shown to the owner to check before anything is saved.
import type { BillAdjustment, BillEventInput, BillLineInput } from "./masterBilling";

export const BILL_PDF_PROMPT = `You copy insurance payment details (an EOB or remittance advice) off these pages for a medical practice's own billing records.
Copy ONLY what is printed. Never guess, estimate or calculate a missing number: use null. Do not add anything that isn't on the page.
Return ONLY a JSON object, no other text:
{"payments":[{"payer":string|null,"checkNumber":string|null,"checkDate":"YYYY-MM-DD"|null,"checkAmount":number|null,
 "claims":[{"patientName":string|null,"memberId":string|null,"accountNumber":string|null,"payerClaimNumber":string|null,"provider":string|null,
  "status":"paid"|"denied"|"reversed"|"other","billed":number|null,"allowed":number|null,"paid":number|null,"patientResponsibility":number|null,
  "lines":[{"date":"YYYY-MM-DD"|null,"code":string,"modifiers":[string],"units":number|null,"billed":number|null,"allowed":number|null,"paid":number|null,
   "deductible":number|null,"coinsurance":number|null,"copay":number|null,
   "adjustments":[{"group":"CO"|"PR"|"OA"|"PI","code":string,"amount":number}],"remarks":[string]}]}]}]}
Rules:
- Amounts are dollars as plain numbers (150.00 → 150). A taken-back (reversed) amount is negative.
- "accountNumber" is the practice's patient account / patient control number; "payerClaimNumber" is the insurance's claim / ICN number.
- "code" is the CPT or HCPCS procedure code exactly as printed.
- Adjustment group and reason codes exactly as printed (for example "CO-45" → group "CO", code "45").
- If the pages hold no payment details, return {"payments":[]}.`;

export interface PdfReadClaim {
  event: BillEventInput;
  /** Things that don't add up, for the owner to check. */
  warnings: string[];
}

export interface PdfReadPayment {
  payer: string | null;
  checkNumber: string | null;
  checkDate: string | null;
  checkAmountCents: number | null;
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() && !/^(null|unknown|n\/a|none)$/i.test(v.trim()) ? v.trim().slice(0, max) : null);
const cents = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const date = (v: unknown) => {
  const s = str(v, 10);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/** Turn the AI's answer into claim events (source "pdf"). Bad or missing JSON = nothing read. */
export function parsePdfReading(text: string): { payments: PdfReadPayment[]; claims: PdfReadClaim[] } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { payments: [], claims: [] };
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(m[0]) as Record<string, unknown>; } catch { return { payments: [], claims: [] }; }
  const payments: PdfReadPayment[] = [];
  const claims: PdfReadClaim[] = [];
  for (const p of arr(raw.payments)) {
    const pay: PdfReadPayment = { payer: str(p.payer, 160), checkNumber: str(p.checkNumber, 60), checkDate: date(p.checkDate), checkAmountCents: cents(p.checkAmount) };
    payments.push(pay);
    for (const c of arr(p.claims)) {
      const warnings: string[] = [];
      const lines: BillLineInput[] = arr(c.lines).map((l) => {
        const adjustments: BillAdjustment[] = arr(l.adjustments)
          .map((x) => ({ group: (str(x.group, 2) ?? "").toUpperCase(), code: (str(x.code, 5) ?? "").toUpperCase(), cents: cents(x.amount) ?? 0 }))
          .filter((x) => /^(CO|PR|OA|PI|CR)$/.test(x.group) && x.cents !== 0);
        // Deductible / coinsurance / copay printed as their own columns (when no PR codes were listed).
        if (!adjustments.some((x) => x.group === "PR")) {
          for (const [k, code] of [["deductible", "1"], ["coinsurance", "2"], ["copay", "3"]] as const) {
            const v = cents(l[k]);
            if (v) adjustments.push({ group: "PR", code, cents: v });
          }
        }
        const mods = Array.isArray(l.modifiers) ? l.modifiers.map((x) => String(x).toUpperCase().trim()).filter((x) => /^[A-Z0-9]{2}$/.test(x)) : [];
        return {
          code: (str(l.code, 10) ?? "").toUpperCase().replace(/\s+/g, ""), modifiers: mods, units: Number(l.units) > 0 ? Number(l.units) : 1,
          serviceDate: date(l.date), billedCents: cents(l.billed) ?? 0, allowedCents: cents(l.allowed), paidCents: cents(l.paid) ?? 0,
          adjustments, remarks: Array.isArray(l.remarks) ? l.remarks.map((x) => String(x).trim()).filter((x) => /^[A-Z]{1,2}\d{1,4}$/.test(x)).slice(0, 10) : [],
        };
      }).filter((l) => l.code);
      const lineBilled = lines.reduce((a, l) => a + l.billedCents, 0);
      const linePaid = lines.reduce((a, l) => a + l.paidCents, 0);
      const billed = cents(c.billed) ?? lineBilled;
      const paid = cents(c.paid) ?? linePaid;
      if (lines.length && billed !== lineBilled) warnings.push(`The lines' billed amounts add up to ${fmt(lineBilled)}, but the claim says ${fmt(billed)}.`);
      if (lines.length && paid !== linePaid) warnings.push(`The lines' paid amounts add up to ${fmt(linePaid)}, but the claim says ${fmt(paid)}.`);
      for (const l of lines) {
        const accounted = l.paidCents + l.adjustments.reduce((a, x) => a + x.cents, 0);
        if (l.billedCents && accounted !== l.billedCents) warnings.push(`${l.code}: paid + adjustments = ${fmt(accounted)}, billed ${fmt(l.billedCents)}.`);
      }
      const status = str(c.status, 10);
      const patientName = str(c.patientName, 255);
      if (!patientName) warnings.push("No patient name was read.");
      const dates = lines.map((l) => l.serviceDate).filter((x): x is string => !!x).sort();
      claims.push({
        warnings,
        event: {
          source: "pdf", claimNo: str(c.accountNumber, 60), payerClaimNo: str(c.payerClaimNumber, 60),
          clpStatus: status === "reversed" || paid < 0 ? "22" : status === "denied" ? "4" : "1", sheetStatus: null,
          payerName: pay.payer, payerId: null, filingIndicator: null,
          patientName, patientDob: null, memberId: str(c.memberId, 60), providerName: str(c.provider, 255), providerNpi: null,
          serviceFrom: dates[0] ?? null, serviceTo: dates.at(-1) ?? null, paidDate: pay.checkDate, checkNumber: pay.checkNumber,
          billedCents: billed, paidCents: paid, patientRespCents: cents(c.patientResponsibility) ?? 0, claimAdjustments: [], lines, note: null,
        },
      });
    }
  }
  return { payments, claims };
}

const fmt = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

// Master Billing: the standard insurance codes that come back on payment files (ERA / 835) and EOBs,
// in plain words. These are short summaries of the public X12 code lists (claim status codes,
// claim adjustment group codes and claim adjustment reason codes, "CARC"); the payer's own wording
// is official. Which reasons count as a denial vs. a normal write-off is the practice's working
// rule (built 2026-11-11) and should be confirmed with the biller.
import { insNorm, MEDICAID_KEYS, PLANS } from "./insurance";

/** CLP02: what the insurance did with the claim. */
export const CLAIM_STATUS_CODES: Record<string, string> = {
  "1": "Processed as primary insurance",
  "2": "Processed as secondary insurance",
  "3": "Processed as tertiary insurance",
  "4": "Denied",
  "19": "Processed as primary, sent on to the next insurance",
  "20": "Processed as secondary, sent on to the next insurance",
  "21": "Processed as tertiary, sent on to the next insurance",
  "22": "Reversal of an earlier payment (taken back)",
  "23": "Not our claim, sent on to another insurance",
  "25": "Predetermination only, not paid",
};

/** Which insurance in line a payment came from (1 = primary). Denials and others count as primary. */
export function payerLevel(clpStatus: string | null | undefined): number {
  if (clpStatus === "2" || clpStatus === "20") return 2;
  if (clpStatus === "3" || clpStatus === "21") return 3;
  return 1;
}

export const isReversal = (clpStatus: string | null | undefined) => clpStatus === "22";

/** CAS01: who the adjusted amount belongs to. */
export const ADJUSTMENT_GROUPS: Record<string, string> = {
  CO: "Contractual (the practice writes it off)",
  PR: "Patient responsibility",
  OA: "Other adjustment",
  PI: "Payer initiated reduction",
  CR: "Correction / reversal",
};

/** Common claim adjustment reason codes (CARC), in plain words. Unlisted codes show the code only. */
export const REASON_CODES: Record<string, string> = {
  "1": "Deductible",
  "2": "Coinsurance",
  "3": "Copay",
  "4": "Modifier missing or doesn't fit the procedure code",
  "5": "Procedure code doesn't fit the place of service",
  "6": "Procedure doesn't fit the patient's age",
  "8": "Procedure code doesn't fit the provider type",
  "9": "Diagnosis doesn't fit the patient's age",
  "10": "Diagnosis doesn't fit the patient's sex",
  "11": "Diagnosis doesn't fit the procedure",
  "15": "Authorization number missing or invalid",
  "16": "Claim is missing information or has a billing error (see remark codes)",
  "18": "Duplicate claim or service",
  "19": "Work-related injury: bill workers' comp",
  "22": "Another insurance may pay first (coordination of benefits)",
  "23": "Reduced because of what the earlier insurance paid",
  "24": "Covered by a capitation / managed-care agreement",
  "26": "Service was before the coverage started",
  "27": "Service was after the coverage ended",
  "29": "Filing deadline passed",
  "31": "Patient can't be identified as this insurance's member",
  "32": "Not an eligible dependent on this insurance",
  "39": "Denied when the authorization was requested",
  "40": "Doesn't meet emergency / urgent care rules",
  "42": "Charge is over the payer's maximum allowed",
  "44": "Prompt-pay discount",
  "45": "Charge is over the contracted rate (normal write-off)",
  "49": "Routine / preventive service not covered",
  "50": "Not medically necessary (per the payer)",
  "51": "Pre-existing condition not covered",
  "54": "Multiple providers / assistant not covered",
  "55": "Experimental service (per the payer)",
  "58": "Wrong or invalid place of service",
  "59": "Reduced under the multiple-procedure rule",
  "66": "Blood deductible",
  "94": "Processed for more than the charge",
  "96": "Non-covered charge",
  "97": "Included in the payment for another service (bundled)",
  "100": "Payment was made to the patient",
  "107": "Related qualifying claim or service not on this claim",
  "109": "Not covered by this payer: send to the right insurance",
  "119": "Benefit maximum reached",
  "129": "Earlier processing information looks wrong",
  "131": "Claim-specific negotiated discount",
  "140": "Member ID and patient name don't match",
  "142": "Monthly Medicaid patient liability",
  "144": "Incentive adjustment",
  "146": "Diagnosis code invalid for the date of service",
  "151": "Payer says the records don't support this many services",
  "167": "Diagnosis not covered",
  "170": "Not paid when done by this type of provider",
  "181": "Procedure code invalid on the date of service",
  "182": "Modifier invalid on the date of service",
  "185": "Rendering provider not eligible for this service",
  "187": "Paid from the patient's health spending account",
  "189": "Unlisted code used when a specific code exists",
  "197": "Authorization / precertification missing",
  "198": "Authorization / precertification exceeded",
  "204": "Not covered under the patient's current plan",
  "226": "Requested information not sent or not enough",
  "227": "Information requested from the patient not received",
  "234": "Procedure not paid separately",
  "236": "Procedure / modifier combination not allowed with another service that day",
  "237": "Legislated / regulatory penalty or adjustment",
  "242": "Not provided by an in-network / primary care provider",
  "252": "An attachment or other documentation is needed",
  "253": "Sequestration (federal payment reduction)",
  A1: "Claim or service denied (see remark codes)",
  B7: "Provider not eligible to be paid for this service on this date",
  B9: "Patient is enrolled in hospice",
  B11: "Claim sent to the proper payer",
  B15: "Needs a qualifying service that wasn't received or covered",
  B16: "Doesn't meet 'new patient' rules",
};

/**
 * Reasons that are a normal part of getting paid, not a denial: contract write-offs, discounts,
 * sequestration, penalties, and what the earlier insurance already paid.
 */
const NORMAL_REASONS = new Set(["23", "24", "42", "44", "45", "59", "94", "131", "144", "237", "253"]);

export type AdjustmentKind = "patient" | "writeoff" | "denied";

/** Patient share (any PR), normal write-off, or a denial. */
export function adjustmentKind(group: string, code: string): AdjustmentKind {
  const g = group.toUpperCase();
  if (g === "PR") return "patient";
  if (g === "CR" || NORMAL_REASONS.has(code.toUpperCase())) return "writeoff";
  return "denied";
}

/** "CO-97: Included in the payment for another service (bundled)". */
export function describeAdjustment(group: string, code: string): string {
  const text = code ? REASON_CODES[code.toUpperCase()] : (ADJUSTMENT_GROUPS[group.toUpperCase()] ?? null);
  return `${group.toUpperCase()}${code ? `-${code.toUpperCase()}` : ""}${text ? `: ${text}` : ""}`;
}

// ---- Claim status (the practice's view) ----

export const BILL_STATUSES = ["paid", "partly_paid", "denied", "patient_owes", "waiting", "rejected", "taken_back"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const BILL_STATUS_LABELS: Record<BillStatus, string> = {
  paid: "Paid",
  partly_paid: "Partly paid",
  denied: "Denied",
  patient_owes: "Patient owes",
  waiting: "Waiting",
  rejected: "Rejected",
  taken_back: "Taken back",
};

export const BILL_STATUS_HELP: Record<BillStatus, string> = {
  paid: "Insurance paid (any write-off is the normal contract amount).",
  partly_paid: "Insurance paid part of it and denied at least one line.",
  denied: "Insurance paid nothing and gave a denial reason.",
  patient_owes: "Insurance paid nothing because it went to the patient's deductible, copay or coinsurance.",
  waiting: "Sent, no payment or denial yet.",
  rejected: "Never accepted (rejected by the clearinghouse or insurance). Fix and resend.",
  taken_back: "Insurance reversed an earlier payment and hasn't paid it again.",
};

/** A status word from a claim report or spreadsheet → our status (null = can't tell). */
export function statusFromText(raw: string | null | undefined): BillStatus | null {
  const s = (raw ?? "").toLowerCase().trim();
  if (!s) return null;
  if (/revers|recoup|take\s*back|taken\s*back|refund/.test(s)) return "taken_back";
  if (/reject/.test(s)) return "rejected";
  if (/partial/.test(s)) return "partly_paid";
  if (/den(y|ied|ial)/.test(s)) return "denied";
  if (/deductible|patient\s*resp|pt\s*resp|copay|coins/.test(s)) return "patient_owes";
  if (/paid|finali[sz]ed|closed|complete|adjudicated|processed/.test(s)) return "paid";
  if (/pend|submit|accept|ack|process|receiv|sent|forward|open|queue|review|hold|transmit|new|created|ready/.test(s)) return "waiting";
  return null;
}

// ---- Insurance type ----

export const INSURANCE_TYPES = ["Medicare", "Medicare Advantage", "Medicaid", "Commercial", "Military / VA", "Workers' comp / injury", "Other"] as const;
export type InsuranceType = (typeof INSURANCE_TYPES)[number];

/** CLP06 claim filing indicator → type (null when it doesn't say). */
const FILING_TYPES: Record<string, InsuranceType> = {
  MA: "Medicare", MB: "Medicare", "16": "Medicare Advantage", MC: "Medicaid",
  CH: "Military / VA", VA: "Military / VA", WC: "Workers' comp / injury", AM: "Workers' comp / injury", LM: "Workers' comp / injury",
  CI: "Commercial", BL: "Commercial", HM: "Commercial", "12": "Commercial", "13": "Commercial", "14": "Commercial", "15": "Commercial",
};

/** The kind of insurance, from the claim filing code first, then the payer's name. */
export function insuranceType(payerName: string | null | undefined, filingIndicator?: string | null): InsuranceType {
  const name = insNorm(payerName ?? "");
  const byFiling = filingIndicator ? FILING_TYPES[filingIndicator.toUpperCase()] : undefined;
  // A commercial carrier's Medicare Advantage plan is often filed as commercial: the name decides.
  if (byFiling && byFiling !== "Commercial") return byFiling;
  if (!name) return byFiling ?? "Other";
  if (MEDICAID_KEYS.some((k) => k.length > 4 && name.includes(k)) || /medicaid|tmhp|starplus/.test(name)) return "Medicaid";
  if (/tricare|triwest|veteran|champva/.test(name)) return "Military / VA";
  if (/workerscomp|workcomp|injury|corvel|sedgwick|careworks/.test(name)) return "Workers' comp / injury";
  // "Medicare Part B" / "Medicare Texas" = Original Medicare; "Aetna Medicare", "… Medicare Complete" = an Advantage plan.
  if (/medicare/.test(name)) return /^(cms)?medicare/.test(name) && !/advantage|complete|dsnp|hmo|ppo/.test(name) ? "Medicare" : "Medicare Advantage";
  // Medicare's regional contractors (Texas Part B is Novitas).
  if (/novitas|palmetto|noridian|wpsgovernment|nghs|cgsadmin/.test(name)) return "Medicare";
  const plan = PLANS.find((p) => p.keys.split(" ").some((k) => k.length > 3 && name.includes(k)));
  if (plan?.group === "medicare") return plan.name === "Original Medicare" ? "Medicare" : "Medicare Advantage";
  if (plan?.group === "military") return "Military / VA";
  if (plan?.group === "injury") return "Workers' comp / injury";
  return byFiling ?? "Commercial";
}

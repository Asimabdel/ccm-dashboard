// Insurance eligibility through Availity (the X12 270/271 "Coverages" API). Pure helpers shared by
// the server and the UI: read Availity's answer into a short summary staff can act on.

export const GROUP_NPI_DEFAULT = "1841824489"; // Senior Care Providers PLLC (NPPES, Katy TX)
export const ORG_NAME_DEFAULT = "SENIOR CARE PROVIDERS PLLC";

/** Availity statusCode on a coverage: 0 in progress, 4 complete, 3 complete but the payer's reply was invalid, 19 request error; 7/13/14/15 communication errors. */
export const COVERAGE_IN_PROGRESS = "0";
export const COVERAGE_DONE_CODES = ["3", "4"];
export const COVERAGE_COMM_ERRORS = ["7", "13", "14", "15"];

export interface PlanSummary {
  name: string | null;
  insuranceType: string | null;
  groupNumber: string | null;
  start: string | null;
  end: string | null;
  status: string | null;
}

export interface CoverageSummary {
  /** true active, false inactive, null couldn't tell. */
  active: boolean | null;
  statusText: string;
  payerName: string | null;
  plans: PlanSummary[];
  /** The primary care provider the payer has on file (HMO / Medicare Advantage). */
  pcp: string | null;
  officeCopay: string | null;
  deductibleRemaining: string | null;
  coinsurance: string | null;
  /** Other benefit lines worth showing ("Specialist copay $50", …). */
  highlights: string[];
  messages: string[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** "LAST, FIRST M" (Practice Fusion) or "First Middle Last" → first / last. */
export function splitName(full: string): { first: string; last: string } {
  const clean = full.replace(/\s+/g, " ").trim();
  if (clean.includes(",")) {
    const [last, rest] = clean.split(",", 2);
    return { first: (rest ?? "").trim().split(" ")[0] ?? "", last: (last ?? "").trim() };
  }
  const parts = clean.split(" ");
  return { first: parts[0] ?? "", last: parts.length > 1 ? parts[parts.length - 1]! : "" };
}

function personName(v: unknown): string | null {
  const o = obj(v);
  if (!o) return str(v);
  return str(o.name) ?? str(o.organizationName) ?? (([str(o.firstName), str(o.lastName)].filter(Boolean).join(" ")) || null);
}

const money = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: Number(v) % 1 ? 2 : 0, maximumFractionDigits: 2 })}` : v);
const percent = (v: string) => {
  if (!/^\d*\.?\d+$/.test(v)) return v;
  const n = Number(v);
  return `${n <= 1 ? Math.round(n * 100) : n}%`;
};

interface Leaf { benefit: string; path: string; value: string }

/** Every number-ish value inside a benefit, with where it sat ("inNetwork.copayments.amount"). */
function leaves(benefit: Json): Leaf[] {
  const name = str(benefit.name) ?? str(benefit.type) ?? "Benefit";
  const out: Leaf[] = [];
  const walk = (v: unknown, path: string[]) => {
    if (out.length > 200 || path.length > 8) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, path)); return; }
    const o = obj(v);
    if (o) { for (const [k, x] of Object.entries(o)) walk(x, [...path, k]); return; }
    const s = str(v);
    const key = path[path.length - 1] ?? "";
    if (s && /^(amount|remaining|remainingAmount|total|totalAmount|value|percent|percentage)$/i.test(key) && /^-?\d*\.?\d+$/.test(s)) out.push({ benefit: name, path: path.join(".").toLowerCase(), value: s });
  };
  walk(benefit, []);
  return out;
}

const outOfNetwork = (p: string) => /outofnetwork|out_of_network|outnetwork/.test(p);

/** Availity answers either one coverage or a list ({ coverages: [...] }, e.g. the POST reply). */
export function unwrapCoverage(raw: unknown): Record<string, unknown> {
  const o = obj(raw) ?? {};
  const first = obj(arr(o.coverages)[0]);
  return first ?? o;
}

// Plan status (X12 EB01): 1-5 are kinds of active (3 = services capitated, typical HMO), 6-8 inactive.
const ACTIVE_CODES = ["1", "2", "3", "4", "5"];
const INACTIVE_CODES = ["6", "7", "8"];

/** Availity's coverage answer → the few things the front desk needs. Tolerant of missing pieces. */
export function summarizeCoverage(raw: unknown): CoverageSummary {
  const c = unwrapCoverage(raw);
  const plansRaw = arr(c.plans).map(obj).filter((p): p is Json => !!p);
  const plans: PlanSummary[] = plansRaw.map((p) => ({
    name: str(p.groupName) ?? str(p.planName) ?? str(p.description) ?? str(p.insuranceType),
    insuranceType: str(p.insuranceType) ?? str(p.insuranceTypeCode),
    groupNumber: str(p.groupNumber),
    start: str(p.eligibilityStartDate) ?? str(p.coverageStartDate) ?? str(p.planStartDate),
    end: str(p.eligibilityEndDate) ?? str(p.coverageEndDate) ?? str(p.planEndDate),
    status: str(p.status),
  }));
  const isActive = (p: Json) => ACTIVE_CODES.includes(str(p.statusCode) ?? "") || /^active/i.test(str(p.status) ?? "");
  const isInactive = (p: Json) => INACTIVE_CODES.includes(str(p.statusCode) ?? "") || /inactive|not active|terminated/i.test(str(p.status) ?? "");
  const active = plansRaw.some(isActive) ? true : plansRaw.length && plansRaw.every(isInactive) ? false : null;

  const benefits = plansRaw.flatMap((p) => arr(p.benefits).map(obj).filter((b): b is Json => !!b));
  const all = benefits.flatMap(leaves).filter((l) => !outOfNetwork(l.path));
  const officeRe = /office|physician|professional|primary care|pcp/i;
  const copay = all.find((l) => officeRe.test(l.benefit) && /copay/.test(l.path)) ?? all.find((l) => /copay/.test(l.path));
  const deductible = all.find((l) => /deductible/.test(l.path + l.benefit.toLowerCase()) && /remaining/.test(l.path) && !/family/.test(l.path))
    ?? all.find((l) => /deductible/.test(l.path + l.benefit.toLowerCase()) && /remaining/.test(l.path));
  const coins = all.find((l) => officeRe.test(l.benefit) && /coinsurance|co_insurance/.test(l.path)) ?? all.find((l) => /coinsurance|co_insurance/.test(l.path));

  const highlights: string[] = [];
  for (const b of benefits) {
    const name = str(b.name) ?? str(b.type);
    if (!name || highlights.length >= 8) continue;
    const ls = leaves(b).filter((l) => !outOfNetwork(l.path));
    const cp = ls.find((l) => /copay/.test(l.path));
    const ci = ls.find((l) => /coinsurance|co_insurance/.test(l.path));
    const bits = [cp ? `copay ${money(cp.value)}` : null, ci ? `coinsurance ${percent(ci.value)}` : null].filter(Boolean);
    if (bits.length) highlights.push(`${name}: ${bits.join(", ")}`);
  }

  const messages = [
    ...arr(c.validationMessages).map((m) => str(obj(m)?.errorMessage) ?? str(obj(m)?.message) ?? str(m)),
    ...arr(c.reasons).map((m) => str(obj(m)?.description) ?? str(m)),
    str(c.statusMessage),
  ].filter((m): m is string => !!m).slice(0, 6);

  const payer = obj(c.payer);
  const pcp = plansRaw.map((p) => personName(p.primaryCareProvider)).find(Boolean) ?? null;
  return {
    active,
    statusText: active === true ? (plansRaw.map((p) => str(p.status)).find((x) => x && /^active/i.test(x) && !/^active coverage$/i.test(x)) ?? "Active coverage") : active === false ? "Not active" : "Couldn't tell from the payer's answer",
    payerName: str(payer?.responseName) ?? str(payer?.name) ?? null,
    plans,
    pcp,
    officeCopay: copay ? money(copay.value) : null,
    deductibleRemaining: deductible ? money(deductible.value) : null,
    coinsurance: coins ? percent(coins.value) : null,
    highlights,
    messages,
  };
}

/** Does the PCP on file look like one of our providers (by last name)? null when there's no PCP to compare. */
export function pcpIsOurs(pcp: string | null, ourProviderNames: string[]): boolean | null {
  if (!pcp) return null;
  const words = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["dr", "md", "np", "pllc", "llc", "the"].includes(w));
  const p = new Set(words(pcp));
  if (/senior care providers|mypcp/i.test(pcp)) return true;
  return ourProviderNames.some((n) => words(n).some((w) => p.has(w)));
}

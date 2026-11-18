// What a patient will likely owe at the front desk (2026-11-17), worked out from what insurance said
// on past claims: the payment files the owner uploads to Master Billing. Insurance marks the patient's
// part of each line with a reason: 1 = deductible, 2 = coinsurance, 3 = copay. These are pure rules
// shared by the server and the screens. They are estimates: the insurance's own answer always wins.
import type { BillAdjustment } from "./masterBilling";
import { adjustmentKind, insuranceType } from "./billCodes";
import { insNorm, PLANS } from "./insurance";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const medianCents = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

/** "$25", "$118.40". */
export const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", cents % 100 === 0 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "2026-10-03" → "10/3/26". */
export const shortDay = (ymd: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? "");
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]!.slice(2)}` : "";
};

// ---- The patient's part of a line, by reason ----

export interface PatientShares { deductible: number; coinsurance: number; copay: number; other: number }

/**
 * What the patient owes on a line, split by reason. The reasons come from the first insurance; when a
 * second insurance (Medicaid behind Medicare, a supplement) paid some of it, each part shrinks in
 * proportion so the parts add up to what the patient still owes.
 */
export function patientShares(adjustments: BillAdjustment[] | null | undefined, patientOwesCents: number): PatientShares {
  const s: PatientShares = { deductible: 0, coinsurance: 0, copay: 0, other: 0 };
  for (const a of adjustments ?? []) {
    if ((a.kind ?? adjustmentKind(a.group, a.code)) !== "patient") continue;
    const code = a.group.toUpperCase() === "PR" ? a.code.replace(/^0+/, "") : "";
    if (code === "1") s.deductible += a.cents;
    else if (code === "2") s.coinsurance += a.cents;
    else if (code === "3") s.copay += a.cents;
    else s.other += a.cents;
  }
  for (const k of Object.keys(s) as (keyof PatientShares)[]) s[k] = Math.max(0, s[k]);
  const total = s.deductible + s.coinsurance + s.copay + s.other;
  const owes = Math.max(0, patientOwesCents);
  if (total > owes && total > 0) {
    const k = owes / total;
    for (const key of Object.keys(s) as (keyof PatientShares)[]) s[key] = Math.round(s[key] * k);
  }
  return s;
}

// ---- Insurance names ----

/**
 * One name for an insurance however a file writes it ("BCBS OF TEXAS", "Blue Cross Blue Shield of TX"),
 * so a patient's insurance on file can be compared with the insurance on other patients' payments.
 */
export function payerFamily(name: string | null | undefined, filingIndicator?: string | null): string {
  const n = insNorm(name ?? "");
  if (!n) return "";
  const type = insuranceType(name, filingIndicator);
  if (type === "Medicare") return "Original Medicare";
  if (type === "Medicaid") return "Medicaid";
  let best: { name: string; len: number } | null = null;
  for (const p of PLANS) for (const k of p.keys.split(" ")) if (k.length > 3 && n.includes(k) && (!best || k.length > best.len)) best = { name: p.name, len: k.length };
  return best ? best.name : n;
}

// ---- Past visits ----

/** One CPT line of a paid claim, as the estimates need it. */
export interface CostLine {
  claimId: number;
  date: string | null;
  code: string;
  payerName: string | null;
  filingIndicator: string | null;
  memberId: string | null;
  allowedCents: number;
  paidCents: number;
  patientOwesCents: number;
  adjustments: BillAdjustment[] | null;
}

export type VisitKind = "office" | "wellness" | "other";
const OFFICE = /^992(0[2-5]|1[1-5])$/;
const WELLNESS = /^(9938[1-7]|9939[1-7]|G0402|G0438|G0439)$/;
const CLAIM_LEVEL_CODE = "(claim level)";
export const isOfficeCode = (code: string) => OFFICE.test(code.toUpperCase());
export const isNewPatientCode = (code: string) => /^9920[2-5]$/.test(code);
/** The office visit codes "what a visit usually costs" is shown for. */
export const EXPECTED_CODES = { established: ["99213", "99214"], newPatient: ["99203", "99204"] } as const;
/** Plain names for those codes. */
export const VISIT_CODE_NAMES: Record<string, string> = { "99213": "Follow-up visit", "99214": "Longer follow-up visit", "99203": "New patient visit", "99204": "Longer new patient visit" };

/** One day's visit, with the office visit itself (not that day's tests) split into what the patient owed and why. */
export interface PastVisit {
  date: string;
  payer: string | null;
  payerKey: string;
  memberId: string | null;
  kind: VisitKind;
  /** The office visit code billed (99214…), when there was one. */
  code: string | null;
  /** The office visit only: allowed by insurance, paid by insurance, left to the patient. */
  allowedCents: number;
  paidCents: number;
  owesCents: number;
  deductibleCents: number;
  coinsuranceCents: number;
  /** Copay anywhere on that day's claim(s): a copay is per visit. */
  copayCents: number;
  /** Everything the patient owed for the day, tests included. */
  dayOwesCents: number;
}

/** Lines → one visit per day, newest first. Days where insurance allowed nothing for the visit are left out. */
export function visitsOf(lines: CostLine[]): PastVisit[] {
  const byDay = new Map<string, CostLine[]>();
  for (const l of lines) {
    if (!l.date) continue;
    const list = byDay.get(l.date);
    if (list) list.push(l); else byDay.set(l.date, [l]);
  }
  const out: PastVisit[] = [];
  for (const [date, day] of Array.from(byDay.entries())) {
    const codes = day.map((l) => l.code.toUpperCase());
    const kind: VisitKind = codes.some((c) => OFFICE.test(c)) ? "office" : codes.some((c) => WELLNESS.test(c)) ? "wellness" : "other";
    const isMain = (l: CostLine) => (kind === "office" ? OFFICE.test(l.code.toUpperCase()) : kind === "wellness" ? WELLNESS.test(l.code.toUpperCase()) : true);
    const main = day.filter(isMain);
    const first = main[0] ?? day[0]!;
    // A claim's own adjustments (not tied to a line) belong to the visit when the visit is on that claim.
    const mainClaims = new Set(main.map((l) => l.claimId));
    const visitLines = day.filter((l) => isMain(l) || (l.code === CLAIM_LEVEL_CODE && mainClaims.has(l.claimId)));
    const shares = visitLines.map((l) => patientShares(l.adjustments, l.patientOwesCents));
    const allowed = sum(main.map((l) => l.allowedCents));
    if (allowed <= 0) continue;
    out.push({
      date, payer: first.payerName, payerKey: payerFamily(first.payerName, first.filingIndicator), memberId: first.memberId, kind,
      code: kind === "other" ? null : first.code.toUpperCase(),
      allowedCents: allowed, paidCents: sum(visitLines.map((l) => l.paidCents)), owesCents: sum(visitLines.map((l) => Math.max(0, l.patientOwesCents))),
      deductibleCents: sum(shares.map((s) => s.deductible)), coinsuranceCents: sum(shares.map((s) => s.coinsurance)),
      copayCents: sum(day.map((l) => patientShares(l.adjustments, l.patientOwesCents).copay)),
      dayOwesCents: sum(day.map((l) => Math.max(0, l.patientOwesCents))),
    });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// ---- One patient's own history ----

/** How many of the latest office visits a copay is read from. */
export const COST_LOOK_BACK_VISITS = 6;

export interface CopayFinding {
  /** The copay seen most often on the visits looked at. */
  cents: number;
  seenOn: number;
  outOf: number;
  lastDate: string;
  /** The copay on the most recent visit that had one (differs from `cents` after a change). */
  latestCents: number;
  /** No visit yet this year: this is last year's copay, and plans can change in January. */
  fromLastYear: boolean;
}

/**
 * applies: the deductible was applied on their latest visit this year and insurance paid nothing for it.
 * met: it was applied earlier this year, and insurance has started paying.
 * reset: applied last year, and there is no visit yet this year (it starts over each January).
 */
export type DeductibleState = "applies" | "met" | "reset" | "none";

export interface PersonCost {
  payer: string | null;
  payerKey: string;
  memberId: string | null;
  lastVisit: string;
  /** Office visits looked at (same insurance as the latest, this year; last year's when there are none yet). */
  lookedAt: number;
  copay: CopayFinding | null;
  /** Insurance left the patient nothing to pay on every visit looked at. */
  nothingOwed: boolean;
  deductible: {
    state: DeductibleState;
    year: number;
    visitsThisYear: number;
    centsThisYear: number;
    visitsLastYear: number;
    centsLastYear: number;
    /** The latest visit the deductible was applied on, and what the patient owed for that office visit. */
    lastDate: string | null;
    lastOwedCents: number | null;
    lastAllowedCents: number | null;
  };
  /** The patient's percentage after the deductible (20 = 20%), when visits show one. */
  coinsurancePct: number | null;
  /** What that percentage comes to for an office visit once the deductible is out of the way. */
  coinsuranceCents: number | null;
  /** What an office visit usually left to the patient (the middle of the visits looked at). */
  usualOwesCents: number;
  /** The visits behind all of this, newest first. */
  recent: PastVisit[];
}

/**
 * A patient's copay / deductible picture from their own past office visits. Only visits on the same
 * insurance as their latest one count, from January of last year on. null = nothing recent to go on.
 */
export function personCost(visits: PastVisit[], today: string): PersonCost | null {
  const year = Number(today.slice(0, 4));
  const from = `${year - 1}-01-01`;
  const office = visits.filter((v) => v.kind === "office" && v.date <= today).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const latest = office[0];
  if (!latest || latest.date < from) return null;
  const same = office.filter((v) => v.payerKey === latest.payerKey && v.date >= from);
  const thisYear = same.filter((v) => v.date >= `${year}-01-01`);
  const lastYear = same.filter((v) => v.date < `${year}-01-01`);
  const basis = (thisYear.length ? thisYear : lastYear).slice(0, COST_LOOK_BACK_VISITS);

  let copay: CopayFinding | null = null;
  const withCopay = basis.filter((v) => v.copayCents > 0);
  if (withCopay.length) {
    const counts = new Map<number, number>();
    for (const v of withCopay) counts.set(v.copayCents, (counts.get(v.copayCents) ?? 0) + 1);
    // The amount seen most often; a tie goes to the more recent one.
    let best = withCopay[0]!.copayCents;
    for (const v of withCopay) if ((counts.get(v.copayCents) ?? 0) > (counts.get(best) ?? 0)) best = v.copayCents;
    copay = { cents: best, seenOn: counts.get(best)!, outOf: basis.length, lastDate: withCopay.find((v) => v.copayCents === best)!.date, latestCents: withCopay[0]!.copayCents, fromLastYear: !thisYear.length };
  }

  const dedThis = thisYear.filter((v) => v.deductibleCents > 0);
  const dedLast = lastYear.filter((v) => v.deductibleCents > 0);
  let state: DeductibleState = "none";
  if (thisYear.length) {
    const top = thisYear[0]!;
    // Insurance pays nothing until the deductible is used up: a payment on a visit with a deductible means it ran out there.
    if (top.deductibleCents > 0) state = top.paidCents > 0 ? "met" : "applies";
    else if (dedThis.length) state = "met";
  } else if (dedLast.length) state = "reset";
  const lastDed = dedThis[0] ?? (thisYear.length ? undefined : dedLast[0]);

  const pcts = basis.filter((v) => v.coinsuranceCents > 0 && v.allowedCents - v.deductibleCents > 0).map((v) => (v.coinsuranceCents / (v.allowedCents - v.deductibleCents)) * 100);
  let pct: number | null = null;
  if (pcts.length) {
    const mid = pcts.slice().sort((a, b) => a - b)[pcts.length >> 1]!;
    const five = Math.round(mid / 5) * 5;
    pct = Math.abs(mid - five) <= 1 ? five : Math.round(mid);
    if (pct <= 0 || pct >= 100) pct = null;
  }
  // Visits where only the percentage applied show it best; otherwise the percentage of a visit like their latest.
  const plain = basis.filter((v) => v.coinsuranceCents > 0 && v.deductibleCents === 0).map((v) => v.coinsuranceCents);
  const coinsuranceCents = pct == null ? null : plain.length ? medianCents(plain) : Math.round((latest.allowedCents * pct) / 100);

  return {
    payer: latest.payer, payerKey: latest.payerKey, memberId: latest.memberId, lastVisit: latest.date, lookedAt: basis.length, copay,
    nothingOwed: basis.length > 0 && basis.every((v) => v.dayOwesCents === 0),
    deductible: {
      state, year, visitsThisYear: dedThis.length, centsThisYear: sum(dedThis.map((v) => v.deductibleCents)), visitsLastYear: dedLast.length, centsLastYear: sum(dedLast.map((v) => v.deductibleCents)),
      lastDate: lastDed?.date ?? null, lastOwedCents: lastDed ? lastDed.owesCents : null, lastAllowedCents: lastDed ? lastDed.allowedCents : null,
    },
    coinsurancePct: pct, coinsuranceCents,
    usualOwesCents: medianCents(basis.map((v) => v.owesCents)),
    recent: same.slice(0, 8),
  };
}

// ---- What staff may see of it (2026-11-18, the owner: "make sure they dont see any bills or paid things") ----

/** A past visit without its money: the date, the visit, and what applied (the copay amount is a plan term, so it stays). */
export interface StaffPastVisit { date: string; code: string | null; copayCents: number; deductible: boolean; coinsurance: boolean; nothingOwed: boolean }
/** PersonCost for everyone but the owner: no insurance payments, visit prices, past balances or deductible totals. */
export interface StaffOwn {
  payer: string | null;
  copay: PersonCost["copay"];
  nothingOwed: boolean;
  deductible: { state: DeductibleState; year: number; visitsThisYear: number; visitsLastYear: number; lastDate: string | null };
  coinsurancePct: number | null;
  recent: StaffPastVisit[];
}

export function staffOwn(pc: PersonCost): StaffOwn {
  const d = pc.deductible;
  return {
    payer: pc.payer,
    copay: pc.copay,
    nothingOwed: pc.nothingOwed,
    deductible: { state: d.state, year: d.year, visitsThisYear: d.visitsThisYear, visitsLastYear: d.visitsLastYear, lastDate: d.lastDate },
    coinsurancePct: pc.coinsurancePct,
    recent: pc.recent.map((v) => ({
      date: v.date, code: v.code, copayCents: v.copayCents, deductible: v.deductibleCents > 0, coinsurance: v.coinsuranceCents > 0,
      nothingOwed: v.owesCents === 0 && v.copayCents === 0,
    })),
  };
}

// ---- The short note staff see ----

export type CollectKind = "copay" | "deductible" | "coinsurance" | "nothing" | "info";
export interface CollectNote {
  kind: CollectKind;
  /** The chip: "Copay $25". */
  label: string;
  /** One or two plain sentences on where it comes from. */
  detail: string;
  /** The amount to expect at check-in, when there is one. */
  cents: number | null;
  /** own = this patient's past visits; plan = other patients on the same plan. */
  /** own = their past visits; plan = other patients on the same plan; card = their insurance card; table = the owner's plan copay table. */
  basis: "own" | "plan" | "card" | "table";
}

const visitsWord = (n: number) => `${n} visit${n === 1 ? "" : "s"}`;
/** "their last visit" / "their last 3 visits". */
const lastVisits = (n: number) => (n === 1 ? "their last visit" : `their last ${n} visits`);
/** "on their last visit" / "on 2 of their last 3 visits". */
const seenOn = (seen: number, of: number) => (seen === of ? `on ${of === 1 ? "their last visit" : `all of their last ${of} visits`}` : `on ${seen} of their last ${of} visits`);

/** The front-desk note for a patient with past visits; null when their visits say nothing useful. */
export function personNote(pc: PersonCost): CollectNote | null {
  const d = pc.deductible;
  const c = pc.copay;
  const copayLine = c ? ` Their copay was ${usd(c.cents)} ${seenOn(c.seenOn, c.outOf)}.` : "";
  if (d.state === "applies" && d.lastOwedCents != null) {
    return {
      kind: "deductible", basis: "own", cents: d.lastOwedCents,
      label: c ? `Copay ${usd(c.cents)} + deductible` : `Deductible not met: about ${usd(d.lastOwedCents)}`,
      detail: `The deductible isn't met yet: it applied on ${visitsWord(d.visitsThisYear)} this year, most recently ${shortDay(d.lastDate)}. Until it's met, expect about ${usd(d.lastOwedCents)} for an office visit.${copayLine}`,
    };
  }
  const met = d.state === "met" ? ` The deductible looks met for ${d.year}.` : "";
  const reset = d.state === "reset" ? ` In ${d.year - 1} the deductible was applied on ${visitsWord(d.visitsLastYear)}; it starts over each January.` : "";
  if (c) {
    const changed = c.latestCents !== c.cents ? ` Their most recent copay was ${usd(c.latestCents)}.` : "";
    const stale = c.fromLastYear ? ` No visit yet in ${d.year}: plans can change in January.` : "";
    return {
      kind: "copay", basis: "own", cents: c.cents, label: `Copay ${usd(c.cents)}${c.fromLastYear ? ` (from ${d.year - 1})` : ""}`,
      detail: `Their copay was ${usd(c.cents)} ${seenOn(c.seenOn, c.outOf)} (latest ${shortDay(c.lastDate)}).${changed}${met}${reset}${stale}`,
    };
  }
  if (d.state === "reset" && d.lastOwedCents != null) {
    return {
      kind: "deductible", basis: "own", cents: d.lastOwedCents, label: `Deductible applied in ${d.year - 1}`,
      detail: `In ${d.year - 1} the deductible applied on ${visitsWord(d.visitsLastYear)}. No visit yet in ${d.year}: it starts over each January, so until it's met expect about ${usd(d.lastOwedCents)} for an office visit.`,
    };
  }
  if (pc.coinsurancePct && pc.coinsuranceCents) {
    return {
      kind: "coinsurance", basis: "own", cents: pc.coinsuranceCents, label: `Coinsurance ${pc.coinsurancePct}%: about ${usd(pc.coinsuranceCents)}`,
      detail: `The patient pays ${pc.coinsurancePct}% of each office visit, about ${usd(pc.coinsuranceCents)} for a visit like their recent ones.${met}`,
    };
  }
  if (pc.nothingOwed) {
    return { kind: "nothing", basis: "own", cents: 0, label: "No copay on past visits", detail: `Nothing to pay on ${lastVisits(pc.lookedAt)} (latest ${shortDay(pc.lastVisit)}).${met}` };
  }
  if (d.state === "met") {
    return { kind: "info", basis: "own", cents: null, label: "Deductible looks met", detail: `The deductible applied on ${visitsWord(d.visitsThisYear)} earlier in ${d.year} and looks met now (latest visit ${shortDay(pc.lastVisit)}).` };
  }
  if (pc.usualOwesCents > 0) {
    return { kind: "info", basis: "own", cents: pc.usualOwesCents, label: `Usually about ${usd(pc.usualOwesCents)}`, detail: `Their part has been about ${usd(pc.usualOwesCents)} per office visit on ${lastVisits(pc.lookedAt)}.` };
  }
  return null;
}

// ---- Other patients on the same plan (for someone with no visits yet) ----

export type PlanTier = "group" | "plan" | "payer";
export const PLAN_TIER_WORDS: Record<PlanTier, string> = { group: "group number", plan: "plan", payer: "insurance" };

/** What one patient's visits say about their plan. */
export interface PlanMember { copayCents: number | null; nothingOwed: boolean; deductible: boolean }
export interface PlanStat {
  tier: PlanTier;
  /** Patients with past visits on this plan. */
  patients: number;
  /** Their usual copays, most common first (0 = insurance left them nothing to pay). */
  copays: { cents: number; patients: number }[];
  /** How many had a deductible applied. */
  deductiblePatients: number;
}

export function planStat(tier: PlanTier, members: PlanMember[]): PlanStat {
  const counts = new Map<number, number>();
  for (const m of members) {
    const cents = m.copayCents && m.copayCents > 0 ? m.copayCents : m.nothingOwed ? 0 : null;
    if (cents != null) counts.set(cents, (counts.get(cents) ?? 0) + 1);
  }
  return {
    tier, patients: members.length, deductiblePatients: members.filter((m) => m.deductible).length,
    copays: Array.from(counts.entries()).map(([cents, patients]) => ({ cents, patients })).sort((a, b) => b.patients - a.patients || a.cents - b.cents),
  };
}

/** How many patients must agree before a plan's copay is shown for someone new (a wrong number is worse than none). */
const PLAN_RULES: Record<PlanTier, { min: number; share: number }> = { group: { min: 2, share: 0.75 }, plan: { min: 3, share: 0.75 }, payer: { min: 10, share: 0.9 } };

/** The copay nearly everyone on the plan has, when enough patients agree. */
export function planCopay(stat: PlanStat): { cents: number; patients: number; of: number } | null {
  const of = sum(stat.copays.map((c) => c.patients));
  const top = stat.copays[0];
  const rule = PLAN_RULES[stat.tier];
  if (!top || of < rule.min || top.patients / of < rule.share) return null;
  return { cents: top.cents, patients: top.patients, of };
}

/** Most patients on the plan had a deductible applied (same group number or plan name only). */
export const planDeductibleLikely = (stat: PlanStat) => stat.tier !== "payer" && stat.patients >= 3 && stat.deductiblePatients / stat.patients >= 0.6;

/** The note for a patient with no past visits, from other patients on the same plan. */
export function planNote(stat: PlanStat | null, expectedCents: number | null): CollectNote | null {
  if (!stat) return null;
  const word = PLAN_TIER_WORDS[stat.tier];
  const c = planCopay(stat);
  const none = " This patient has no past visits on file yet.";
  if (planDeductibleLikely(stat)) {
    return {
      kind: "deductible", basis: "plan", cents: expectedCents, label: `Likely deductible plan${expectedCents ? `: about ${usd(expectedCents)}` : ""}`,
      detail: `The deductible applied for ${stat.deductiblePatients} of ${stat.patients} other patients with the same ${word}.${expectedCents ? ` Until it's met, expect about ${usd(expectedCents)} for the visit.` : ""}${none}`,
    };
  }
  if (c && c.cents > 0) return { kind: "copay", basis: "plan", cents: c.cents, label: `Copay ${usd(c.cents)} (same ${stat.tier === "payer" ? "insurance" : "plan"})`, detail: `${c.patients} of ${c.of} other patients with the same ${word} had a ${usd(c.cents)} copay on their office visits.${none}` };
  if (c && c.cents === 0) return { kind: "nothing", basis: "plan", cents: 0, label: `Usually no copay (same ${stat.tier === "payer" ? "insurance" : "plan"})`, detail: `Nothing to pay for ${c.patients} of ${c.of} other patients with the same ${word}.${none}` };
  return null;
}

// ---- A patient's insurance on file (Practice Fusion's insurance list) ----

export interface CoverageInfo {
  payer: string | null;
  memberId: string | null;
  /** Group number. */
  group: string | null;
  /** Plan name. */
  plan: string | null;
  active: boolean;
  start: string | null;
  /** 1 = primary, when the record says. */
  order: number | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A FHIR Coverage record → the insurance, member ID, group number and plan name. */
export function coverageInfo(raw: unknown, today: string): CoverageInfo {
  const r = obj(raw) ?? {};
  const payer = (Array.isArray(r.payor) ? r.payor : []).map((p) => text(obj(p)?.display)).find(Boolean) ?? null;
  const memberId = text(r.subscriberId) ?? (Array.isArray(r.identifier) ? r.identifier : []).map((i) => text(obj(i)?.value)).find(Boolean) ?? null;
  let group: string | null = null;
  let plan: string | null = null;
  for (const c of Array.isArray(r.class) ? r.class : []) {
    const o = obj(c);
    if (!o) continue;
    const type = obj(o.type);
    const code = ((Array.isArray(type?.coding) ? type!.coding : []).map((x) => text(obj(x)?.code)).find(Boolean) ?? text(type?.text) ?? "").toLowerCase();
    if (code === "group" || code === "subgroup") group ??= text(o.value) ?? text(o.name);
    else if (code === "plan" || code === "subplan" || code === "class") plan ??= text(o.name) ?? text(o.value);
  }
  const period = obj(r.period);
  const start = text(period?.start)?.slice(0, 10) ?? null;
  const end = text(period?.end)?.slice(0, 10) ?? null;
  const status = (text(r.status) ?? "active").toLowerCase();
  return { payer, memberId, group, plan, active: status === "active" && (!end || end >= today), start, order: typeof r.order === "number" ? r.order : null };
}

const JUNK_GROUP = /^(0+|N\/?A|NA|NONE|UNKNOWN|X+|GROUP|SELF|INDIVIDUAL)$/;
const upperAlnum = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The ways a plan is recognized, most exact first: same group number, same plan name, same insurance. */
export function planKeys(payerKey: string, group: string | null | undefined, plan: string | null | undefined): { tier: PlanTier; key: string }[] {
  if (!payerKey) return [];
  const out: { tier: PlanTier; key: string }[] = [];
  const g = upperAlnum(group);
  // A longer group number is its own name; a short one ("001") only means something within one insurance.
  if (g.length >= 3 && !JUNK_GROUP.test(g)) out.push({ tier: "group", key: g.length >= 5 ? `g|${g}` : `g|${payerKey}|${g}` });
  // A "plan name" that is only the insurance's own name says nothing more than the insurance does.
  const p = insNorm(plan ?? "");
  if (p.length >= 6 && p !== insNorm(payerKey)) out.push({ tier: "plan", key: `n|${payerKey}|${p}` });
  out.push({ tier: "payer", key: `p|${payerKey}` });
  return out;
}

/** Do two member IDs look like the same one (a plan prefix or a card suffix aside)? */
export function sameMemberId(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = upperAlnum(a), y = upperAlnum(b);
  if (x.length < 5 || y.length < 5) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 7 && long.includes(short) && long.length - short.length <= 4;
}

// Costs in Master Billing (owner only, 2026-11-15): the practice's monthly bills (rent per clinic first),
// and a month-by-month "money in vs. money out" next to insurance payments, payroll and ZocDoc.
// A cost counts in every month from its starting month through its last month (or on, if none).

export const COST_CATEGORIES = ["rent", "utilities", "software", "insurance", "equipment", "other"] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];
export const COST_CATEGORY_LABELS: Record<CostCategory, string> = {
  rent: "Rent", utilities: "Utilities", software: "Software", insurance: "Insurance", equipment: "Equipment", other: "Other",
};

export interface MonthlyCost { amountCents: number; startMonth: string; endMonth: string | null }

export const isMonth = (m: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

/** "2026-11" → "2026-12". */
export function nextMonth(m: string, n = 1): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

/** Months from `from` through `to`, oldest first. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 240; m = nextMonth(m)) out.push(m);
  return out;
}

export const costInMonth = (c: MonthlyCost, month: string) => c.startMonth <= month && (!c.endMonth || c.endMonth >= month);

/** Each month's total of the costs in effect that month. */
export function costsByMonth(costs: MonthlyCost[], months: string[]): Map<string, number> {
  return new Map(months.map((m) => [m, costs.filter((c) => costInMonth(c, m)).reduce((s, c) => s + c.amountCents, 0)]));
}

export interface MoneyMonth {
  month: string;
  /** Insurance payments loaded in Master Billing, by payment date. */
  insuranceCents: number;
  payrollCents: number;
  costsCents: number;
  zocdocCents: number;
  outCents: number;
  /** Money in minus money out. */
  leftCents: number;
  inProgress: boolean;
}

/**
 * Split an amount across keys in proportion to their weights, in whole cents that add back up exactly
 * (largest remainders get the leftover cents). No weight at all: it all goes to `fallback`.
 */
export function splitCents<K>(totalCents: number, weights: Map<K, number>, fallback: K): Map<K, number> {
  const out = new Map<K, number>();
  if (!totalCents) return out;
  const entries = Array.from(weights.entries()).filter(([, w]) => w > 0);
  const sum = entries.reduce((s, [, w]) => s + w, 0);
  if (!sum) return new Map([[fallback, totalCents]]);
  const raw = entries.map(([k, w]) => ({ k, exact: (totalCents * w) / sum }));
  let given = 0;
  for (const r of raw) { const c = Math.floor(r.exact); out.set(r.k, c); given += c; }
  for (const r of raw.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)))) {
    if (given >= totalCents) break;
    out.set(r.k, out.get(r.k)! + 1);
    given++;
  }
  return out;
}

/** Add one split into a running total. */
export function addSplit<K>(into: Map<K, number>, part: Map<K, number>) {
  for (const [k, v] of Array.from(part.entries())) into.set(k, (into.get(k) ?? 0) + v);
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/** What tells a clinic apart in someone else's text: its name after "MyPCP Dr - ", and its street ("Provincial Blvd"). */
export function clinicKeywords(c: { name: string; address?: string | null }): string[] {
  const keys = new Set<string>();
  const suffix = c.name.split(/\s+-\s+/).slice(1).join(" ").trim();
  if (suffix) keys.add(words(suffix));
  const street = (c.address ?? "").split(",")[0]!.replace(/^\s*\d+\s*/, "").replace(/\b(ste|suite|unit|#)\b.*$/i, "").trim();
  if (street) keys.add(words(street));
  return Array.from(keys).filter((k) => k.length >= 4);
}

/**
 * Which clinic a ZocDoc location (or any text naming a place) means: the clinic whose name or street appears in
 * it, preferring the longest match ("Highland Knolls, Katy" is Highland Knolls, not Katy). Null if none or a tie.
 */
export function matchClinic<T extends { id: number; name: string; address?: string | null }>(text: string | null | undefined, clinics: T[]): T | null {
  if (!text) return null;
  const t = ` ${words(text)} `;
  let best: { c: T; len: number } | null = null, tie = false;
  for (const c of clinics) {
    for (const k of clinicKeywords(c)) {
      if (!t.includes(` ${k} `)) continue;
      if (!best || k.length > best.len) { best = { c, len: k.length }; tie = false; }
      else if (k.length === best.len && best.c.id !== c.id) tie = true;
    }
  }
  return best && !tie ? best.c : null;
}

export function moneyMonth(m: { month: string; insuranceCents: number; payrollCents: number; costsCents: number; zocdocCents: number; inProgress: boolean }): MoneyMonth {
  const outCents = m.payrollCents + m.costsCents + m.zocdocCents;
  return { ...m, outCents, leftCents: m.insuranceCents - outCents };
}

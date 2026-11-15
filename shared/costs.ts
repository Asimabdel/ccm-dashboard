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

export function moneyMonth(m: { month: string; insuranceCents: number; payrollCents: number; costsCents: number; zocdocCents: number; inProgress: boolean }): MoneyMonth {
  const outCents = m.payrollCents + m.costsCents + m.zocdocCents;
  return { ...m, outCents, leftCents: m.insuranceCents - outCents };
}

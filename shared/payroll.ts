// Payroll estimate (Master Billing, owner only, 2026-11-12): each person's gross pay from time-clock
// hours and their pay rate, for a month or a pay period. An estimate before taxes and deductions; the
// payroll provider's (QuickBooks) numbers are the official ones.
//
// What it relies on (federal rule for non-exempt hourly staff; Texas adds none): hours over 40 in a
// Monday–Sunday week are overtime at 1.5× the hourly rate. A week that crosses into the next month
// counts its overtime on the days worked after the 40th hour. Salary is per year: a month is 1/12, a
// pay period 1/26, spread evenly over its days (so a mid-month start or raise is prorated).
import { addDays, weekStart } from "./workforce";

export type PayType = "hourly" | "salary";
export const PAY_TYPE_LABELS: Record<PayType, string> = { hourly: "Hourly", salary: "Salary (per year)" };
export interface PayRateInput { payType: PayType; amountCents: number; overtime: boolean; startDate: string }
export const REGULAR_WEEK_MINUTES = 40 * 60;
export const OVERTIME_MULTIPLIER = 1.5;
export type PayBasis = "month" | "period";

/** The rate in effect on a day: the one with the latest start on or before it. */
export function rateOn<T extends { startDate: string }>(rates: T[], date: string): T | null {
  let best: T | null = null;
  for (const r of rates) if (r.startDate <= date && (!best || r.startDate >= best.startDate)) best = r;
  return best;
}

/** Each day's minutes split into regular and overtime (time past 40 hours in its Monday–Sunday week, in the order worked). */
export function splitWeeks(dayMinutes: Map<string, number>): Map<string, { regular: number; overtime: number }> {
  const weeks = new Map<string, string[]>();
  for (const d of Array.from(dayMinutes.keys())) {
    const w = weekStart(d);
    weeks.set(w, [...(weeks.get(w) ?? []), d]);
  }
  const out = new Map<string, { regular: number; overtime: number }>();
  for (const days of Array.from(weeks.values())) {
    let soFar = 0;
    for (const d of days.sort()) {
      const m = Math.max(0, dayMinutes.get(d) ?? 0);
      const regular = Math.min(m, Math.max(0, REGULAR_WEEK_MINUTES - soFar));
      out.set(d, { regular, overtime: m - regular });
      soFar += m;
    }
  }
  return out;
}

const daysInMonth = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate();
/** A salary's share for one day: a month is 1/12 of the year, a pay period (14 days) 1/26. */
const salaryPerDay = (yearCents: number, date: string, basis: PayBasis) => (basis === "month" ? yearCents / 12 / daysInMonth(date) : yearCents / 26 / 14);

export interface PayEstimate {
  regularMinutes: number;
  overtimeMinutes: number;
  regularCents: number;
  overtimeCents: number;
  salaryCents: number;
  totalCents: number;
  /** Days worked with no pay rate set (their hours aren't priced). */
  unpricedDays: number;
}

/**
 * Pay for the days `from`…`to`. `dayMinutes` should also hold the rest of each week around the range,
 * so overtime in a week that crosses the range edge is placed right.
 */
export function estimatePay(opts: { from: string; to: string; dayMinutes: Map<string, number>; rates: PayRateInput[]; basis: PayBasis }): PayEstimate {
  const split = splitWeeks(opts.dayMinutes);
  let regularMinutes = 0, overtimeMinutes = 0, regular = 0, overtime = 0, salary = 0, unpricedDays = 0;
  for (let d = opts.from; d <= opts.to; d = addDays(d, 1)) {
    const s = split.get(d) ?? { regular: 0, overtime: 0 };
    regularMinutes += s.regular;
    overtimeMinutes += s.overtime;
    const rate = rateOn(opts.rates, d);
    if (!rate) {
      if (s.regular + s.overtime > 0) unpricedDays++;
      continue;
    }
    if (rate.payType === "salary") salary += salaryPerDay(rate.amountCents, d, opts.basis);
    else {
      const perMinute = rate.amountCents / 60;
      regular += s.regular * perMinute;
      // Staff not paid overtime: hours past 40 are paid at their regular rate.
      if (rate.overtime) overtime += s.overtime * perMinute * OVERTIME_MULTIPLIER;
      else regular += s.overtime * perMinute;
    }
  }
  const r = { regularCents: Math.round(regular), overtimeCents: Math.round(overtime), salaryCents: Math.round(salary) };
  return { regularMinutes, overtimeMinutes, ...r, totalCents: r.regularCents + r.overtimeCents + r.salaryCents, unpricedDays };
}

/** "$18.50/hr" or "$62,000/yr". */
export function rateLabel(r: { payType: PayType; amountCents: number }): string {
  const dollars = r.amountCents / 100;
  return r.payType === "salary"
    ? `$${dollars.toLocaleString("en-US", { maximumFractionDigits: 0 })}/yr`
    : `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/hr`;
}

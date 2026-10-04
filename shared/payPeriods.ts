// Pay periods (2026-10-04, the practice's choices): every 2 weeks, Monday to the second Saturday — Oct 5–17,
// Oct 19–31, … (the anchor Monday an admin can change). The Sunday in between belongs to the period that just
// ended (so a rare Sunday shift is never left out of payroll); its dates still read Monday–Saturday. Staff confirm their
// hours, managers approve, an admin closes the period (no more punch changes), then downloads the
// QuickBooks Payroll sheet. QuickBooks Online Payroll can't import hours from a file, so the sheet lists each
// person's regular and overtime hours in the order they're typed into Run payroll.
import { addDays, weekdayIndex } from "./workforce";

export const DEFAULT_PAY_ANCHOR = "2026-10-05";
export const PAY_PERIOD_DAYS = 14;
/** A period's last day is its second Saturday (Monday + 12). */
const LAST_DAY = 12;

export interface PayPeriod {
  start: string;
  /** The last day (Saturday) — what the dates say, and when it has ended. */
  end: string;
  /** The last day whose hours count in it (the Sunday after). */
  through: string;
}
const period = (start: string): PayPeriod => ({ start, end: addDays(start, LAST_DAY), through: addDays(start, PAY_PERIOD_DAYS - 1) });

const dayNumber = (d: string) => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000);

/** The pay period a date's hours count in. */
export function payPeriodOf(date: string, anchor: string = DEFAULT_PAY_ANCHOR): PayPeriod {
  const idx = Math.floor((dayNumber(date) - dayNumber(anchor)) / PAY_PERIOD_DAYS);
  return period(addDays(anchor, idx * PAY_PERIOD_DAYS));
}

/** The current period and the ones before it, newest first. */
export function recentPayPeriods(today: string, anchor: string = DEFAULT_PAY_ANCHOR, count = 6): PayPeriod[] {
  const cur = payPeriodOf(today, anchor);
  return Array.from({ length: count }, (_, i) => period(addDays(cur.start, -i * PAY_PERIOD_DAYS)));
}

/** An anchor must be a Monday so each period is two whole Monday–Sunday overtime weeks. */
export const isMonday = (date: string) => weekdayIndex(date) === 0;

const hrs = (minutes: number) => (Math.round((minutes / 60) * 100) / 100).toFixed(2);

/** The QuickBooks Payroll sheet: one row per person, in the order Run payroll asks for them. */
export function quickbooksSheet(period: { start: string; end: string }, people: { name: string; regularMinutes: number; overtimeMinutes: number; totalMinutes: number; daysWorked: number }[]): string[][] {
  return [
    ["Employee", "Regular pay hours", "Overtime pay hours", "Total hours", "Days worked", "Pay period"],
    ...people.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => [p.name, hrs(p.regularMinutes), hrs(p.overtimeMinutes), hrs(p.totalMinutes), String(p.daysWorked), `${period.start} to ${period.end}`]),
  ];
}

/** CSV text (Excel-friendly) from rows. */
export function toCsv(rows: string[][]): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(esc).join(",")).join("\r\n");
}

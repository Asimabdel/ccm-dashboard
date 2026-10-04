// Pay periods (2026-10-04, the practice's choices): every 2 weeks, Monday–Sunday, starting from an anchor
// Monday an admin can change (default: Mon Sep 28, 2026, the time clock's first day). Staff confirm their
// hours, managers approve, an admin closes the period (no more punch changes), then downloads the
// QuickBooks Payroll sheet. QuickBooks Online Payroll can't import hours from a file, so the sheet lists each
// person's regular and overtime hours in the order they're typed into Run payroll.
import { addDays, weekdayIndex } from "./workforce";

export const DEFAULT_PAY_ANCHOR = "2026-09-28";
export const PAY_PERIOD_DAYS = 14;

const dayNumber = (d: string) => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000);

/** The pay period (first and last day) a date falls in. */
export function payPeriodOf(date: string, anchor: string = DEFAULT_PAY_ANCHOR): { start: string; end: string } {
  const idx = Math.floor((dayNumber(date) - dayNumber(anchor)) / PAY_PERIOD_DAYS);
  const start = addDays(anchor, idx * PAY_PERIOD_DAYS);
  return { start, end: addDays(start, PAY_PERIOD_DAYS - 1) };
}

/** The current period and the ones before it, newest first. */
export function recentPayPeriods(today: string, anchor: string = DEFAULT_PAY_ANCHOR, count = 6): { start: string; end: string }[] {
  const cur = payPeriodOf(today, anchor);
  return Array.from({ length: count }, (_, i) => {
    const start = addDays(cur.start, -i * PAY_PERIOD_DAYS);
    return { start, end: addDays(start, PAY_PERIOD_DAYS - 1) };
  });
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

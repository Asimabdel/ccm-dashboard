// Provider report (2026-10-07, the practice's choices): each provider's patients seen as daily, weekly and monthly
// averages over a date range, days worked, light days (1–2 patients: most likely off, so they don't count as
// days worked), no-shows and cancellations, and new patients (first visit with the practice) with how many
// qualified for CCM / RPM. Seen = schedule visits marked arrived … checked out (like the daily reports).
import { addDays, weekStart } from "./workforce";

/** Fewer patients than this in a day = a light day (most likely off): not a day worked. */
export const WORKED_DAY_MIN = 3;

export interface ProviderDay {
  date: string;
  /** Visits on the schedule that weren't cancelled. */
  booked: number;
  /** Patients seen (arrived … checked out). */
  seen: number;
  noShow: number;
  cancelled: number;
  /** Past visits still "scheduled": the day's statuses haven't been imported yet. */
  stillScheduled: number;
  /** Seen that day for the first time with the practice. */
  newPatients: number;
  /** …of whom qualified for CCM / RPM. */
  newCcm: number;
  newRpm: number;
}

export type DayKind = "worked" | "light" | "off" | "pending";

/** Today, or a past day whose visits are still "scheduled" (statuses not imported yet), isn't counted yet. */
export function dayKind(d: Pick<ProviderDay, "date" | "seen" | "stillScheduled">, today: string): DayKind {
  if (d.date >= today) return "pending";
  if (d.stillScheduled >= WORKED_DAY_MIN && d.stillScheduled > d.seen) return "pending";
  if (d.seen >= WORKED_DAY_MIN) return "worked";
  return d.seen > 0 ? "light" : "off";
}

/** Calendar months ("YYYY-MM") that lie entirely inside [from, to] and are over before today. */
export function completeMonths(from: string, to: string, today: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  for (let i = 0; i < 40; i++) {
    const first = `${y}-${String(m).padStart(2, "0")}-01`;
    const nextFirst = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const last = addDays(nextFirst, -1);
    if (first > to) break;
    if (first >= from && last <= to && last < today) out.push(first.slice(0, 7));
    y = m === 12 ? y + 1 : y; m = m === 12 ? 1 : m + 1;
  }
  return out;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const per = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10) / 10 : null);
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export interface ProviderSummary {
  daysWorked: number;
  lightDays: { date: string; seen: number }[];
  pendingDays: number;
  /** Patients seen per day worked / per week worked / per complete month worked. */
  dailyAvg: number | null;
  weeklyAvg: number | null;
  monthlyAvg: number | null;
  weeksWorked: number;
  daysPerWeek: number | null;
  monthsCounted: string[];
  /** All patients seen on counted days (light days included). */
  totalSeen: number;
  noShows: number;
  /** No-shows ÷ (seen + no-shows), %. */
  noShowRate: number | null;
  cancellations: number;
  /** Cancellations ÷ everything booked (kept + cancelled), %. */
  cancelRate: number | null;
  newPatients: number;
  newPerDay: number | null;
  newPerWeek: number | null;
  newPerMonth: number | null;
  newCcm: number;
  newRpm: number;
  /** Patients seen per week (Monday), for the trend. */
  weekly: { week: string; seen: number }[];
}

export function summarizeProvider(days: ProviderDay[], range: { from: string; to: string; today: string }): ProviderSummary {
  const kinded = days.map((d) => ({ ...d, kind: dayKind(d, range.today) }));
  const counted = kinded.filter((d) => d.kind !== "pending");
  const worked = kinded.filter((d) => d.kind === "worked");
  const weeks = new Set(worked.map((d) => weekStart(d.date)));
  const months = completeMonths(range.from, range.to, range.today).filter((m) => worked.some((d) => d.date.startsWith(m)));
  const inMonths = worked.filter((d) => months.includes(d.date.slice(0, 7)));
  const seenWorked = sum(worked.map((d) => d.seen));
  const newWorked = sum(worked.map((d) => d.newPatients));
  const totalSeen = sum(counted.map((d) => d.seen));
  const noShows = sum(counted.map((d) => d.noShow));
  const cancellations = sum(counted.map((d) => d.cancelled));
  const booked = sum(counted.map((d) => d.booked));
  const byWeek = new Map<string, number>();
  for (const d of counted) byWeek.set(weekStart(d.date), (byWeek.get(weekStart(d.date)) ?? 0) + d.seen);
  return {
    daysWorked: worked.length,
    lightDays: kinded.filter((d) => d.kind === "light").map((d) => ({ date: d.date, seen: d.seen })),
    pendingDays: kinded.filter((d) => d.kind === "pending" && d.booked > 0).length,
    dailyAvg: per(seenWorked, worked.length),
    weeklyAvg: per(seenWorked, weeks.size),
    monthlyAvg: per(sum(inMonths.map((d) => d.seen)), months.length),
    weeksWorked: weeks.size,
    daysPerWeek: per(worked.length, weeks.size),
    monthsCounted: months,
    totalSeen,
    noShows,
    noShowRate: pct(noShows, totalSeen + noShows),
    cancellations,
    cancelRate: pct(cancellations, booked + cancellations),
    newPatients: sum(counted.map((d) => d.newPatients)),
    newPerDay: per(newWorked, worked.length),
    newPerWeek: per(newWorked, weeks.size),
    newPerMonth: per(sum(inMonths.map((d) => d.newPatients)), months.length),
    newCcm: sum(counted.map((d) => d.newCcm)),
    newRpm: sum(counted.map((d) => d.newRpm)),
    weekly: Array.from(byWeek.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([week, seen]) => ({ week, seen })),
  };
}

/** Range presets for the page. */
export type RangePreset = "4w" | "3m" | "6m" | "ytd";
export function presetRange(p: RangePreset, today: string): { from: string; to: string } {
  const to = addDays(today, -1);
  if (p === "4w") return { from: addDays(weekStart(today), -28), to };
  if (p === "ytd") return { from: `${today.slice(0, 4)}-01-01`, to };
  const back = p === "3m" ? 3 : 6;
  let y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - back;
  while (m < 1) { m += 12; y--; }
  return { from: `${y}-${String(m).padStart(2, "0")}-01`, to };
}

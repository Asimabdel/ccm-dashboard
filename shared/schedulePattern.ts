// Staff "usual week": for each weekday, working or off, the hours, and the clinic (or remote). An
// employee sets it once themselves (it fills in their future shifts right away); after that each
// change is a request their office manager (or the time-off approver) approves. Pure helpers shared
// by server and client.
import { addDays, isValidTimeStr } from "./workforce";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABELS: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
export const WEEKDAY_SHORT: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** One weekday: off, or working start–end at a clinic (null clinic = remote). */
export interface DayPlan { work: boolean; start: string; end: string; clinicId: number | null }
export type WeekPattern = Record<Weekday, DayPlan>;

/** Roles that set their own schedule (staff, not providers or admins). */
export const SELF_SCHEDULE_ROLES = ["staff", "front_desk", "medical_assistant", "office_manager", "billing"] as const;
export const canSelfSchedule = (role: string | null | undefined) => !!role && (SELF_SCHEDULE_ROLES as readonly string[]).includes(role);

const OFF: DayPlan = { work: false, start: "09:00", end: "17:00", clinicId: null };
export const emptyPattern = (clinicId: number | null = null): WeekPattern =>
  Object.fromEntries(WEEKDAYS.map((d) => [d, { ...OFF, work: !["sat", "sun"].includes(d), clinicId }])) as WeekPattern;

/** "2026-10-05" → "mon" (dates are clinic-local calendar dates). */
export function weekdayOf(date: string): Weekday {
  const js = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7]!;
}

/** Problems with a pattern, or null when it's fine. */
export function patternProblem(p: WeekPattern): string | null {
  let working = 0;
  for (const d of WEEKDAYS) {
    const x = p[d];
    if (!x) return "Every weekday needs a choice.";
    if (!x.work) continue;
    working++;
    if (!isValidTimeStr(x.start) || !isValidTimeStr(x.end)) return `${WEEKDAY_LABELS[d]}: enter a start and end time.`;
    if (x.end <= x.start) return `${WEEKDAY_LABELS[d]}: the end time must be after the start time.`;
  }
  return working ? null : "Pick at least one working day.";
}

/** The office is closed: New Year's Day, Memorial Day, July 4, Labor Day, Thanksgiving, Christmas. */
export function isClinicHoliday(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  if ((m === 1 && d === 1) || (m === 7 && d === 4) || (m === 12 && d === 25)) return true;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const nth = Math.ceil(d / 7);
  if (m === 11 && dow === 4 && nth === 4) return true; // Thanksgiving: 4th Thursday
  if (m === 9 && dow === 1 && nth === 1) return true; // Labor Day: 1st Monday
  if (m === 5 && dow === 1 && d + 7 > 31) return true; // Memorial Day: last Monday
  return false;
}

/** The shifts a pattern makes from `from` through `to` (skipping days off and holidays). */
export function shiftsFromPattern(p: WeekPattern, from: string, to: string): { date: string; startTime: string; endTime: string; clinicId: number | null }[] {
  const out: { date: string; startTime: string; endTime: string; clinicId: number | null }[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const x = p[weekdayOf(date)];
    if (x?.work && !isClinicHoliday(date)) out.push({ date, startTime: x.start, endTime: x.end, clinicId: x.clinicId });
  }
  return out;
}

/** Someone's usual week as their upcoming shifts show it (the most common hours/clinic per weekday). */
export function patternFromShifts(list: { date: string; startTime: string; endTime: string; clinicId: number | null }[]): WeekPattern | null {
  if (!list.length) return null;
  const counts = new Map<Weekday, Map<string, number>>();
  const weeks = new Set<string>();
  for (const s of list) {
    const wd = weekdayOf(s.date);
    weeks.add(addDays(s.date, -WEEKDAYS.indexOf(wd)));
    const k = `${s.startTime}|${s.endTime}|${s.clinicId ?? ""}`;
    const m = counts.get(wd) ?? new Map<string, number>();
    m.set(k, (m.get(k) ?? 0) + 1);
    counts.set(wd, m);
  }
  // Days off keep their usual clinic, so switching a day on starts there.
  const byClinic = new Map<number | null, number>();
  for (const s of list) byClinic.set(s.clinicId, (byClinic.get(s.clinicId) ?? 0) + 1);
  const usualClinic = Array.from(byClinic.entries()).sort((a, b) => b[1] - a[1])[0]![0];
  const p = emptyPattern(usualClinic);
  for (const d of WEEKDAYS) {
    const m = counts.get(d);
    // A weekday they work in at least half of the weeks shown.
    const best = m ? Array.from(m.entries()).sort((a, b) => b[1] - a[1])[0] : undefined;
    const total = m ? Array.from(m.values()).reduce((a, b) => a + b, 0) : 0;
    if (!best || total * 2 < weeks.size) { p[d] = { ...p[d], work: false }; continue; }
    const [start, end, clinic] = best[0].split("|");
    p[d] = { work: true, start: start!, end: end!, clinicId: clinic ? Number(clinic) : null };
  }
  return p;
}

/** "Mon–Fri 9:00 AM–5:00 PM · Katy" style lines (consecutive days with the same plan grouped). */
export function describePattern(p: WeekPattern, clinicName: (id: number | null) => string): string[] {
  const fmt = (t: string) => { const [h, m] = t.split(":").map(Number) as [number, number]; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
  const key = (x: DayPlan) => (x.work ? `${x.start}|${x.end}|${x.clinicId ?? ""}` : "off");
  const lines: string[] = [];
  let i = 0;
  while (i < WEEKDAYS.length) {
    const d = WEEKDAYS[i]!;
    let j = i;
    while (j + 1 < WEEKDAYS.length && key(p[WEEKDAYS[j + 1]!]) === key(p[d])) j++;
    const days = i === j ? WEEKDAY_SHORT[d] : `${WEEKDAY_SHORT[d]}–${WEEKDAY_SHORT[WEEKDAYS[j]!]}`;
    const x = p[d];
    lines.push(x.work ? `${days} ${fmt(x.start)}–${fmt(x.end)} · ${clinicName(x.clinicId)}` : `${days} off`);
    i = j + 1;
  }
  return lines;
}

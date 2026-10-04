// Time clock reminders, lunch breaks, manager alerts and weekly attendance (2026-10-04, the practice's
// choices): reminders by MyPCP pop-up + banner and, for people who turned it on, a text to their own cell;
// a Start lunch / End lunch button (only real breaks come off); late / no-show / missed clock-out / no lunch
// / heading-into-overtime alerts go to the person's office manager as tasks; a Monday shout-out for perfect
// attendance in the Everyone channel.
import { CLINIC_TZ, LATE_GRACE_MINUTES, timeToMinutes } from "./workforce";

/** Remind to clock in from this many minutes before the shift starts. */
export const CLOCK_IN_REMINDER_BEFORE = 5;
/** Not clocked in this long after the start: they get a second nudge and their manager is told. */
export const LATE_ALERT_AFTER = 15;
/** Still clocked in this long after the shift ended: remind them to clock out. */
export const CLOCK_OUT_REMINDER_AFTER = 15;
/** End-of-day alerts (no-show, missed clock-out, no lunch) go this long after the shift ended. */
export const END_OF_DAY_AFTER = 60;
/** On lunch this long: remind them to clock back in. */
export const LUNCH_REMINDER_AFTER = 60;
/** Working this long in a day without a break is flagged for the manager. */
export const LUNCH_EXPECTED_AFTER = 6 * 60;
/** A gap between punches at least this long counts as a break even without the lunch button. */
export const BREAK_GAP_MINUTES = 20;
/** Overtime starts over this many minutes in a Monday–Sunday week. */
export const WEEKLY_REGULAR_MINUTES = 40 * 60;

export interface PunchLike { clockInAt: Date | string; clockOutAt: Date | string | null; outReason?: string | null }
const ms = (d: Date | string) => new Date(d).getTime();

/** Minutes worked from a day's punches (an open punch counts up to `now`), and whether they took a break. */
export function dayWork(punches: PunchLike[], now: Date = new Date()): { workedMinutes: number; tookBreak: boolean; onLunchSince: Date | null } {
  const sorted = punches.slice().sort((a, b) => ms(a.clockInAt) - ms(b.clockInAt));
  let worked = 0, tookBreak = false;
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!;
    const end = p.clockOutAt ? ms(p.clockOutAt) : now.getTime();
    worked += Math.max(0, Math.round((end - ms(p.clockInAt)) / 60000));
    const next = sorted[i + 1];
    if (p.clockOutAt && next && (p.outReason === "lunch" || (ms(next.clockInAt) - ms(p.clockOutAt)) / 60000 >= BREAK_GAP_MINUTES)) tookBreak = true;
  }
  const last = sorted.at(-1);
  const onLunchSince = last && last.clockOutAt && last.outReason === "lunch" ? new Date(last.clockOutAt) : null;
  return { workedMinutes: worked, tookBreak, onLunchSince };
}

/**
 * What a person should do about the clock right now (the banner and the reminder job agree on this).
 * `shift` = today's current or next scheduled shift; minutes are clinic-local.
 */
export type ClockNudge = "clock_in" | "late" | "end_lunch" | "clock_out" | null;
export function clockNudge(input: { shift: { startTime: string; endTime: string } | null; punches: PunchLike[]; nowMinutes: number; now?: Date }): ClockNudge {
  const { shift, punches, nowMinutes } = input;
  const now = input.now ?? new Date();
  const open = punches.some((p) => !p.clockOutAt);
  const { onLunchSince } = dayWork(punches, now);
  if (!shift) return null;
  const start = timeToMinutes(shift.startTime), end = timeToMinutes(shift.endTime);
  if (open) return nowMinutes >= end + CLOCK_OUT_REMINDER_AFTER ? "clock_out" : null;
  if (onLunchSince) return nowMinutes < end && (now.getTime() - onLunchSince.getTime()) / 60000 >= LUNCH_REMINDER_AFTER ? "end_lunch" : null;
  if (punches.length) return null; // clocked out for the day
  if (nowMinutes >= start + LATE_GRACE_MINUTES && nowMinutes < end) return "late";
  if (nowMinutes >= start - CLOCK_IN_REMINDER_BEFORE && nowMinutes < end) return "clock_in";
  return null;
}

/** A clinic-local date and "HH:MM" as an instant (handles daylight saving). */
export function clinicInstant(date: string, hhmm: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, h ?? 0, mi ?? 0);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: CLINIC_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at));
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - at) / 60000;
  };
  let t = guess - offset(guess) * 60000;
  const second = offset(t);
  if (second !== offset(guess)) t = guess - second * 60000;
  return new Date(t);
}

/** "HH:MM" of an instant, clinic-local. */
export function clinicHhmm(d: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: CLINIC_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d));
}

/**
 * Perfect attendance for a week: at least 3 shifts due, every one clocked in on time (no late, no
 * no-show), and no forgotten clock-out. Called-out shifts don't count either way.
 */
export function perfectWeek(shifts: { firstPunchLate: number | null; missedClockOut: boolean }[]): boolean {
  if (shifts.length < 3) return false;
  return shifts.every((s) => s.firstPunchLate === 0 && !s.missedClockOut);
}

/** "Andrea Espinosa" → "Andrea E." (shout-outs). */
export function shortStaffName(name: string): string {
  const parts = name.replace(/\s*\([^)]*\)/g, "").trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)![0]!.toUpperCase()}.` : parts[0] ?? name;
}

/** Validation for a fix-my-punch request. */
export function punchFixProblem(input: { workDate: string; today: string; clockIn: string | null; clockOut: string | null; hasPunch: boolean; reason: string }): string | null {
  if (input.workDate > input.today) return "Pick a day that has already happened.";
  if (!input.reason.trim()) return "Say what happened (e.g. \"forgot to clock out, left at 5:05\").";
  if (!input.hasPunch && (!input.clockIn || !input.clockOut)) return "For a day you didn't clock in at all, give both times.";
  if (input.hasPunch && !input.clockIn && !input.clockOut) return "Give the correct time.";
  if (input.clockIn && input.clockOut && timeToMinutes(input.clockOut) <= timeToMinutes(input.clockIn)) return "Clock-out must be after clock-in.";
  return null;
}

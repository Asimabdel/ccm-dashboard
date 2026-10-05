// Fixing clock-in / clock-out times (2026-10-05, the practice's choices): a "Needs fixing" list of every
// punch problem with one-click fixes, a day view against the schedule, quick editing, and an automatic
// clock-out for people who forget (at their scheduled end, 2 hours later; with no shift, after 12 hours),
// flagged for a manager to confirm. Times in fixes are clinic-local "HH:MM" on the problem's date.
import { END_OF_DAY_AFTER, clinicHhmm, clinicInstant } from "./attendance";
import { fmtTime, timeToMinutes } from "./workforce";

/** Still clocked in this long after the scheduled end: clocked out automatically at the scheduled end. */
export const AUTO_CLOCK_OUT_AFTER = 120;
/** With no shift to go by: clocked out automatically after this long on the clock. */
export const AUTO_CLOCK_OUT_UNSCHEDULED = 12 * 60;
/** A day longer than this gets a second look. */
export const LONG_DAY_MINUTES = 12 * 60;
/** A punch shorter than this is probably a double tap. */
export const TINY_PUNCH_MINUTES = 3;
/** After lunch with no clock back in, the suggested afternoon starts this long after lunch began. */
export const SUGGESTED_LUNCH_MINUTES = 30;

export interface FixShift { id: number; date: string; startTime: string; endTime: string; status?: string }
export interface FixPunch { id: number; workDate: string; clockInAt: Date | string; clockOutAt: Date | string | null; outReason: string | null; shiftId: number | null }

const ms = (d: Date | string) => new Date(d).getTime();

/** The shift a punch belongs to: the one it was made for, else that day's shift still going (or next) at clock-in. */
export function shiftForPunch<S extends FixShift>(punch: FixPunch, dayShifts: S[]): S | null {
  const scheduled = dayShifts.filter((s) => s.date === punch.workDate && (s.status ?? "scheduled") === "scheduled");
  const own = punch.shiftId ? scheduled.find((s) => s.id === punch.shiftId) : undefined;
  if (own) return own;
  const inMin = timeToMinutes(clinicHhmm(punch.clockInAt));
  return scheduled.slice().sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)).find((s) => timeToMinutes(s.endTime) > inMin) ?? null;
}

/** When an open punch gets clocked out automatically, if it's time (null = not yet). */
export function autoClockOutAt(input: { clockInAt: Date | string; shift: { date: string; endTime: string } | null; now: Date }): Date | null {
  const start = ms(input.clockInAt);
  if (input.shift) {
    const end = clinicInstant(input.shift.date, input.shift.endTime).getTime();
    if (end > start) return input.now.getTime() >= end + AUTO_CLOCK_OUT_AFTER * 60000 ? new Date(end) : null;
  }
  const cap = start + AUTO_CLOCK_OUT_UNSCHEDULED * 60000;
  return input.now.getTime() >= cap ? new Date(cap) : null;
}

export type FixKind = "missing_out" | "auto_out" | "lunch_no_return" | "no_punch" | "long_day" | "tiny_punch";

/** What a button does. edit / add use clinic-local times on `date` (an out time before the in time = next day). */
export type FixAction =
  | { type: "edit"; label: string; punchId: number; clockIn: string; clockOut: string | null }
  | { type: "add"; label: string; clockIn: string; clockOut: string }
  | { type: "delete"; label: string; punchId: number }
  | { type: "confirm"; label: string; punchId: number }
  | { type: "dismiss"; label: string }
  /** Open the editor (prefilled) instead of saving straight away. */
  | { type: "open_edit"; label: string; punchId: number; clockIn: string; clockOut: string | null }
  | { type: "open_add"; label: string; clockIn: string; clockOut: string };

export interface PunchProblem {
  /** Unique per problem: `${kind}:${punch or shift id}` (also what "dismiss" stores). */
  ref: string;
  kind: FixKind;
  userId: number;
  name: string;
  date: string;
  /** "fix" = hours are wrong until it's fixed; "check" = probably fine, give it a look. */
  severity: "fix" | "check";
  title: string;
  detail: string;
  shift: { startTime: string; endTime: string } | null;
  actions: FixAction[];
}

export interface FixPerson {
  userId: number;
  name: string;
  /** On the time clock and judged from this date (attendanceTracked). */
  tracked: (date: string) => boolean;
  shifts: FixShift[];
  punches: FixPunch[];
  /** Dates with approved time off. */
  offDates: Set<string>;
  /** Problems a manager already marked as fine: `${date}|${ref}`. */
  reviewed: Set<string>;
}

const t12 = (hhmm: string) => fmtTime(hhmm);
const shiftLabel = (s: { startTime: string; endTime: string }) => `${t12(s.startTime)} – ${t12(s.endTime)}`;
const minutesOf = (p: FixPunch) => (p.clockOutAt ? Math.max(0, Math.round((ms(p.clockOutAt) - ms(p.clockInAt)) / 60000)) : 0);
const plus = (hhmm: string, minutes: number) => {
  const m = Math.min(23 * 60 + 59, timeToMinutes(hhmm) + minutes);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const hm = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;

/**
 * Every punch problem for these people on dates [from, today]. `nowMinutes` is clinic-local; today's shifts only
 * count once they're over (an hour after the end, like the end-of-day alerts).
 */
export function findPunchProblems(people: FixPerson[], input: { from: string; today: string; nowMinutes: number; now: Date }): PunchProblem[] {
  const out: PunchProblem[] = [];
  const { from, today, nowMinutes, now } = input;
  for (const person of people) {
    const add = (p: Omit<PunchProblem, "userId" | "name">) => {
      if (!person.reviewed.has(`${p.date}|${p.ref}`)) out.push({ ...p, userId: person.userId, name: person.name });
    };
    const dates = new Set<string>([...person.punches.map((p) => p.workDate), ...person.shifts.map((s) => s.date)]);
    for (const date of Array.from(dates).sort()) {
      if (date < from || date > today) continue;
      const dayShifts = person.shifts.filter((s) => s.date === date && (s.status ?? "scheduled") === "scheduled")
        .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
      const dayPunches = person.punches.filter((p) => p.workDate === date).sort((a, b) => ms(a.clockInAt) - ms(b.clockInAt));
      const shiftOver = (s: FixShift) => date < today || nowMinutes >= timeToMinutes(s.endTime) + END_OF_DAY_AFTER;
      const lastShift = dayShifts.at(-1) ?? null;
      const dayOver = date < today || (lastShift ? shiftOver(lastShift) : false);

      for (const p of dayPunches) {
        const s = shiftForPunch(p, dayShifts);
        const inHhmm = clinicHhmm(p.clockInAt);
        // Still clocked in: from an earlier day, after the shift is over, or 12+ hours with no shift.
        if (!p.clockOutAt) {
          const late = date < today || (s ? shiftOver(s) : now.getTime() - ms(p.clockInAt) >= AUTO_CLOCK_OUT_UNSCHEDULED * 60000);
          if (!late) continue;
          const actions: FixAction[] = [];
          if (s && timeToMinutes(s.endTime) > timeToMinutes(inHhmm)) actions.push({ type: "edit", label: `Clock out at ${t12(s.endTime)} (scheduled end)`, punchId: p.id, clockIn: inHhmm, clockOut: s.endTime });
          actions.push({ type: "open_edit", label: "Other time…", punchId: p.id, clockIn: inHhmm, clockOut: s?.endTime ?? null });
          add({ ref: `missing_out:${p.id}`, kind: "missing_out", date, severity: "fix", shift: s, actions,
            title: "Didn't clock out",
            detail: `Clocked in at ${t12(inHhmm)}${s ? `; shift ${shiftLabel(s)}` : " (no shift scheduled)"}. Counts 0 hours until it's fixed.` });
          continue;
        }
        const outHhmm = clinicHhmm(p.clockOutAt);
        if (p.outReason === "auto") {
          add({ ref: `auto_out:${p.id}`, kind: "auto_out", date, severity: "check", shift: s,
            title: `Clocked out automatically at ${t12(outHhmm)}`,
            detail: `They didn't clock out, so MyPCP did ${s ? "at their scheduled end" : `after ${AUTO_CLOCK_OUT_UNSCHEDULED / 60} hours`}. In at ${t12(inHhmm)}.`,
            actions: [
              { type: "confirm", label: "Looks right", punchId: p.id },
              { type: "open_edit", label: "Change time…", punchId: p.id, clockIn: inHhmm, clockOut: outHhmm },
            ] });
        }
        const mins = minutesOf(p);
        if (mins < TINY_PUNCH_MINUTES && p.outReason !== "lunch") {
          add({ ref: `tiny_punch:${p.id}`, kind: "tiny_punch", date, severity: "check", shift: s,
            title: `A ${mins}-minute punch`,
            detail: `${t12(inHhmm)} → ${t12(outHhmm)}. Probably a double tap.`,
            actions: [{ type: "delete", label: "Delete it", punchId: p.id }, { type: "dismiss", label: "Keep" }] });
        }
      }

      // Went to lunch and never came back on the clock.
      const last = dayPunches.at(-1);
      if (last?.clockOutAt && last.outReason === "lunch" && dayOver) {
        const lunchAt = clinicHhmm(last.clockOutAt);
        const s = shiftForPunch(last, dayShifts);
        const back = plus(lunchAt, SUGGESTED_LUNCH_MINUTES);
        const actions: FixAction[] = [];
        if (s && timeToMinutes(s.endTime) > timeToMinutes(back)) actions.push({ type: "add", label: `Add the afternoon: ${t12(back)} – ${t12(s.endTime)}`, clockIn: back, clockOut: s.endTime });
        actions.push({ type: "open_add", label: "Other times…", clockIn: back, clockOut: s?.endTime ?? plus(back, 4 * 60) });
        actions.push({ type: "dismiss", label: "They left at lunch" });
        add({ ref: `lunch_no_return:${last.id}`, kind: "lunch_no_return", date, severity: "fix", shift: s, actions,
          title: "Didn't clock back in after lunch",
          detail: `Started lunch at ${t12(lunchAt)}${s ? `; shift ${shiftLabel(s)}` : ""}.` });
      }

      // A scheduled shift with no clock-in at all (not on time off, attendance tracked, shift over).
      if (person.tracked(date) && !person.offDates.has(date)) {
        for (const s of dayShifts) {
          if (!shiftOver(s)) continue;
          const mine = dayShifts.length === 1 ? dayPunches : dayPunches.filter((p) => shiftForPunch(p, dayShifts)?.id === s.id);
          if (mine.length) continue;
          add({ ref: `no_punch:${s.id}`, kind: "no_punch", date, severity: "fix", shift: s,
            title: "No clock-in for their shift",
            detail: `Scheduled ${shiftLabel(s)}. If they worked, add the time; if they weren't in, mark it.`,
            actions: [
              { type: "add", label: `Add ${shiftLabel(s)}`, clockIn: s.startTime, clockOut: s.endTime },
              { type: "open_add", label: "Other times…", clockIn: s.startTime, clockOut: s.endTime },
              { type: "dismiss", label: "Wasn't in" },
            ] });
        }
      }

      // A very long day.
      const worked = dayPunches.reduce((sum, p) => sum + minutesOf(p), 0);
      if (worked > LONG_DAY_MINUTES && dayPunches.every((p) => p.clockOutAt)) {
        add({ ref: "long_day", kind: "long_day", date, severity: "check", shift: lastShift,
          title: `${hm(worked)} on the clock`,
          detail: `${dayPunches.map((p) => `${t12(clinicHhmm(p.clockInAt))} → ${t12(clinicHhmm(p.clockOutAt!))}`).join(", ")}. Check it's right.`,
          actions: [{ type: "dismiss", label: "Looks right" }] });
      }
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? (a.date === b.date ? a.name.localeCompare(b.name) : b.date.localeCompare(a.date)) : a.severity === "fix" ? -1 : 1));
}

/** Manager alert task kinds (workforceAlerts refs) a problem kind answers, so fixing it closes the task. */
export const TASK_REFS_FOR: Record<FixKind, string[]> = {
  missing_out: ["missedout"],
  auto_out: ["auto"],
  lunch_no_return: ["lunchback"],
  no_punch: ["noshow"],
  long_day: [],
  tiny_punch: [],
};

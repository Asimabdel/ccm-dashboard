import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { autoClockOutAt, findPunchProblems, shiftForPunch, type FixPerson, type FixPunch } from "../shared/punchFixes";

// Clinic time is Central (CDT = UTC-5 in October).
const at = (iso: string) => new Date(iso);
const shift = (id: number, date: string, startTime = "09:00", endTime = "17:00") => ({ id, date, startTime, endTime, status: "scheduled" });
const punch = (id: number, date: string, inUtc: string, outUtc: string | null, outReason: string | null = null, shiftId: number | null = null): FixPunch =>
  ({ id, workDate: date, clockInAt: at(`${date}T${inUtc}:00Z`), clockOutAt: outUtc ? at(`${outUtc.includes("T") ? outUtc : `${date}T${outUtc}`}:00Z`) : null, outReason, shiftId });
const person = (p: Partial<FixPerson>): FixPerson => ({
  userId: 7, name: "Andrea Espinosa", tracked: () => true, shifts: [], punches: [], offDates: new Set(), reviewed: new Set(), ...p,
});
// Tuesday Oct 6, 2026, 10:00 AM clinic time.
const NOW = at("2026-10-06T15:00:00Z");
const run = (people: FixPerson[], now = NOW, nowMinutes = 10 * 60) => findPunchProblems(people, { from: "2026-10-01", today: "2026-10-06", nowMinutes, now });

describe("automatic clock-out", () => {
  it("waits 2 hours past the scheduled end, then clocks out at the end", () => {
    const s = { date: "2026-10-05", endTime: "17:00" }; // 5 PM CDT = 22:00Z
    expect(autoClockOutAt({ clockInAt: at("2026-10-05T14:00:00Z"), shift: s, now: at("2026-10-05T23:59:00Z") })).toBe(null);
    expect(autoClockOutAt({ clockInAt: at("2026-10-05T14:00:00Z"), shift: s, now: at("2026-10-06T00:00:00Z") })?.toISOString()).toBe("2026-10-05T22:00:00.000Z");
  });

  it("with no shift (or clocked in after it ended), after 12 hours on the clock", () => {
    expect(autoClockOutAt({ clockInAt: at("2026-10-10T14:00:00Z"), shift: null, now: at("2026-10-11T01:59:00Z") })).toBe(null);
    expect(autoClockOutAt({ clockInAt: at("2026-10-10T14:00:00Z"), shift: null, now: at("2026-10-11T02:00:00Z") })?.toISOString()).toBe("2026-10-11T02:00:00.000Z");
    // Came back at 6 PM after a 9–5 shift: the shift doesn't apply.
    expect(autoClockOutAt({ clockInAt: at("2026-10-05T23:00:00Z"), shift: { date: "2026-10-05", endTime: "17:00" }, now: at("2026-10-06T01:00:00Z") })).toBe(null);
  });

  it("finds the shift a punch belongs to", () => {
    const shifts = [shift(1, "2026-10-05", "08:00", "12:00"), shift(2, "2026-10-05", "13:00", "17:00")];
    expect(shiftForPunch(punch(1, "2026-10-05", "13:05", null), shifts)?.id).toBe(1); // 8:05 AM
    expect(shiftForPunch(punch(1, "2026-10-05", "17:55", null), shifts)?.id).toBe(2); // 12:55 PM
    expect(shiftForPunch(punch(1, "2026-10-05", "23:30", null), shifts)).toBe(null); // 6:30 PM
    expect(shiftForPunch(punch(1, "2026-10-05", "23:30", null, null, 1), shifts)?.id).toBe(1); // made for shift 1
  });
});

describe("Needs fixing", () => {
  it("didn't clock out: one click to the scheduled end", () => {
    const [p] = run([person({ shifts: [shift(11, "2026-10-05")], punches: [punch(5, "2026-10-05", "14:02", null)] })]);
    expect(p).toMatchObject({ kind: "missing_out", severity: "fix", date: "2026-10-05", ref: "missing_out:5", title: "Didn't clock out" });
    expect(p!.actions[0]).toEqual({ type: "edit", label: "Clock out at 5:00 PM (scheduled end)", punchId: 5, clockIn: "09:02", clockOut: "17:00" });
  });

  it("today's open punch only once the shift is over", () => {
    const today = person({ shifts: [shift(12, "2026-10-06")], punches: [punch(6, "2026-10-06", "14:00", null)] });
    expect(run([today])).toEqual([]);
    expect(run([today], at("2026-10-06T23:00:00Z"), 18 * 60).map((x) => x.kind)).toEqual(["missing_out"]);
  });

  it("an automatic clock-out asks for a look; checked ones don't", () => {
    const auto = run([person({ shifts: [shift(11, "2026-10-05")], punches: [punch(5, "2026-10-05", "14:00", "22:00", "auto")] })]);
    expect(auto.map((x) => [x.kind, x.severity, x.title])).toEqual([["auto_out", "check", "Clocked out automatically at 5:00 PM"]]);
    expect(auto[0]!.actions.map((a) => a.type)).toEqual(["confirm", "open_edit"]);
    expect(run([person({ shifts: [shift(11, "2026-10-05")], punches: [punch(5, "2026-10-05", "14:00", "22:00", "auto_ok")] })])).toEqual([]);
  });

  it("no clock-back-in after lunch: add the afternoon", () => {
    const [p] = run([person({ shifts: [shift(11, "2026-10-05")], punches: [punch(5, "2026-10-05", "14:00", "17:00", "lunch")] })]);
    expect(p!.kind).toBe("lunch_no_return");
    expect(p!.actions[0]).toEqual({ type: "add", label: "Add the afternoon: 12:30 PM – 5:00 PM", clockIn: "12:30", clockOut: "17:00" });
    expect(p!.actions.at(-1)).toEqual({ type: "dismiss", label: "They left at lunch" });
  });

  it("no clock-in for a shift, unless they were off, not tracked yet, or it was marked", () => {
    const base = { shifts: [shift(11, "2026-10-05")] };
    const [p] = run([person(base)]);
    expect(p).toMatchObject({ kind: "no_punch", ref: "no_punch:11" });
    expect(p!.actions[0]).toEqual({ type: "add", label: "Add 9:00 AM – 5:00 PM", clockIn: "09:00", clockOut: "17:00" });
    expect(run([person({ ...base, offDates: new Set(["2026-10-05"]) })])).toEqual([]);
    expect(run([person({ ...base, tracked: (d) => d >= "2026-10-06" })])).toEqual([]);
    expect(run([person({ ...base, reviewed: new Set(["2026-10-05|no_punch:11"]) })])).toEqual([]);
    expect(run([person({ shifts: [{ ...shift(11, "2026-10-05"), status: "called_out" }] })])).toEqual([]);
  });

  it("double taps and very long days get a second look", () => {
    const tiny = run([person({ shifts: [shift(11, "2026-10-05")], punches: [punch(5, "2026-10-05", "14:00", "22:00"), punch(6, "2026-10-05", "22:01", "22:02")] })]);
    expect(tiny.map((x) => [x.kind, x.actions[0]!.type])).toEqual([["tiny_punch", "delete"]]);
    const long = run([person({ punches: [punch(5, "2026-10-05", "12:00", "2026-10-06T01:00")] })]);
    expect(long.map((x) => [x.kind, x.title])).toEqual([["long_day", "13h 00m on the clock"]]);
  });

  it("a clean day has nothing to fix, and fixes come before checks", () => {
    expect(run([person({ shifts: [shift(11, "2026-10-05")], punches: [punch(5, "2026-10-05", "14:00", "17:00", "lunch"), punch(6, "2026-10-05", "17:30", "22:00")] })])).toEqual([]);
    const both = run([person({ shifts: [shift(11, "2026-10-02"), shift(12, "2026-10-05")], punches: [punch(5, "2026-10-05", "14:00", "22:00", "auto")] })]);
    expect(both.map((x) => x.kind)).toEqual(["no_punch", "auto_out"]);
  });
});

describe("access", () => {
  const callerFor = (role: string) => appRouter.createCaller({
    user: { id: 93, openId: "fix-test", email: "fix@example.com", name: "Fix Test", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as NonNullable<TrpcContext["user"]>,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext);
  it("keeps fixing punches with managers", async () => {
    await expect(callerFor("medical_assistant").workforce.fixes.list({})).rejects.toThrow(/access/);
    await expect(callerFor("staff").workforce.fixes.day({ date: "2026-10-05" })).rejects.toThrow(/access/);
    await expect(callerFor("front_desk").workforce.fixes.dismiss({ userId: 2, date: "2026-10-05", ref: "no_punch:1" })).rejects.toThrow(/access/);
    await expect(callerFor("provider").workforce.fixes.confirm({ punchId: 1 })).rejects.toThrow(/access/);
  });
});

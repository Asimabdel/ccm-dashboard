import { describe, expect, it } from "vitest";
import { canSelfSchedule, describePattern, emptyPattern, isClinicHoliday, patternFromShifts, patternProblem, shiftsFromPattern, weekdayOf } from "../shared/schedulePattern";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function ctxFor(role: string): TrpcContext {
  const user = { id: 95, openId: "sched-test", email: "sched@example.com", name: "Schedule Test", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
  return { user: user as NonNullable<TrpcContext["user"]>, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("usual week", () => {
  it("knows weekdays and the office's holidays", () => {
    expect(weekdayOf("2026-10-05")).toBe("mon");
    expect(weekdayOf("2026-10-04")).toBe("sun");
    expect(isClinicHoliday("2026-11-26")).toBe(true); // Thanksgiving
    expect(isClinicHoliday("2026-12-25")).toBe(true);
    expect(isClinicHoliday("2027-01-01")).toBe(true);
    expect(isClinicHoliday("2027-05-31")).toBe(true); // Memorial Day
    expect(isClinicHoliday("2026-09-07")).toBe(true); // Labor Day
    expect(isClinicHoliday("2026-11-19")).toBe(false);
  });

  it("turns a week into shifts, skipping days off and holidays", () => {
    const p = emptyPattern(3); // Mon–Fri 9–5 at clinic 3
    p.fri = { work: true, start: "08:00", end: "12:00", clinicId: null }; // Friday mornings remote
    const s = shiftsFromPattern(p, "2026-11-23", "2026-11-29"); // Thanksgiving week
    expect(s.map((x) => x.date)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"]);
    expect(s[3]).toEqual({ date: "2026-11-27", startTime: "08:00", endTime: "12:00", clinicId: null });
  });

  it("reads someone's usual week back from their shifts and describes it", () => {
    const p = emptyPattern(3);
    p.wed = { ...p.wed, work: false };
    const back = patternFromShifts(shiftsFromPattern(p, "2026-10-05", "2026-11-01"));
    expect(back).toEqual(p);
    expect(describePattern(p, (id) => (id ? "Katy" : "Remote"))).toEqual(["Mon–Tue 9:00 AM–5:00 PM · Katy", "Wed off", "Thu–Fri 9:00 AM–5:00 PM · Katy", "Sat–Sun off"]);
  });

  it("checks the week before saving", () => {
    const p = emptyPattern(1);
    expect(patternProblem(p)).toBeNull();
    expect(patternProblem({ ...p, mon: { ...p.mon, end: "08:00" } })).toMatch(/end time/);
    const none = emptyPattern(1);
    for (const d of Object.keys(none) as (keyof typeof none)[]) none[d] = { ...none[d], work: false };
    expect(patternProblem(none)).toMatch(/at least one/);
  });

  it("staff set their own week; providers and admins don't", async () => {
    expect(canSelfSchedule("medical_assistant")).toBe(true);
    expect(canSelfSchedule("front_desk")).toBe(true);
    expect(canSelfSchedule("staff")).toBe(true);
    expect(canSelfSchedule("provider")).toBe(false);
    expect(canSelfSchedule("admin")).toBe(false);
    await expect(appRouter.createCaller(ctxFor("provider")).workforce.me.submitWeek({ pattern: emptyPattern(1), effectiveFrom: "2099-01-05" })).rejects.toThrow(/admin/);
    await expect(appRouter.createCaller(ctxFor("medical_assistant")).workforce.scheduleRequests.decide({ id: 1, approve: true })).rejects.toThrow();
  });
});

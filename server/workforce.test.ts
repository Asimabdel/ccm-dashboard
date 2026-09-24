import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import {
  addDays, fmtDuration, fmtTime, isValidDateStr, isValidTimeStr, localDateStr, localMinutes,
  periodKey, shiftMinutes, weekDates, weekStart, MA_ROLE_TEMPLATE,
} from "../shared/workforce";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function ctxFor(role: string): TrpcContext {
  const user = {
    id: 99, openId: "wf-test", email: "wf@example.com", name: "WF Test", loginMethod: "password",
    role: role as AuthenticatedUser["role"], createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  } as AuthenticatedUser;
  return { user, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("medical_assistant is fenced off from patient data", () => {
  const ma = () => appRouter.createCaller(ctxFor("medical_assistant"));

  it("blocks procedures that have their own role check", async () => {
    await expect(ma().patients.list({})).rejects.toThrow(/access/i);
    await expect(ma().worklist.forMonth({ month: "2026-09" })).rejects.toThrow(/access/i);
  });

  it("blocks procedures that have NO role check of their own", async () => {
    await expect(ma().patients.getById(1)).rejects.toThrow(/access/i);
    await expect(ma().worklist.getTask(1)).rejects.toThrow(/access/i);
    await expect(ma().ccmNotes.getByTaskId(1)).rejects.toThrow(/access/i);
    await expect(ma().clinics.list()).rejects.toThrow(/access/i);
  });

  it("still lets them read their own session", async () => {
    await expect(ma().auth.me()).resolves.toMatchObject({ role: "medical_assistant" });
  });
});

describe("workforce management is admin-only", () => {
  it.each(["staff", "provider", "billing", "front_desk", "medical_assistant"])("blocks %s from manager procedures", async (role) => {
    const caller = appRouter.createCaller(ctxFor(role));
    await expect(caller.workforce.roles.list()).rejects.toThrow(/access/i);
    await expect(caller.workforce.people.list()).rejects.toThrow(/access/i);
    await expect(caller.workforce.board()).rejects.toThrow(/access/i);
    await expect(caller.workforce.schedule.range({ from: "2026-09-21", to: "2026-09-27" })).rejects.toThrow(/access/i);
    await expect(caller.workforce.schedule.saveShift({ userId: 1, clinicId: 1, date: "2026-09-21", startTime: "08:00", endTime: "17:00" })).rejects.toThrow(/access/i);
    await expect(caller.workforce.timeOff.decide({ id: 1, status: "approved" })).rejects.toThrow(/access/i);
    await expect(caller.workforce.performance.scorecards({ from: "2026-09-01", to: "2026-09-21" })).rejects.toThrow(/access/i);
    await expect(caller.workforce.performance.addNote({ userId: 1, kind: "kudos", note: "x" })).rejects.toThrow(/access/i);
    await expect(caller.workforce.punches.edit({ id: 1, clockInAt: new Date(), clockOutAt: null })).rejects.toThrow(/access/i);
    await expect(caller.workforce.punches.add({ userId: 1, clockInAt: new Date(), clockOutAt: null })).rejects.toThrow(/access/i);
    await expect(caller.workforce.punches.delete(1)).rejects.toThrow(/access/i);
    await expect(caller.workforce.timesheet({ from: "2026-09-14", to: "2026-09-20" })).rejects.toThrow(/access/i);
    await expect(caller.workforce.people.saveProfile({ userId: 1, jobRoleId: null, homeClinicId: null, canFloat: false, usesTimeClock: true, active: true })).rejects.toThrow(/access/i);
  });

  it("rejects malformed dates and times before any DB work", async () => {
    const admin = appRouter.createCaller(ctxFor("admin"));
    await expect(admin.workforce.schedule.saveShift({ userId: 1, clinicId: 1, date: "09/21/2026", startTime: "08:00", endTime: "17:00" })).rejects.toThrow();
    await expect(admin.workforce.schedule.saveShift({ userId: 1, clinicId: 1, date: "2026-09-21", startTime: "8am", endTime: "17:00" })).rejects.toThrow();
  });

  it("rejects a time-off request that ends before it starts", async () => {
    const ma = appRouter.createCaller(ctxFor("medical_assistant"));
    await expect(ma.workforce.me.requestTimeOff({ startDate: "2026-10-10", endDate: "2026-10-08", type: "pto" })).rejects.toThrow(/end date/i);
  });
});

describe("team schedule", () => {
  it("is closed to accounts without an access role", async () => {
    const pending = appRouter.createCaller(ctxFor("user"));
    await expect(pending.workforce.team.week({ from: "2026-09-21", to: "2026-09-27" })).rejects.toThrow(/access/i);
  });

  it("rejects backwards or oversized ranges before any DB work", async () => {
    const ma = appRouter.createCaller(ctxFor("medical_assistant"));
    await expect(ma.workforce.team.week({ from: "2026-09-27", to: "2026-09-21" })).rejects.toThrow(/6 weeks/);
    await expect(ma.workforce.team.week({ from: "2026-01-01", to: "2026-06-01" })).rejects.toThrow(/6 weeks/);
  });
});

describe("clinic-local date math", () => {
  it("uses Houston time, not UTC, for the work date", () => {
    // 03:30 UTC on Sep 22 is still 10:30 PM on Sep 21 in Houston (CDT).
    const d = new Date("2026-09-22T03:30:00Z");
    expect(localDateStr(d)).toBe("2026-09-21");
    expect(localMinutes(d)).toBe(22 * 60 + 30);
    // Winter (CST, UTC-6)
    expect(localMinutes(new Date("2026-01-15T14:05:00Z"))).toBe(8 * 60 + 5);
  });

  it("finds Monday-based weeks", () => {
    expect(weekStart("2026-09-21")).toBe("2026-09-21"); // a Monday
    expect(weekStart("2026-09-27")).toBe("2026-09-21"); // Sunday belongs to the same week
    expect(weekDates("2026-09-23")).toEqual(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"]);
  });

  it("adds days across month ends and DST changes", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02"); // fall-back day
    expect(addDays("2026-03-08", -7)).toBe("2026-03-01"); // spring-forward day
  });

  it("buckets duty completions by frequency", () => {
    expect(periodKey("daily", "2026-09-23")).toBe("2026-09-23");
    expect(periodKey("weekly", "2026-09-23")).toBe("2026-09-21");
    expect(periodKey("monthly", "2026-09-23")).toBe("2026-09");
  });

  it("validates and formats", () => {
    expect(isValidDateStr("2026-09-21")).toBe(true);
    expect(isValidDateStr("2026-9-21")).toBe(false);
    expect(isValidTimeStr("08:00")).toBe(true);
    expect(isValidTimeStr("24:00")).toBe(false);
    expect(shiftMinutes("08:00", "17:00")).toBe(540);
    expect(shiftMinutes("17:00", "08:00")).toBe(0);
    expect(fmtTime("13:05")).toBe("1:05 PM");
    expect(fmtTime("00:00")).toBe("12:00 AM");
    expect(fmtDuration(135)).toBe("2h 15m");
  });

  it("ships a usable MA template", () => {
    expect(MA_ROLE_TEMPLATE.duties.length).toBeGreaterThan(10);
    expect(MA_ROLE_TEMPLATE.duties.some((d) => d.frequency === "daily")).toBe(true);
  });
});

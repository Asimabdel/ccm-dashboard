import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { clinicHhmm, clinicInstant, clockNudge, dayWork, perfectWeek, punchFixProblem, shortStaffName } from "../shared/attendance";

const at = (iso: string) => new Date(iso);

describe("lunch and breaks", () => {
  it("counts only time on the clock, and sees a lunch break", () => {
    const punches = [
      { clockInAt: at("2026-10-05T14:00:00Z"), clockOutAt: at("2026-10-05T17:00:00Z"), outReason: "lunch" }, // 9–12 CDT, then lunch
      { clockInAt: at("2026-10-05T17:30:00Z"), clockOutAt: at("2026-10-05T22:00:00Z"), outReason: null }, // 12:30–5
    ];
    const w = dayWork(punches, at("2026-10-05T23:00:00Z"));
    expect(w.workedMinutes).toBe(7 * 60 + 30);
    expect(w.tookBreak).toBe(true);
    expect(w.onLunchSince).toBe(null);
  });

  it("notices someone on lunch right now, and a day with no break", () => {
    const onLunch = dayWork([{ clockInAt: at("2026-10-05T14:00:00Z"), clockOutAt: at("2026-10-05T17:00:00Z"), outReason: "lunch" }]);
    expect(onLunch.onLunchSince?.toISOString()).toBe("2026-10-05T17:00:00.000Z");
    const straight = dayWork([{ clockInAt: at("2026-10-05T14:00:00Z"), clockOutAt: at("2026-10-05T22:00:00Z") }]);
    expect(straight.tookBreak).toBe(false);
    expect(straight.workedMinutes).toBe(480);
  });
});

describe("what the clock asks for", () => {
  const shift = { startTime: "09:00", endTime: "17:00" };
  it("reminds to clock in, then flags late", () => {
    expect(clockNudge({ shift, punches: [], nowMinutes: 8 * 60 + 50 })).toBe(null);
    expect(clockNudge({ shift, punches: [], nowMinutes: 8 * 60 + 56 })).toBe("clock_in");
    expect(clockNudge({ shift, punches: [], nowMinutes: 9 * 60 + 10 })).toBe("late");
    expect(clockNudge({ shift, punches: [], nowMinutes: 18 * 60 })).toBe(null);
  });

  it("reminds to clock out after the shift, and to come back from a long lunch", () => {
    const open = [{ clockInAt: at("2026-10-05T14:00:00Z"), clockOutAt: null }];
    expect(clockNudge({ shift, punches: open, nowMinutes: 16 * 60 })).toBe(null);
    expect(clockNudge({ shift, punches: open, nowMinutes: 17 * 60 + 20 })).toBe("clock_out");
    const lunch = [{ clockInAt: at("2026-10-05T14:00:00Z"), clockOutAt: at("2026-10-05T17:00:00Z"), outReason: "lunch" }];
    expect(clockNudge({ shift, punches: lunch, nowMinutes: 12 * 60 + 30, now: at("2026-10-05T17:30:00Z") })).toBe(null);
    expect(clockNudge({ shift, punches: lunch, nowMinutes: 13 * 60 + 5, now: at("2026-10-05T18:05:00Z") })).toBe("end_lunch");
  });
});

describe("clinic time", () => {
  it("turns a clinic date and time into the right instant, summer and winter", () => {
    expect(clinicInstant("2026-10-05", "09:00").toISOString()).toBe("2026-10-05T14:00:00.000Z"); // CDT
    expect(clinicInstant("2026-12-07", "09:00").toISOString()).toBe("2026-12-07T15:00:00.000Z"); // CST
    expect(clinicHhmm(at("2026-10-05T22:05:00Z"))).toBe("17:05");
  });
});

describe("attendance and requests", () => {
  it("perfect attendance means every shift on time and no forgotten clock-out", () => {
    const ok = { firstPunchLate: 0, missedClockOut: false };
    expect(perfectWeek([ok, ok, ok, ok, ok])).toBe(true);
    expect(perfectWeek([ok, ok])).toBe(false); // too few shifts to count
    expect(perfectWeek([ok, ok, { firstPunchLate: 7, missedClockOut: false }])).toBe(false);
    expect(perfectWeek([ok, ok, { firstPunchLate: null, missedClockOut: false }])).toBe(false); // a no-show
    expect(perfectWeek([ok, ok, { firstPunchLate: 0, missedClockOut: true }])).toBe(false);
    expect(shortStaffName("Andrea Espinosa")).toBe("Andrea E.");
    expect(shortStaffName("Rosa Diaz (MA)")).toBe("Rosa D.");
  });

  it("checks a fix-my-punch request", () => {
    const base = { workDate: "2026-10-02", today: "2026-10-04", clockIn: null, clockOut: "17:05", hasPunch: true, reason: "Forgot to clock out" };
    expect(punchFixProblem(base)).toBe(null);
    expect(punchFixProblem({ ...base, reason: " " })).toMatch(/what happened/);
    expect(punchFixProblem({ ...base, workDate: "2026-10-05" })).toMatch(/already happened/);
    expect(punchFixProblem({ ...base, hasPunch: false })).toMatch(/both times/);
    expect(punchFixProblem({ ...base, clockIn: "18:00" })).toMatch(/after clock-in/);
  });
});

describe("access", () => {
  const callerFor = (role: string) => appRouter.createCaller({
    user: { id: 93, openId: "att-test", email: "att@example.com", name: "Att Test", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as NonNullable<TrpcContext["user"]>,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext);
  it("only managers decide punch fixes", async () => {
    await expect(callerFor("medical_assistant").workforce.punchRequests.decide({ id: 1, approve: true })).rejects.toThrow(/access/);
    await expect(callerFor("front_desk").workforce.punchRequests.get(1)).rejects.toThrow(/access/);
  });
});

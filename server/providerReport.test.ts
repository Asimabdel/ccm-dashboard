import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { completeMonths, dayKind, presetRange, summarizeProvider, type ProviderDay } from "../shared/providerReport";

const day = (date: string, seen: number, extra: Partial<ProviderDay> = {}): ProviderDay =>
  ({ date, booked: seen, seen, noShow: 0, cancelled: 0, stillScheduled: 0, newPatients: 0, newCcm: 0, newRpm: 0, ...extra });

describe("which days count", () => {
  const today = "2026-10-07";
  it("3+ patients is a day worked; 1–2 is a light day (most likely off)", () => {
    expect(dayKind(day("2026-10-01", 3), today)).toBe("worked");
    expect(dayKind(day("2026-10-01", 2), today)).toBe("light");
    expect(dayKind(day("2026-10-01", 0), today)).toBe("off");
  });
  it("today, and past days whose statuses weren't imported, wait", () => {
    expect(dayKind(day("2026-10-07", 12), today)).toBe("pending");
    // Oct 2: 1 seen, 16 still "scheduled" (the schedule was imported Oct 1) — not a light day.
    expect(dayKind(day("2026-10-02", 1, { stillScheduled: 16 }), today)).toBe("pending");
    expect(dayKind(day("2026-10-02", 15, { stillScheduled: 2 }), today)).toBe("worked");
  });
  it("finds the complete months in a range", () => {
    expect(completeMonths("2026-07-01", "2026-10-06", "2026-10-07")).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(completeMonths("2026-07-15", "2026-09-30", "2026-10-07")).toEqual(["2026-08", "2026-09"]);
    expect(completeMonths("2026-09-08", "2026-10-06", "2026-10-07")).toEqual([]);
  });
  it("range presets end yesterday", () => {
    expect(presetRange("3m", "2026-10-07")).toEqual({ from: "2026-07-01", to: "2026-10-06" });
    expect(presetRange("6m", "2026-02-10")).toEqual({ from: "2025-08-01", to: "2026-02-09" });
    expect(presetRange("4w", "2026-10-07")).toEqual({ from: "2026-09-07", to: "2026-10-06" });
    expect(presetRange("ytd", "2026-10-07")).toEqual({ from: "2026-01-01", to: "2026-10-06" });
  });
});

describe("averages", () => {
  it("daily / weekly / monthly from days worked only", () => {
    const days = [
      // Week of Aug 31 (Mon) – 3 days worked + a light day.
      day("2026-08-31", 10), day("2026-09-01", 12), day("2026-09-02", 8), day("2026-09-03", 2),
      // Week of Sep 7 – 2 days worked.
      day("2026-09-08", 10, { noShow: 2, cancelled: 1, booked: 12, newPatients: 2, newCcm: 1 }), day("2026-09-09", 10),
      // Oct 2, statuses not imported yet.
      day("2026-10-02", 1, { stillScheduled: 15, booked: 16 }),
    ];
    const s = summarizeProvider(days, { from: "2026-08-01", to: "2026-10-06", today: "2026-10-07" });
    expect(s.daysWorked).toBe(5);
    expect(s.lightDays).toEqual([{ date: "2026-09-03", seen: 2 }]);
    expect(s.pendingDays).toBe(1);
    expect(s.dailyAvg).toBe(10); // 50 / 5
    expect(s.weeksWorked).toBe(2);
    expect(s.weeklyAvg).toBe(25); // 50 / 2
    expect(s.daysPerWeek).toBe(2.5);
    // Complete months worked: August (10) and September (40) → 25.
    expect(s.monthsCounted).toEqual(["2026-08", "2026-09"]);
    expect(s.monthlyAvg).toBe(25);
    expect(s.totalSeen).toBe(52); // light day counts in the total, not the averages
    expect(s.noShows).toBe(2);
    expect(s.noShowRate).toBe(3.7); // 2 / (52 + 2)
    expect(s.cancellations).toBe(1);
    expect(s.newPatients).toBe(2);
    expect(s.newPerWeek).toBe(1);
    expect(s.newCcm).toBe(1);
    expect(s.weekly).toEqual([{ week: "2026-08-31", seen: 32 }, { week: "2026-09-07", seen: 20 }]);
  });

  it("nothing worked: no averages", () => {
    const s = summarizeProvider([day("2026-09-03", 1)], { from: "2026-09-01", to: "2026-09-30", today: "2026-10-07" });
    expect([s.daysWorked, s.dailyAvg, s.weeklyAvg, s.monthlyAvg]).toEqual([0, null, null, null]);
  });
});

describe("access", () => {
  const callerFor = (role: string) => appRouter.createCaller({
    user: { id: 94, openId: "prov-report-test", email: "pr@example.com", name: "PR Test", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as NonNullable<TrpcContext["user"]>,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext);
  it("is for admins and office managers", async () => {
    await expect(callerFor("staff").workspace.providerReport.get({ from: "2026-09-01", to: "2026-09-30" })).rejects.toThrow();
    await expect(callerFor("medical_assistant").workspace.providerReport.get({ from: "2026-09-01", to: "2026-09-30" })).rejects.toThrow();
  });
});

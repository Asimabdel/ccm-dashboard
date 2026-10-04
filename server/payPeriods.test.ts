import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { DEFAULT_PAY_ANCHOR, isMonday, payPeriodOf, quickbooksSheet, recentPayPeriods, toCsv } from "../shared/payPeriods";

describe("pay periods (every 2 weeks from Mon Sep 28, 2026)", () => {
  it("finds the period a day is in, before and after the anchor", () => {
    expect(DEFAULT_PAY_ANCHOR).toBe("2026-09-28");
    expect(payPeriodOf("2026-09-28")).toEqual({ start: "2026-09-28", end: "2026-10-11" });
    expect(payPeriodOf("2026-10-11")).toEqual({ start: "2026-09-28", end: "2026-10-11" });
    expect(payPeriodOf("2026-10-12")).toEqual({ start: "2026-10-12", end: "2026-10-25" });
    expect(payPeriodOf("2026-09-27")).toEqual({ start: "2026-09-14", end: "2026-09-27" });
    // Across the November time change, still whole days.
    expect(payPeriodOf("2026-11-09")).toEqual({ start: "2026-11-09", end: "2026-11-22" });
  });

  it("lists the current period and the ones before it", () => {
    const list = recentPayPeriods("2026-10-04", DEFAULT_PAY_ANCHOR, 3);
    expect(list.map((p) => p.start)).toEqual(["2026-09-28", "2026-09-14", "2026-08-31"]);
  });

  it("only starts on a Monday", () => {
    expect(isMonday("2026-10-12")).toBe(true);
    expect(isMonday("2026-10-13")).toBe(false);
  });
});

describe("QuickBooks sheet", () => {
  it("gives regular and overtime hours per person, alphabetically, to 2 decimals", () => {
    const rows = quickbooksSheet({ start: "2026-09-28", end: "2026-10-11" }, [
      { name: "Walid Saleh", regularMinutes: 4800, overtimeMinutes: 95, totalMinutes: 4895, daysWorked: 10 },
      { name: "Andrea Espinosa", regularMinutes: 4530, overtimeMinutes: 0, totalMinutes: 4530, daysWorked: 10 },
    ]);
    expect(rows[0]).toEqual(["Employee", "Regular pay hours", "Overtime pay hours", "Total hours", "Days worked", "Pay period"]);
    expect(rows[1]).toEqual(["Andrea Espinosa", "75.50", "0.00", "75.50", "10", "2026-09-28 to 2026-10-11"]);
    expect(rows[2]).toEqual(["Walid Saleh", "80.00", "1.58", "81.58", "10", "2026-09-28 to 2026-10-11"]);
  });

  it("writes CSV that Excel opens (commas and quotes escaped)", () => {
    expect(toCsv([["a", "b,c"], ['say "hi"', "x"]])).toBe('a,"b,c"\r\n"say ""hi""",x');
  });
});

describe("access", () => {
  const callerFor = (role: string) => appRouter.createCaller({
    user: { id: 92, openId: "pay-test", email: "pay@example.com", name: "Pay Test", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as NonNullable<TrpcContext["user"]>,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext);
  it("keeps approvals with managers and closing periods with admins", async () => {
    await expect(callerFor("medical_assistant").workforce.shiftOffers.decide({ offerId: 1, approve: true })).rejects.toThrow(/access/);
    await expect(callerFor("front_desk").workforce.payPeriods.approve({ userId: 2, start: "2026-09-28" })).rejects.toThrow(/access/);
    await expect(callerFor("office_manager").workforce.payPeriods.setLocked({ start: "2026-09-28", locked: true })).rejects.toThrow(/access/);
    await expect(callerFor("office_manager").workforce.payPeriods.setAnchor({ anchor: "2026-10-05" })).rejects.toThrow(/access/);
  });
});

import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { DEFAULT_PAY_ANCHOR, isMonday, payPeriodOf, quickbooksSheet, recentPayPeriods, toCsv } from "../shared/payPeriods";

describe("pay periods (Oct 5–17, Oct 19–31, … 2026)", () => {
  it("runs Monday to the second Saturday, with that Sunday's hours counting in it", () => {
    expect(DEFAULT_PAY_ANCHOR).toBe("2026-10-05");
    expect(payPeriodOf("2026-10-05")).toEqual({ start: "2026-10-05", end: "2026-10-17", through: "2026-10-18" });
    expect(payPeriodOf("2026-10-17")).toEqual({ start: "2026-10-05", end: "2026-10-17", through: "2026-10-18" });
    expect(payPeriodOf("2026-10-18").start).toBe("2026-10-05");
    expect(payPeriodOf("2026-10-19")).toEqual({ start: "2026-10-19", end: "2026-10-31", through: "2026-11-01" });
    expect(payPeriodOf("2026-11-02")).toEqual({ start: "2026-11-02", end: "2026-11-14", through: "2026-11-15" });
    // Before the first one, and across the November time change, still whole days.
    expect(payPeriodOf("2026-10-04")).toEqual({ start: "2026-09-21", end: "2026-10-03", through: "2026-10-04" });
    expect(payPeriodOf("2026-11-16")).toEqual({ start: "2026-11-16", end: "2026-11-28", through: "2026-11-29" });
  });

  it("lists the current period and the ones before it", () => {
    const list = recentPayPeriods("2026-10-20", DEFAULT_PAY_ANCHOR, 3);
    expect(list.map((p) => `${p.start} to ${p.end}`)).toEqual(["2026-10-19 to 2026-10-31", "2026-10-05 to 2026-10-17", "2026-09-21 to 2026-10-03"]);
  });

  it("only starts on a Monday", () => {
    expect(isMonday("2026-10-12")).toBe(true);
    expect(isMonday("2026-10-13")).toBe(false);
  });
});

describe("QuickBooks sheet", () => {
  it("gives regular and overtime hours per person, alphabetically, to 2 decimals", () => {
    const rows = quickbooksSheet({ start: "2026-10-05", end: "2026-10-17" }, [
      { name: "Walid Saleh", regularMinutes: 4800, overtimeMinutes: 95, totalMinutes: 4895, daysWorked: 10 },
      { name: "Andrea Espinosa", regularMinutes: 4530, overtimeMinutes: 0, totalMinutes: 4530, daysWorked: 10 },
    ]);
    expect(rows[0]).toEqual(["Employee", "Regular pay hours", "Overtime pay hours", "Total hours", "Days worked", "Pay period"]);
    expect(rows[1]).toEqual(["Andrea Espinosa", "75.50", "0.00", "75.50", "10", "2026-10-05 to 2026-10-17"]);
    expect(rows[2]).toEqual(["Walid Saleh", "80.00", "1.58", "81.58", "10", "2026-10-05 to 2026-10-17"]);
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

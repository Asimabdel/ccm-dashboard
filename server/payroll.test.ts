// Payroll estimate (Master Billing): pay from time-clock hours and pay rates. Made-up rates and hours.
import { describe, expect, it } from "vitest";
import { estimatePay, rateLabel, rateOn, splitWeeks, type PayRateInput } from "../shared/payroll";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const days = (entries: [string, number][]) => new Map(entries.map(([d, h]) => [d, h * 60]));
const hourly = (dollars: number, startDate = "2026-10-01", overtime = true): PayRateInput => ({ payType: "hourly", amountCents: Math.round(dollars * 100), overtime, startDate });

describe("payroll estimate", () => {
  it("puts time past 40 hours in a Monday–Sunday week into overtime, on the days it happened", () => {
    // Mon Nov 2 – Fri Nov 6, 2026: 9 hours a day = 45 hours.
    const s = splitWeeks(days([["2026-11-02", 9], ["2026-11-03", 9], ["2026-11-04", 9], ["2026-11-05", 9], ["2026-11-06", 9]]));
    expect(s.get("2026-11-05")).toEqual({ regular: 540, overtime: 0 });
    expect(s.get("2026-11-06")).toEqual({ regular: 240, overtime: 300 });
  });

  it("prices regular and overtime hours (1.5×), and counts a month-crossing week's overtime in the month it was worked", () => {
    // Week of Mon Oct 26: 40 hours in October, then 5 hours on Sunday Nov 1 = overtime in November.
    const worked = days([["2026-10-26", 8], ["2026-10-27", 8], ["2026-10-28", 8], ["2026-10-29", 8], ["2026-10-30", 8], ["2026-11-01", 5], ["2026-11-02", 8]]);
    const nov = estimatePay({ from: "2026-11-01", to: "2026-11-30", dayMinutes: worked, rates: [hourly(20)], basis: "month" });
    expect(nov).toMatchObject({ regularMinutes: 480, overtimeMinutes: 300, regularCents: 16000, overtimeCents: 15000, totalCents: 31000 });
    const oct = estimatePay({ from: "2026-10-01", to: "2026-10-31", dayMinutes: worked, rates: [hourly(20)], basis: "month" });
    expect(oct).toMatchObject({ regularMinutes: 2400, overtimeMinutes: 0, totalCents: 80000 });
  });

  it("uses the rate in effect each day (a raise mid-month), and pays straight time when overtime is off", () => {
    const worked = days([["2026-11-13", 8], ["2026-11-16", 8]]);
    const raise = [hourly(20, "2026-10-01"), hourly(22, "2026-11-16")];
    expect(rateOn(raise, "2026-11-15")?.amountCents).toBe(2000);
    expect(estimatePay({ from: "2026-11-01", to: "2026-11-30", dayMinutes: worked, rates: raise, basis: "month" }).totalCents).toBe(8 * 2000 + 8 * 2200);
    const long = days([["2026-11-02", 10], ["2026-11-03", 10], ["2026-11-04", 10], ["2026-11-05", 10], ["2026-11-06", 5]]);
    expect(estimatePay({ from: "2026-11-01", to: "2026-11-30", dayMinutes: long, rates: [hourly(20, "2026-10-01", false)], basis: "month" })).toMatchObject({ overtimeMinutes: 300, overtimeCents: 0, totalCents: 45 * 2000 });
  });

  it("spreads a yearly salary over the month (1/12) or pay period (1/26), prorated from the start date", () => {
    const salary: PayRateInput = { payType: "salary", amountCents: 6_000_000, overtime: false, startDate: "2026-11-16" };
    expect(estimatePay({ from: "2026-12-01", to: "2026-12-31", dayMinutes: new Map(), rates: [salary], basis: "month" }).salaryCents).toBe(500_000);
    expect(estimatePay({ from: "2026-11-01", to: "2026-11-30", dayMinutes: new Map(), rates: [salary], basis: "month" }).salaryCents).toBe(250_000);
    expect(estimatePay({ from: "2026-11-30", to: "2026-12-13", dayMinutes: new Map(), rates: [salary], basis: "period" }).salaryCents).toBe(230_769);
  });

  it("flags hours worked before any pay rate starts", () => {
    const e = estimatePay({ from: "2026-11-01", to: "2026-11-30", dayMinutes: days([["2026-11-02", 8], ["2026-11-20", 8]]), rates: [hourly(20, "2026-11-15")], basis: "month" });
    expect(e).toMatchObject({ unpricedDays: 1, totalCents: 16000, regularMinutes: 960 });
    expect(rateLabel({ payType: "hourly", amountCents: 1850 })).toBe("$18.50/hr");
    expect(rateLabel({ payType: "salary", amountCents: 6_200_000 })).toBe("$62,000/yr");
  });

  it("pays a day rate for each day worked (a provider's schedule days, else time-clock days), from the rate's start", () => {
    const day: PayRateInput = { payType: "per_day", amountCents: 50_000, overtime: false, startDate: "2026-10-01" };
    // Made-up provider: 9 schedule days in the period (one day off), no time clock.
    const worked = new Set(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]);
    expect(estimatePay({ from: "2026-10-19", to: "2026-11-01", dayMinutes: new Map(), rates: [day], basis: "period", workedDays: worked }))
      .toMatchObject({ paidDays: 9, dayPayCents: 450_000, totalCents: 450_000, unpricedDays: 0 });
    // No schedule days given: days on the time clock count instead.
    expect(estimatePay({ from: "2026-11-01", to: "2026-11-30", dayMinutes: days([["2026-11-02", 8], ["2026-11-03", 4]]), rates: [day], basis: "month" }))
      .toMatchObject({ paidDays: 2, dayPayCents: 100_000, regularCents: 0 });
    // Days before the rate starts aren't paid, and are flagged.
    expect(estimatePay({ from: "2026-10-19", to: "2026-11-01", dayMinutes: new Map(), rates: [{ ...day, startDate: "2026-10-26" }], basis: "period", workedDays: worked }))
      .toMatchObject({ paidDays: 4, unpricedDays: 5 });
  });

  it("pays per CCM completed, on the days they were completed", () => {
    const ccm: PayRateInput = { payType: "per_ccm", amountCents: 1_000, overtime: false, startDate: "2026-10-07" };
    const calls = new Map([["2026-10-06", 3], ["2026-10-07", 5], ["2026-10-31", 4], ["2026-11-01", 6]]);
    expect(estimatePay({ from: "2026-10-01", to: "2026-10-31", dayMinutes: new Map(), rates: [ccm], basis: "month", ccmsPerDay: calls }))
      .toMatchObject({ ccms: 9, ccmPayCents: 9_000, totalCents: 9_000, unpricedDays: 1 });
    expect(rateLabel({ payType: "per_day", amountCents: 50_000 })).toBe("$500/day");
    expect(rateLabel({ payType: "per_ccm", amountCents: 1_000 })).toBe("$10/CCM");
    expect(rateLabel({ payType: "per_ccm", amountCents: 1_250 })).toBe("$12.50/CCM");
  });

  it("keeps pay rates to the owner (other admins and staff are refused before anything is read)", async () => {
    const ctxFor = (role: string, realRole?: string): TrpcContext => ({
      user: { id: 97, openId: "pay-test", email: "pay@example.com", name: "Pay Test", loginMethod: "manus", role, realRole, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as NonNullable<TrpcContext["user"]>,
      req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"],
    });
    for (const role of ["staff", "front_desk", "office_manager", "medical_assistant", "billing"]) {
      await expect(appRouter.createCaller(ctxFor(role)).masterBilling.payroll({ view: "month", month: "2026-11" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(appRouter.createCaller(ctxFor(role)).masterBilling.setPayRate({ userId: 1, payType: "hourly", amountCents: 2000, overtime: true, startDate: "2026-11-01" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(appRouter.createCaller(ctxFor("billing", "admin")).masterBilling.payRates({ userId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

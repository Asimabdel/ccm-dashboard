// Costs in Master Billing: monthly bills and money in vs. out. Made-up amounts.
import { describe, expect, it } from "vitest";
import { costInMonth, costsByMonth, moneyMonth, monthsBetween, nextMonth } from "../shared/costs";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

describe("monthly costs", () => {
  it("counts a cost from its first month through its last (or on, with no last month)", () => {
    const rent = { amountCents: 300_000, startMonth: "2026-10", endMonth: null };
    const old = { amountCents: 250_000, startMonth: "2026-01", endMonth: "2026-09" };
    expect([costInMonth(rent, "2026-09"), costInMonth(rent, "2026-10"), costInMonth(rent, "2027-03")]).toEqual([false, true, true]);
    expect([costInMonth(old, "2026-09"), costInMonth(old, "2026-10")]).toEqual([true, false]);
    const by = costsByMonth([rent, old, { amountCents: 50_000, startMonth: "2026-11", endMonth: "2026-11" }], ["2026-09", "2026-10", "2026-11", "2026-12"]);
    expect(Array.from(by.values())).toEqual([250_000, 300_000, 350_000, 300_000]);
  });

  it("walks months across a year end", () => {
    expect(nextMonth("2026-12")).toBe("2027-01");
    expect(monthsBetween("2026-10", "2027-02")).toEqual(["2026-10", "2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(monthsBetween("2026-11", "2026-10")).toEqual([]);
  });

  it("adds up money out and what's left", () => {
    expect(moneyMonth({ month: "2026-10", insuranceCents: 10_000_000, payrollCents: 6_000_000, costsCents: 1_180_000, zocdocCents: 900_000, inProgress: false }))
      .toMatchObject({ outCents: 8_080_000, leftCents: 1_920_000 });
    expect(moneyMonth({ month: "2026-11", insuranceCents: 100, payrollCents: 200, costsCents: 0, zocdocCents: 0, inProgress: true }).leftCents).toBe(-100);
  });

  it("keeps costs to the owner (other admins and staff are refused before anything is read)", async () => {
    const ctxFor = (role: string, realRole?: string): TrpcContext => ({
      user: { id: 98, openId: "cost-test", email: "cost@example.com", name: "Cost Test", loginMethod: "manus", role, realRole, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as NonNullable<TrpcContext["user"]>,
      req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"],
    });
    for (const role of ["staff", "front_desk", "office_manager", "medical_assistant", "billing"]) {
      await expect(appRouter.createCaller(ctxFor(role)).masterBilling.costsReport()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(appRouter.createCaller(ctxFor(role)).masterBilling.saveCost({ name: "Rent", category: "rent", clinicId: null, amountCents: 100, startMonth: "2026-11", endMonth: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(appRouter.createCaller(ctxFor("billing", "admin")).masterBilling.costsReport()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

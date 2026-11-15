// Costs in Master Billing: monthly bills and money in vs. out. Made-up amounts.
import { describe, expect, it } from "vitest";
import { costInMonth, costsByMonth, matchClinic, moneyMonth, monthsBetween, nextMonth, splitCents } from "../shared/costs";
import { payByClinic } from "./payrollDb";
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

  it("splits money by weight in whole cents that add back up", () => {
    const s = splitCents(1000, new Map([["a", 1], ["b", 1], ["c", 1]]), "none");
    expect(Array.from(s.values()).reduce((x, y) => x + y, 0)).toBe(1000);
    expect(Array.from(s.values()).sort()).toEqual([333, 333, 334]);
    expect(splitCents(500, new Map(), "none")).toEqual(new Map([["none", 500]]));
    expect(splitCents(0, new Map([["a", 1]]), "none").size).toBe(0);
  });

  it("matches ZocDoc location names to clinics by name or street, longest match first", () => {
    const clinics = [
      { id: 1, name: "Demo Clinic - Katy", address: "100 Provincial Blvd" },
      { id: 2, name: "Demo Clinic - Cypress", address: "7050 Lakeview Haven Ste 100" },
      { id: 3, name: "Demo Clinic - Westheimer", address: "12121 Richmond Ave, ste 216" },
      { id: 4, name: "Demo Clinic - Highland Knolls", address: "22214 Highland Knolls, Ste A, Katy, TX 77450" },
    ];
    expect(matchClinic("Demo Doctor - Katy", clinics)?.id).toBe(1);
    expect(matchClinic("Highland Knolls Office, Katy TX", clinics)?.id).toBe(4);
    expect(matchClinic("12121 Richmond Ave Suite 216, Houston", clinics)?.id).toBe(3);
    expect(matchClinic("Lakeview Haven", clinics)?.id).toBe(2);
    // ZocDoc's LocationAddress style: "<number> <street>, Ste <n>, <city>, TX, <zip>".
    expect(matchClinic("7050 Lakeview Haven Dr, Ste 100, Houston, TX, 77095", clinics)?.id).toBe(2);
    expect(matchClinic("100 Provincial Blvd, Katy, TX, 77450", clinics)?.id).toBe(1);
    expect(matchClinic("12121 Richmond Ave, Ste 216, Houston, TX, 77082", clinics)?.id).toBe(3);
    expect(matchClinic("Sugar Land", clinics)).toBeNull();
    expect(matchClinic(null, clinics)).toBeNull();
  });

  it("places pay by clinic: clock-ins, a provider's schedule days, each CCM patient's clinic, else home", () => {
    const none = { regularCents: 0, overtimeCents: 0, salaryCents: 0, dayPayCents: 0, ccmPayCents: 0 };
    // Hourly: 6 h at clinic 1, 2 h at clinic 2.
    const hourly = payByClinic({ pay: { ...none, regularCents: 16_000 }, from: "2026-10-01", to: "2026-10-31", homeClinicId: 1,
      punches: [{ workDate: "2026-10-05", minutes: 360, clinicId: 1 }, { workDate: "2026-10-06", minutes: 120, clinicId: 2 }, { workDate: "2026-09-30", minutes: 600, clinicId: 2 }] });
    expect(Object.fromEntries(hourly)).toEqual({ 1: 12_000, 2: 4_000 });
    // Salaried provider: 3 days at clinic 3, 1 at clinic 4.
    const days = new Set(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    const clinicOf = new Map([["2026-10-05", 3], ["2026-10-06", 3], ["2026-10-07", 3], ["2026-10-08", 4]]);
    expect(Object.fromEntries(payByClinic({ pay: { ...none, salaryCents: 2_500_000 }, from: "2026-10-01", to: "2026-10-31", homeClinicId: 1, punches: [], providerDays: { worked: days, clinicOf } })))
      .toEqual({ 3: 1_875_000, 4: 625_000 });
    // Salaried staff: home clinic. Per-CCM: each patient's clinic; no clinic falls back to home, then "not tied".
    expect(Object.fromEntries(payByClinic({ pay: { ...none, salaryCents: 500_000 }, from: "2026-10-01", to: "2026-10-31", homeClinicId: 4, punches: [] }))).toEqual({ 4: 500_000 });
    const calls = [{ day: "2026-10-02", clinicId: 1 }, { day: "2026-10-03", clinicId: 1 }, { day: "2026-10-04", clinicId: null }, { day: "2026-10-05", clinicId: 2 }];
    expect(Array.from(payByClinic({ pay: { ...none, ccmPayCents: 4_000 }, from: "2026-10-01", to: "2026-10-31", homeClinicId: null, punches: [], ccmCalls: calls }).entries()))
      .toEqual([[1, 2_000], [null, 1_000], [2, 1_000]]);
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

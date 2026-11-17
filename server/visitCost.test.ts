import { describe, expect, it } from "vitest";
import {
  coverageInfo, patientShares, payerFamily, personCost, personNote, planCopay, planDeductibleLikely, planKeys, planNote, planStat, sameMemberId, shortDay, usd, visitsOf,
  type CostLine, type PlanMember,
} from "../shared/visitCost";
import type { BillAdjustment } from "../shared/masterBilling";

// Made-up claims only.
const today = "2026-11-17";
const pr = (code: string, cents: number): BillAdjustment => ({ group: "PR", code, cents });
const co45 = (cents: number): BillAdjustment => ({ group: "CO", code: "45", cents });
let claim = 0;
/** One office visit line: allowed, what insurance paid, and the patient's part by reason. */
function line(date: string, o: { code?: string; payer?: string; allowed: number; paid: number; adj?: BillAdjustment[]; owes?: number; memberId?: string; claimId?: number }): CostLine {
  const adj = o.adj ?? [];
  const owes = o.owes ?? adj.filter((a) => a.group === "PR").reduce((s, a) => s + a.cents, 0);
  return { claimId: o.claimId ?? ++claim, date, code: o.code ?? "99214", payerName: o.payer ?? "BCBS OF TEXAS", filingIndicator: "BL", memberId: o.memberId ?? "ZGP123456789", allowedCents: o.allowed, paidCents: o.paid, patientOwesCents: owes, adjustments: [co45(5000), ...adj] };
}
const cost = (lines: CostLine[]) => personCost(visitsOf(lines), today);

describe("the patient's part of a line", () => {
  it("splits by reason: 1 deductible, 2 coinsurance, 3 copay", () => {
    expect(patientShares([pr("1", 5000), pr("2", 1000), pr("3", 2500), co45(4000)], 8500)).toEqual({ deductible: 5000, coinsurance: 1000, copay: 2500, other: 0 });
    expect(patientShares([pr("03", 2500)], 2500).copay).toBe(2500);
    expect(patientShares([pr("96", 3000)], 3000)).toEqual({ deductible: 0, coinsurance: 0, copay: 0, other: 3000 });
    expect(patientShares(null, 0)).toEqual({ deductible: 0, coinsurance: 0, copay: 0, other: 0 });
  });
  it("shrinks the parts when a second insurance paid some of it", () => {
    // Medicare left $20 coinsurance; Medicaid paid it all.
    expect(patientShares([pr("2", 2000)], 0)).toEqual({ deductible: 0, coinsurance: 0, copay: 0, other: 0 });
    // A supplement paid half.
    expect(patientShares([pr("1", 6000), pr("2", 2000)], 4000)).toEqual({ deductible: 3000, coinsurance: 1000, copay: 0, other: 0 });
  });
  it("does not count a write-off as the patient's", () => {
    expect(patientShares([co45(9000)], 0).other).toBe(0);
  });
});

describe("insurance names", () => {
  it("gives one name however a file writes the insurance", () => {
    expect(payerFamily("BCBS OF TEXAS")).toBe(payerFamily("Blue Cross Blue Shield of Texas"));
    expect(payerFamily("NOVITAS SOLUTIONS", "MB")).toBe("Original Medicare");
    expect(payerFamily("Medicare Part B")).toBe("Original Medicare");
    expect(payerFamily("AETNA MEDICARE")).toBe("Aetna Medicare Advantage");
    expect(payerFamily("Some Tiny Plan")).toBe("sometinyplan");
    expect(payerFamily(null)).toBe("");
  });
});

describe("past visits", () => {
  it("makes one visit per day and keeps that day's tests out of the visit's own numbers", () => {
    const v = visitsOf([
      line("2026-10-03", { allowed: 12800, paid: 10300, adj: [pr("3", 2500)], claimId: 900 }),
      line("2026-10-03", { code: "93923", allowed: 9000, paid: 7200, adj: [pr("2", 1800)], claimId: 900 }),
      line("2026-09-01", { allowed: 12800, paid: 10300, adj: [pr("3", 2500)] }),
    ]);
    expect(v.map((x) => x.date)).toEqual(["2026-10-03", "2026-09-01"]);
    expect(v[0]).toMatchObject({ kind: "office", code: "99214", allowedCents: 12800, paidCents: 10300, owesCents: 2500, copayCents: 2500, coinsuranceCents: 0, dayOwesCents: 4300 });
  });
  it("leaves out days insurance allowed nothing for, and lines with no date", () => {
    expect(visitsOf([line("2026-10-03", { allowed: 0, paid: 0 }), { ...line("2026-10-04", { allowed: 9000, paid: 9000 }), date: null }])).toEqual([]);
  });
  it("tells an office visit from a wellness visit and from other billing", () => {
    const v = visitsOf([line("2026-05-01", { code: "G0439", allowed: 13000, paid: 13000 }), line("2026-06-01", { code: "99490", allowed: 6000, paid: 4800, adj: [pr("2", 1200)] })]);
    expect(v.map((x) => x.kind)).toEqual(["other", "wellness"]);
    expect(cost([line("2026-05-01", { code: "G0439", allowed: 13000, paid: 13000 })])).toBeNull();
  });
});

describe("a patient's own copay", () => {
  it("is the amount insurance applied on their office visits", () => {
    const pc = cost([
      line("2026-10-03", { allowed: 12800, paid: 10300, adj: [pr("3", 2500)] }),
      line("2026-07-10", { allowed: 12800, paid: 10300, adj: [pr("3", 2500)] }),
      line("2026-03-02", { code: "99213", allowed: 9200, paid: 6700, adj: [pr("3", 2500)] }),
    ])!;
    expect(pc.copay).toMatchObject({ cents: 2500, seenOn: 3, outOf: 3, lastDate: "2026-10-03", latestCents: 2500, fromLastYear: false });
    expect(pc.deductible.state).toBe("none");
    const note = personNote(pc)!;
    expect(note).toMatchObject({ kind: "copay", label: "Copay $25", cents: 2500, basis: "own" });
    expect(note.detail).toContain("on all of their last 3 visits");
  });
  it("says when the latest copay differs from the usual one", () => {
    const pc = cost([
      line("2026-10-03", { allowed: 12800, paid: 8800, adj: [pr("3", 4000)] }),
      line("2026-07-10", { allowed: 12800, paid: 10300, adj: [pr("3", 2500)] }),
      line("2026-03-02", { allowed: 12800, paid: 10300, adj: [pr("3", 2500)] }),
    ])!;
    expect(pc.copay).toMatchObject({ cents: 2500, latestCents: 4000 });
    expect(personNote(pc)!.detail).toContain("most recent copay was $40");
  });
  it("uses last year's when there is no visit yet this year, and says so", () => {
    const pc = personCost(visitsOf([line("2026-11-03", { allowed: 12800, paid: 10300, adj: [pr("3", 2500)] })]), "2027-01-12")!;
    expect(pc.copay?.fromLastYear).toBe(true);
    const note = personNote(pc)!;
    expect(note.label).toBe("Copay $25 (from 2026)");
    expect(note.detail).toContain("plans can change in January");
  });
  it("ignores visits on an earlier insurance, and visits too old to trust", () => {
    const pc = cost([
      line("2026-09-03", { payer: "AETNA", allowed: 12000, paid: 9000, adj: [pr("3", 3000)], memberId: "W99887766" }),
      line("2026-02-03", { allowed: 12800, paid: 10300, adj: [pr("3", 2500)] }),
    ])!;
    expect(pc.copay?.cents).toBe(3000);
    expect(pc.lookedAt).toBe(1);
    expect(cost([line("2024-12-30", { allowed: 12800, paid: 10300, adj: [pr("3", 2500)] })])).toBeNull();
  });
  it("says so when insurance left nothing to pay", () => {
    const pc = cost([line("2026-10-03", { allowed: 12800, paid: 12800 }), line("2026-08-03", { allowed: 12800, paid: 12800 })])!;
    expect(pc.nothingOwed).toBe(true);
    expect(personNote(pc)).toMatchObject({ kind: "nothing", label: "No copay on past visits", cents: 0 });
  });
  it("counts a patient as owing nothing when a second insurance paid their part", () => {
    const pc = cost([line("2026-10-03", { payer: "NOVITAS SOLUTIONS", allowed: 13000, paid: 10400, adj: [pr("2", 2600)], owes: 0 })])!;
    expect(pc.nothingOwed).toBe(true);
    expect(pc.coinsurancePct).toBeNull();
  });
});

describe("a patient's own deductible", () => {
  it("applies when insurance paid nothing for the latest visit", () => {
    const pc = cost([
      line("2026-10-03", { allowed: 12800, paid: 0, adj: [pr("1", 12800)] }),
      line("2026-06-10", { allowed: 12800, paid: 0, adj: [pr("1", 12800)] }),
    ])!;
    expect(pc.deductible).toMatchObject({ state: "applies", visitsThisYear: 2, centsThisYear: 25600, lastDate: "2026-10-03", lastOwedCents: 12800 });
    const note = personNote(pc)!;
    expect(note).toMatchObject({ kind: "deductible", label: "Deductible not met: about $128", cents: 12800 });
    expect(note.detail).toContain("on 2 visits this year");
  });
  it("looks met once insurance starts paying", () => {
    // The deductible ran out on the latest visit: insurance paid part of it.
    const ranOut = cost([
      line("2026-10-03", { allowed: 12800, paid: 6240, adj: [pr("1", 5000), pr("2", 1560)] }),
      line("2026-06-10", { allowed: 12800, paid: 0, adj: [pr("1", 12800)] }),
    ])!;
    expect(ranOut.deductible.state).toBe("met");
    expect(ranOut.coinsurancePct).toBe(20);
    // Applied earlier in the year, not on the latest visit.
    const later = cost([
      line("2026-10-03", { allowed: 12800, paid: 10240, adj: [pr("2", 2560)] }),
      line("2026-02-10", { allowed: 12800, paid: 0, adj: [pr("1", 12800)] }),
    ])!;
    expect(later.deductible.state).toBe("met");
    const note = personNote(later)!;
    expect(note.kind).toBe("coinsurance");
    // The amount is what the percentage comes to after the deductible, not a mix with the deductible visit.
    expect(note.label).toBe("Coinsurance 20%: about $25.60");
    expect(personNote(ranOut)!.label).toBe("Coinsurance 20%: about $25.60");
    expect(note.detail).toContain("looks met for 2026");
  });
  it("starts over in January", () => {
    const pc = personCost(visitsOf([
      line("2026-10-03", { allowed: 12800, paid: 0, adj: [pr("1", 12800)] }),
      line("2026-06-10", { allowed: 12800, paid: 0, adj: [pr("1", 12800)] }),
    ]), "2027-01-20")!;
    expect(pc.deductible).toMatchObject({ state: "reset", visitsThisYear: 0, visitsLastYear: 2 });
    const note = personNote(pc)!;
    expect(note.label).toBe("Deductible applied in 2026");
    expect(note.detail).toContain("starts over each January");
  });
  it("shows a copay together with a deductible", () => {
    const pc = cost([line("2026-10-03", { allowed: 12800, paid: 0, adj: [pr("3", 3000), pr("1", 9800)] })])!;
    expect(personNote(pc)).toMatchObject({ kind: "deductible", label: "Copay $30 + deductible", cents: 12800 });
  });
});

describe("other patients on the same plan", () => {
  const m = (copayCents: number | null, extra: Partial<PlanMember> = {}): PlanMember => ({ copayCents, nothingOwed: false, deductible: false, ...extra });
  it("shows a copay only when enough patients agree", () => {
    expect(planCopay(planStat("group", [m(2500), m(2500)]))).toEqual({ cents: 2500, patients: 2, of: 2 });
    expect(planCopay(planStat("group", [m(2500)]))).toBeNull();
    expect(planCopay(planStat("group", [m(2500), m(4000)]))).toBeNull();
    expect(planCopay(planStat("plan", [m(2500), m(2500)]))).toBeNull();
    expect(planCopay(planStat("plan", [m(2500), m(2500), m(2500), m(4000)]))).toEqual({ cents: 2500, patients: 3, of: 4 });
    // The same insurance alone: copays differ by plan, so nearly everyone must agree.
    expect(planCopay(planStat("payer", [...Array(8).fill(m(2500)), m(4000), m(0)]))).toBeNull();
    expect(planCopay(planStat("payer", Array(12).fill(m(null, { nothingOwed: true }))))).toEqual({ cents: 0, patients: 12, of: 12 });
  });
  it("writes the note for a patient with no visits yet", () => {
    expect(planNote(planStat("group", [m(2500), m(2500), m(2500)]), null)).toMatchObject({ kind: "copay", label: "Copay $25 (same plan)", cents: 2500, basis: "plan" });
    expect(planNote(planStat("payer", Array(12).fill(m(null, { nothingOwed: true }))), null)).toMatchObject({ kind: "nothing", label: "Usually no copay (same insurance)" });
    const hd = planStat("group", [m(null, { deductible: true }), m(null, { deductible: true }), m(2500)]);
    expect(planDeductibleLikely(hd)).toBe(true);
    expect(planNote(hd, 16500)).toMatchObject({ kind: "deductible", label: "Likely deductible plan: about $165", cents: 16500 });
    expect(planNote(planStat("payer", [m(2500), m(4000), m(0)]), 16500)).toBeNull();
    expect(planNote(null, null)).toBeNull();
  });
  it("never calls a whole insurance a deductible plan", () => {
    expect(planDeductibleLikely(planStat("payer", Array(20).fill(m(null, { deductible: true }))))).toBe(false);
  });
});

describe("insurance on file", () => {
  it("reads the group number and plan name from a Practice Fusion insurance record", () => {
    const c = coverageInfo({
      resourceType: "Coverage", status: "active", subscriberId: "ZGP123456789", order: 1, payor: [{ display: "Blue Cross Blue Shield of Texas" }], period: { start: "2026-01-01" },
      class: [{ type: { coding: [{ code: "group" }] }, value: "174589", name: "Acme Tools" }, { type: { coding: [{ code: "plan" }] }, value: "P1", name: "Blue Choice PPO" }],
    }, today);
    expect(c).toEqual({ payer: "Blue Cross Blue Shield of Texas", memberId: "ZGP123456789", group: "174589", plan: "Blue Choice PPO", active: true, start: "2026-01-01", order: 1 });
    expect(coverageInfo({ status: "active", period: { end: "2026-06-30" } }, today).active).toBe(false);
    expect(coverageInfo({ status: "cancelled" }, today).active).toBe(false);
    expect(coverageInfo(null, today)).toMatchObject({ payer: null, group: null, plan: null });
  });
  it("recognizes a plan by group number, then plan name, then insurance", () => {
    const bcbs = payerFamily("BCBS OF TEXAS");
    expect(planKeys(bcbs, "174-589", "Blue Choice PPO").map((k) => k.tier)).toEqual(["group", "plan", "payer"]);
    expect(planKeys(bcbs, "174-589", null)[0]!.key).toBe("g|174589");
    // A short group number only means something within one insurance; junk is not a group number.
    expect(planKeys(bcbs, "001A", null)[0]!.key).toBe(`g|${bcbs}|001A`);
    expect(planKeys(bcbs, "N/A", "PPO").map((k) => k.tier)).toEqual(["payer"]);
    expect(planKeys(bcbs, "0000", "Blue Cross Blue Shield of Texas").map((k) => k.tier)).toEqual(["payer"]);
    expect(planKeys("", "174589", "x")).toEqual([]);
  });
  it("matches a member ID written with or without its prefix", () => {
    expect(sameMemberId("ZGP123456789", "zgp-123456789")).toBe(true);
    expect(sameMemberId("ZGP123456789", "123456789")).toBe(true);
    expect(sameMemberId("123456789", "123456780")).toBe(false);
    expect(sameMemberId("1234", "1234")).toBe(false);
    expect(sameMemberId(null, "ZGP123456789")).toBe(false);
  });
});

describe("how amounts and dates read", () => {
  it("formats them the short way", () => {
    expect(usd(2500)).toBe("$25");
    expect(usd(11840)).toBe("$118.40");
    expect(usd(125000)).toBe("$1,250");
    expect(shortDay("2026-10-03")).toBe("10/3/26");
    expect(shortDay(null)).toBe("");
  });
});

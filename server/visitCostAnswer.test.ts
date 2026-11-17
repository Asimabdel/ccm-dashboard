import { describe, expect, it } from "vitest";
import { personCost, planNote, planStat, visitsOf, type CostLine } from "../shared/visitCost";
import { visitAnswer, visitKindOf, type AnswerInput } from "../shared/visitCostAnswer";
import type { BillAdjustment } from "../shared/masterBilling";

// Made-up claims only.
const today = "2026-11-17";
const pr = (code: string, cents: number): BillAdjustment => ({ group: "PR", code, cents });
let claim = 0;
function line(date: string, o: { code?: string; payer?: string; allowed: number; paid: number; adj?: BillAdjustment[]; owes?: number }): CostLine {
  const adj = o.adj ?? [];
  const owes = o.owes ?? adj.reduce((s, a) => s + a.cents, 0);
  return { claimId: ++claim, date, code: o.code ?? "99214", payerName: o.payer ?? "BCBS OF TEXAS", filingIndicator: "BL", memberId: "ZGP123456789", allowedCents: o.allowed, paidCents: o.paid, patientOwesCents: owes, adjustments: [{ group: "CO", code: "45", cents: 5000 }, ...adj] };
}
const pcOf = (lines: CostLine[], on = today) => personCost(visitsOf(lines), on);
const copay25 = (date: string) => line(date, { allowed: 12800, paid: 10300, adj: [pr("3", 2500)] });
const input = (o: Partial<AnswerInput>): AnswerInput => ({
  today, pc: null, planNote: null, insurance: null, insuranceFrom: null, visit: { date: today, type: "Follow Up", reason: null }, seenBefore: true, newVisitCents: null, lastWellness: null, ...o,
});

describe("the booked visit's type", () => {
  it("reads it from the schedule's words", () => {
    expect(visitKindOf("Annual Wellness")).toBe("wellness");
    expect(visitKindOf("Medicare AWV")).toBe("wellness");
    expect(visitKindOf("Physical", null)).toBe("wellness");
    expect(visitKindOf("New Patient")).toBe("new");
    expect(visitKindOf("NP visit")).toBe("new");
    expect(visitKindOf("Follow Up", "Lab results")).toBe("followup");
    expect(visitKindOf(null)).toBe("followup");
  });
});

describe("what the patient pays today", () => {
  it("a steady copay: collect it, and say so in both languages", () => {
    const pc = pcOf([copay25("2026-10-03"), copay25("2026-07-10"), copay25("2026-03-02")]);
    const a = visitAnswer(input({ pc, insurance: "BCBS OF TEXAS", insuranceFrom: "claim" }));
    expect(a).toMatchObject({ kind: "collect", cents: 2500, approx: false, sure: "sure", headline: "Collect $25" });
    expect(a.say.en).toBe("Your copay for today's visit is $25.");
    expect(a.say.es).toBe("Su copago para la visita de hoy es de $25.");
  });
  it("a copay seen on only one visit is a best guess", () => {
    const a = visitAnswer(input({ pc: pcOf([copay25("2026-10-03")]) }));
    expect(a).toMatchObject({ headline: "Collect $25", sure: "guess" });
  });
  it("a deductible not met: about the whole visit", () => {
    const pc = pcOf([line("2026-10-03", { allowed: 12800, paid: 0, adj: [pr("1", 12800)] }), line("2026-06-10", { allowed: 12800, paid: 0, adj: [pr("1", 12800)] })]);
    const a = visitAnswer(input({ pc }));
    expect(a).toMatchObject({ kind: "collect", cents: 12800, approx: true, sure: "likely", headline: "Collect about $128" });
    expect(a.say.en).toContain("deductible hasn't been met");
    expect(a.say.en).toContain("estimate");
    // A new-patient visit costs more while the deductible applies.
    expect(visitAnswer(input({ pc, newVisitCents: 16500, visit: { date: today, type: "New Patient", reason: null } }))).toMatchObject({ cents: 16500, headline: "Collect about $165" });
  });
  it("a deductible from last year starts over in January", () => {
    const pc = pcOf([line("2026-10-03", { allowed: 12800, paid: 0, adj: [pr("1", 12800)] })], "2027-01-12");
    const a = visitAnswer(input({ today: "2027-01-12", pc, visit: { date: "2027-01-12", type: "Follow Up", reason: null } }));
    expect(a).toMatchObject({ kind: "collect", cents: 12800, sure: "guess" });
    expect(a.say.es).toContain("se reinició en enero");
  });
  it("coinsurance once the deductible is met", () => {
    const pc = pcOf([line("2026-10-03", { allowed: 12800, paid: 10240, adj: [pr("2", 2560)] }), line("2026-02-10", { allowed: 12800, paid: 0, adj: [pr("1", 12800)] })]);
    expect(visitAnswer(input({ pc }))).toMatchObject({ kind: "collect", cents: 2560, approx: true, headline: "Collect about $25.60" });
  });
  it("nothing to pay when insurance covered every visit", () => {
    const pc = pcOf([line("2026-10-03", { payer: "AETNA MEDICARE", allowed: 12000, paid: 12000 }), line("2026-08-03", { payer: "AETNA MEDICARE", allowed: 12000, paid: 12000 }), line("2026-05-03", { payer: "AETNA MEDICARE", allowed: 12000, paid: 12000 })]);
    expect(visitAnswer(input({ pc }))).toMatchObject({ kind: "nothing", cents: 0, sure: "sure", headline: "Nothing to collect" });
  });
});

describe("wellness visits", () => {
  const wellness = { date: today, type: "Annual Wellness", reason: null };
  it("are usually covered in full, with the copay as a warning", () => {
    const pc = pcOf([copay25("2026-10-03"), copay25("2026-07-10")]);
    const a = visitAnswer(input({ pc, visit: wellness }));
    expect(a).toMatchObject({ kind: "nothing", cents: 0, headline: "Likely nothing to collect", visitKind: "wellness" });
    expect(a.why.join(" ")).toContain("$25 copay can apply");
    expect(a.say.es).toContain("visita anual de bienestar");
  });
  it("use their own last wellness visit when it left them something", () => {
    const a = visitAnswer(input({ pc: pcOf([copay25("2026-10-03")]), visit: wellness, lastWellness: { date: "2025-11-20", owesCents: 4000 } }));
    expect(a).toMatchObject({ kind: "collect", cents: 4000, approx: true, headline: "Collect about $40" });
  });
});

describe("plans we don't take, and no insurance", () => {
  it("Humana: the self-pay price, follow-up or first visit", () => {
    const pc = pcOf([line("2026-09-03", { payer: "HUMANA GOLD PLUS", allowed: 11000, paid: 11000 })]);
    const a = visitAnswer(input({ pc, insurance: "HUMANA GOLD PLUS", insuranceFrom: "claim" }));
    expect(a).toMatchObject({ kind: "selfpay", cents: 9900, headline: "Self-pay $99" });
    expect(a.say.en).toContain("not able to bill Humana");
    expect(a.say.es).toContain("No podemos facturarle a Humana");
    expect(visitAnswer(input({ insurance: "Humana", insuranceFrom: "chart", seenBefore: false, visit: { date: today, type: "New Patient", reason: null } }))).toMatchObject({ cents: 12000, headline: "Self-pay $120" });
  });
  it("Medicaid / CHIP plans", () => {
    const a = visitAnswer(input({ insurance: "Texas Medicaid STAR", insuranceFrom: "roster" }));
    expect(a).toMatchObject({ kind: "selfpay", headline: "Self-pay $99" });
    expect(a.say.en).toContain("Medicaid or CHIP");
  });
  it("Medicare with Medicaid behind it is Medicare first, which we take", () => {
    expect(visitAnswer(input({ insurance: "Medicare + Medicaid", insuranceFrom: "roster" })).kind).toBe("unknown");
    expect(visitAnswer(input({ insurance: "Humana Medicare", insuranceFrom: "chart" })).kind).toBe("selfpay");
  });
  it("a record that says self-pay", () => {
    expect(visitAnswer(input({ insurance: "Self Pay", insuranceFrom: "roster", seenBefore: false }))).toMatchObject({ kind: "selfpay", cents: 12000 });
  });
});

describe("little or nothing to go on", () => {
  it("goes by other patients on the same plan", () => {
    const stat = planStat("group", [{ copayCents: 2500, nothingOwed: false, deductible: false }, { copayCents: 2500, nothingOwed: false, deductible: false }, { copayCents: 2500, nothingOwed: false, deductible: false }]);
    const a = visitAnswer(input({ planNote: planNote(stat, null), insurance: "Blue Cross Blue Shield of Texas", insuranceFrom: "chart", seenBefore: false }));
    expect(a).toMatchObject({ kind: "collect", cents: 2500, sure: "guess", headline: "Collect $25" });
    expect(a.say.en).toContain("likely $25");
  });
  it("says to check the card, with the self-pay prices", () => {
    const a = visitAnswer(input({ insurance: "UNITEDHEALTHCARE", insuranceFrom: "chart", seenBefore: false }));
    expect(a).toMatchObject({ kind: "unknown", cents: null, sure: null, headline: "Not sure: check their card" });
    expect(a.why.join(" ")).toContain("$120 first visit, $99 follow-up");
    expect(a.say.en).toContain("insurance card");
    expect(visitAnswer(input({}))).toMatchObject({ kind: "unknown" });
  });
});

import { describe, expect, it } from "vitest";
import { parseCardReading } from "../shared/insuranceCard";
import { personCost, visitsOf, type CostLine } from "../shared/visitCost";
import { visitAnswer, type AnswerInput, type CardInput } from "../shared/visitCostAnswer";

// Made-up cards and claims only.
describe("reading an insurance card", () => {
  it("keeps what is printed", () => {
    const c = parseCardReading(`Here you go: {"isInsuranceCard": true, "payer": "Blue Cross Blue Shield of Texas", "planName": "Blue Choice PPO", "planType": "commercial",
      "memberId": "ZGP123456789", "groupNumber": "174589", "copays": {"pcp": "$25", "specialist": 50, "urgentCare": "75.00", "er": 250}, "deductible": null, "coinsurancePercent": "20%", "highDeductible": false}`);
    expect(c).toMatchObject({ isCard: true, payer: "Blue Cross Blue Shield of Texas", planName: "Blue Choice PPO", planType: "commercial", groupNumber: "174589", pcpCopayCents: 2500, specialistCopayCents: 5000, urgentCareCopayCents: 7500, erCopayCents: 25000, coinsurancePct: 20, highDeductible: false });
  });
  it("drops anything that isn't a plain amount, and silly amounts", () => {
    const c = parseCardReading(JSON.stringify({ isInsuranceCard: true, payer: "Aetna", copays: { pcp: "see plan", specialist: "-5", er: 999999 }, deductible: "N/A", coinsurancePercent: 150 }));
    expect(c).toMatchObject({ pcpCopayCents: null, specialistCopayCents: null, erCopayCents: null, deductibleCents: null, coinsurancePct: null });
  });
  it("spots HSA / high-deductible / Bronze plans", () => {
    expect(parseCardReading(JSON.stringify({ isInsuranceCard: true, payer: "Ambetter", planName: "Essential Care Bronze", copays: {} })).highDeductible).toBe(true);
    expect(parseCardReading(JSON.stringify({ isInsuranceCard: true, payer: "Aetna", planName: "Choice POS II HSA", copays: {} })).highDeductible).toBe(true);
  });
  it("never keeps copays on an Original Medicare card", () => {
    expect(parseCardReading(JSON.stringify({ isInsuranceCard: true, payer: "Medicare", planType: "original_medicare", copays: { pcp: 20 } })).pcpCopayCents).toBeNull();
  });
  it("is nothing when the photo isn't a card, or the answer isn't JSON", () => {
    expect(parseCardReading(JSON.stringify({ isInsuranceCard: false, payer: "Texas DL" })).isCard).toBe(false);
    expect(parseCardReading("I can't read this image.").isCard).toBe(false);
    expect(parseCardReading("{not json").isCard).toBe(false);
  });
});

const today = "2026-11-17";
const card = (o: Partial<CardInput>): CardInput => ({ payer: "Blue Cross Blue Shield of Texas", planName: "Blue Choice PPO", planType: "commercial", pcpCopayCents: 2500, highDeductible: false, photoDate: "2026-11-10", ...o });
const input = (o: Partial<AnswerInput>): AnswerInput => ({
  today, pc: null, planNote: null, insurance: null, insuranceFrom: null, visit: { date: today, type: "New Patient", reason: null }, seenBefore: false, newVisitCents: 16500, followUpVisitCents: 12800, lastWellness: null, ...o,
});
let claim = 0;
const copayVisit = (date: string, payer = "BCBS OF TEXAS", copay = 2500): CostLine => ({ claimId: ++claim, date, code: "99214", payerName: payer, filingIndicator: "BL", memberId: "ZGP123456789", allowedCents: 12800, paidCents: 12800 - copay, patientOwesCents: copay, adjustments: [{ group: "PR", code: "3", cents: copay }] });

describe("new patients: the card, then the owner's plan table", () => {
  it("uses the copay printed on their card", () => {
    const a = visitAnswer(input({ card: card({}), insurance: "Blue Cross Blue Shield of Texas", insuranceFrom: "card" }));
    expect(a).toMatchObject({ kind: "collect", cents: 2500, from: "card", sure: "likely", headline: "Collect $25" });
    expect(a.why[0]).toContain("Printed on their insurance card (photo from 11/10/26)");
  });
  it("says when the owner's table disagrees with the card", () => {
    const a = visitAnswer(input({ card: card({}), ownerPlan: { answer: "copay", copayCents: 4000, coinsurancePct: null, label: "Blue Choice PPO (BCBS)" } }));
    expect(a.cents).toBe(2500);
    expect(a.why.join(" ")).toContain("table says $40");
  });
  it("a high-deductible card: about the full visit", () => {
    const a = visitAnswer(input({ card: card({ planName: "Blue Saver HSA", highDeductible: true, pcpCopayCents: null }) }));
    expect(a).toMatchObject({ kind: "collect", cents: 16500, approx: true, from: "card", headline: "Collect about $165" });
  });
  it("no copay on the card: the owner's table answers", () => {
    const blank = card({ pcpCopayCents: null });
    expect(visitAnswer(input({ card: blank, ownerPlan: { answer: "copay", copayCents: 3000, coinsurancePct: null, label: "Plan X" } }))).toMatchObject({ cents: 3000, from: "table", headline: "Collect $30" });
    expect(visitAnswer(input({ card: blank, ownerPlan: { answer: "deductible", copayCents: null, coinsurancePct: null, label: "Plan X" } }))).toMatchObject({ cents: 16500, from: "table", headline: "Collect about $165" });
    expect(visitAnswer(input({ card: blank, ownerPlan: { answer: "nothing", copayCents: null, coinsurancePct: null, label: "Plan X" } }))).toMatchObject({ kind: "nothing", cents: 0, from: "table" });
    expect(visitAnswer(input({ card: blank, ownerPlan: { answer: "coinsurance", copayCents: null, coinsurancePct: 20, label: "Plan X" } }))).toMatchObject({ cents: 3300, from: "table", headline: "Collect about $33" });
    // No card at all: still the table.
    expect(visitAnswer(input({ ownerPlan: { answer: "copay", copayCents: 3000, coinsurancePct: null, label: "Plan X" } }))).toMatchObject({ cents: 3000, from: "table" });
  });
  it("Original Medicare: ask about a supplement", () => {
    const a = visitAnswer(input({ card: card({ payer: "Medicare", planName: null, planType: "original_medicare", pcpCopayCents: null }), insurance: "Medicare", insuranceFrom: "card" }));
    expect(a).toMatchObject({ kind: "unknown", headline: "Original Medicare: ask about a supplement" });
    expect(a.say.es).toContain("suplementario");
  });
  it("a card with nothing useful says so", () => {
    expect(visitAnswer(input({ card: card({ pcpCopayCents: null }) })).why[0]).toContain("doesn't show an office visit copay");
  });
  it("a Humana card is self-pay, even with old visits on another plan", () => {
    const pc = personCost(visitsOf([copayVisit("2026-06-01"), copayVisit("2026-03-01")]), today);
    const a = visitAnswer(input({ pc, seenBefore: true, visit: { date: today, type: "Follow Up", reason: null }, card: card({ payer: "Humana", planName: "Gold Plus HMO", pcpCopayCents: 0 }), insurance: "Humana", insuranceFrom: "card" }));
    expect(a).toMatchObject({ kind: "selfpay", headline: "Self-pay $99" });
    expect(a.why[0]).toContain("their insurance card");
  });
});

describe("patients with visits, and a newer card", () => {
  const pc = personCost(visitsOf([copayVisit("2026-09-01"), copayVisit("2026-06-01"), copayVisit("2026-03-01")]), today);
  const followUp = { date: today, type: "Follow Up", reason: null };
  it("their own visits still win when the card agrees or is older", () => {
    expect(visitAnswer(input({ pc, seenBefore: true, visit: followUp, card: card({ photoDate: "2026-11-10" }) }))).toMatchObject({ cents: 2500, from: "visits", sure: "sure" });
    expect(visitAnswer(input({ pc, seenBefore: true, visit: followUp, card: card({ photoDate: "2026-01-10", pcpCopayCents: 4000 }) }))).toMatchObject({ cents: 2500, from: "visits" });
  });
  it("a newer card with a different copay: the plan likely changed", () => {
    const a = visitAnswer(input({ pc, seenBefore: true, visit: followUp, card: card({ pcpCopayCents: 4000 }) }));
    expect(a).toMatchObject({ cents: 4000, from: "card", headline: "Collect $40" });
    expect(a.why.join(" ")).toContain("past visits had $25");
  });
  it("a newer card from another insurer: their old visits don't count", () => {
    const a = visitAnswer(input({ pc, seenBefore: true, visit: followUp, card: card({ payer: "Aetna", planName: "Open Access", pcpCopayCents: 3500 }), insurance: "Aetna", insuranceFrom: "card" }));
    expect(a).toMatchObject({ cents: 3500, from: "card", headline: "Collect $35" });
    expect(a.why[0]).toContain("new insurance: Aetna");
  });
});

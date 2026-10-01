import { describe, expect, it } from "vitest";
import { bmiOf, eligibleTests, isCurrentSmoker, officeTestState, qualifierOf, type TestFacts } from "../shared/officeTests";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function ctxFor(role: string): TrpcContext {
  const user = { id: 96, openId: "office-tests", email: "office-tests@example.com", name: "Office Tests", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
  return { user: user as NonNullable<TrpcContext["user"]>, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

const facts = (over: Partial<TestFacts>): TestFacts => ({ age: 40, diagnoses: [], ...over });
const testsOf = (f: TestFacts) => eligibleTests(f).map((t) => t.test);

describe("in-office testing (ABI-Q, PFT, RMR) by the practice's criteria", () => {
  it("hyperlipidemia or type 2 diabetes → all three tests", () => {
    expect(testsOf(facts({ diagnoses: [{ title: "Mixed hyperlipidemia", code: "icd-10-cm|E78.2" }] }))).toEqual(["abi_q", "pft", "rmr"]);
    expect(testsOf(facts({ diagnoses: [{ title: "Type 2 diabetes mellitus without complications", code: "icd-10-cm|E11.9" }] }))).toEqual(["abi_q", "pft", "rmr"]);
    expect(testsOf(facts({ diagnoses: [{ title: "Diabetes" }] }))).toEqual(["abi_q", "pft", "rmr"]); // by name, no type given
  });

  it("type 1, gestational and pre-diabetes don't count as type 2", () => {
    expect(testsOf(facts({ diagnoses: [{ title: "Type 1 diabetes mellitus", code: "icd-10-cm|E10.9" }] }))).toEqual([]);
    expect(testsOf(facts({ diagnoses: [{ title: "Prediabetes" }, { title: "Gestational diabetes" }] }))).toEqual([]);
  });

  it("obesity (diagnosis or BMI 30+) → RMR only; overweight doesn't count", () => {
    expect(testsOf(facts({ diagnoses: [{ title: "Morbid obesity", code: "icd-10-cm|E66.01" }] }))).toEqual(["rmr"]);
    expect(testsOf(facts({ bmi: { value: "31.2 kg/m2", date: "2026-08-01" } }))).toEqual(["rmr"]);
    expect(testsOf(facts({ bmi: { value: "27.9 kg/m2", date: "2026-08-01" } }))).toEqual([]);
    expect(testsOf(facts({ diagnoses: [{ title: "Overweight", code: "icd-10-cm|E66.3" }] }))).toEqual([]);
  });

  it("smoker, age 55+ or any respiratory diagnosis → PFT", () => {
    expect(testsOf(facts({ smoking: { value: "Current every day smoker", date: "2026-05-01" } }))).toEqual(["pft"]);
    expect(testsOf(facts({ diagnoses: [{ title: "Nicotine dependence, cigarettes", code: "icd-10-cm|F17.210" }] }))).toEqual(["pft"]);
    expect(testsOf(facts({ age: 55 }))).toEqual(["pft"]);
    expect(testsOf(facts({ age: 54 }))).toEqual([]);
    expect(testsOf(facts({ diagnoses: [{ title: "Mild intermittent asthma", code: "icd-10-cm|J45.20" }] }))).toEqual(["pft"]);
    expect(testsOf(facts({ diagnoses: [{ title: "Acute bronchitis" }] }))).toEqual(["pft"]); // any respiratory diagnosis
    expect(testsOf(facts({ diagnoses: [{ title: "Obstructive sleep apnea", code: "icd-10-cm|G47.33" }] }))).toEqual(["pft"]);
  });

  it("former and never smokers, resolved and 'history of' problems don't count", () => {
    expect(isCurrentSmoker("Former smoker")).toBe(false);
    expect(isCurrentSmoker("Never smoker")).toBe(false);
    expect(isCurrentSmoker("Current some day smoker")).toBe(true);
    expect(qualifierOf({ title: "Asthma", code: "icd-10-cm|J45.909", status: "resolved" })).toBeNull();
    expect(qualifierOf({ title: "History of tobacco use" })).toBeNull();
    expect(qualifierOf({ title: "Pulmonary embolism" })).toBeNull();
    expect(bmiOf("BMI 41.5")).toBe(41.5);
  });

  it("explains why, in the criteria's order", () => {
    const t = eligibleTests(facts({ age: 61, diagnoses: [{ title: "Hyperlipidemia", code: "icd-10-cm|E78.5" }] }));
    expect(t.find((x) => x.test === "pft")!.reasons.map((r) => r.why)).toEqual(["Hyperlipidemia (E78.5)", "Age 61"]);
  });

  it("done = off the list for a year; scheduled, declined and not needed show as such", () => {
    const today = "2026-10-01";
    expect(officeTestState([], today).state).toBe("eligible");
    expect(officeTestState([{ status: "done", date: "2026-03-01" }], today)).toMatchObject({ state: "done", eligibleAgainOn: "2027-03-01" });
    expect(officeTestState([{ status: "done", date: "2025-09-15" }], today).state).toBe("eligible");
    expect(officeTestState([{ status: "done", date: "2025-09-15" }, { status: "scheduled", date: "2026-10-14" }], today)).toMatchObject({ state: "scheduled", scheduledFor: "2026-10-14" });
    expect(officeTestState([{ status: "scheduled", date: "2026-10-14" }, { status: "done", date: "2026-10-14", id: 9 }], today).state).toBe("done");
    expect(officeTestState([{ status: "declined", date: "2026-06-01" }], today).state).toBe("declined");
    expect(officeTestState([{ status: "not_applicable", date: "2025-06-01" }], today).state).toBe("eligible");
  });

  it("billing and people without a role can't open the Testing tab", async () => {
    await expect(appRouter.createCaller(ctxFor("billing")).workspace.officeTests.list({})).rejects.toThrow(/access/);
    await expect(appRouter.createCaller(ctxFor("user")).workspace.officeTests.record({ subjectKey: "p:1", tests: ["pft"], status: "done", date: "2026-09-01" })).rejects.toThrow();
  });
});

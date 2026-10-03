import { describe, expect, it } from "vitest";
import { NOT_ON_ROSTER, classifyDiagnosis, countChronicConditions, diagnosesFingerprint, icd10Of, suggestPrograms, type MatchedDiagnosis } from "../shared/programRules";
import { apcmPriority, computeApcmLevel } from "./db";
import { firstClose, similarSpelling, tok } from "./rosterMatch";
import { conditionsToAdd } from "./conditionSync";
import { pickKeep } from "./rosterMerge";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function ctxFor(role: string): TrpcContext {
  const user = { id: 97, openId: "programs-test", email: "programs@example.com", name: "Programs Test", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
  return { user: user as NonNullable<TrpcContext["user"]>, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

const dx = (...items: [string, string?][]) => items.map(([title, code]) => classifyDiagnosis({ title, code })).filter((x): x is MatchedDiagnosis => !!x);

describe("program suggestions from diagnoses", () => {
  it("reads ICD-10 codes the way Practice Fusion stores them", () => {
    expect(icd10Of("icd-10-cm|E11.9")).toBe("E119");
    expect(icd10Of("sct|44054006")).toBeNull();
    expect(icd10Of("I10")).toBe("I10");
    expect(icd10Of(null)).toBeNull();
  });

  it("sorts problem-list entries into conditions by ICD-10 first, else by name", () => {
    expect(classifyDiagnosis({ title: "Type 2 diabetes mellitus without complications", code: "icd-10-cm|E11.9" })?.category).toBe("diabetes");
    expect(classifyDiagnosis({ title: "Essential hypertension", code: "sct|59621000" })?.category).toBe("hypertension");
    expect(classifyDiagnosis({ title: "Major depressive disorder, recurrent", code: "icd-10-cm|F33.1" })?.category).toBe("depression");
    expect(classifyDiagnosis({ title: "Something", code: "icd-10-cm|J44.9" })?.category).toBe("copd");
  });

  it("doesn't count look-alikes, insomnia, nicotine, resolved or 'history of' problems", () => {
    expect(classifyDiagnosis({ title: "Prediabetes" })).toBeNull();
    expect(classifyDiagnosis({ title: "Gestational diabetes" })).toBeNull();
    expect(classifyDiagnosis({ title: "Pulmonary hypertension" })).toBeNull();
    expect(classifyDiagnosis({ title: "Insomnia", code: "icd-10-cm|G47.00" })).toBeNull();
    expect(classifyDiagnosis({ title: "Nicotine dependence, cigarettes", code: "icd-10-cm|F17.210" })).toBeNull();
    expect(classifyDiagnosis({ title: "Essential hypertension", code: "icd-10-cm|I10", status: "Resolved" })).toBeNull();
    expect(classifyDiagnosis({ title: "History of breast cancer" })).toBeNull();
    expect(classifyDiagnosis({ title: "Basal cell carcinoma of skin of nose", code: "icd-10-cm|C44.311" })).toBeNull();
    expect(classifyDiagnosis({ title: "Overweight", code: "icd-10-cm|E66.3" })).toBeNull();
  });

  it("suggests CCM for 2+ different chronic conditions, RPM for BP/diabetes/heart failure, BHI for behavioral health", () => {
    const m = dx(["Type 2 diabetes", "icd-10-cm|E11.9"], ["Type 2 diabetes with hyperglycemia", "icd-10-cm|E11.65"], ["Essential hypertension", "icd-10-cm|I10"], ["Generalized anxiety disorder", "icd-10-cm|F41.1"]);
    const s = suggestPrograms(m, NOT_ON_ROSTER);
    expect(s.map((x) => x.program)).toEqual(["ccm", "bhi", "rpm"]);
    expect(s[0]!.reason).toBe("3 chronic conditions: Anxiety, Diabetes, High blood pressure"); // the two diabetes entries count once
    expect(s[1]!.diagnoses.map((x) => x.icd)).toEqual(["F41.1"]);
  });

  it("suggests APCM level 1 for exactly one chronic condition", () => {
    const s = suggestPrograms(dx(["Hypothyroidism", "icd-10-cm|E03.9"]), NOT_ON_ROSTER);
    expect(s.map((x) => x.program)).toEqual(["apcm"]);
    expect(s[0]!.reason).toContain("G0556");
  });

  it("skips programs they're already in or declined", () => {
    const m = dx(["Essential hypertension", "icd-10-cm|I10"], ["Hyperlipidemia", "icd-10-cm|E78.5"], ["Depression", "icd-10-cm|F32.A"]);
    const s = suggestPrograms(m, { ...NOT_ON_ROSTER, ccm: "active", bhi: "declined", rpm: "declined" });
    expect(s).toEqual([]);
    const consentNo = suggestPrograms(m, { ...NOT_ON_ROSTER, ccm: "inactive", ccmConsent: "declined", bhi: "not_enrolled" });
    expect(consentNo.map((x) => x.program)).toEqual(["bhi", "rpm"]);
  });

  it("remembers which diagnoses a decision was about", () => {
    expect(diagnosesFingerprint(dx(["Hypertension", "I10"], ["Diabetes", "E11.9"]))).toBe("diabetes,hypertension");
  });

  it("counts only recognized chronic conditions for APCM-only levels (GERD doesn't raise it)", () => {
    expect(countChronicConditions(["Hypothyroidism", "GERD"])).toBe(1);
    expect(countChronicConditions(["Type 2 Diabetes", "Diabetes with neuropathy", "Hypertension"])).toBe(2);
    expect(countChronicConditions(["ADHD"])).toBe(0);
  });

  it("levels APCM-only patients by their conditions; CCM-mirrored ones stay level 2+", () => {
    expect(computeApcmLevel(1, false, false)).toBe("level_1");
    expect(computeApcmLevel(1, true, false)).toBe("level_1");
    expect(computeApcmLevel(3, true, false)).toBe("level_3");
    expect(computeApcmLevel(0, false, true)).toBe("level_2");
  });

  it("fills CCM chronic conditions from Practice Fusion: adds with ICD-10, keeps what's there, no duplicates", () => {
    const problems = [
      { title: "Type 2 diabetes mellitus without complications", code: "icd-10-cm|E11.9", status: "active", date: "2022-01-01" },
      { title: "Type 2 diabetes mellitus with hyperglycemia", code: "icd-10-cm|E11.65", status: "active", date: "2025-03-01" },
      { title: "Essential hypertension", code: "icd-10-cm|I10", status: "active", date: "2020-05-05" },
      { title: "Asthma", code: "icd-10-cm|J45.909", status: "resolved", date: "2019-01-01" },
      { title: "Major depressive disorder, recurrent, moderate", code: "icd-10-cm|F33.1", status: "active", date: "2024-02-02" },
      { title: "Gastro-esophageal reflux disease", code: "icd-10-cm|K21.9", status: "active", date: "2024-02-02" },
    ];
    // Staff already typed "HTN": high blood pressure isn't added again; the newest diabetes problem is used.
    expect(conditionsToAdd({ chronic: ["HTN"], bhi: [], bhiActive: true }, problems)).toEqual({
      chronic: ["Major depressive disorder, recurrent, moderate (F33.1)", "Type 2 diabetes mellitus with hyperglycemia (E11.65)"],
      bhi: ["Major depressive disorder, recurrent, moderate (F33.1)"],
    });
    // Not in BHI: nothing goes on the BHI list. Everything already there: nothing added.
    expect(conditionsToAdd({ chronic: ["Diabetes", "Hypertension", "Depression"], bhi: [], bhiActive: false }, problems)).toEqual({ chronic: [], bhi: [] });
  });

  it("record matching: accents, hyphens, suffixes and compound surnames don't stop a name match (made-up names)", () => {
    expect(tok("José Hernández")).toMatchObject({ first: "jose", last: "hernandez" });
    expect(tok("HERNANDEZ, JOSE")).toMatchObject({ first: "jose", last: "hernandez" });
    expect(tok("John Testman Jr")).toMatchObject({ first: "john", last: "testman" });
    expect(tok("Maria Garcia-Lopez").lasts.sort()).toEqual(["garcia", "garcialopez", "lopez"]);
    expect(tok("Maria Garcia").lasts).toEqual(["garcia"]);
    expect(similarSpelling("mohamed", "mohammed")).toBe(true);
    expect(similarSpelling("smith", "smyth")).toBe(true);
    expect(similarSpelling("lee", "lea")).toBe(false); // too short to call a typo
    expect(similarSpelling("garcia", "gomez")).toBe(false);
  });

  it("duplicate roster records: keep the CCM-active copy, else the one with more CCM history, else the one with a birthday", () => {
    const base = { ccmEnrollmentStatus: "inactive", dateOfBirth: null } as never;
    const p = (id: number, over: Record<string, unknown>) => ({ ...(base as object), id, ...over }) as Parameters<typeof pickKeep>[0];
    const none = new Map<number, number>();
    expect(pickKeep(p(1, {}), p(2, { ccmEnrollmentStatus: "active" }), none)[0].id).toBe(2);
    expect(pickKeep(p(1, {}), p(2, {}), new Map([[1, 5], [2, 1]]))[0].id).toBe(1);
    expect(pickKeep(p(1, {}), p(2, { dateOfBirth: new Date("1950-01-01") }), none)[0].id).toBe(2);
    expect(pickKeep(p(3, {}), p(2, {}), none)[0].id).toBe(2);
  });

  it("record matching: close first names are nicknames / initials; only admins confirm pairs", async () => {
    expect(firstClose("abdul", "abdulrahman")).toBe(true);
    expect(firstClose("j", "john")).toBe(true);
    expect(firstClose("jo", "john")).toBe(false); // two letters isn't enough
    expect(firstClose("john", "john")).toBe(false); // an exact match is handled separately
    expect(firstClose("maria", "mario")).toBe(false);
    await expect(appRouter.createCaller(ctxFor("staff")).workspace.recordMatching.list()).rejects.toThrow(/admin/);
    await expect(appRouter.createCaller(ctxFor("office_manager")).workspace.recordMatching.confirm({ rosterId: 1, pfId: "x" })).rejects.toThrow(/admin/);
    await expect(appRouter.createCaller(ctxFor("office_manager")).workspace.recordMatching.mergeDuplicate({ rosterId: 1, intoId: 2 })).rejects.toThrow(/admin/);
    expect(similarSpelling("rebecca", "rebceca")).toBe(true); // two letters swapped in a longer name
  });

  it("only admins move the start date (patients seen since …)", async () => {
    await expect(appRouter.createCaller(ctxFor("staff")).workspace.seenSince.set({ date: "2026-09-01" })).rejects.toThrow(/admin/);
    await expect(appRouter.createCaller(ctxFor("office_manager")).workspace.seenSince.set({ date: "2026-09-01" })).rejects.toThrow(/admin/);
    await expect(appRouter.createCaller(ctxFor("admin")).workspace.seenSince.set({ date: "2999-01-01" })).rejects.toThrow(/future/);
  });

  it("only the named approvers reach the approval tab", async () => {
    // No database here: not being on the approvers list fails before anything is read.
    await expect(appRouter.createCaller(ctxFor("billing")).workspace.programs.list({})).rejects.toThrow();
    await expect(appRouter.createCaller(ctxFor("staff")).workspace.programs.decide({ decisions: [{ subjectKey: "p:1", approve: ["ccm"], reject: [] }] })).rejects.toThrow();
    await expect(appRouter.createCaller(ctxFor("admin")).workspace.programs.decide({ decisions: [{ subjectKey: "bogus", approve: ["ccm"], reject: [] }] })).rejects.toThrow();
  });
});

describe("APCM priority", () => {
  it("puts patients we completed a CCM with this year first, then reached, then not reached", () => {
    expect(apcmPriority({ ccmDoneThisMonth: false, ccmCompletedThisYear: 3, reachedThisYear: true })).toBe(1);
    expect(apcmPriority({ ccmDoneThisMonth: false, ccmCompletedThisYear: 0, reachedThisYear: true })).toBe(2);
    expect(apcmPriority({ ccmDoneThisMonth: false, ccmCompletedThisYear: 0, reachedThisYear: false })).toBe(3);
  });
  it("leaves out a patient whose CCM was completed that month (it bills CCM, not APCM)", () => {
    expect(apcmPriority({ ccmDoneThisMonth: true, ccmCompletedThisYear: 5, reachedThisYear: true })).toBe(null);
  });
});

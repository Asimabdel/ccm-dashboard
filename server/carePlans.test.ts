import { describe, expect, it } from "vitest";
import { DEFAULT_LIBRARY, LIBRARY_KEYS, educationMessage, keyOfSlug, slugOf } from "../shared/conditionLibrary";
import { defaultGeneral, planGaps, problemFromTemplate, renderPlanText } from "../shared/carePlanDoc";
import { classifyConditionName } from "../shared/programRules";
import { can } from "../shared/workspace";
import { libraryEntrySchema } from "./carePlanSchemas";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function ctxFor(role: string): TrpcContext {
  const user = { id: 96, openId: "careplans-test", email: "careplans@example.com", name: "Care Plans Test", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
  return { user: user as NonNullable<TrpcContext["user"]>, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("condition library", () => {
  it("has a complete draft for every chronic condition, in both languages, that passes the edit checks", () => {
    for (const key of LIBRARY_KEYS) {
      const e = DEFAULT_LIBRARY.get(key);
      expect(e, key).toBeDefined();
      expect(libraryEntrySchema.safeParse(e).success, key).toBe(true);
      for (const lang of ["en", "es"] as const) {
        const d = e!.education[lang];
        expect(d.title.length, `${key}.${lang}`).toBeGreaterThan(3);
        expect(d.call911.length, `${key}.${lang} emergency signs`).toBeGreaterThan(0);
        expect(d.whatYouCanDo.length, `${key}.${lang}`).toBeGreaterThan(2);
      }
      // Same structure in English and Spanish.
      expect(e!.education.es.whatYouCanDo.length, key).toBe(e!.education.en.whatYouCanDo.length);
      expect(e!.carePlan.goals.length, key).toBeGreaterThan(0);
      expect(e!.carePlan.interventions.length, key).toBeGreaterThan(0);
    }
  });

  it("patient links name no condition (text messages show on lock screens)", () => {
    const msg = educationMessage("en", "https://mypcpcare.com/learn/s/Ab3dE9xYz2", "(281) 555-0101");
    expect(msg).toContain("https://mypcpcare.com/learn/s/Ab3dE9xYz2");
    for (const key of LIBRARY_KEYS) expect(msg.toLowerCase()).not.toContain(DEFAULT_LIBRARY.get(key)!.education.en.title.toLowerCase());
    expect(slugOf("heart_failure")).toBe("heart-failure");
    expect(keyOfSlug("Heart-Failure")).toBe("heart_failure");
  });
});

describe("care plans", () => {
  it("reads roster condition names, using the ICD-10 code in brackets when there is one", () => {
    expect(classifyConditionName("Type 2 diabetes mellitus without complications (E11.9)")?.category).toBe("diabetes");
    expect(classifyConditionName("Something unusual (I10)")?.category).toBe("hypertension");
    expect(classifyConditionName("COPD")?.category).toBe("copd");
    expect(classifyConditionName("Seasonal allergies")).toBeNull();
  });

  it("starts each section from the approved template, headed by the patient's own diagnosis", () => {
    const t = DEFAULT_LIBRARY.get("diabetes")!.carePlan;
    const p = problemFromTemplate("diabetes", "Type 2 diabetes mellitus with hyperglycemia (E11.65)", t, 3);
    expect(p.problem).toBe("Type 2 diabetes mellitus with hyperglycemia (E11.65)");
    expect(p.goals).toEqual(t.goals);
    expect(p.goals).not.toBe(t.goals); // a copy: editing the plan never changes the template
    expect(p.templateVersion).toBe(3);
    expect(planGaps({ problems: [p] })).toEqual([]);
    expect(planGaps({ problems: [{ ...p, goals: [] }] })[0]).toMatch(/no measurable goal/);
    expect(planGaps({ problems: [] })).toEqual(["No problems on the plan."]);
  });

  it("writes a text copy with the signer", () => {
    const p = problemFromTemplate("hypertension", "Essential hypertension (I10)", DEFAULT_LIBRARY.get("hypertension")!.carePlan, 1);
    const text = renderPlanText({ problems: [p], general: defaultGeneral({ providerName: "Dr. Test", clinicPhone: "(281) 555-0101" }) }, { patientName: "Test Patient", signedBy: "Dr. Test", signedAt: "2026-10-01T15:00:00Z" });
    expect(text).toContain("COMPREHENSIVE CARE PLAN");
    expect(text).toContain("ESSENTIAL HYPERTENSION (I10)");
    expect(text).toContain("24 hours a day, 7 days a week at (281) 555-0101");
    expect(text).toContain("Established and signed by Dr. Test on 2026-10-01.");
  });

  it("care plans are for the CCM team and providers; handouts for every patient-facing role; only admins and providers edit the library", () => {
    expect(can("staff", "carePlans")).toBe(true);
    expect(can("provider", "carePlans")).toBe(true);
    expect(can("medical_assistant", "carePlans")).toBe(false);
    expect(can("front_desk", "carePlans")).toBe(false);
    expect(can("front_desk", "education")).toBe(true);
    expect(can("billing", "education")).toBe(false);
    expect(can("medical_assistant", "education")).toBe(true);
    expect(can("staff", "libraryEdit")).toBe(false);
    expect(can("provider", "libraryEdit")).toBe(true);
  });

  it("refuses the wrong roles before touching the database", async () => {
    await expect(appRouter.createCaller(ctxFor("front_desk")).workspace.carePlans.queue({ filter: "to_sign" })).rejects.toThrow();
    await expect(appRouter.createCaller(ctxFor("billing")).workspace.carePlans.get({ patientId: 1 })).rejects.toThrow();
    await expect(appRouter.createCaller(ctxFor("staff")).workspace.library.save({ key: "diabetes", entry: DEFAULT_LIBRARY.get("diabetes")! })).rejects.toThrow();
    await expect(appRouter.createCaller(ctxFor("billing")).workspace.education.forPatient({ subjectKey: "p:1" })).rejects.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_WELLNESS, WELLNESS_GROUPS, WELLNESS_KEYS, WELLNESS_REVIEW_NOTES, WELLNESS_TOPICS, smokerFrom, suggestWellness, type WellnessPerson } from "../shared/wellness";
import { LIBRARY_KEYS } from "../shared/conditionLibrary";
import { wellnessEntrySchema } from "./carePlanSchemas";

const person = (p: Partial<WellnessPerson>): WellnessPerson => ({ age: null, sex: null, smoker: null, bmi: null, ...p });
const keysFor = (p: Partial<WellnessPerson>) => suggestWellness(person(p)).map((s) => s.key);

describe("wellness handouts", () => {
  it("has a complete draft for every topic, in both languages, that passes the edit checks", () => {
    expect(DEFAULT_WELLNESS.size).toBe(WELLNESS_KEYS.length);
    for (const key of WELLNESS_KEYS) {
      const e = DEFAULT_WELLNESS.get(key);
      expect(e, key).toBeDefined();
      expect(wellnessEntrySchema.safeParse(e).success, key).toBe(true);
      for (const lang of ["en", "es"] as const) {
        const d = e!.education[lang];
        expect(d.title.length, `${key}.${lang}`).toBeGreaterThan(3);
        expect(d.summary.length, `${key}.${lang}`).toBeGreaterThan(20);
        expect(d.whatToDo.length, `${key}.${lang}`).toBeGreaterThan(1);
        expect(d.talkToUs.length, `${key}.${lang}`).toBeGreaterThan(0);
      }
      // Same structure in English and Spanish.
      expect(e!.education.es.whatToDo.length, key).toBe(e!.education.en.whatToDo.length);
      expect(e!.education.es.whoFor.length, key).toBe(e!.education.en.whoFor.length);
      expect(e!.basis.length, key).toBeGreaterThan(0);
    }
  });

  it("keys never clash with the condition library, and every topic has a group", () => {
    for (const t of WELLNESS_TOPICS) {
      expect(t.key.startsWith("w_"), t.key).toBe(true);
      expect(LIBRARY_KEYS.includes(t.key), t.key).toBe(false);
      expect(WELLNESS_GROUPS[t.group], t.key).toBeDefined();
      if (t.suggest) expect(t.why, t.key).toBeTruthy();
    }
    for (const key of Object.keys(WELLNESS_REVIEW_NOTES)) expect(WELLNESS_KEYS, key).toContain(key);
  });

  it("drafts don't hard-code local phone numbers (the flyer prints the clinic's own; national 1-8xx helplines are fine)", () => {
    for (const e of Array.from(DEFAULT_WELLNESS.values())) {
      const text = JSON.stringify(e.education).replace(/1-8\d\d-[\dA-ZÉ-]+(\s*\(1-8\d\d-\d{3}-\d{4}\))?/g, "");
      expect(/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(text), e.key).toBe(false);
    }
  });

  it("suggests by age, sex, smoking and BMI", () => {
    const woman52 = keysFor({ age: 52, sex: "F", smoker: "never", bmi: 31 });
    expect(woman52).toEqual(expect.arrayContaining(["w_flu", "w_shingles", "w_colon_cancer", "w_breast_cancer", "w_cervical_cancer", "w_diabetes_screening", "w_healthy_weight"]));
    expect(woman52).not.toContain("w_lung_cancer");
    expect(woman52).not.toContain("w_prostate_cancer");
    expect(woman52).not.toContain("w_bone_density");
    expect(woman52).not.toContain("w_quit_smoking");

    const man67 = keysFor({ age: 67, sex: "M", smoker: "current", bmi: 23 });
    expect(man67).toEqual(expect.arrayContaining(["w_covid", "w_lung_cancer", "w_prostate_cancer", "w_quit_smoking", "w_fall_prevention"]));
    expect(man67).not.toContain("w_healthy_weight");
    expect(man67).not.toContain("w_breast_cancer");

    // The reason says when the weight isn't on file.
    expect(suggestWellness(person({ age: 50 })).find((s) => s.key === "w_diabetes_screening")?.why).toMatch(/not on file/);
    expect(suggestWellness(person({ age: 50, bmi: 28 })).find((s) => s.key === "w_diabetes_screening")?.why).toBe("Age 35–70 with extra weight");

    // Nothing age-based without a date of birth.
    expect(keysFor({})).toEqual([]);
    expect(keysFor({ sex: "F" })).toEqual([]);
  });

  it("reads the chart's smoking status", () => {
    expect(smokerFrom("Current every day smoker")).toBe("current");
    expect(smokerFrom("Light tobacco smoker")).toBe("current");
    expect(smokerFrom("Former smoker")).toBe("former");
    expect(smokerFrom("Never smoker")).toBe("never");
    expect(smokerFrom("Unknown if ever smoked")).toBe(null);
    expect(smokerFrom("Never assessed")).toBe(null);
    expect(smokerFrom("")).toBe(null);
    expect(smokerFrom(null)).toBe(null);
  });
});

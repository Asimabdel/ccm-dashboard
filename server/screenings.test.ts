import { describe, expect, it } from "vitest";
import { INTAKE_LANGS } from "../shared/intake";
import {
  DIFFICULTY_ID, GAD7, PHQ9, RISK_NOTE, SCREENINGS, SCREENING_INTRO, SCREENING_NOT_LIVE, cleanScreeningAnswers, isScreeningKey, screeningFor, screeningMissing, screeningResult,
  screeningSummary, type ScreeningAnswers,
} from "../shared/screenings";

const all = (s: typeof PHQ9, v: string): ScreeningAnswers => Object.fromEntries(s.items.map((i) => [i.id, v]));

describe("depression and anxiety screenings (PHQ-9, GAD-7)", () => {
  it("are the published forms: 9 and 7 questions, four answers worth 0 to 3, in three languages", () => {
    expect(PHQ9.items).toHaveLength(9);
    expect(GAD7.items).toHaveLength(7);
    for (const s of SCREENINGS) {
      expect(s.options).toHaveLength(4);
      expect(s.options.map((o) => o.en)).toEqual(["Not at all", "Several days", "More than half the days", "Nearly every day"]);
      for (const lang of INTAKE_LANGS) {
        for (const text of [s.title, s.stem, s.credit, ...s.items.map((i) => i.text), ...s.options, ...(s.difficulty ? [s.difficulty.question, ...s.difficulty.options] : [])]) {
          expect(text[lang].trim().length).toBeGreaterThan(2);
        }
      }
      // Every score from 0 to the top falls in exactly one range.
      const max = s.items.length * 3;
      for (let n = 0; n <= max; n++) expect(s.bands.filter((b) => n >= b.min && n <= b.max)).toHaveLength(1);
      expect(s.bands[0]!.min).toBe(0);
      expect(s.bands[s.bands.length - 1]!.max).toBe(max);
    }
    // The wording must stay word for word (a score only means something with the published text).
    expect(PHQ9.items[0]!.text.en).toBe("Little interest or pleasure in doing things");
    expect(PHQ9.items[8]!.text.en).toBe("Thoughts that you would be better off dead or of hurting yourself in some way");
    expect(PHQ9.items[8]!.text.es).toBe("Pensamientos de que estaría mejor muerto(a) o de lastimarse de alguna manera");
    expect(GAD7.items[0]!.text.en).toBe("Feeling nervous, anxious or on edge");
    expect(GAD7.items[6]!.text.es).toBe("Ha tenido miedo de que algo terrible fuera a pasar");
    expect(PHQ9.riskItem).toBe("q9");
    expect(GAD7.riskItem).toBeUndefined();
    expect(GAD7.difficulty).toBeUndefined();
    expect(isScreeningKey("phq9")).toBe(true);
    expect(isScreeningKey("medical_intake")).toBe(false);
    expect(screeningFor("gad7")).toBe(GAD7);
  });

  it("adds up the points and names the published range", () => {
    expect(screeningResult(PHQ9, all(PHQ9, "0"))).toMatchObject({ score: 0, max: 27, complete: true, positive: false, risk: false, asksDifficulty: false });
    expect(screeningResult(PHQ9, all(PHQ9, "0")).band?.label).toBe("Minimal or none");
    expect(screeningResult(PHQ9, all(PHQ9, "3"))).toMatchObject({ score: 27, positive: true, risk: true, riskPoints: 3 });
    expect(screeningResult(PHQ9, all(PHQ9, "3")).band?.label).toBe("Severe");
    const cases: [number, string, boolean][] = [[4, "Minimal or none", false], [5, "Mild", false], [9, "Mild", false], [10, "Moderate", true], [14, "Moderate", true], [15, "Moderately severe", true], [19, "Moderately severe", true], [20, "Severe", true]];
    for (const [target, label, positive] of cases) {
      // Spread the points over the first eight questions; question 9 stays at 0.
      const a = all(PHQ9, "0");
      let left = target;
      for (const item of PHQ9.items.slice(0, 8)) { const p = Math.min(3, left); a[item.id] = String(p); left -= p; }
      const r = screeningResult(PHQ9, a);
      expect([r.score, r.band?.label, r.positive, r.risk]).toEqual([target, label, positive, false]);
    }
    expect(screeningResult(GAD7, all(GAD7, "3"))).toMatchObject({ score: 21, max: 21, positive: true, risk: false, riskPoints: null });
    expect(screeningResult(GAD7, all(GAD7, "3")).band?.label).toBe("Severe");
    expect(screeningResult(GAD7, { ...all(GAD7, "1"), q1: "3" })).toMatchObject({ score: 9, positive: false });
    expect(screeningResult(GAD7, { ...all(GAD7, "1"), q1: "3", q2: "2" })).toMatchObject({ score: 10, positive: true });
    expect(screeningSummary(PHQ9, screeningResult(PHQ9, { ...all(PHQ9, "1"), q1: "3", q2: "2" }))).toBe("12 of 27 · Moderate (10–14)");
  });

  it("flags the self-harm question on any answer above \"Not at all\", whatever the total", () => {
    const a = { ...all(PHQ9, "0"), q9: "1" };
    expect(screeningResult(PHQ9, a)).toMatchObject({ score: 1, positive: false, risk: true, riskPoints: 1 });
    expect(screeningResult(PHQ9, { ...all(PHQ9, "3"), q9: "0" })).toMatchObject({ score: 24, risk: false, riskPoints: 0 });
  });

  it("has no range and is not positive until every question is answered", () => {
    const a = all(PHQ9, "3");
    delete a.q4;
    const r = screeningResult(PHQ9, a);
    expect(r).toMatchObject({ complete: false, answered: 8, positive: false, band: null });
    expect(screeningMissing(PHQ9, a)).toEqual(["q4", DIFFICULTY_ID]);
    expect(screeningMissing(PHQ9, {})).toEqual(PHQ9.items.map((i) => i.id));
  });

  it("asks the difficulty question only when a problem was checked (PHQ-9)", () => {
    expect(screeningMissing(PHQ9, all(PHQ9, "0"))).toEqual([]);
    const some = { ...all(PHQ9, "0"), q2: "1" };
    expect(screeningMissing(PHQ9, some)).toEqual([DIFFICULTY_ID]);
    expect(screeningMissing(PHQ9, { ...some, [DIFFICULTY_ID]: "2" })).toEqual([]);
    expect(screeningResult(PHQ9, { ...some, [DIFFICULTY_ID]: "2" })).toMatchObject({ asksDifficulty: true, difficulty: 2 });
    expect(screeningMissing(GAD7, all(GAD7, "2"))).toEqual([]);
  });

  it("keeps only real questions and real answers (they come from the public page)", () => {
    const a = cleanScreeningAnswers(PHQ9, { q1: "2", q2: "7", q3: 1, q9: "0", hacker: "x", q10: "1", [DIFFICULTY_ID]: "3" });
    expect(a).toEqual({ q1: "2", q9: "0", [DIFFICULTY_ID]: "3" });
    // No problem checked: a left-over difficulty answer is dropped.
    expect(cleanScreeningAnswers(PHQ9, { ...all(PHQ9, "0"), [DIFFICULTY_ID]: "3" })).toEqual(all(PHQ9, "0"));
    // The GAD-7 has no difficulty question.
    expect(cleanScreeningAnswers(GAD7, { ...all(GAD7, "1"), [DIFFICULTY_ID]: "1", q8: "1" })).toEqual(all(GAD7, "1"));
    expect(cleanScreeningAnswers(PHQ9, null)).toEqual({});
    expect(cleanScreeningAnswers(PHQ9, "nope")).toEqual({});
  });

  it("always gives the 988 and 911 numbers in the safety notes, in every language", () => {
    for (const lang of INTAKE_LANGS) {
      for (const text of [SCREENING_NOT_LIVE, RISK_NOTE.body, RISK_NOTE.followUp]) {
        expect(text[lang]).toContain("988");
        expect(text[lang]).toContain("911");
      }
      expect(RISK_NOTE.title[lang].length).toBeGreaterThan(5);
      expect(SCREENING_INTRO[lang].length).toBeGreaterThan(5);
    }
  });
});

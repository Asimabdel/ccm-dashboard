import { describe, expect, it } from "vitest";
import { LIBRARY_ITEMS } from "../shared/conditionLibrary";
import { joinAnswer, simpleQuestionsFor, splitAnswer } from "../shared/ccmQuestions";

describe("Simple CCM call questions", () => {
  const conditions = LIBRARY_ITEMS.filter((i) => i.kind === "condition");

  it("every condition has at least 3 short questions with tap answers", () => {
    for (const c of conditions) {
      const list = simpleQuestionsFor(c.key, c.category);
      expect(list.length, c.key).toBeGreaterThanOrEqual(3);
      expect(new Set(list.map((x) => x.q)).size, `${c.key}: repeated question`).toBe(list.length);
      for (const x of list) {
        expect(x.q.length, x.q).toBeLessThanOrEqual(70);
        expect(x.options.length, x.q).toBeGreaterThanOrEqual(2);
        expect(x.options.length, x.q).toBeLessThanOrEqual(4);
        expect(new Set(x.options).size, x.q).toBe(x.options.length);
        for (const t of x.tell ?? []) expect(x.options, `${x.q}: "${t}"`).toContain(t);
      }
    }
  });

  it("keeps the tapped answer and the note apart when a saved call is opened again", () => {
    const options = ["No", "Yes"];
    expect(joinAnswer("Yes", " twice, after meals ")).toBe("Yes — twice, after meals");
    expect(splitAnswer("Yes — twice, after meals", options)).toEqual({ choice: "Yes", note: "twice, after meals" });
    expect(splitAnswer("No", options)).toEqual({ choice: "No", note: "" });
    expect(splitAnswer("only a note", options)).toEqual({ choice: "", note: "only a note" });
    expect(joinAnswer("", "only a note")).toBe("only a note");
  });
});

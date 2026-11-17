import { describe, expect, it } from "vitest";
import { cleanFields, hasPatientBoxes, missingFor, pdfDocIdOf, pdfFormKey } from "../shared/documents";

// Made-up boxes only.
const pages = [{ w: 612, h: 792, rotate: 0 }];

describe("Documents sent to the patient", () => {
  it("keeps boxes meant for the patient when saving (marks stay the preparer's)", () => {
    const saved = cleanFields([
      { id: "a", type: "text", page: 0, x: 10, y: 10, w: 100, h: 16, assignee: "patient", required: true },
      { id: "b", type: "signature", page: 0, x: 10, y: 40, w: 100, h: 20, assignee: "patient" },
      { id: "c", type: "highlight", page: 0, x: 10, y: 70, w: 100, h: 20, assignee: "patient" },
      { id: "d", type: "text", page: 0, x: 10, y: 100, w: 100, h: 16, assignee: "somebody" },
    ], pages);
    expect(saved.map((f) => [f.id, f.assignee])).toEqual([["a", "patient"], ["b", "patient"], ["c", "preparer"], ["d", "preparer"]]);
    expect(hasPatientBoxes(saved)).toBe(true);
    expect(hasPatientBoxes(saved.filter((f) => f.id !== "a" && f.id !== "b"))).toBe(false);
    // The patient's required boxes are theirs to fill, not the preparer's.
    expect(missingFor(saved, "patient").map((f) => f.id)).toEqual(["a"]);
    expect(missingFor(saved, "preparer")).toEqual([]);
  });

  it("names the document inside a patient forms link as pdf:<id>, and nothing else", () => {
    expect(pdfFormKey(42)).toBe("pdf:42");
    expect(pdfDocIdOf("pdf:42")).toBe(42);
    expect(pdfDocIdOf("doc:42")).toBeNull();
    expect(pdfDocIdOf("pdf:")).toBeNull();
    expect(pdfDocIdOf("pdf:12345678901")).toBeNull();
    expect(pdfDocIdOf("pdf:4 2")).toBeNull();
  });
});

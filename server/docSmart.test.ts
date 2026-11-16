import { describe, expect, it } from "vitest";
import { cleanFields, guessPrefill, type DocPage } from "../shared/documents";
import { editTextBoxes } from "../shared/docEdit";
import { AI_PAGE_PROMPT, boxesFromAi, parseAiFields, suggestBoxes, textRunAt, whoOfLabel, type PageText } from "../shared/docSuggest";

const letter: DocPage = { w: 612, h: 792, rotate: 0 };

describe("Documents editor: fill from the patient's record", () => {
  it("knows what a label is asking for when MyPCP holds it on file", () => {
    const cases: [string, ReturnType<typeof guessPrefill>][] = [
      ["Patient name", "patient_name"], ["Name", "patient_name"], ["Full name", "patient_name"], ["Nombre del paciente", "patient_name"],
      ["Date of birth", "patient_dob"], ["DOB", "patient_dob"],
      ["Phone", "patient_phone"], ["Cell phone", "patient_phone"], ["Email", "patient_email"], ["Address", "patient_address"], ["Street address", "patient_address"],
      ["Sex", "patient_sex"], ["MRN", "patient_mrn"], ["Chart number", "patient_mrn"],
      ["Insurance", "insurance_name"], ["Insurance company", "insurance_name"], ["Member ID", "insurance_member_id"], ["Policy number", "insurance_member_id"], ["Group number", "insurance_group"],
      ["Provider", "provider_name"], ["Physician name", "provider_name"], ["Provider: Name", "provider_name"], ["NPI", "provider_npi"],
      ["Office phone", "clinic_phone"], ["Clinic address", "clinic_address"], ["Practice name", "clinic_name"],
    ];
    for (const [label, key] of cases) expect([label, guessPrefill(label, "text")]).toEqual([label, key]);
  });
  it("never guesses for someone else, a fax number, a signature, or a plain date", () => {
    for (const label of ["Witness name", "Guardian name", "Emergency contact phone", "Employer address", "Pharmacy phone", "Printed name of representative", "Staff: Name", "Fax", "Provider signature", "Comments", "", "Relationship to patient's spouse"]) {
      expect([label, guessPrefill(label, "text")]).toEqual([label, null]);
    }
    expect(guessPrefill("Date", "date")).toBeNull();
    expect(guessPrefill("Today's date", "date")).toBeNull();
    expect(guessPrefill("Date of birth", "date")).toBe("patient_dob");
    expect(guessPrefill("Patient name", "signature")).toBeNull();
    expect(guessPrefill("Patient name", "checkbox")).toBeNull();
    // The new "fill automatically with" choices survive saving.
    const [f] = cleanFields([{ id: "a", type: "text", page: 0, x: 1, y: 1, w: 50, h: 20, prefill: "insurance_member_id" }], [letter]);
    expect(f!.prefill).toBe("insurance_member_id");
  });
});

describe("Documents editor: suggestions never mix up whose details a blank wants", () => {
  it("a phone on the emergency contact's line is the contact's, not the patient's", () => {
    const out = suggestBoxes(0, letter, [
      { str: "Emergency contact name: ______________________    Phone: ________________", x: 60, y: 360, w: 440, h: 11 },
      { str: "Phone: ____________________    Email: ______________________________", x: 60, y: 600, w: 400, h: 11 },
    ]);
    expect(out.map((s) => [s.label, s.prefill])).toEqual([
      ["Emergency contact name", null], ["Emergency contact name Phone", null], ["Phone", "patient_phone"], ["Email", "patient_email"],
    ]);
    // …and the label keeps saying so, so "Fill from the patient's record" leaves it alone later too.
    expect(guessPrefill(out[1]!.label, "text")).toBeNull();
  });
});

describe("Documents editor: edit printed text", () => {
  const items: PageText[] = [
    { str: "Release records to:", x: 60, y: 548, w: 105, h: 12 },
    { str: "Dr. Old Name,", x: 169, y: 548, w: 74, h: 12 },
    { str: "123 Wrong Street", x: 247, y: 548, w: 92, h: 12 },
    { str: "Fax: 555-0100", x: 420, y: 548, w: 80, h: 12 },
    { str: "Another line", x: 60, y: 500, w: 70, h: 12 },
  ];
  it("picks up the words under the click, joined with the pieces next to them on the line", () => {
    const run = textRunAt(items, 200, 552)!;
    expect(run.str).toBe("Release records to: Dr. Old Name, 123 Wrong Street");
    expect(run).toMatchObject({ x: 60, y: 548, h: 12 });
    expect(run.w).toBeCloseTo(279, 5);
    // A wide gap ends the run: the fax number is its own piece of text.
    expect(textRunAt(items, 450, 550)!.str).toBe("Fax: 555-0100");
    expect(textRunAt(items, 80, 503)!.str).toBe("Another line");
    // Empty space, between lines: nothing.
    expect(textRunAt(items, 300, 520)).toBeNull();
    expect(textRunAt([], 10, 10)).toBeNull();
  });
  it("swaps them for white-out plus a text box with the same words, size and baseline", () => {
    const [white, text] = editTextBoxes(0, letter, { str: "Dr. Old Name", x: 169, y: 548, w: 74, h: 12 });
    expect(white).toMatchObject({ type: "whiteout", page: 0, assignee: "preparer" });
    // The white-out covers the old words: from just below the baseline to above the tall letters.
    expect(white.x).toBeLessThanOrEqual(169);
    expect(white.x + white.w).toBeGreaterThanOrEqual(169 + 74);
    expect(white.y).toBeLessThan(548);
    expect(white.y + white.h).toBeGreaterThan(548 + 9);
    expect(text).toMatchObject({ type: "text", value: "Dr. Old Name", fontSize: 12, assignee: "preparer" });
    // The signed PDF prints text 0.375 x size above the bottom of its box (see drawValue): that is the old baseline.
    expect(text.y + 0.375 * 12).toBeCloseTo(548, 5);
    expect(text.w).toBeGreaterThan(74);
    expect(text.id).not.toBe(white.id);
    // Both survive saving unchanged in kind.
    expect(cleanFields([white, text], [letter]).map((f) => f.type)).toEqual(["whiteout", "text"]);
    // Tiny or huge print is kept within what a box can hold; a run at the page edge stays on the page.
    expect(editTextBoxes(0, letter, { str: "x", x: 600, y: 5, w: 30, h: 60 })[1]).toMatchObject({ fontSize: 36 });
    const edge = editTextBoxes(0, letter, { str: "edge", x: 590, y: 5, w: 20, h: 10 })[1];
    expect(edge.x + edge.w).toBeLessThanOrEqual(612);
  });
});

describe("Documents editor: boxes proposed by the AI", () => {
  it("reads the model's reply, even with words or a code fence around it", () => {
    expect(parseAiFields('```json\n{"fields":[["text","Patient name","patient",100,100,500,130]]}\n```')).toHaveLength(1);
    expect(parseAiFields('Here you go: {"fields":[{"type":"date","label":"Date","who":"other","box":[1,2,3,4]}]} Hope that helps.')).toHaveLength(1);
    expect(parseAiFields('{"fields":[]}')).toEqual([]);
    expect(parseAiFields("I could not find anything.")).toEqual([]);
    expect(parseAiFields('{"fields": "none"}')).toEqual([]);
    expect(parseAiFields('{"fields":[')).toEqual([]);
    expect(AI_PAGE_PROMPT).toContain("0 to 1000");
  });
  it("turns rows into boxes on the page, sized for writing, named by who fills them", () => {
    const out = boxesFromAi(1, letter, [
      ["text", "Patient name", "patient", 200, 100, 700, 104],
      ["signature", "Signature", "provider", 150, 800, 600, 803],
      ["checkbox", "Lab results", "patient", 100, 300, 118, 314],
      { type: "date", label: "Date", who: "staff", box: [700, 800, 850, 820] },
      ["text", "Name", "witness", 150, 900, 600, 920],
      ["initials", "Initials", "nobody", 800, 950, 880, 975],
    ]);
    expect(out.map((s) => `${s.type}|${s.label}`)).toEqual([
      "text|Patient name", "signature|Provider: Signature", "checkbox|Patient: Lab results", "date|Staff: Date", "text|Witness: Name", "initials|Initials",
    ]);
    const [name, sig, check, , witness] = out;
    // 0..1000 from the top-left of the picture → page points from the bottom-left.
    expect(name).toMatchObject({ page: 1, prefill: "patient_name", required: false });
    expect(name!.x).toBeCloseTo(122.4, 3);
    expect(name!.w).toBeCloseTo(306, 3);
    expect(name!.h).toBe(14); // a thin line is given room to write on
    expect(name!.y).toBeCloseTo(792 - 0.104 * 792, 3); // …sitting on the line
    expect(sig).toMatchObject({ required: true, prefill: null });
    expect(sig!.h).toBe(26);
    expect(check!.w).toBe(check!.h);
    expect(check!.w).toBeGreaterThanOrEqual(9);
    // A witness's name is never filled from the patient's record.
    expect(witness!.prefill).toBeNull();
    expect(out.every((s) => s.x >= 0 && s.y >= 0 && s.x + s.w <= 612 && s.y + s.h <= 792)).toBe(true);
    expect(whoOfLabel(sig!.label)).toBe("provider");
    expect(whoOfLabel(name!.label)).toBeNull(); // "Patient name" already says who
    expect(whoOfLabel("Staff: Date")).toBe("staff");
  });
  it("never treats an emergency contact's blanks as the patient's, even when the AI does", () => {
    // What the model really answered for a made-up registration form (positions trimmed to that line).
    const out = boxesFromAi(0, letter, [
      ["text", "Phone:", "patient", 160, 229, 359, 245],
      ["text", "Emergency contact name:", "patient", 312, 529, 533, 545],
      ["text", "Phone:", "patient", 611, 529, 775, 545],
    ]);
    expect(out.map((s) => [s.label, s.prefill])).toEqual([
      ["Patient: Phone", "patient_phone"],
      ["Emergency contact name", null],
      ["Emergency contact name: Phone", null],
    ]);
    expect(guessPrefill(out[2]!.label, "text")).toBeNull();
  });
  it("drops junk, whole-page blocks and anything on top of an existing box", () => {
    const existing = [{ page: 0, x: 120, y: 700, w: 300, h: 16 }];
    const out = boxesFromAi(0, letter, [
      ["text", "On top of the existing box", "patient", 200, 100, 680, 115],
      ["text", "The whole page", "patient", 0, 0, 1000, 1000],
      ["text", "A tall block", "patient", 100, 200, 900, 700],
      ["paragraph", "Not a box type", "patient", 100, 100, 200, 120],
      ["text", "Bad numbers", "patient", "a", 2, 3, 4],
      ["text", "Sliver", "patient", 100, 500, 101, 501],
      null, "nonsense", 42,
      ["text", "Out of range is pulled back in", "patient", -50, 400, 1200, 420],
      ["text", "Same place twice", "patient", 100, 600, 400, 620],
      ["text", "Same place twice again", "patient", 100, 600, 400, 620],
    ], existing);
    expect(out.map((s) => s.label)).toEqual(["Patient: Out of range is pulled back in", "Patient: Same place twice"]);
    expect(out[0]!.x).toBe(0);
    expect(out[0]!.x + out[0]!.w).toBeLessThanOrEqual(612);
  });
});

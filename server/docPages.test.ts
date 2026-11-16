import { describe, expect, it } from "vitest";
import type { DocField, DocPage } from "../shared/documents";
import { contentTurn, fieldsAfterOrder, fieldsAfterRemove, fieldsAfterTurn, imagePageLayout, movedOrder, sniffFile, turnRect, turnedPage } from "../shared/docPages";
import { suggestBoxes, type PageText } from "../shared/docSuggest";

const letter: DocPage = { w: 612, h: 792, rotate: 0 };
const box = (p: Partial<DocField>): DocField => ({ id: "a", type: "text", page: 0, x: 100, y: 600, w: 180, h: 20, assignee: "preparer", ...p });

describe("Documents editor: page tools", () => {
  it("turns a box with its page (clockwise), and four quarter turns bring it back", () => {
    const r = { x: 100, y: 600, w: 180, h: 20 };
    // A box near the top-left ends up near the top-right, standing on its side.
    expect(turnRect(r, 90, letter)).toEqual({ x: 600, y: 332, w: 20, h: 180 });
    expect(turnRect(r, 180, letter)).toEqual({ x: 332, y: 172, w: 180, h: 20 });
    expect(turnRect(r, 270, letter)).toEqual({ x: 172, y: 100, w: 20, h: 180 });
    expect(turnRect(r, 0, letter)).toBe(r);
    let cur = r, page = letter;
    for (let i = 0; i < 4; i++) { cur = turnRect(cur, 90, page); page = turnedPage(page, 90); }
    expect(cur).toEqual(r);
    expect(page).toEqual(letter);
    expect(turnedPage(letter, 90)).toEqual({ w: 792, h: 612, rotate: 0 });
    expect(turnedPage(letter, 180)).toEqual({ w: 612, h: 792, rotate: 0 });
  });
  it("adds the turn to a rotation the page already had", () => {
    expect(contentTurn(letter, 90)).toBe(90);
    expect(contentTurn({ ...letter, rotate: 90 }, 90)).toBe(180);
    expect(contentTurn({ ...letter, rotate: 270 }, 90)).toBe(0);
    expect(contentTurn({ ...letter, rotate: -90 }, 180)).toBe(90);
  });
  it("only moves the boxes of the page that was turned", () => {
    const fields = [box({ id: "a", page: 0 }), box({ id: "b", page: 1 })];
    const out = fieldsAfterTurn(fields, 1, 90, letter);
    expect(out[0]).toBe(fields[0]);
    expect(out[1]).toMatchObject({ id: "b", page: 1, x: 600, y: 332, w: 20, h: 180 });
  });
  it("removing a page drops its boxes and moves later pages up", () => {
    const fields = [box({ id: "a", page: 0 }), box({ id: "b", page: 1 }), box({ id: "c", page: 2 }), box({ id: "d", page: 3 })];
    expect(fieldsAfterRemove(fields, 1).map((f) => [f.id, f.page])).toEqual([["a", 0], ["c", 1], ["d", 2]]);
  });
  it("moving a page keeps every box on its own page", () => {
    expect(movedOrder(4, 0, 2)).toEqual([1, 2, 0, 3]);
    expect(movedOrder(4, 3, 0)).toEqual([3, 0, 1, 2]);
    expect(movedOrder(4, 1, 1)).toEqual([0, 1, 2, 3]);
    expect(movedOrder(4, 9, 0)).toEqual([0, 1, 2, 3]);
    const fields = [box({ id: "a", page: 0 }), box({ id: "b", page: 1 }), box({ id: "c", page: 2 })];
    // Page 1 (index 0) goes to the end: its box follows it; the others move up.
    expect(fieldsAfterOrder(fields, movedOrder(3, 0, 2)).map((f) => [f.id, f.page])).toEqual([["a", 2], ["b", 0], ["c", 1]]);
  });
  it("tells a PDF, a JPEG and a PNG apart by their first bytes", () => {
    expect(sniffFile(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toBe("jpeg");
    expect(sniffFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
    expect(sniffFile(new TextEncoder().encode("%PDF-1.7\n..."))).toBe("pdf");
    expect(sniffFile(new TextEncoder().encode("\n\n junk %PDF-1.4"))).toBe("pdf");
    expect(sniffFile(new TextEncoder().encode("PK\u0003\u0004 a zip or Word file"))).toBeNull();
    expect(sniffFile(new Uint8Array([]))).toBeNull();
  });
  it("fits a photo on a Letter page, sideways for a wide picture", () => {
    const tall = imagePageLayout(1500, 2000);
    expect([tall.pageW, tall.pageH]).toEqual([612, 792]);
    expect(tall.x).toBeGreaterThanOrEqual(18);
    expect(tall.y).toBeGreaterThanOrEqual(18);
    expect(tall.w / tall.h).toBeCloseTo(0.75, 5);
    const wide = imagePageLayout(2000, 1000);
    expect([wide.pageW, wide.pageH]).toEqual([792, 612]);
    expect(wide.w).toBeCloseTo(756, 5);
  });
});

describe("Documents editor: suggested boxes", () => {
  const line = (str: string, y: number, x = 60, w = str.length * 6, h = 12): PageText => ({ str, x, y, w, h });
  it("puts a box on each blank and names what it is for", () => {
    const out = suggestBoxes(0, letter, [
      line("Records Release Form", 730),
      line("Patient name: ______________________________", 680),
      line("Date of birth: ____________", 636),
      line("Phone: ____________________", 592),
      line("Release records to: Dr. Old Name, 123 Wrong Street", 548),
      line("Patient signature: ______________________________    Date: ____________", 200),
      line("Initials: ______", 60, 470),
      line("Employer ______________", 400),
    ]);
    const by = Object.fromEntries(out.map((s) => [s.label, s]));
    expect(out.map((s) => `${s.label}:${s.type}`)).toEqual([
      "Patient name:text", "Date of birth:date", "Phone:text", "Patient signature:signature", "Date:date", "Initials:initials", "Employer:text",
    ]);
    expect(by["Patient name"]).toMatchObject({ prefill: "patient_name", required: false, page: 0 });
    expect(by["Date of birth"]!.prefill).toBe("patient_dob");
    expect(by["Phone"]!.prefill).toBe("patient_phone");
    expect(by["Patient signature"]).toMatchObject({ required: true, prefill: null });
    expect(by["Initials"]!.required).toBe(true);
    // The box sits on the blank: to the right of the label, on that line, inside the page.
    const name = by["Patient name"]!;
    expect(name.x).toBeGreaterThan(60 + 40);
    expect(name.x + name.w).toBeLessThanOrEqual(60 + "Patient name: ______________________________".length * 6 + 1);
    expect(name.y).toBeLessThan(680);
    expect(name.y + name.h).toBeGreaterThan(680);
    // Two blanks on one line: the date box is to the right of the signature box.
    expect(by["Date"]!.x).toBeGreaterThan(by["Patient signature"]!.x + by["Patient signature"]!.w - 1);
    expect(by["Patient signature"]!.h).toBeGreaterThanOrEqual(26);
  });
  it("finds check boxes written as [ ] or a square", () => {
    const out = suggestBoxes(2, letter, [line("[  ] Lab results     [  ] Visit notes     [ ] Imaging", 500), line("☐ Yes  □ No", 460)]);
    expect(out.map((s) => `${s.type}:${s.label}`)).toEqual(["checkbox:Lab results", "checkbox:Visit notes", "checkbox:Imaging", "checkbox:Yes", "checkbox:No"]);
    expect(out.every((s) => s.page === 2 && s.w === s.h && s.w >= 9 && s.w <= 16)).toBe(true);
    expect(out[1]!.x).toBeGreaterThan(out[0]!.x + 60);
  });
  it("uses a separate run of underscores, or the free space after a label it recognises", () => {
    const sep = suggestBoxes(0, letter, [{ str: "Signature:", x: 60, y: 300, w: 58, h: 12 }, { str: "____________________", x: 124, y: 300, w: 140, h: 12 }]);
    expect(sep).toHaveLength(1);
    expect(sep[0]).toMatchObject({ type: "signature", x: 124, w: 140 });
    const free = suggestBoxes(0, letter, [{ str: "Date:", x: 60, y: 300, w: 30, h: 12 }, { str: "Witness name:", x: 300, y: 300, w: 80, h: 12 }]);
    expect(free.map((s) => s.type)).toEqual(["date", "text"]);
    expect(free[0]!.x + free[0]!.w).toBeLessThan(300);
    // A label with no colon and no blank, or ordinary sentences, get nothing.
    expect(suggestBoxes(0, letter, [line("Please sign and date this form before your visit.", 400), line("Signature of the provider is required", 380)])).toEqual([]);
  });
  it("never proposes a box on top of one that is already there, or twice in the same place", () => {
    const items = [line("Patient name: ______________________________", 680)];
    const first = suggestBoxes(0, letter, items);
    expect(first).toHaveLength(1);
    expect(suggestBoxes(0, letter, items, [{ page: 0, ...first[0]! }])).toEqual([]);
    expect(suggestBoxes(0, letter, items, [{ ...first[0]!, page: 1 }])).toHaveLength(1);
    expect(suggestBoxes(0, letter, [...items, ...items])).toHaveLength(1);
  });
});

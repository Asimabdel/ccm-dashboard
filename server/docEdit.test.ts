import { describe, expect, it } from "vitest";
import { cleanFields, isFilled, isMarkup, missingFor, type DocField, type DocPage } from "../shared/documents";
import { alignFields, duplicateFields, emptyHistory, fillOrder, keepOnPage, nudgeFields, redo, remember, repeatOnPages, snapMove, undo } from "../shared/docEdit";

const letter: DocPage = { w: 612, h: 792, rotate: 0 };
const small: DocPage = { w: 400, h: 500, rotate: 0 };
const box = (p: Partial<DocField>): DocField => ({ id: "a", type: "text", page: 0, x: 100, y: 600, w: 180, h: 20, assignee: "preparer", ...p });

describe("Documents editor: marks on the page", () => {
  it("keeps the new marks, with safe values", () => {
    const out = cleanFields([
      { id: "w", type: "whiteout", page: 0, x: 10, y: 10, w: 100, h: 16, value: "junk", required: true, assignee: "signer:7", prefill: "patient_name" },
      { id: "h", type: "highlight", page: 0, x: 10, y: 40, w: 100, h: 14 },
      { id: "m1", type: "mark", page: 0, x: 10, y: 70, w: 16, h: 16, value: "circle", color: "red" },
      { id: "m2", type: "mark", page: 0, x: 40, y: 70, w: 16, h: 16, value: "banana", color: "pink" },
      { id: "l", type: "line", page: 0, x: 10, y: 100, w: 100, h: 8, color: "blue" },
      { id: "s1", type: "stamp", page: 0, x: 10, y: 130, w: 110, h: 28, value: "  received\n<b>  " },
      { id: "s2", type: "stamp", page: 0, x: 10, y: 170, w: 110, h: 28, value: "" },
      { id: "g", type: "logo", page: 0, x: 10, y: 210, w: 54, h: 54, value: "x" },
      { id: "z", type: "sticker", page: 0, x: 10, y: 10, w: 10, h: 10 },
    ], [letter]);
    expect(out.map((f) => f.type)).toEqual(["whiteout", "highlight", "mark", "mark", "line", "stamp", "stamp", "logo"]);
    const by = Object.fromEntries(out.map((f) => [f.id, f]));
    // A mark is never someone's to fill in, never required, never auto-filled.
    expect(by.w).toMatchObject({ value: null, required: false, assignee: "preparer", prefill: null });
    expect(by.m1).toMatchObject({ value: "circle", color: "red" });
    expect(by.m2).toMatchObject({ value: "check", color: null });
    expect(by.l).toMatchObject({ value: null, color: "blue" });
    expect(by.s1!.value).toBe("received  b");
    expect(by.s2!.value).toBe("COPY");
    expect(by.g!.value).toBeNull();
    expect(out.every((f) => isMarkup(f.type))).toBe(true);
    expect(missingFor(out, "preparer")).toEqual([]);
  });
  it("leaves ordinary boxes as they were", () => {
    const [t, s, c] = cleanFields([
      { id: "t", type: "text", page: 0, x: 1, y: 1, w: 50, h: 20, value: "hello", required: true, assignee: "signer:3", prefill: "patient_name" },
      { id: "s", type: "signature", page: 0, x: 1, y: 40, w: 50, h: 20, value: "sig:12", required: true },
      { id: "c", type: "checkbox", page: 0, x: 1, y: 80, w: 14, h: 14, value: "yes" },
    ], [letter]);
    expect(t).toMatchObject({ value: "hello", required: true, assignee: "signer:3", prefill: "patient_name", color: null });
    expect(s).toMatchObject({ value: "sig:12", required: true });
    expect(c!.value).toBe("x");
    expect(isFilled(c!)).toBe(true);
  });
});

describe("Documents editor: copy, repeat, nudge, line up", () => {
  it("copies boxes a little to the side with new ids; a signature is not copied", () => {
    const fields = [box({ id: "t", value: "hello", acroName: "Name" }), box({ id: "s", type: "signature", value: "sig:5", y: 500 })];
    const copies = duplicateFields(fields, ["t", "s"], [letter]);
    expect(copies).toHaveLength(2);
    expect(copies[0]).toMatchObject({ type: "text", value: "hello", x: 112, y: 588, acroName: null });
    expect(copies[1]).toMatchObject({ type: "signature", value: null });
    expect(new Set([...fields, ...copies].map((f) => f.id)).size).toBe(4);
    // Onto another page, kept inside it.
    const [moved] = duplicateFields([box({ id: "t", x: 500, y: 700 })], ["t"], [letter, small], { page: 1, dx: 0, dy: 0 });
    expect(moved).toMatchObject({ page: 1, x: 220, y: 480 });
  });
  it("puts the same box on every other page at the same distance from the top, once", () => {
    const pages = [letter, small, letter];
    const fields = [box({ id: "i", type: "initials", x: 500, y: 30, w: 56, h: 28, value: "sig:9", assignee: "signer:4" })];
    const copies = repeatOnPages(fields, "i", pages);
    expect(copies.map((c) => c.page)).toEqual([1, 2]);
    // Page 2 is the same size: same place. Page 1 is smaller: same distance from the top, pulled inside the page.
    expect(copies[1]).toMatchObject({ x: 500, y: 30, assignee: "signer:4", value: null, type: "initials" });
    expect(copies[0]).toMatchObject({ x: 344, y: 0 });
    // Doing it again adds nothing.
    expect(repeatOnPages([...fields, ...copies], "i", pages)).toEqual([]);
    expect(repeatOnPages(fields, "nope", pages)).toEqual([]);
  });
  it("nudges with the arrow keys and stays on the page", () => {
    const [a, b] = nudgeFields([box({ id: "a" }), box({ id: "b" })], ["a"], 10, 10, [letter]);
    expect(a).toMatchObject({ x: 110, y: 590 }); // down the page = smaller y
    expect(b).toMatchObject({ x: 100, y: 600 });
    expect(nudgeFields([box({ id: "a", x: 0, y: 0 })], ["a"], -5, 5, [letter])[0]).toMatchObject({ x: 0, y: 0 });
    expect(keepOnPage({ x: 600, y: 790, w: 100, h: 20 }, letter)).toMatchObject({ x: 512, y: 772 });
  });
  it("lines boxes up with the first one picked", () => {
    const fields = [box({ id: "a", x: 100, y: 600, w: 180, h: 20 }), box({ id: "b", x: 140, y: 500, w: 90, h: 30 }), box({ id: "c", x: 300, y: 400 })];
    const by = (fs: DocField[]) => Object.fromEntries(fs.map((f) => [f.id, f]));
    expect(by(alignFields(fields, ["a", "b"], "left", [letter])).b).toMatchObject({ x: 100, y: 500 });
    expect(by(alignFields(fields, ["a", "b"], "right", [letter])).b).toMatchObject({ x: 190 });
    expect(by(alignFields(fields, ["a", "b"], "top", [letter])).b).toMatchObject({ y: 590 });
    expect(by(alignFields(fields, ["a", "b"], "bottom", [letter])).b).toMatchObject({ y: 600 });
    expect(by(alignFields(fields, ["a", "b"], "width", [letter])).b).toMatchObject({ w: 180, x: 140 });
    // Same height keeps the box's top edge where it was.
    expect(by(alignFields(fields, ["a", "b"], "height", [letter])).b).toMatchObject({ h: 20, y: 510 });
    // The anchor and boxes that weren't picked don't move; one box alone does nothing.
    expect(by(alignFields(fields, ["a", "b"], "left", [letter])).c).toEqual(fields[2]);
    expect(alignFields(fields, ["a"], "left", [letter])).toBe(fields);
  });
  it("snaps a dragged box onto the edges of nearby boxes on the same page", () => {
    const others = [box({ id: "o", x: 100, y: 600, w: 180, h: 20 }), box({ id: "p2", page: 1, x: 300, y: 300 })];
    const moving = { id: "m", page: 0, w: 90, h: 20 };
    expect(snapMove(moving, 103, 560, others, 5)).toEqual({ x: 100, y: 560, guideX: 100, guideY: null });
    expect(snapMove(moving, 193, 598, others, 5)).toEqual({ x: 190, y: 600, guideX: 280, guideY: 600 });
    expect(snapMove(moving, 150, 560, others, 5)).toMatchObject({ x: 145, guideX: 190 }); // middles line up
    expect(snapMove(moving, 320, 300, others, 5)).toEqual({ x: 320, y: 300, guideX: null, guideY: null }); // other page: ignored
    expect(snapMove(moving, 120, 560, others, 5)).toMatchObject({ x: 120, guideX: null }); // too far: left alone
  });
  it("walks through boxes page by page, top to bottom, left to right, skipping marks", () => {
    const fields = [
      box({ id: "p2", page: 1, y: 700 }), box({ id: "low", y: 100 }), box({ id: "right", x: 300, y: 601 }), box({ id: "left", x: 50, y: 600 }),
      box({ id: "stamp", type: "stamp", y: 780 }),
    ];
    expect(fillOrder(fields).map((f) => f.id)).toEqual(["left", "right", "low", "p2"]);
  });
  it("undoes and redoes", () => {
    let h = emptyHistory<number>();
    h = remember(h, 1);
    h = remember(h, 2);
    const u1 = undo(h, 3)!;
    expect(u1.value).toBe(2);
    const u2 = undo(u1.h, u1.value)!;
    expect(u2.value).toBe(1);
    expect(undo(u2.h, u2.value)).toBeNull();
    const r1 = redo(u2.h, u2.value)!;
    expect(r1.value).toBe(2);
    expect(redo(r1.h, r1.value)!.value).toBe(3);
    // A new change after undoing clears "redo".
    expect(redo(remember(u1.h, 9), 10)).toBeNull();
  });
});

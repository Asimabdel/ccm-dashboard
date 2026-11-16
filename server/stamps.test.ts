import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { cleanFields, type DocPage } from "../shared/documents";
import {
  STAMP_GALLERY, cleanDesign, fitSize, logoPrims, logoSize, roundedRectPath, stampDate, stampPrims, stampSize, textWidth, type Prim,
} from "../shared/stamps";

const letter: DocPage = { w: 612, h: 792, rotate: 0 };
const texts = (prims: Prim[]) => prims.filter((p): p is Extract<Prim, { t: "text" }> => p.t === "text");
/** Every piece stays inside the box (words measured with the same widths the PDF uses, give or take a point). */
function inside(prims: Prim[], w: number, h: number) {
  for (const p of prims) {
    if (p.t === "rect") { expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x + p.w).toBeLessThanOrEqual(w + 0.01); expect(p.y + p.h).toBeLessThanOrEqual(h + 0.01); }
    if (p.t === "circle") { expect(p.cx - p.r).toBeGreaterThanOrEqual(-0.01); expect(p.cx + p.r).toBeLessThanOrEqual(w + 0.01); }
    if (p.t === "text" && !p.rotate) {
      const tw = textWidth(p.text, p.size, p.bold);
      const left = p.anchor === "middle" ? p.x - tw / 2 : p.x;
      expect(left).toBeGreaterThanOrEqual(-1);
      expect(left + tw).toBeLessThanOrEqual(w + 1);
      expect(p.y).toBeLessThanOrEqual(h);
      expect(p.y - p.size * 0.72).toBeGreaterThanOrEqual(-1);
    }
  }
}

describe("Documents editor: stamps", () => {
  it("prints dates the way a date stamp does", () => {
    expect(stampDate("2026-11-16")).toBe("NOV 16, 2026");
    expect(stampDate("2026-01-05")).toBe("JAN 5, 2026");
    expect(stampDate(null)).toBe("");
    expect(stampDate("16/11/2026")).toBe("");
  });
  it("measures and fits words exactly like the PDF font", async () => {
    const pdf = await PDFDocument.create();
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const reg = await pdf.embedFont(StandardFonts.Helvetica);
    for (const s of [...STAMP_GALLERY.map((p) => p.word), "NOV 16, 2026", "BY: DR. SARAH CHEN", "MyPCP Dr", "MYPCP DR • KATY FAMILY MEDICINE • ", "Katy Family Medicine", "1234 Katy Fwy, Katy, TX 77494"]) {
      // The PDF font tightens some letter pairs (kerning), so real words can be a little narrower than measured,
      // never wider: what fits on screen always fits on paper.
      for (const [mine, real] of [[textWidth(s, 10, true), bold.widthOfTextAtSize(s, 10)], [textWidth(s, 10, false), reg.widthOfTextAtSize(s, 10)]]) {
        expect([s, mine >= real - 0.05]).toEqual([s, true]);
        expect([s, mine - real <= Math.max(0.3, real * 0.06)]).toEqual([s, true]);
      }
    }
    expect(fitSize("RECEIVED", 30, 20, true)).toBeCloseTo((20 * 30) / textWidth("RECEIVED", 20, true), 5);
    expect(fitSize("OK", 100, 12, true)).toBe(12);
  });
  it("draws every ready-made stamp inside its box, with its words", () => {
    for (const p of STAMP_GALLERY) {
      const size = stampSize(p.kind, p.word);
      const prims = stampPrims({ ...size, value: p.word, design: { kind: p.kind, date: "2026-11-16", by: "Dr. Sarah Chen", place: "MyPCP Dr · Katy Family Medicine" } });
      inside(prims, size.w, size.h);
      const words = texts(prims).map((t) => t.text);
      if (p.kind === "seal") {
        // The word and date in the middle; the office's name runs round the ring one letter at a time.
        expect(words).toContain(p.word);
        expect(words).toContain("NOV 16, 2026");
        const ring = texts(prims).filter((t) => t.rotate != null);
        expect(ring.map((t) => t.text).join("")).toBe("MYPCPDR·KATYFAMILYMEDICINE•");
        // …all at the same distance from the middle.
        const r = ring.map((t) => Math.hypot(t.x - size.w / 2, t.y - size.h / 2));
        expect(Math.max(...r) - Math.min(...r)).toBeLessThan(0.01);
      } else {
        expect(words[0]).toBe(p.word);
        if (p.kind === "dated") expect(words).toEqual([p.word, "NOV 16, 2026", "MYPCP DR · KATY FAMILY MEDICINE"]);
        if (p.kind === "signed") expect(words).toEqual([p.word, "BY: DR. SARAH CHEN", "DATE: NOV 16, 2026"]);
        if (p.kind === "plain") expect(words).toEqual([p.word]);
        // Double border, like a rubber stamp.
        expect(prims.filter((x) => x.t === "rect")).toHaveLength(2);
      }
    }
  });
  it("still fits when stretched, squeezed or given long words", () => {
    for (const [w, h] of [[300, 40], [60, 60], [90, 120], [400, 200]] as const) {
      for (const kind of ["plain", "dated", "signed"] as const) {
        inside(stampPrims({ w, h, value: "ENTERED IN ELECTRONIC HEALTH RECORD", design: { kind, date: "2026-12-31", by: "A very long reviewer name for testing", place: "MyPCP Dr · Highland Knolls Family Medicine" } }), w, h);
      }
    }
    // Blanks to write on when there is no name or date yet.
    expect(texts(stampPrims({ w: 170, h: 66, value: "APPROVED", design: { kind: "signed" } })).map((t) => t.text)).toEqual(["APPROVED", "BY: ______________", "DATE: ______________"]);
    // Long wording in a round seal goes on two lines, still inside the inner ring.
    const seal = stampPrims({ w: 96, h: 96, value: "Reviewed by provider", design: { kind: "seal", date: "2026-11-16", place: "MyPCP Dr" } });
    const middle = texts(seal).filter((t) => t.rotate == null);
    expect(middle.map((t) => t.text)).toEqual(["REVIEWED BY", "PROVIDER", "NOV 16, 2026"]);
    const innerRing = seal.filter((p): p is Extract<Prim, { t: "circle" }> => p.t === "circle")[1]!;
    for (const t of middle) {
      const half = textWidth(t.text, t.size, true) / 2;
      for (const [x, y] of [[t.x - half, t.y], [t.x + half, t.y], [t.x - half, t.y - t.size * 0.72], [t.x + half, t.y - t.size * 0.72]]) {
        expect(Math.hypot(x! - 48, y! - 48)).toBeLessThan(innerRing.r);
      }
    }
    expect(middle[0]!.size).toBeGreaterThan(5);
    // A dated stamp with no office line leaves it out.
    expect(texts(stampPrims({ w: 132, h: 60, value: "FAXED", design: { kind: "dated", date: "2026-11-16" } })).map((t) => t.text)).toEqual(["FAXED", "NOV 16, 2026"]);
  });
  it("keeps only well-formed stamp and logo details", () => {
    expect(cleanDesign("stamp", { kind: "seal", date: "2026-11-16", by: "  Dr. <b>Chen</b>\n", place: "x".repeat(200), extra: 1 }))
      .toEqual({ kind: "seal", date: "2026-11-16", by: "Dr. b Chen /b", place: "x".repeat(80) });
    expect(cleanDesign("stamp", { kind: "fancy", date: "tomorrow" })).toEqual({ kind: "plain", date: null, by: null, place: null });
    expect(cleanDesign("stamp", null)).toEqual({ kind: "plain", date: null, by: null, place: null });
    expect(cleanDesign("logo", { kind: "letterhead", place: "Katy Family Medicine", address: "1234 Katy Fwy", phone: "281-555-0101", date: "2026-11-16" }))
      .toEqual({ kind: "letterhead", place: "Katy Family Medicine", address: "1234 Katy Fwy", phone: "281-555-0101" });
    // Saved with the box; other boxes never carry a design.
    const [s, l, t] = cleanFields([
      { id: "s", type: "stamp", page: 0, x: 1, y: 1, w: 132, h: 60, value: "RECEIVED", color: "green", design: { kind: "dated", date: "2026-11-16", place: "MyPCP Dr" } },
      { id: "l", type: "logo", page: 0, x: 1, y: 100, w: 300, h: 62, design: { kind: "letterhead", place: "Katy" } },
      { id: "t", type: "text", page: 0, x: 1, y: 200, w: 100, h: 20, design: { kind: "seal" } },
    ], [letter]);
    expect(s).toMatchObject({ value: "RECEIVED", color: "green", design: { kind: "dated", date: "2026-11-16", place: "MyPCP Dr" } });
    expect(l).toMatchObject({ value: null, design: { kind: "letterhead", place: "Katy" } });
    expect(t!.design).toBeNull();
    // A stamp from before (no design) is a plain word stamp.
    const [old] = cleanFields([{ id: "o", type: "stamp", page: 0, x: 1, y: 1, w: 110, h: 28, value: "COPY" }], [letter]);
    expect(old!.design).toEqual({ kind: "plain", date: null, by: null, place: null });
  });
});

describe("Documents editor: logo", () => {
  it("draws the mark, the mark with the name, or a letterhead, inside the box", () => {
    const mark = logoPrims({ ...logoSize("mark"), design: { kind: "mark" } });
    expect(mark).toEqual([{ t: "brand", x: 0, y: 0, size: 54 }]);
    const full = logoPrims({ ...logoSize("full"), design: { kind: "full" } });
    expect(full.map((p) => p.t)).toEqual(["brand", "text"]);
    expect(texts(full)[0]).toMatchObject({ text: "MyPCP Dr", color: "brand", bold: true });
    inside(full, 150, 40);
    const head = logoPrims({ ...logoSize("letterhead"), design: { kind: "letterhead", place: "Katy Family Medicine", address: "1234 Katy Fwy, Katy, TX 77494", phone: "281-555-0101" } });
    expect(texts(head).map((t) => [t.text, t.color])).toEqual([
      ["MyPCP Dr", "brand"], ["Katy Family Medicine", "dark"], ["1234 Katy Fwy, Katy, TX 77494  ·  281-555-0101", "muted"],
    ]);
    inside(head, 300, 62);
    // With no office chosen yet, the letterhead is just the logo and the name.
    expect(texts(logoPrims({ w: 300, h: 62, design: { kind: "letterhead" } })).map((t) => t.text)).toEqual(["MyPCP Dr"]);
  });
  it("makes a closed rounded box for the PDF", () => {
    const d = roundedRectPath(100, 40, 6);
    expect(d.startsWith("M 6 0")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(roundedRectPath(10, 4, 50)).toContain("Q 10 0 10 2"); // the corner can't be rounder than the box
  });
});

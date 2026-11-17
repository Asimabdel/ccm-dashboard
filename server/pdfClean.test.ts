import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from "pdf-lib";
import { dropUnreachableObjects, replacePageWithPicture } from "./pdfClean";
import { pictureFitsPage, whiteoutPages } from "../shared/docPages";

// Made-up words only.
async function twoPages() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText("Made-up keep words", { x: 72, y: 700, size: 12, font });
  pdf.addPage([612, 792]).drawText("Made-up hidden words", { x: 72, y: 700, size: 12, font });
  return PDFDocument.load(await pdf.save());
}

/** Every non-picture stream in a saved PDF, unpacked, as text: what someone could dig out of the file. */
async function everythingInside(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  let out = "";
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && String(obj.dict.get(PDFName.of("Subtype")) ?? "") !== "/Image") {
      try { out += Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1"); } catch { /* unreadable */ }
    }
  }
  return out;
}
/** pdf-lib writes words as hex (<4D61…> Tj): look for them either way. */
const has = (inside: string, words: string) => inside.includes(words) || inside.toUpperCase().includes(Buffer.from(words, "latin1").toString("hex").toUpperCase());

/** A plain white PNG of the given size. */
function whitePng(w: number, h: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0xff);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("Removed means removed", () => {
  it("a removed page's words stay in the file unless the leftovers are dropped", async () => {
    const pdf = await twoPages();
    pdf.removePage(1);
    // The problem: pdf-lib still writes the removed page.
    expect(has(await everythingInside(await pdf.save()), "Made-up hidden words")).toBe(true);

    const again = await twoPages();
    again.removePage(1);
    expect(await dropUnreachableObjects(again)).toBeGreaterThan(0);
    const inside = await everythingInside(await again.save());
    expect(has(inside, "Made-up hidden words")).toBe(false);
    expect(has(inside, "Made-up keep words")).toBe(true);
    expect((await PDFDocument.load(await again.save())).getPageCount()).toBe(1);
  });

  it("white-out: the page becomes a picture, same size and turn, and its words are gone", async () => {
    const pdf = await twoPages();
    pdf.getPage(1).setRotation({ type: "degrees", angle: 90 } as never);
    const img = await pdf.embedPng(whitePng(153, 198)); // the page's shape (612 × 792)
    expect(pictureFitsPage(153, 198, 612, 792)).toBe(true);
    replacePageWithPicture(pdf, 1, img);
    await dropUnreachableObjects(pdf);
    const bytes = await pdf.save();
    const inside = await everythingInside(bytes);
    expect(has(inside, "Made-up hidden words")).toBe(false);
    expect(has(inside, "Made-up keep words")).toBe(true);
    const back = await PDFDocument.load(bytes);
    expect(back.getPageCount()).toBe(2);
    expect(back.getPage(1).getSize()).toEqual({ width: 612, height: 792 });
    expect(back.getPage(1).getRotation().angle).toBe(90);
    // The picture is on the page.
    expect(inside).toMatch(/\/Im\w*\s+Do|Do\b/);
  });

  it("knows which pages have white-out and whether a picture fits a page", () => {
    expect(whiteoutPages([{ type: "whiteout", page: 2 }, { type: "text", page: 0 }, { type: "whiteout", page: 0 }, { type: "whiteout", page: 2 }])).toEqual([0, 2]);
    expect(whiteoutPages([{ type: "highlight", page: 1 }])).toEqual([]);
    expect(pictureFitsPage(1700, 2200, 612, 792)).toBe(true);
    expect(pictureFitsPage(2200, 1700, 612, 792)).toBe(false);
    expect(pictureFitsPage(0, 10, 612, 792)).toBe(false);
  });
});

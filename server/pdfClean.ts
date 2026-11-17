// Keeping removed content out of a PDF. pdf-lib writes EVERY object it holds when it saves, including ones
// nothing points to anymore: a page that was removed or replaced (its words, its scanned picture) would still
// be inside the file, just not shown. These helpers make "removed" mean removed.
import { PDFArray, PDFDict, PDFDocument, PDFRef, PDFStream, degrees, type PDFImage, type PDFObject } from "pdf-lib";

/**
 * Delete every object that nothing in the document points to anymore (a removed page's words and pictures,
 * a removed form box…). Call after the changes and before saving. Returns how many objects were dropped.
 */
export async function dropUnreachableObjects(pdf: PDFDocument): Promise<number> {
  // Fonts, pictures and pages waiting to be embedded are written into the document first, so they count as used.
  await pdf.flush();
  const ctx = pdf.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo;
  for (const o of [t.Root, t.Info, t.Encrypt, t.ID]) if (o) stack.push(o as PDFObject);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) stack.push(v);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  let dropped = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) { ctx.delete(ref); dropped++; }
  }
  return dropped;
}

/**
 * Put a picture of a page in its place: same size, same visible area, same turn (so boxes on it stay put).
 * `onOldPage` runs on the old page before it goes (e.g. to take its fill-in boxes out of the form).
 * The caller drops the old page's leftovers with dropUnreachableObjects before saving.
 */
export function replacePageWithPicture(pdf: PDFDocument, page: number, img: PDFImage, onOldPage?: (old: ReturnType<PDFDocument["getPage"]>) => void) {
  const src = pdf.getPage(page);
  const mb = src.getMediaBox(), cb = src.getCropBox(), turn = src.getRotation().angle;
  const fresh = pdf.insertPage(page, [mb.width, mb.height]);
  fresh.setMediaBox(mb.x, mb.y, mb.width, mb.height);
  fresh.setCropBox(cb.x, cb.y, cb.width, cb.height);
  fresh.setRotation(degrees(turn));
  fresh.drawImage(img, { x: cb.x, y: cb.y, width: cb.width, height: cb.height });
  onOldPage?.(src);
  pdf.removePage(page + 1);
  return { width: cb.width, height: cb.height };
}

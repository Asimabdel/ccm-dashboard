// Page tools for the Documents editor (remove, move, turn a page): what happens to the boxes when the
// pages change. Pure, so it can be tested; the server uses the same rules when it rebuilds the PDF.
// Positions are PDF points with the origin at the page's lower-left (see DocField).
import type { DocField, DocPage } from "./documents";

export const MAX_DOC_PAGES = 200;

/** A quarter, half or three-quarter turn, clockwise. */
export const TURNS = [90, 180, 270] as const;
export type Turn = (typeof TURNS)[number];

/** One change to a draft's pages (page numbers start at 0). */
export type PageChange = { op: "remove"; page: number } | { op: "move"; page: number; to: number } | { op: "turn"; page: number; turn: Turn };

/**
 * How far the page's CONTENT has to be turned (clockwise) so the page reads the way it looks after the
 * turn, with no rotation flag left on it: the turn asked for plus any rotation the page already carried.
 */
export const contentTurn = (page: DocPage, turn: Turn): 0 | Turn => ((((page.rotate % 360) + 360 + turn) % 360) as 0 | Turn);

/** The page after its content was turned: sideways turns swap width and height; no rotation flag remains. */
export function turnedPage(page: DocPage, by: 0 | Turn): DocPage {
  return by === 90 || by === 270 ? { w: page.h, h: page.w, rotate: 0 } : { w: page.w, h: page.h, rotate: 0 };
}

/** Where a box lands when its page's content is turned clockwise by `by` (the box turns with the page). */
export function turnRect<T extends { x: number; y: number; w: number; h: number }>(r: T, by: 0 | Turn, page: DocPage): T {
  const W = page.w, H = page.h;
  if (by === 90) return { ...r, x: r.y, y: W - r.x - r.w, w: r.h, h: r.w };
  if (by === 180) return { ...r, x: W - r.x - r.w, y: H - r.y - r.h };
  if (by === 270) return { ...r, x: H - r.y - r.h, y: r.x, w: r.h, h: r.w };
  return r;
}

/** Boxes after one page was turned (only that page's boxes move). */
export function fieldsAfterTurn(fields: DocField[], page: number, by: 0 | Turn, old: DocPage): DocField[] {
  return fields.map((f) => (f.page === page ? turnRect(f, by, old) : f));
}

/** Boxes after a page was removed: its boxes go with it; boxes on later pages move up one page. */
export function fieldsAfterRemove(fields: DocField[], page: number): DocField[] {
  return fields.filter((f) => f.page !== page).map((f) => (f.page > page ? { ...f, page: f.page - 1 } : f));
}

/** The new order of the old page numbers when page `from` is moved to position `to`. */
export function movedOrder(count: number, from: number, to: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  if (from < 0 || from >= count || to < 0 || to >= count || from === to) return order;
  const [p] = order.splice(from, 1);
  order.splice(to, 0, p!);
  return order;
}

/** Boxes after pages were put in a new order (`order[newIndex] = oldIndex`): every box stays on its own page. */
export function fieldsAfterOrder(fields: DocField[], order: number[]): DocField[] {
  const newIndexOf = new Map(order.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  return fields.map((f) => { const n = newIndexOf.get(f.page); return n == null || n === f.page ? f : { ...f, page: n }; });
}

/** What kind of file is this, from its first bytes? (A PDF's marker can sit a little way in.) */
export function sniffFile(bytes: Uint8Array): "pdf" | "jpeg" | "png" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length > 7 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  const head = String.fromCharCode(...Array.from(bytes.subarray(0, 1024)));
  return head.includes("%PDF") ? "pdf" : null;
}

/** A photo or scan becomes a Letter page (turned sideways for a wide picture), the picture fitted inside a small margin. */
export function imagePageLayout(imgW: number, imgH: number): { pageW: number; pageH: number; x: number; y: number; w: number; h: number } {
  const wide = imgW > imgH * 1.05;
  const pageW = wide ? 792 : 612, pageH = wide ? 612 : 792, margin = 18;
  const s = Math.min((pageW - margin * 2) / Math.max(1, imgW), (pageH - margin * 2) / Math.max(1, imgH));
  const w = imgW * s, h = imgH * s;
  return { pageW, pageH, x: (pageW - w) / 2, y: (pageH - h) / 2, w, h };
}

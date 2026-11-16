// Editing helpers for the Documents editor, kept pure so they can be tested: copy boxes, repeat a
// box on every page, nudge, line boxes up, snap while dragging, and the order boxes are filled in.
// Positions are PDF points with the origin at the page's lower-left (see DocField).
import { isMarkup, type DocField, type DocPage } from "./documents";

export const newFieldId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

/** Keep a box on its page. */
export function keepOnPage<T extends Pick<DocField, "x" | "y" | "w" | "h">>(f: T, page: DocPage | undefined): T {
  if (!page) return f;
  return { ...f, x: clamp(f.x, 0, page.w - f.w), y: clamp(f.y, 0, page.h - f.h) };
}

/** What a copy of a box starts with: a signature can't be copied, and the copy isn't one of the PDF's own form boxes. */
function copyOf(f: DocField): DocField {
  const signed = f.type === "signature" || f.type === "initials";
  return { ...f, id: newFieldId(), value: signed ? null : f.value ?? null, acroName: null };
}

/** Copies of the chosen boxes, moved a little (or onto another page) so they don't sit exactly on top. Returns only the new boxes. */
export function duplicateFields(fields: DocField[], ids: string[], pages: DocPage[], opts: { dx?: number; dy?: number; page?: number } = {}): DocField[] {
  const dx = opts.dx ?? 12, dy = opts.dy ?? -12;
  return fields.filter((f) => ids.includes(f.id)).map((f) => {
    const page = opts.page != null && pages[opts.page] ? opts.page : f.page;
    return keepOnPage({ ...copyOf(f), page, x: f.x + dx, y: f.y + dy }, pages[page]);
  });
}

/**
 * The same box on every other page, at the same distance from the top-left corner (pages can differ in size).
 * A page that already has that box there is skipped, so doing it twice doesn't stack copies. Returns only the new boxes.
 */
export function repeatOnPages(fields: DocField[], id: string, pages: DocPage[]): DocField[] {
  const f = fields.find((x) => x.id === id);
  const from = f ? pages[f.page] : null;
  if (!f || !from) return [];
  const fromTop = from.h - (f.y + f.h);
  const out: DocField[] = [];
  pages.forEach((p, i) => {
    if (i === f.page) return;
    const at = keepOnPage({ x: f.x, y: p.h - fromTop - f.h, w: f.w, h: f.h }, p);
    const already = fields.some((o) => o.page === i && o.type === f.type && o.assignee === f.assignee && Math.abs(o.x - at.x) < 3 && Math.abs(o.y - at.y) < 3);
    if (!already) out.push({ ...copyOf(f), page: i, x: at.x, y: at.y });
  });
  return out;
}

/**
 * "Edit text": the two boxes that replace some printed words: white-out over the old words, and a text box on
 * top holding the same words at the same size, on the same baseline, ready to be retyped.
 * `run` is the printed text: where its baseline starts (x, y), its width and its letter height.
 */
export function editTextBoxes(page: number, size: DocPage, run: { str: string; x: number; y: number; w: number; h: number; bold?: boolean }): [DocField, DocField] {
  const s = clamp(Math.round((run.h || 10) * 10) / 10, 5, 36);
  const white: DocField = keepOnPage({ id: newFieldId(), type: "whiteout", page, x: run.x - 1.5, y: run.y - s * 0.28, w: run.w + 3, h: s * 1.25, assignee: "preparer" }, size);
  // Room to type a little more than was there; the words sit exactly where the old ones did (see drawValue).
  const w = Math.max(40, Math.min(size.w - (run.x - 2) - 4, run.w * 1.25 + 24));
  const text: DocField = keepOnPage({
    id: `${newFieldId()}t`, type: "text", page, x: run.x - 2, y: run.y - s * 0.375, w, h: s * 1.3, assignee: "preparer", value: run.str.slice(0, 2000), fontSize: s, label: "Edited text", bold: run.bold ? true : null,
  }, size);
  return [white, text];
}

/** Move boxes by a small step (arrow keys). `dy` is in screen terms: positive moves DOWN the page. */
export function nudgeFields(fields: DocField[], ids: string[], dx: number, dy: number, pages: DocPage[]): DocField[] {
  return fields.map((f) => (ids.includes(f.id) ? keepOnPage({ ...f, x: f.x + dx, y: f.y - dy }, pages[f.page]) : f));
}

export const ALIGN_HOWS = ["left", "right", "top", "bottom", "width", "height"] as const;
export type AlignHow = (typeof ALIGN_HOWS)[number];

/** Line the chosen boxes up with the FIRST one chosen (same edge), or give them its width / height. */
export function alignFields(fields: DocField[], ids: string[], how: AlignHow, pages: DocPage[]): DocField[] {
  const anchor = fields.find((f) => f.id === ids[0]);
  if (!anchor || ids.length < 2) return fields;
  return fields.map((f) => {
    if (f.id === anchor.id || !ids.includes(f.id)) return f;
    let n: DocField = f;
    if (how === "left") n = { ...f, x: anchor.x };
    else if (how === "right") n = { ...f, x: anchor.x + anchor.w - f.w };
    else if (how === "bottom") n = { ...f, y: anchor.y };
    else if (how === "top") n = { ...f, y: anchor.y + anchor.h - f.h };
    else if (how === "width") n = { ...f, w: anchor.w };
    else n = { ...f, h: anchor.h, y: f.y + f.h - anchor.h }; // keep its top edge where it is
    return keepOnPage(n, pages[f.page]);
  });
}

export interface Snap { x: number; y: number; guideX: number | null; guideY: number | null }

/**
 * While dragging a box: pull it onto the edges or the middle of the other boxes on the same page when it
 * is within `tol` points, and say where to draw the guide lines.
 */
export function snapMove(moving: Pick<DocField, "id" | "page" | "w" | "h">, x: number, y: number, fields: DocField[], tol: number): Snap {
  const others = fields.filter((o) => o.page === moving.page && o.id !== moving.id);
  let bestX: { d: number; to: number; guide: number } | null = null;
  let bestY: { d: number; to: number; guide: number } | null = null;
  for (const o of others) {
    // [where on the moving box, where on the other box]
    for (const [mine, theirs] of [[0, o.x], [0, o.x + o.w], [moving.w, o.x + o.w], [moving.w, o.x], [moving.w / 2, o.x + o.w / 2]] as const) {
      const d = Math.abs(x + mine - theirs);
      if (d <= tol && (!bestX || d < bestX.d)) bestX = { d, to: theirs - mine, guide: theirs };
    }
    for (const [mine, theirs] of [[0, o.y], [0, o.y + o.h], [moving.h, o.y + o.h], [moving.h, o.y], [moving.h / 2, o.y + o.h / 2]] as const) {
      const d = Math.abs(y + mine - theirs);
      if (d <= tol && (!bestY || d < bestY.d)) bestY = { d, to: theirs - mine, guide: theirs };
    }
  }
  return { x: bestX ? bestX.to : x, y: bestY ? bestY.to : y, guideX: bestX ? bestX.guide : null, guideY: bestY ? bestY.guide : null };
}

/** The order boxes are filled in: page by page, top to bottom, then left to right along a row. Marks are left out. */
export function fillOrder(fields: DocField[]): DocField[] {
  return fields.filter((f) => !isMarkup(f.type)).sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    const topA = a.y + a.h, topB = b.y + b.h;
    // Boxes whose tops are within a few points sit on the same row.
    if (Math.abs(topA - topB) > Math.min(a.h, b.h, 12) * 0.6) return topB - topA;
    return a.x - b.x;
  });
}

// ---- undo / redo ----

export interface History<T> { past: T[]; future: T[] }
export const HISTORY_MAX = 100;
export const emptyHistory = <T>(): History<T> => ({ past: [], future: [] });
/** Remember where things stood before a change (a new change clears "redo"). */
export const remember = <T>(h: History<T>, before: T): History<T> => ({ past: [...h.past, before].slice(-HISTORY_MAX), future: [] });
export function undo<T>(h: History<T>, now: T): { h: History<T>; value: T } | null {
  if (!h.past.length) return null;
  return { h: { past: h.past.slice(0, -1), future: [now, ...h.future].slice(0, HISTORY_MAX) }, value: h.past[h.past.length - 1]! };
}
export function redo<T>(h: History<T>, now: T): { h: History<T>; value: T } | null {
  if (!h.future.length) return null;
  return { h: { past: [...h.past, now].slice(-HISTORY_MAX), future: h.future.slice(1) }, value: h.future[0]! };
}

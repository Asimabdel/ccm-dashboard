// "Suggest boxes" for the Documents editor: read the words printed on a page and propose where the
// fill-in boxes go ("Patient name: ______", "Signature: ____", "Date: ____", "[ ] Lab results").
// Plain pattern matching on the page's own text (no AI, nothing leaves the browser). It only proposes:
// the person preparing the document checks every box, and one Undo takes them all back.
// Positions are PDF points with the origin at the page's lower-left (see DocField).
import type { DocField, DocPage, FieldType, PrefillKey } from "./documents";

/** One run of text on a page, as pdf.js reports it: where its baseline starts, its width and its letter height. */
export interface PageText { str: string; x: number; y: number; w: number; h: number }
export interface Suggestion { type: FieldType; page: number; x: number; y: number; w: number; h: number; label: string; prefill: PrefillKey | null; required: boolean }

export const MAX_SUGGESTIONS = 120;

// Rough letter widths (Helvetica-like), to find where inside a run of text a blank starts and ends.
const charWidth = (ch: string) => (ch === " " ? 0.28 : ch === "_" ? 0.556 : /[:.,;'|![\]ilIjt()/-]/.test(ch) ? 0.3 : /[mwMW@%]/.test(ch) ? 0.85 : /[A-Z0-9]/.test(ch) ? 0.64 : 0.52);
/** Where each character starts along the run, from 0 to 1 (one more entry than characters: the end). */
function charStarts(str: string): number[] {
  const out = [0];
  for (const ch of str) out.push(out[out.length - 1]! + charWidth(ch));
  const total = out[out.length - 1]! || 1;
  return out.map((v) => v / total);
}

interface Kind { type: FieldType; prefill: PrefillKey | null; required: boolean }
/** What a label is asking for. Null = nothing we recognise (a plain blank after it still gets a text box). */
function kindOf(label: string): Kind | null {
  const s = label.toLowerCase();
  if (/initial|inicial/.test(s)) return { type: "initials", prefill: null, required: true };
  if (/signature|sign here|\bsigned\b|firma/.test(s)) return { type: "signature", prefill: null, required: true };
  if (/birth|\bdob\b|d\.o\.b|nacimiento/.test(s)) return { type: "date", prefill: "patient_dob", required: false };
  if (/\bdate\b|fecha/.test(s)) return { type: "date", prefill: null, required: false };
  if (/phone|tel[eé]fono|\btel\b|\bcell\b/.test(s)) return { type: "text", prefill: /patient|paciente/.test(s) || /^\s*(phone|tel[eé]fono)\s*$/.test(s) ? "patient_phone" : null, required: false };
  if (/name|nombre/.test(s)) return { type: "text", prefill: /patient|paciente/.test(s) ? "patient_name" : null, required: false };
  return null;
}
const tidy = (label: string) => label.replace(/[_:]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ix > 0 && iy > 0 && ix * iy > 0.25 * Math.min(a.w * a.h, b.w * b.h);
};

/** The box for a blank that runs from `x` for `w` points along a baseline at `y`, for letters `h` tall. */
function boxFor(kind: Kind, x: number, w: number, y: number, h: number) {
  const letter = Math.max(7, Math.min(h || 10, 16));
  if (kind.type === "signature") return { x, y: y - 3, w: Math.max(80, Math.min(w, 280)), h: Math.max(26, letter * 2.4) };
  if (kind.type === "initials") return { x, y: y - 3, w: Math.max(40, Math.min(w, 90)), h: Math.max(22, letter * 2) };
  if (kind.type === "date") return { x, y: y - 3, w: Math.max(60, Math.min(w, 130)), h: Math.max(14, letter * 1.5) };
  return { x, y: y - 3, w: Math.max(40, w), h: Math.max(14, letter * 1.5) };
}

/**
 * Boxes proposed for one page. `existing` are boxes already on the page (nothing is proposed on top of them).
 * Handles: blanks after a label in the same run of text; a label followed by a separate run of underscores;
 * a label we recognise that ends with ":" and has free space to its right; and "[ ]" / "☐" check boxes.
 */
export function suggestBoxes(page: number, size: DocPage, items: PageText[], existing: Pick<DocField, "page" | "x" | "y" | "w" | "h">[] = []): Suggestion[] {
  const out: Suggestion[] = [];
  const taken = existing.filter((f) => f.page === page).map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h }));
  const add = (kind: Kind, box: { x: number; y: number; w: number; h: number }, label: string) => {
    const b = { ...box, w: Math.min(box.w, size.w - box.x - 2) };
    if (b.w < 8 || b.x < 0 || b.y < 0 || b.y + b.h > size.h) return;
    if (taken.some((t) => overlaps(t, b))) return;
    taken.push(b);
    out.push({ type: kind.type, page, ...b, label: tidy(label), prefill: kind.prefill, required: kind.required });
  };
  const text = items.filter((i) => i.str.trim() && i.w > 0);
  const sameLine = (a: PageText, b: PageText) => Math.abs(a.y - b.y) <= Math.max(a.h, b.h, 6) * 0.6;

  for (const it of text) {
    const starts = charStarts(it.str);
    const at = (i: number) => it.x + it.w * starts[Math.max(0, Math.min(i, starts.length - 1))]!;

    // "[ ] Lab results", "☐ Yes": a check box on the brackets.
    for (const m of Array.from(it.str.matchAll(/\[\s{0,3}\]|[☐□]/g))) {
      const s = Math.max(9, Math.min((it.h || 10) * 1.05, 16));
      const mid = (at(m.index!) + at(m.index! + m[0].length)) / 2;
      const after = it.str.slice(m.index! + m[0].length).split(/\[|☐|□/)[0] ?? "";
      add({ type: "checkbox", prefill: null, required: false }, { x: mid - s / 2, y: it.y - s * 0.18, w: s, h: s }, after);
    }

    // "Patient name: ________" (one or several on a line): a box over each blank.
    let found = false;
    for (const m of Array.from(it.str.matchAll(/([^_:]{0,60}?):?\s*(_{3,})/g))) {
      found = true;
      const label = m[1] ?? "";
      const runStart = m.index! + m[0].length - m[2]!.length;
      const kind = kindOf(label) ?? { type: "text" as FieldType, prefill: null, required: false };
      add(kind, boxFor(kind, at(runStart), at(runStart + m[2]!.length) - at(runStart), it.y, it.h), label);
    }
    if (found) continue;

    // "Signature:" with the blank as its own run of underscores to the right, or just free space to the right.
    const kind = kindOf(it.str);
    if (!kind || !/:\s*$/.test(it.str) || it.str.length > 48) continue;
    const right = text.filter((o) => o !== it && sameLine(it, o) && o.x >= it.x + it.w - 1).sort((a, b) => a.x - b.x)[0];
    const from = it.x + it.w + 4;
    if (right && /^[\s_]*_{3,}[\s_]*$/.test(right.str) && right.x - from < 40) add(kind, boxFor(kind, right.x, right.w, it.y, it.h), it.str);
    else {
      const room = (right ? right.x - 6 : size.w - 36) - from;
      if (room >= 50) add(kind, boxFor(kind, from, Math.min(room, kind.type === "signature" ? 180 : kind.type === "text" ? 160 : 90), it.y, it.h), it.str);
    }
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

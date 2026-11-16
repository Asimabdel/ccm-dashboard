// "Suggest boxes" for the Documents editor: read the words printed on a page and propose where the
// fill-in boxes go ("Patient name: ______", "Signature: ____", "Date: ____", "[ ] Lab results").
// Plain pattern matching on the page's own text (no AI, nothing leaves the browser). It only proposes:
// the person preparing the document checks every box, and one Undo takes them all back.
// Positions are PDF points with the origin at the page's lower-left (see DocField).
import { ABOUT_SOMEONE_ELSE, guessPrefill, type DocField, type DocPage, type FieldType, type PrefillKey } from "./documents";

/** One run of text on a page, as pdf.js reports it: where its baseline starts, its width and its letter height. */
export interface PageText { str: string; x: number; y: number; w: number; h: number; /** Printed in a bold font (when known). */ bold?: boolean }
export interface Suggestion { type: FieldType; page: number; x: number; y: number; w: number; h: number; label: string; prefill: PrefillKey | null; required: boolean }

export const MAX_SUGGESTIONS = 120;

/**
 * "Edit text": the printed words under a click, as one run. Pieces of the same line that sit close together
 * (a line is often stored as several pieces) are joined, so the whole phrase is picked up; a wide gap ends it.
 */
export function textRunAt(items: PageText[], x: number, y: number): PageText | null {
  const real = items.filter((i) => i.str.trim() && i.w > 0 && i.h > 0);
  const hit = real.find((i) => x >= i.x - 2 && x <= i.x + i.w + 2 && y >= i.y - i.h * 0.35 && y <= i.y + i.h * 1.05);
  if (!hit) return null;
  const line = real.filter((o) => Math.abs(o.y - hit.y) <= Math.max(o.h, hit.h) * 0.35).sort((a, b) => a.x - b.x);
  const near = (a: PageText, b: PageText) => b.x - (a.x + a.w) <= Math.max(a.h, b.h) * 0.9;
  let lo = line.indexOf(hit), hi = lo;
  while (lo > 0 && near(line[lo - 1]!, line[lo]!)) lo--;
  while (hi < line.length - 1 && near(line[hi]!, line[hi + 1]!)) hi++;
  const run = line.slice(lo, hi + 1);
  let str = "";
  run.forEach((it, i) => {
    const prev = run[i - 1];
    // Pieces with a visible gap between them were separate words.
    if (prev && it.x - (prev.x + prev.w) > Math.max(it.h, prev.h) * 0.15 && !/\s$/.test(str) && !/^\s/.test(it.str)) str += " ";
    str += it.str;
  });
  const first = run[0]!, last = run[run.length - 1]!;
  return { str: str.replace(/\s+/g, " ").trim(), x: first.x, y: hit.y, w: last.x + last.w - first.x, h: Math.max(...run.map((r) => r.h)), bold: !!hit.bold };
}

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
  // Anything else MyPCP holds on file (name, phone, address, insurance, provider, office…) is a text box it can fill in.
  const prefill = guessPrefill(tidy(label), "text");
  if (prefill || /phone|tel[eé]fono|\btel\b|\bcell\b|name|nombre/.test(s)) return { type: "text", prefill, required: false };
  return null;
}
const tidy = (label: string) => label.replace(/[_:]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ix > 0 && iy > 0 && ix * iy > 0.25 * Math.min(a.w * a.h, b.w * b.h);
};

// ---- "Read with AI": the practice's AI model looks at a picture of the page and says where the blanks are ----

/** Who the AI thinks fills a box. It becomes the start of the box's label ("Provider: signature"), so boxes can be picked by person. */
export const AI_WHO = ["patient", "provider", "staff", "witness", "other"] as const;
export type AiWho = (typeof AI_WHO)[number];
export const AI_WHO_LABELS: Record<AiWho, string> = { patient: "Patient", provider: "Provider", staff: "Staff", witness: "Witness", other: "Other" };
/** "Provider: signature" → "provider" (null when a label doesn't start with one of the names above). */
export function whoOfLabel(label: string | null | undefined): AiWho | null {
  const m = /^(patient|provider|staff|witness|other):/i.exec(label ?? "");
  return m ? (m[1]!.toLowerCase() as AiWho) : null;
}

export const AI_PAGE_PROMPT = `You are looking at ONE page of a paper form from a medical office. Find every place where a person is meant to write, tick or sign.

Return ONLY a JSON object, no other words. Each field is one short row: [type, label, who, left, top, right, bottom]
{"fields":[[TYPE, LABEL, WHO, LEFT, TOP, RIGHT, BOTTOM], [TYPE, LABEL, WHO, LEFT, TOP, RIGHT, BOTTOM]]}
(The capital words stand for real values you read from THIS page. Never copy these words, and do not invent blanks.)

Rules:
- type is one of: "text" (a blank line or empty box to write in), "date" (a blank for a date), "checkbox" (a small square, circle or bracket to tick), "signature" (a signature line), "initials" (a place for initials).
- left, top, right, bottom give the EMPTY area to write in (the blank line or box itself, NOT the printed label next to it), in whole numbers from 0 to 1000, where 0,0 is the top-left corner of the picture and 1000,1000 is the bottom-right corner. For a blank line, the box sits on the line and is as wide as the line. For a checkbox, the box is the small square itself.
- label is a few plain words saying what goes there, taken from the printed words next to it (for a checkbox, the option's wording).
- who is who fills it in: "patient" (the patient or their representative), "provider" (the doctor or clinician), "staff" (office staff), "witness", or "other" when the form does not make it clear.
- Include every blank, even if similar ones repeat. Do NOT include printed text, headings, or places that are already filled in or signed.
- At most 60 fields. If the page has no blanks, return {"fields":[]}.`;

/** Pull the JSON object out of the model's reply (it sometimes wraps it in a code fence or adds a sentence). */
export function parseAiFields(reply: string): unknown[] {
  const start = reply.indexOf("{"), end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const obj = JSON.parse(reply.slice(start, end + 1)) as { fields?: unknown };
    return Array.isArray(obj.fields) ? obj.fields.slice(0, 200) : [];
  } catch {
    return [];
  }
}

/**
 * The AI's answer for one page, checked and turned into boxes in page points. Anything malformed, tiny, or
 * covering a big part of the page is dropped; boxes are kept on the page and never placed on top of one that
 * is already there. The AI only proposes: every box is the preparer's to check.
 */
export function boxesFromAi(page: number, size: DocPage, raw: unknown[], existing: Pick<DocField, "page" | "x" | "y" | "w" | "h">[] = []): Suggestion[] {
  const out: Suggestion[] = [];
  const taken = existing.filter((f) => f.page === page).map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h }));
  const types: FieldType[] = ["text", "date", "checkbox", "signature", "initials"];
  for (const r of raw) {
    // A row is [type, label, who, left, top, right, bottom]; the longer {type, label, who, box} form is accepted too.
    const f = (Array.isArray(r) ? { type: r[0], label: r[1], who: r[2], box: r.slice(3, 7) } : r ?? {}) as Record<string, unknown>;
    const type = types.find((t) => t === f.type);
    const b = Array.isArray(f.box) && f.box.length === 4 && f.box.every((n) => typeof n === "number" && Number.isFinite(n)) ? (f.box as number[]).map((n) => Math.max(0, Math.min(1000, n))) : null;
    if (!type || !b) continue;
    const left = Math.min(b[0]!, b[2]!), right = Math.max(b[0]!, b[2]!), top = Math.min(b[1]!, b[3]!), bottom = Math.max(b[1]!, b[3]!);
    let x = (left / 1000) * size.w, w = ((right - left) / 1000) * size.w, h = ((bottom - top) / 1000) * size.h;
    let y = size.h - (bottom / 1000) * size.h;
    // Not a blank: a sliver, or a block of the page.
    if (w < 3 || h < 2 || (w > size.w * 0.97 && h > size.h * 0.2) || h > size.h * 0.35) continue;
    if (type === "checkbox") {
      const s = Math.max(9, Math.min(Math.max(w, h), 18));
      x = x + w / 2 - s / 2; y = y + h / 2 - s / 2; w = s; h = s;
    } else {
      // A blank line comes back very thin: give it the height someone needs to write on it, sitting on the line.
      const min = type === "signature" ? 26 : type === "initials" ? 22 : 14;
      const max = type === "signature" ? 60 : type === "initials" ? 40 : 44;
      if (h < min) h = min;
      if (h > max) { y += h - max; h = max; }
      w = Math.max(type === "date" ? 50 : type === "initials" ? 36 : 40, w);
    }
    x = Math.max(0, Math.min(x, size.w - w)); y = Math.max(0, Math.min(y, size.h - h));
    const box = { x, y, w: Math.min(w, size.w - x), h };
    if (taken.some((t) => overlaps(t, box))) continue;
    taken.push(box);
    let who = AI_WHO.find((k) => k === f.who) ?? "other";
    const words = tidy(typeof f.label === "string" ? f.label : "") || (type === "checkbox" ? "option" : type);
    // A blank about someone else (emergency contact, witness, guardian…) is not the patient's, whatever the AI said.
    if (who === "patient" && ABOUT_SOMEONE_ELSE.test(words)) who = /witness|testigo/i.test(words) ? "witness" : "other";
    // "Patient: Patient name" would be silly: the person is only put in front when the words don't already say it.
    const label = who === "other" || new RegExp(`^${who}\\b`, "i").test(words) ? words : `${AI_WHO_LABELS[who]}: ${words}`;
    out.push({
      type, page, ...box, label: label.slice(0, 110),
      // Only the patient's own details are on file; a provider's or witness's "name" is never filled from the patient.
      prefill: who === "patient" || who === "other" ? guessPrefill(words, type) : who === "provider" && type === "text" ? guessPrefill(`provider ${words}`, type) : null,
      required: type === "signature" || type === "initials",
    });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  // "Emergency contact name: ____  Phone: ____": a box further along the same line as a blank about someone else
  // is about them too (the AI sometimes calls it the patient's). It is named so, and never filled from the patient.
  const sameRow = (a: Suggestion, b: Suggestion) => Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) <= Math.max(6, Math.min(a.h, b.h) * 0.6);
  for (const s of out) {
    if (/patient|paciente/i.test(s.label.replace(/^patient:\s*/i, "")) || ABOUT_SOMEONE_ELSE.test(s.label)) continue;
    const before = out.filter((o) => o !== s && o.page === s.page && sameRow(o, s) && o.x < s.x && ABOUT_SOMEONE_ELSE.test(o.label)).sort((a, b) => b.x - a.x)[0];
    if (!before) continue;
    const words = s.label.replace(/^(patient|provider|staff|witness|other):\s*/i, "");
    s.label = `${before.label.replace(/^(patient|provider|staff|witness|other):\s*/i, "")}: ${words}`.slice(0, 110);
    s.prefill = null;
  }
  return out;
}

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
    // "Emergency contact name: ____   Phone: ____": the phone on that line is the contact's, not the patient's.
    let someoneElse: string | null = null;
    for (const m of Array.from(it.str.matchAll(/([^_:]{0,60}?):?\s*(_{3,})/g))) {
      found = true;
      let label = m[1] ?? "";
      if (ABOUT_SOMEONE_ELSE.test(label)) someoneElse = tidy(label);
      else if (someoneElse && !/patient|paciente/i.test(label)) label = `${someoneElse}: ${tidy(label)}`;
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

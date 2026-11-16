// The work / school excuse note: one Letter page with the provider's letterhead, the wording printed on the
// page, and boxes on every blank (patient, dates, work / school, restrictions, the provider's signature).
// The server prints the wording and draws the blanks; the boxes are ordinary document boxes, so the note is
// filled in, signed and finished like any other document. Pure: shared by the server and the tests.
import type { Assignee, DocField } from "./documents";
import { PRACTICE_FAX, PRACTICE_PHONE, officeShortName, textWidth } from "./stamps";

export const NOTE_PAGE = { w: 612, h: 792 };
const L = 72, R = 540;

/** Words printed on the page: `b` is the baseline, measured from the TOP of the page. */
export interface NoteText { x: number; b: number; size: number; bold?: boolean; muted?: boolean; text: string; center?: boolean }
/** A line (blank to write on, or the coloured rule under the letterhead), top-based. */
export interface NoteLine { x1: number; x2: number; top: number; rule?: boolean }
/** A printed square for a check box, top-based. */
export interface NoteSquare { x: number; top: number; size: number }

export interface ExcuseNoteInput {
  /** The provider as they appear on letters ("Sudad Al Hadad, MD"). */
  who: string;
  office: { name: string | null; address: string | null } | null;
  /** YYYY-MM-DD. */
  today: string;
  /** Who signs the signature box: the person making the note, or the provider as a co-signer. */
  signer: Assignee;
}

export function excuseNoteLayout(o: ExcuseNoteInput) {
  const texts: NoteText[] = [], lines: NoteLine[] = [], squares: NoteSquare[] = [], fields: DocField[] = [];
  const pdfY = (top: number, h: number) => NOTE_PAGE.h - top - h;
  const say = (text: string, x: number, b: number, size = 12, extra: Partial<NoteText> = {}) => { texts.push({ text, x, b, size, ...extra }); return x + textWidth(text, size, !!extra.bold); };
  /** A blank to write on from x1 to x2 on baseline b, with a box sitting on it. */
  const blank = (id: string, type: "text" | "date", label: string, x1: number, x2: number, b: number, extra: Partial<DocField> = {}) => {
    lines.push({ x1, x2, top: b + 2 });
    fields.push({ id, type, page: 0, x: x1 + 2, y: pdfY(b + 2 - 18, 18), w: x2 - x1 - 4, h: 18, assignee: "preparer", label, fontSize: 12, value: null, ...extra });
  };
  const check = (id: string, label: string, x: number, b: number) => {
    squares.push({ x, top: b - 10, size: 11 });
    fields.push({ id, type: "checkbox", page: 0, x, y: pdfY(b - 10, 11), w: 11, h: 11, assignee: "preparer", label, value: "" });
    return say(label, x + 17, b);
  };

  // The letterhead (an ordinary logo box, so it can be changed in the editor like any other) and a rule under it.
  const place = officeShortName(o.office?.name);
  fields.push({
    id: "letterhead", type: "logo", page: 0, x: 60, y: pdfY(34, 84), w: 400, h: 84, assignee: "preparer", value: null,
    design: { kind: "letterhead", who: o.who || null, place, address: o.office?.address ?? null, phone: PRACTICE_PHONE, fax: PRACTICE_FAX },
  });
  lines.push({ x1: 60, x2: 552, top: 132, rule: true });

  const dateX = say("Date:", 392, 168);
  blank("date", "date", "Date", dateX + 6, R, 168, { value: o.today, required: true });
  say("WORK / SCHOOL EXCUSE", NOTE_PAGE.w / 2, 214, 17, { bold: true, center: true });
  say("To whom it may concern:", L, 254);

  blank("patient_name", "text", "Patient name", say("Patient name:", L, 292) + 6, 330, 292, { prefill: "patient_name", required: true });
  blank("patient_dob", "date", "Date of birth", say("Date of birth:", 342, 292) + 6, R, 292, { prefill: "patient_dob" });
  blank("seen_on", "date", "Seen on", say("The patient named above was seen in our office on", L, 326) + 6, 458, 326, { value: o.today, required: true });

  let x = say("Please excuse the patient from:", L, 362) + 14;
  x = check("work", "Work", x, 362) + 22;
  check("school", "School", x, 362);
  blank("from", "date", "Excused from", say("From:", L, 398) + 6, 216, 398);
  blank("through", "date", "Excused through", say("Through:", 234, 398) + 6, 400, 398);
  blank("return_on", "date", "May return on", say("The patient may return on:", L, 434) + 6, 352, 434);
  check("no_restrictions", "With no restrictions", L, 468);
  const rx = check("restrictions_yes", "With these restrictions:", L, 498);
  blank("restrictions", "text", "Restrictions", rx + 6, R, 498);
  blank("comments", "text", "Comments", say("Comments:", L, 534) + 6, R, 534);
  blank("comments_more", "text", "Comments (more)", L, R, 562);

  say(`If you have any questions, please call our office at ${PRACTICE_PHONE}.`, L, 602, 10.5, { muted: true });
  say("Sincerely,", L, 634);

  // The provider's signature on a line, the date beside it, the printed name under it.
  lines.push({ x1: L, x2: 300, top: 692 });
  fields.push({ id: "signature", type: "signature", page: 0, x: L + 2, y: pdfY(692 - 40, 40), w: 224, h: 40, assignee: o.signer, label: "Provider signature", required: true, value: null });
  say("Provider signature", L, 705, 9, { muted: true });
  blank("signed_on", "date", "Date signed", say("Date:", 360, 690) + 6, 500, 690, { assignee: o.signer, value: o.today });
  // The printed name: a bold box (not printed on the page), so it can be corrected along with the letterhead.
  fields.push({ id: "signed_by", type: "text", page: 0, x: L, y: pdfY(726 - 16, 16), w: 300, h: 16, assignee: "preparer", label: "Signed by", fontSize: 11.5, bold: true, value: o.who || null });

  return { page: NOTE_PAGE, texts, lines, squares, fields };
}

/** How a provider's name prints on letters: what was set for letters, else their name and title. */
export function letterNameOf(p: { letterName?: string | null; name?: string | null; userName?: string | null; title?: string | null }) {
  const set = p.letterName?.trim();
  if (set) return set;
  const base = (p.userName || p.name || "").trim();
  const title = p.title?.trim();
  return base && title && !base.includes(title) ? `${base}, ${title}` : base;
}

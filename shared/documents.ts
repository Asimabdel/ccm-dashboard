// Documents (our own DocuSign): upload a PDF, place boxes on it (text, date, checkbox, signature,
// initials), fill in your part, send it to teammates to sign, and get a flattened, signed PDF with a
// certificate page. Shared by the server (validation, PDF building) and the editor.

export const FIELD_TYPES = ["text", "date", "checkbox", "signature", "initials"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_LABELS: Record<FieldType, string> = { text: "Text", date: "Date", checkbox: "Checkbox", signature: "Signature", initials: "Initials" };

/** Size of a new box, in PDF points (1/72 inch). */
export const FIELD_DEFAULT_SIZE: Record<FieldType, { w: number; h: number }> = {
  text: { w: 180, h: 20 }, date: { w: 90, h: 20 }, checkbox: { w: 14, h: 14 }, signature: { w: 170, h: 38 }, initials: { w: 56, h: 28 },
};

/** Things MyPCP can fill in for you when a document is started for a patient. */
export const PREFILL_KEYS = ["patient_name", "patient_dob", "patient_phone", "today", "my_name", "clinic_name"] as const;
export type PrefillKey = (typeof PREFILL_KEYS)[number];
export const PREFILL_LABELS: Record<PrefillKey, string> = {
  patient_name: "Patient name", patient_dob: "Patient date of birth", patient_phone: "Patient phone", today: "Today's date", my_name: "My name", clinic_name: "Office name",
};

export const DOC_STATUSES = ["draft", "signing", "completed", "cancelled"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];
export const DOC_STATUS_LABELS: Record<DocStatus, string> = { draft: "Draft", signing: "Out for signature", completed: "Completed", cancelled: "Cancelled" };

/** "preparer" = whoever is preparing the document fills it in now; "signer:<userId>" = a teammate signs it later. */
export type Assignee = "preparer" | `signer:${number}`;
export const signerOf = (a: string): number | null => { const m = /^signer:(\d+)$/.exec(a); return m ? Number(m[1]) : null; };

/**
 * One box on a page. Position is in PDF user space (points, origin at the page's lower-left), the
 * same space pdf-lib draws in, so what's placed in the editor lands exactly there in the final PDF.
 */
export interface DocField {
  id: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  assignee: Assignee;
  label?: string;
  required?: boolean;
  fontSize?: number | null;
  /** text: the words · date: YYYY-MM-DD · checkbox: "x" or "" · signature/initials: "sig:<documentSignatures.id>" */
  value?: string | null;
  prefill?: PrefillKey | null;
  /** The PDF's own form field this box came from (fillable PDFs). */
  acroName?: string | null;
}

export interface DocPage { w: number; h: number; rotate: number }

const num = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);

/** Keep only well-formed boxes on real pages (the editor and the server both use this). */
export function cleanFields(raw: unknown, pages: DocPage[]): DocField[] {
  if (!Array.isArray(raw)) return [];
  const out: DocField[] = [];
  const ids = new Set<string>();
  for (const r of raw.slice(0, 600)) {
    const f = (r ?? {}) as Record<string, unknown>;
    const type = f.type as FieldType;
    if (!FIELD_TYPES.includes(type)) continue;
    // A box on a page that doesn't exist is dropped (never moved onto another page).
    const page = typeof f.page === "number" && Number.isInteger(f.page) && f.page >= 0 && f.page < pages.length ? f.page : null;
    if (page == null) continue;
    const p = pages[page]!;
    const size = Math.max(p.w, p.h);
    const x = num(f.x, -size, size), y = num(f.y, -size, size), w = num(f.w, 4, size), h = num(f.h, 4, size);
    if (x == null || y == null || w == null || h == null) continue;
    const id = typeof f.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(f.id) && !ids.has(f.id) ? f.id : `f${out.length}_${Math.random().toString(36).slice(2, 8)}`;
    ids.add(id);
    const assignee = f.assignee === "preparer" || (typeof f.assignee === "string" && /^signer:\d+$/.test(f.assignee)) ? (f.assignee as Assignee) : "preparer";
    let value = typeof f.value === "string" ? f.value.slice(0, 2000) : null;
    if (type === "checkbox") value = value ? "x" : "";
    if (type === "date" && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) value = null;
    if ((type === "signature" || type === "initials") && value && !/^sig:\d+$/.test(value)) value = null;
    out.push({
      id, type, page, x, y, w, h, assignee,
      label: typeof f.label === "string" ? f.label.slice(0, 120) : undefined,
      required: !!f.required,
      fontSize: num(f.fontSize, 5, 36),
      value,
      prefill: PREFILL_KEYS.includes(f.prefill as PrefillKey) ? (f.prefill as PrefillKey) : null,
      acroName: typeof f.acroName === "string" ? f.acroName.slice(0, 200) : null,
    });
  }
  return out;
}

/** Is this box filled in (for "required" checks)? A checkbox counts when ticked. */
export const isFilled = (f: DocField) => (f.type === "checkbox" ? f.value === "x" : !!f.value?.trim());

/** Required boxes this person still has to fill. */
export const missingFor = (fields: DocField[], assignee: Assignee) => fields.filter((f) => f.assignee === assignee && f.required && !isFilled(f));

/** YYYY-MM-DD → MM/DD/YYYY (how dates print on the PDF). */
export function usDate(v: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v ?? "");
  return m ? `${m[2]}/${m[3]}/${m[1]}` : v ?? "";
}

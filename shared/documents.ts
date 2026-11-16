// Documents (our own DocuSign): upload a PDF, place boxes on it (text, date, checkbox, signature,
// initials), fill in your part, send it to teammates to sign, and get a flattened, signed PDF with a
// certificate page. Shared by the server (validation, PDF building) and the editor.

export const FIELD_TYPES = ["text", "date", "checkbox", "signature", "initials", "whiteout", "highlight", "mark", "line", "stamp", "logo"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_LABELS: Record<FieldType, string> = {
  text: "Text", date: "Date", checkbox: "Checkbox", signature: "Signature", initials: "Initials",
  whiteout: "White-out", highlight: "Highlight", mark: "Mark", line: "Line", stamp: "Stamp", logo: "Logo",
};

/** Boxes somebody fills in or signs. */
export const FILL_TYPES: readonly FieldType[] = ["text", "date", "checkbox", "signature", "initials"];
/**
 * Marks the person preparing the document draws on the page (cover text, highlight, tick, cross out, stamp).
 * Nobody fills them in, they are never "required", and they print exactly as placed.
 */
export const MARKUP_TYPES: readonly FieldType[] = ["whiteout", "highlight", "mark", "line", "stamp", "logo"];
export const isMarkup = (t: FieldType) => MARKUP_TYPES.includes(t);

/** A "mark" is a tick, a cross or a circle (its `value`). */
export const MARK_STYLES = ["check", "x", "circle"] as const;
export type MarkStyle = (typeof MARK_STYLES)[number];
export const MARK_LABELS: Record<MarkStyle, string> = { check: "Check ✓", x: "X ✗", circle: "Circle ○" };

/** How thick a tick, cross or circle is drawn, in points (the editor and the signed PDF use the same). */
export const markPen = (f: { w: number; h: number }) => Math.max(1, Math.min(2.5, Math.min(f.w, f.h) * 0.1));

/** Ink for marks, lines and stamps. */
export const INK_COLORS = ["black", "red", "blue"] as const;
export type InkColor = (typeof INK_COLORS)[number];
export const INK_HEX: Record<InkColor, string> = { black: "#0f172a", red: "#c81e1e", blue: "#1d4ed8" };
export const inkOf = (c: string | null | undefined, fallback: InkColor = "black"): InkColor => (INK_COLORS.includes(c as InkColor) ? (c as InkColor) : fallback);
/** Ready-made stamp wording (any short text can be typed instead). */
export const STAMP_PRESETS = ["COPY", "FAXED", "RECEIVED", "APPROVED", "VOID", "DRAFT", "CONFIDENTIAL"] as const;
export const STAMP_MAX = 40;

/** Size of a new box, in PDF points (1/72 inch). */
export const FIELD_DEFAULT_SIZE: Record<FieldType, { w: number; h: number }> = {
  text: { w: 180, h: 20 }, date: { w: 90, h: 20 }, checkbox: { w: 14, h: 14 }, signature: { w: 170, h: 38 }, initials: { w: 56, h: 28 },
  whiteout: { w: 140, h: 16 }, highlight: { w: 140, h: 14 }, mark: { w: 16, h: 16 }, line: { w: 140, h: 8 }, stamp: { w: 110, h: 28 }, logo: { w: 54, h: 54 },
};

/** Things MyPCP can fill in for you when a document is started for a patient. */
export const PREFILL_KEYS = [
  "patient_name", "patient_dob", "patient_phone", "patient_email", "patient_address", "patient_sex", "patient_mrn",
  "insurance_name", "insurance_member_id", "insurance_group", "provider_name", "provider_npi",
  "clinic_name", "clinic_phone", "clinic_address", "today", "my_name",
] as const;
export type PrefillKey = (typeof PREFILL_KEYS)[number];
export const PREFILL_LABELS: Record<PrefillKey, string> = {
  patient_name: "Patient name", patient_dob: "Patient date of birth", patient_phone: "Patient phone", patient_email: "Patient email", patient_address: "Patient address",
  patient_sex: "Patient sex", patient_mrn: "Chart number (MRN)", insurance_name: "Insurance name", insurance_member_id: "Insurance member ID", insurance_group: "Insurance group number",
  provider_name: "Patient's provider", provider_npi: "Provider NPI", clinic_name: "Office name", clinic_phone: "Office phone", clinic_address: "Office address",
  today: "Today's date", my_name: "My name",
};

/**
 * What a box's label is asking for, when it is something MyPCP holds on file ("Patient name", "DOB", "Member ID",
 * "Office phone"…). Null when unsure: a box about someone else (witness, guardian, emergency contact, employer)
 * or a plain "Date" (whose date depends on who signs) is never guessed.
 */
/** A label about somebody other than the patient (their details are not on file, and must never be filled with the patient's). */
export const ABOUT_SOMEONE_ELSE = /witness|guardian|emergency|spouse|employer|pharmacy|relative|representative|parent|next of kin|referring|referred|sponsor|guarantor|testigo|tutor|emergencia/i;

export function guessPrefill(label: string | null | undefined, type: FieldType): PrefillKey | null {
  const s = (label ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!s || (type !== "text" && type !== "date")) return null;
  if (ABOUT_SOMEONE_ELSE.test(s)) return null;
  if (type === "date") return /birth|\bdob\b|d\.o\.b|nacimiento/.test(s) ? "patient_dob" : null;
  if (/birth|\bdob\b|d\.o\.b|nacimiento/.test(s)) return "patient_dob";
  const office = /clinic|office|practice|facility|cl[ií]nica|consultorio/.test(s);
  const doctor = /provider|physician|doctor|\bdr\b|\bpcp\b|m[eé]dico|proveedor/.test(s);
  if (/\bnpi\b/.test(s)) return "provider_npi";
  if (/e-?mail|correo/.test(s)) return office || doctor ? null : "patient_email";
  if (/address|direcci[oó]n|domicilio|street/.test(s)) return office ? "clinic_address" : doctor ? null : "patient_address";
  if (/\bfax\b/.test(s)) return null;
  if (/phone|tel[eé]fono|\btel\b|\bcell\b|mobile|celular/.test(s)) return office ? "clinic_phone" : doctor ? null : "patient_phone";
  if (/group\s*(#|no\b|number|num)|n[uú]mero de grupo/.test(s)) return "insurance_group";
  if (/member|subscriber|policy\s*(#|no\b|number|id)|\bid\s*(#|no\b|number)|n[uú]mero de (miembro|p[oó]liza)/.test(s)) return "insurance_member_id";
  if (/insurance|insurer|\bpayer\b|health plan|aseguranza|seguro/.test(s)) return "insurance_name";
  if (/\bmrn\b|chart\s*(#|no\b|number)|medical record (#|no\b|number)/.test(s)) return "patient_mrn";
  if (/\bsex\b|gender|sexo/.test(s)) return "patient_sex";
  if (doctor) return /signature|firma|sign/.test(s) ? null : "provider_name";
  if (office) return "clinic_name";
  if (/name|nombre/.test(s)) return /patient|paciente|client\b/.test(s) || /^(full |legal |print(ed)? )?(name|nombre)( completo)?$/.test(s) ? "patient_name" : null;
  return null;
}

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
  /**
   * text: the words · date: YYYY-MM-DD · checkbox: "x" or "" · signature/initials: "sig:<documentSignatures.id>"
   * · mark: "check" | "x" | "circle" · stamp: its wording · white-out / highlight / line / logo: nothing
   */
  value?: string | null;
  prefill?: PrefillKey | null;
  /** The PDF's own form field this box came from (fillable PDFs). */
  acroName?: string | null;
  /** Ink for a mark, line or stamp (black when not set; stamps default to red). */
  color?: InkColor | null;
  /** A text box printed in bold (e.g. a bold heading retyped with "Edit text"). */
  bold?: boolean | null;
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
    const markup = isMarkup(type);
    // A mark on the page always belongs to the person preparing the document.
    const assignee = !markup && (f.assignee === "preparer" || (typeof f.assignee === "string" && /^signer:\d+$/.test(f.assignee))) ? (f.assignee as Assignee) : "preparer";
    let value = typeof f.value === "string" ? f.value.slice(0, 2000) : null;
    if (type === "checkbox") value = value ? "x" : "";
    if (type === "date" && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) value = null;
    if ((type === "signature" || type === "initials") && value && !/^sig:\d+$/.test(value)) value = null;
    if (type === "mark") value = MARK_STYLES.includes(value as MarkStyle) ? value : "check";
    if (type === "stamp") value = (value ?? "").replace(/[\r\n<>]/g, " ").trim().slice(0, STAMP_MAX) || STAMP_PRESETS[0];
    if (type === "whiteout" || type === "highlight" || type === "line" || type === "logo") value = null;
    out.push({
      id, type, page, x, y, w, h, assignee,
      label: typeof f.label === "string" ? f.label.slice(0, 120) : undefined,
      required: !markup && !!f.required,
      fontSize: num(f.fontSize, 5, 36),
      bold: type === "text" && f.bold === true ? true : null,
      value,
      prefill: !markup && PREFILL_KEYS.includes(f.prefill as PrefillKey) ? (f.prefill as PrefillKey) : null,
      acroName: typeof f.acroName === "string" ? f.acroName.slice(0, 200) : null,
      color: INK_COLORS.includes(f.color as InkColor) ? (f.color as InkColor) : null,
    });
  }
  return out;
}

/** Is this box filled in (for "required" checks)? A checkbox counts when ticked. */
export const isFilled = (f: DocField) => (f.type === "checkbox" ? f.value === "x" : !!f.value?.trim());

/** Required boxes this person still has to fill. */
export const missingFor = (fields: DocField[], assignee: Assignee) => fields.filter((f) => f.assignee === assignee && f.required && !isFilled(f));

/** How the provider approved staff applying their signature. */
export const APPROVAL_METHODS = ["in_person", "phone", "text", "other"] as const;
export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];
export const APPROVAL_LABELS: Record<ApprovalMethod, string> = { in_person: "In person", phone: "By phone", text: "By text message", other: "Other" };
/** Shown wherever staff apply a provider's signature. */
export const PROVIDER_SIGNATURE_RULE =
  "For administrative documents only (forms, letters, records requests, work or school notes). Medicare orders, prescriptions and medical-record entries must be signed by the provider personally: add them under \"Who else signs\" instead.";

/** YYYY-MM-DD → MM/DD/YYYY (how dates print on the PDF). */
export function usDate(v: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v ?? "");
  return m ? `${m[2]}/${m[3]}/${m[1]}` : v ?? "";
}

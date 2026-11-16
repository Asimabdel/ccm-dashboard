// Stamps and the logo for the Documents editor: what each one looks like, as a list of simple drawing
// pieces (boxes, circles, lines, words, the brand mark) in the box's own points, top-left origin.
// The editor draws the pieces as SVG and the signed PDF draws the very same pieces with pdf-lib, so a
// stamp prints exactly as it looks on screen. Pure: shared by the server and the editor.

export const STAMP_KINDS = ["plain", "dated", "signed", "seal"] as const;
export type StampKind = (typeof STAMP_KINDS)[number];
export const STAMP_KIND_LABELS: Record<StampKind, string> = { plain: "Word", dated: "With date", signed: "Reviewed by + date", seal: "Round seal" };
export const LOGO_KINDS = ["mark", "full", "letterhead"] as const;
export type LogoKind = (typeof LOGO_KINDS)[number];
export const LOGO_LABELS: Record<LogoKind, string> = { mark: "Logo", full: "Logo + name", letterhead: "Letterhead" };

/** The extra details a stamp or the logo carries (all optional; what each kind uses is shown in the editor). */
export interface MarkDesign {
  kind?: string | null;
  /** YYYY-MM-DD (dated / signed / seal stamps). */
  date?: string | null;
  /** Who reviewed / approved (signed stamps). */
  by?: string | null;
  /** The office line (dated stamps, seal ring, letterhead). */
  place?: string | null;
  /** Letterhead only: the provider's name as it prints on letters ("Sudad Al Hadad, MD"), address, phone, fax. */
  who?: string | null;
  address?: string | null;
  phone?: string | null;
  fax?: string | null;
}

/** The practice's main phone and fax: every letterhead shows them (they can be changed on each one). */
export const PRACTICE_PHONE = "(346) 707-8978";
export const PRACTICE_FAX = "(313) 457-1003";
/** "MyPCP Dr - Katy" → "Katy": the logo already says MyPCP Dr. */
export const officeShortName = (name: string | null | undefined) => (name ?? "").replace(/^\s*my\s*pcp\s*dr\.?\s*[-–·:]\s*/i, "").trim() || null;

export interface StampPreset { id: string; name: string; word: string; kind: StampKind; color: "black" | "red" | "blue" | "green" }
/** The ready-made stamps in the editor's gallery (wording, date, name and colour can all be changed after). */
export const STAMP_GALLERY: StampPreset[] = [
  { id: "received", name: "Received", word: "RECEIVED", kind: "dated", color: "red" },
  { id: "faxed", name: "Faxed", word: "FAXED", kind: "dated", color: "blue" },
  { id: "scanned", name: "Scanned", word: "SCANNED", kind: "dated", color: "blue" },
  { id: "ehr", name: "Entered in chart", word: "ENTERED IN EHR", kind: "dated", color: "green" },
  { id: "reviewed", name: "Reviewed by provider", word: "REVIEWED BY PROVIDER", kind: "signed", color: "blue" },
  { id: "approved", name: "Approved", word: "APPROVED", kind: "signed", color: "green" },
  { id: "verified", name: "Verified seal", word: "VERIFIED", kind: "seal", color: "blue" },
  { id: "paid", name: "Paid", word: "PAID", kind: "dated", color: "green" },
  { id: "copy", name: "Copy", word: "COPY", kind: "plain", color: "red" },
  { id: "original", name: "Original", word: "ORIGINAL", kind: "plain", color: "blue" },
  { id: "confidential", name: "Confidential", word: "CONFIDENTIAL", kind: "plain", color: "red" },
  { id: "void", name: "Void", word: "VOID", kind: "plain", color: "red" },
];

export const stampKindOf = (d: MarkDesign | null | undefined): StampKind => (STAMP_KINDS.includes(d?.kind as StampKind) ? (d!.kind as StampKind) : "plain");
export const logoKindOf = (d: MarkDesign | null | undefined): LogoKind => (LOGO_KINDS.includes(d?.kind as LogoKind) ? (d!.kind as LogoKind) : "mark");

/** The usual size of a new stamp, in points. */
export function stampSize(kind: StampKind, word: string): { w: number; h: number } {
  if (kind === "seal") return { w: 96, h: 96 };
  if (kind === "signed") return { w: Math.max(170, textWidth(word, 13, true) + 30), h: 66 };
  if (kind === "dated") return { w: Math.max(132, textWidth(word, 17, true) + 30), h: 60 };
  return { w: Math.max(80, textWidth(word, 15, true) + 28), h: 30 };
}
export const logoSize = (kind: LogoKind) => (kind === "letterhead" ? { w: 330, h: 74 } : kind === "full" ? { w: 150, h: 40 } : { w: 54, h: 54 });

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null : null);

/** Keep only well-formed details for a stamp or the logo (they come from the editor). */
export function cleanDesign(type: "stamp" | "logo", raw: unknown): MarkDesign {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (type === "logo") {
    return { kind: logoKindOf(d as MarkDesign), who: clean(d.who, 80), place: clean(d.place, 80), address: clean(d.address, 140), phone: clean(d.phone, 40), fax: clean(d.fax, 40) };
  }
  return {
    kind: stampKindOf(d as MarkDesign),
    date: typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null,
    by: clean(d.by, 60), place: clean(d.place, 80),
  };
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** 2026-11-16 → "NOV 16, 2026", the way a date stamp prints. */
export function stampDate(ymd: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  return m ? `${MONTHS[Number(m[2]) - 1] ?? "?"} ${Number(m[3])}, ${m[1]}` : "";
}

// ---- Measuring words (Helvetica's own letter widths, so the editor and the PDF fit words the same way) ----

const BOLD_UPPER = "722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611".split(" ").map(Number);
const BOLD_LOWER = "556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500".split(" ").map(Number);
const REG_UPPER = "667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611".split(" ").map(Number);
const REG_LOWER = "556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500".split(" ").map(Number);
function charWidth(ch: string, bold: boolean) {
  const c = ch.charCodeAt(0);
  if (c >= 65 && c <= 90) return (bold ? BOLD_UPPER : REG_UPPER)[c - 65]!;
  if (c >= 97 && c <= 122) return (bold ? BOLD_LOWER : REG_LOWER)[c - 97]!;
  if (c >= 48 && c <= 57) return 556;
  if (ch === " ") return 278;
  if (ch === "•") return 350;
  if (/[.,:;·'|!]/.test(ch)) return bold ? 333 : 278;
  if (/[-()/]/.test(ch)) return 333;
  if (ch === "&") return 722;
  if (ch === "#") return 556;
  return bold ? 611 : 556;
}
export function textWidth(s: string, size: number, bold: boolean) {
  let n = 0;
  for (const ch of s) n += charWidth(ch, bold);
  return (n / 1000) * size;
}
/** The biggest size (up to `max`) at which the words fit in `width`. */
export function fitSize(s: string, width: number, max: number, bold: boolean, min = 1.5) {
  const w = textWidth(s, max, bold);
  return Math.max(min, w > width ? (max * width) / w : max);
}

// ---- The drawing pieces ----

/** Who a piece is coloured as: the stamp's ink, the brand teal, dark text or grey text (logo). */
export type PrimColor = "ink" | "brand" | "dark" | "muted";
export type Prim =
  | { t: "rect"; x: number; y: number; w: number; h: number; stroke: number; r: number }
  | { t: "circle"; cx: number; cy: number; r: number; stroke: number }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; stroke: number }
  /** (x, y) is the point the words hang from: the start of the baseline, or its middle; `rotate` turns them clockwise about it (degrees). */
  | { t: "text"; x: number; y: number; size: number; bold: boolean; text: string; anchor: "start" | "middle"; rotate?: number; color?: PrimColor }
  /** The MyPCP Dr mark, `size` points square, its top-left at (x, y). */
  | { t: "brand"; x: number; y: number; size: number };

export const BRAND_TEAL = "#0f766e";
export const DARK_TEXT = "#0f172a";
export const MUTED_TEXT = "#475569";
/** The mark's own drawing (viewBox -12 2 224 224), in solid colours so it prints the same everywhere. */
export const BRAND_PATHS = [
  { d: "M58 22 C58 58 66 84 99 116", color: "#2dd4bf", width: 19 },
  { d: "M140 22 C140 58 132 84 99 116", color: "#0e7490", width: 19 },
  { d: "M99 118 C82 96 56 88 36 98 C14 109 8 138 23 159 C40 183 72 200 99 213 C126 200 158 183 175 159 C190 138 184 109 162 98 C142 88 116 96 99 118 Z", color: "#0d9488", width: 26 },
];
export const BRAND_CIRCLES = [
  { cx: 99, cy: 160, r: 17, stroke: "#2dd4bf", width: 10, fill: null as string | null },
  { cx: 58, cy: 18, r: 16, stroke: null as string | null, width: 0, fill: "#2dd4bf" },
  { cx: 140, cy: 18, r: 16, stroke: null as string | null, width: 0, fill: "#0e7490" },
];
export const BRAND_VIEW = { x: -12, y: 2, size: 224 };

const word = (s: string | null | undefined) => (s ?? "").toUpperCase();
const center = (text: string, x: number, y: number, size: number, bold = true, color?: PrimColor): Prim => ({ t: "text", x, y: y + size * 0.36, size, bold, text, anchor: "middle", color });

/** The pieces of a stamp, for a box `w` × `h` points. */
export function stampPrims(f: { w: number; h: number; value?: string | null; design?: MarkDesign | null }): Prim[] {
  const { w, h } = f;
  const d = f.design ?? {};
  const kind = stampKindOf(d);
  const text = word(f.value) || "STAMP";
  const date = stampDate(d.date);
  const place = word(d.place);
  if (kind === "seal") return sealPrims(w, h, text, date, place || "MYPCP DR");
  const b = Math.max(1, Math.min(2.4, Math.min(w, h) * 0.055));
  const out: Prim[] = [
    { t: "rect", x: b / 2, y: b / 2, w: w - b, h: h - b, stroke: b, r: Math.min(h * 0.16, 7) },
    { t: "rect", x: b * 2.6, y: b * 2.6, w: w - b * 5.2, h: h - b * 5.2, stroke: b * 0.45, r: Math.min(h * 0.1, 4) },
  ];
  const inner = w - b * 7 - 4;
  if (kind === "plain") {
    out.push(center(text, w / 2, h / 2, fitSize(text, inner, h * 0.46, true)));
  } else if (kind === "dated") {
    const withPlace = !!place;
    out.push(center(text, w / 2, h * (withPlace ? 0.31 : 0.36), fitSize(text, inner, h * (withPlace ? 0.27 : 0.33), true)));
    if (date) out.push(center(date, w / 2, h * (withPlace ? 0.6 : 0.7), fitSize(date, inner, h * (withPlace ? 0.18 : 0.22), true)));
    if (withPlace) out.push(center(place, w / 2, h * 0.82, fitSize(place, inner, h * 0.11, false)));
  } else {
    out.push(center(text, w / 2, h * 0.24, fitSize(text, inner, h * 0.2, true)));
    out.push({ t: "line", x1: b * 4, y1: h * 0.42, x2: w - b * 4, y2: h * 0.42, stroke: b * 0.45 });
    const by = `BY: ${word(d.by) || "______________"}`;
    const dt = `DATE: ${date || "______________"}`;
    const left = b * 4 + 2;
    out.push({ t: "text", x: left, y: h * 0.63, size: fitSize(by, w - left * 2, h * 0.15, true), bold: true, text: by, anchor: "start" });
    out.push({ t: "text", x: left, y: h * 0.86, size: fitSize(dt, w - left * 2, h * 0.15, true), bold: true, text: dt, anchor: "start" });
  }
  return out;
}

/** A round seal: two rings, the office's name running round between them, the word and the date in the middle. */
function sealPrims(w: number, h: number, text: string, date: string, place: string): Prim[] {
  const s = Math.min(w, h), cx = w / 2, cy = h / 2;
  const b = Math.max(1, Math.min(2.4, s * 0.028));
  const r1 = s / 2 - b, r2 = r1 * 0.64;
  const out: Prim[] = [{ t: "circle", cx, cy, r: r1, stroke: b }, { t: "circle", cx, cy, r: r2, stroke: b * 0.6 }];
  // The ring: "MYPCP DR • KATY FAMILY MEDICINE • " all the way round, spaced (or shrunk) to fill it exactly.
  const ring = `${place} • `;
  let size = (r1 - r2) * 0.5;
  let rt = (r1 + r2) / 2 - size * 0.36;
  const C = 2 * Math.PI * rt;
  const natural = textWidth(ring, size, true);
  if (natural > C * 0.97) { size *= (C * 0.97) / natural; rt = (r1 + r2) / 2 - size * 0.36; }
  const chars = Array.from(ring);
  const widths = chars.map((ch) => textWidth(ch, size, true));
  const total = widths.reduce((a, n) => a + n, 0);
  const gap = Math.max(0, (2 * Math.PI * rt - total) / chars.length);
  let along = 0;
  chars.forEach((ch, i) => {
    const mid = along + widths[i]! / 2;
    along += widths[i]! + gap;
    if (ch === " ") return;
    // Centred on the top of the ring and running clockwise, so the words read left to right across the top.
    const a = -Math.PI / 2 + (mid - (total + gap * chars.length) / 2) / rt;
    out.push({ t: "text", x: cx + rt * Math.cos(a), y: cy + rt * Math.sin(a), size, bold: true, text: ch, anchor: "middle", rotate: (a * 180) / Math.PI + 90 });
  });
  const innerW = r2 * 1.7;
  const one = fitSize(text, innerW, r2 * 0.42, true);
  const lines = one < r2 * 0.26 ? splitInTwo(text) : null;
  if (lines) {
    // Long wording ("REVIEWED BY PROVIDER") reads better on two lines than squeezed onto one.
    const size = Math.min(fitSize(lines[0], r2 * 1.5, r2 * 0.32, true), fitSize(lines[1], r2 * 1.5, r2 * 0.32, true));
    const top = date ? -0.34 : -0.2;
    out.push(center(lines[0], cx, cy + r2 * top, size), center(lines[1], cx, cy + r2 * (top + 0.36), size));
    if (date) out.push(center(date, cx, cy + r2 * 0.44, fitSize(date, r2 * 1.4, r2 * 0.2, true)));
    return out;
  }
  out.push(center(text, cx, cy - (date ? r2 * 0.16 : 0), one));
  if (date) out.push(center(date, cx, cy + r2 * 0.36, fitSize(date, r2 * 1.55, r2 * 0.22, true)));
  return out;
}

/** Little words that read better at the end of the first line ("REVIEWED BY / PROVIDER") than starting the second. */
const LINKING = new Set(["BY", "IN", "OF", "TO", "FOR", "AND", "ON", "AT", "&"]);

/** Splits words into two lines as evenly as possible, or null when there is only one word. */
function splitInTwo(text: string): [string, string] | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  let best: [string, string] | null = null, bestW = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
    const wMax = Math.max(textWidth(a, 10, true), textWidth(b, 10, true)) * (LINKING.has(words[i]!) ? 1.3 : 1);
    if (wMax < bestW) { bestW = wMax; best = [a, b]; }
  }
  return best;
}

/** The pieces of the logo: the mark alone, the mark with "MyPCP Dr", or a letterhead with the office's details. */
export function logoPrims(f: { w: number; h: number; design?: MarkDesign | null }): Prim[] {
  const { w, h } = f;
  const d = f.design ?? {};
  const kind = logoKindOf(d);
  if (kind === "mark") { const s = Math.min(w, h); return [{ t: "brand", x: (w - s) / 2, y: (h - s) / 2, size: s }]; }
  const s = Math.min(h * (kind === "letterhead" ? 0.92 : 1), w * 0.4);
  const out: Prim[] = [{ t: "brand", x: 0, y: (h - s) / 2, size: s }];
  const x = s * 1.2, room = w - x - 2;
  if (kind === "full") {
    const size = fitSize("MyPCP Dr", room, h * 0.56, true);
    out.push({ t: "text", x, y: h / 2 + size * 0.36, size, bold: true, text: "MyPCP Dr", anchor: "start", color: "brand" });
    return out;
  }
  // "MyPCP Dr", then the provider (or the office), the address, and "PH: …   FAX: …", each on its own line.
  const lines: { text: string; size: number; bold: boolean; color: PrimColor }[] = [{ text: "MyPCP Dr", size: 0.3, bold: true, color: "brand" }];
  const named = d.who || d.place;
  if (named) lines.push({ text: named, size: 0.175, bold: true, color: "dark" });
  if (d.address) lines.push({ text: d.address, size: 0.14, bold: false, color: "muted" });
  const contact = letterContact(d);
  if (contact) lines.push({ text: contact, size: 0.14, bold: false, color: "muted" });
  if (lines.length === 1) lines[0]!.size = 0.5;
  // Each line takes its size plus a little air; the block is centred on the logo and shrunk if it would overflow.
  const gap = 0.32;
  const sizes = lines.map((l) => fitSize(l.text, room, h * l.size, l.bold));
  const tall = sizes.reduce((a, s, i) => a + s * (i ? 1 + gap : 1), 0);
  const k = Math.min(1, (h * 0.96) / tall);
  let y = (h - tall * k) / 2;
  lines.forEach((l, i) => {
    const size = sizes[i]! * k;
    y += i ? size * (1 + gap) : size;
    out.push({ t: "text", x, y: y - size * 0.24, size, bold: l.bold, text: l.text, anchor: "start", color: l.color });
  });
  return out;
}

/** "PH: (346) 707-8978   FAX: (313) 457-1003" (either part left out when not set). */
export function letterContact(d: Pick<MarkDesign, "phone" | "fax">) {
  return [d.phone ? `PH: ${d.phone}` : null, d.fax ? `FAX: ${d.fax}` : null].filter(Boolean).join("     ");
}

/** A rounded rectangle as an SVG path (top-left origin), for the PDF (pdf-lib has no rounded rectangle). */
export function roundedRectPath(w: number, h: number, r: number) {
  const q = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M ${q} 0 L ${w - q} 0 Q ${w} 0 ${w} ${q} L ${w} ${h - q} Q ${w} ${h} ${w - q} ${h} L ${q} ${h} Q 0 ${h} 0 ${h - q} L 0 ${q} Q 0 0 ${q} 0 Z`;
}

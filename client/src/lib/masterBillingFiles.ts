// Master Billing: opening uploaded files in the browser. Zips are unpacked; 835 payment files are read
// here (so nothing big goes through the API); spreadsheets become rows for the column picker; PDFs
// are sent to private storage and read by the AI on the server.
import { unzipSync } from "fflate";
import { eraToEvents, isX12, parseEra835 } from "@shared/era835";
import { headerSignature } from "@shared/billSheet";
import { parseCsvRows } from "@shared/workspace";
import type { BillEventInput } from "@shared/masterBilling";

export interface CheckSummary {
  payerName: string | null;
  checkNumber: string | null;
  paymentDate: string | null;
  amountCents: number;
  method: string | null;
  claims: number;
  balanced: boolean | null;
  balanceDiffCents: number;
  adjustments: { code: string; ref: string | null; cents: number }[];
}

interface Base { id: string; name: string; sha256: string; size: number; bytes: Uint8Array; contentType: string }
export type PreparedFile =
  | (Base & { kind: "era835"; checks: CheckSummary[]; events: BillEventInput[]; warnings: string[] })
  | (Base & { kind: "sheet"; rows: string[][]; signature: string })
  | (Base & { kind: "pdf" })
  | { kind: "error"; id: string; name: string; message: string }
  /** Something left out on purpose (a readable copy, the same file twice): shown as a plain note. */
  | { kind: "note"; id: string; name: string; message: string };

export const ACCEPT = ".zip,.835,.era,.edi,.x12,.txt,.rmt,.csv,.xlsx,.pdf";
const COPIES = "__readable_copies__";
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const MAX_BYTES = 25 * 1024 * 1024;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const decode = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
const isPdf = (bytes: Uint8Array) => decode(bytes.subarray(0, 8)).startsWith("%PDF");
const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b;
let seq = 0;

/** Excel cell → text ("YYYY-MM-DD" for dates). */
function cellText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  return String(v);
}

async function prepareOne(name: string, bytes: Uint8Array): Promise<PreparedFile[]> {
  const id = `f${++seq}`;
  if (bytes.length > MAX_BYTES) return [{ kind: "error", id, name, message: "Too big (25 MB at most)." }];
  if (isZip(bytes) && /\.xlsx$/i.test(name)) {
    try {
      const { default: readXlsxFile } = await import("read-excel-file");
      const raw = (await readXlsxFile(new Blob([bytes as BlobPart]))) as unknown[][];
      const rows = raw.map((r) => r.map(cellText));
      return [{ kind: "sheet", id, name, sha256: await sha256Hex(bytes), size: bytes.length, bytes, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", rows, signature: headerSignature(rows[0] ?? []) }];
    } catch {
      return [{ kind: "error", id, name, message: "This Excel file couldn't be read. Try File → Save As → CSV and upload that." }];
    }
  }
  if (isZip(bytes)) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      return [{ kind: "error", id, name, message: "This zip file couldn't be opened." }];
    }
    const files = Object.entries(entries).filter(([n, b]) => b.length && !n.endsWith("/") && !/(^|\/)(__MACOSX|\.DS_Store)/.test(n));
    const inner = (await Promise.all(files.map(([n, b]) => prepareOne(n.split("/").pop() || n, b)))).flat();
    // An Office Ally ERA download zip holds the .835 plus a readable .txt (and sometimes a PDF) copy of the same payments.
    const has835 = inner.some((f) => f.kind === "era835");
    const kept = has835 ? inner.filter((f) => !isReadableCopy(f)) : inner;
    if (!kept.length) return [{ kind: "error", id, name, message: "The zip is empty." }];
    const dropped = inner.length - kept.length;
    // Counted together with the other readable copies in prepareFiles (one note, not one per zip).
    return dropped ? [...kept, { kind: "note", id, name: COPIES, message: String(dropped) }] : kept;
  }
  const sha256 = await sha256Hex(bytes);
  if (isPdf(bytes)) return [{ kind: "pdf", id, name, sha256, size: bytes.length, bytes, contentType: "application/pdf" }];
  if (/\.xls$/i.test(name)) return [{ kind: "error", id, name, message: "Old Excel (.xls) files can't be read. Save it as .xlsx or CSV and upload that." }];
  const text = decode(bytes);
  if (isX12(text)) {
    try {
      const file = parseEra835(text);
      const checks: CheckSummary[] = file.checks.map((c) => ({
        payerName: c.payerName, checkNumber: c.checkNumber, paymentDate: c.paymentDate, amountCents: c.amountCents, method: c.method,
        claims: c.claims.length, balanced: c.balanced, balanceDiffCents: c.balanceDiffCents, adjustments: c.providerAdjustments,
      }));
      if (!file.checks.length) return [{ kind: "error", id, name, message: "No 835 payments were found in this file (it may be a different kind of X12 file)." }];
      return [{ kind: "era835", id, name, sha256, size: bytes.length, bytes, contentType: "text/plain", checks, events: eraToEvents(file), warnings: file.warnings }];
    } catch (e) {
      return [{ kind: "error", id, name, message: (e as Error).message }];
    }
  }
  if (/\.(csv|txt)$/i.test(name) || text.includes(",")) {
    const rows = parseCsvRows(text);
    if (rows.length < 2) return [{ kind: "error", id, name, message: "This file has no rows to read." }];
    return [{ kind: "sheet", id, name, sha256, size: bytes.length, bytes, contentType: "text/csv", rows, signature: headerSignature(rows[0] ?? []) }];
  }
  return [{ kind: "error", id, name, message: "MyPCP can't read this kind of file. Upload Office Ally's 835 / ERA zip, a CSV or Excel report, or a PDF EOB." }];
}

/** A readable copy of a payment file (Office Ally's .txt remit, a PDF print): the .835 has the same payments. */
function isReadableCopy(f: PreparedFile): boolean {
  if (f.kind === "pdf") return true;
  return (f.kind === "sheet" || f.kind === "error") && /\.txt$/i.test(f.name);
}

/**
 * Open everything the owner picked (zips unpacked; hundreds of files at once is fine). With payment files in
 * the pick, Office Ally's readable .txt copies are left out, and so are PDFs named like one of the .835 files;
 * the same file picked twice counts once. What was left out comes back as one note each.
 */
export async function prepareFiles(files: File[], onProgress?: (done: number, total: number) => void): Promise<PreparedFile[]> {
  let out: PreparedFile[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    out.push(...(await prepareOne(f.name, new Uint8Array(await f.arrayBuffer()))));
    onProgress?.(i + 1, files.length);
  }
  const notes: PreparedFile[] = [];
  let left = sum(out.map((f) => (f.kind === "note" && f.name === COPIES ? Number(f.message) || 0 : 0)));
  out = out.filter((f) => !(f.kind === "note" && f.name === COPIES));
  const stem = (n: string) => n.replace(/\.[^.]+$/, "").toLowerCase();
  const eraStems = new Set(out.filter((f) => f.kind === "era835").map((f) => stem(f.name)));
  if (eraStems.size) {
    const copy = (f: PreparedFile) => (f.kind === "pdf" ? eraStems.has(stem(f.name)) : isReadableCopy(f));
    left += out.filter(copy).length;
    out = out.filter((f) => !copy(f));
  }
  if (left) notes.push({ kind: "note", id: `f${++seq}`, name: `${left} readable cop${left === 1 ? "y" : "ies"} left out`, message: "Office Ally's .txt (or PDF) versions of payment files: the .835 files have the same payments." });
  const seen = new Set<string>();
  let twice = 0;
  out = out.filter((f) => {
    if (f.kind === "error" || f.kind === "note") return true;
    if (seen.has(f.sha256)) { twice++; return false; }
    seen.add(f.sha256);
    return true;
  });
  if (twice) notes.push({ kind: "note", id: `f${++seq}`, name: `${twice} file${twice === 1 ? "" : "s"} picked twice`, message: "The same file was in the pick more than once (for example \"name (1).835\"); it's counted once." });
  return [...notes, ...out];
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

export function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** "JANE DOE" → "Jane Doe" (payment files print names in capitals). */
export function niceName(n: string | null | undefined): string {
  if (!n) return "";
  return n === n.toUpperCase() ? n.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()) : n;
}

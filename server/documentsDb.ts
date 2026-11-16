// Documents: our own DocuSign, for the team.
//
// Someone uploads a PDF (or starts from a saved template), places boxes on it (text, date, checkbox,
// signature, initials), fills in their own part and signs it. If teammates need to sign too, it goes out
// for signature: each signer gets a task, opens it in MyPCP and fills in / signs their boxes. When the last
// signer is done, MyPCP builds the final PDF: every value and signature stamped onto the original pages,
// the form flattened, and a certificate page (who signed what, when, from where, document fingerprints).
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { BlendMode, LineCapStyle, PDFCheckBox, PDFDocument, PDFDropdown, PDFRef, PDFSignature, PDFTextField, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { getDb } from "./db";
import {
  clinics, coverageOnFile, documentEvents, documentSignatures, documentSigners, documents, fhirPatients, patients, providerSignatureDelegates, providerSignatures, providers, userSignatures, users,
  workTaskActivities, workTasks,
} from "../drizzle/schema";
import {
  APPROVAL_LABELS, APPROVAL_METHODS, INK_HEX, cleanFields, guessPrefill, inkOf, isMarkup, markPen, missingFor, signerOf, usDate, type ApprovalMethod, type Assignee, type DocField, type DocPage, type DocStatus,
  type InkColor, type PrefillKey,
} from "../shared/documents";
import {
  BRAND_CIRCLES, BRAND_PATHS, BRAND_TEAL, BRAND_VIEW, DARK_TEXT, MUTED_TEXT, logoPrims, roundedRectPath, stampPrims, type Prim, type PrimColor,
} from "../shared/stamps";
import { AI_PAGE_PROMPT, boxesFromAi, parseAiFields } from "../shared/docSuggest";
import { excuseNoteLayout, letterNameOf } from "../shared/excuseNote";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  MAX_DOC_PAGES, TURNS, contentTurn, fieldsAfterOrder, fieldsAfterRemove, fieldsAfterTurn, imagePageLayout, movedOrder, sniffFile, turnedPage, type PageChange,
} from "../shared/docPages";
import { localDateStr } from "../shared/workforce";
import { MAX_PDF_BYTES, exists, getBytes, onS3, putBytes, readTarget, uploadTarget } from "./docStore";
import { WorkspaceError, audit, createTask, loadScheduleSubjects, notifyTask, subjectCare, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export interface ClientMeta { ip: string | null; userAgent: string | null }

async function logEvent(documentId: number, type: string, opts: { userId?: number | null; meta?: ClientMeta; detail?: string | null } = {}) {
  await (await db()).insert(documentEvents).values({
    documentId, at: new Date(), type, userId: opts.userId ?? null,
    ip: opts.meta?.ip?.slice(0, 64) ?? null, userAgent: opts.meta?.userAgent?.slice(0, 255) ?? null, detail: opts.detail?.slice(0, 255) ?? null,
  });
}

type DocRow = typeof documents.$inferSelect;

// ---------------------------------------------------------------------------
// Who may see / change what
// ---------------------------------------------------------------------------

const isAdmin = (a: WorkspaceActor) => a.role === "admin";

async function signersOf(documentId: number) {
  return (await db()).select({ s: documentSigners, name: users.name }).from(documentSigners).leftJoin(users, eq(users.id, documentSigners.userId))
    .where(eq(documentSigners.documentId, documentId)).orderBy(asc(documentSigners.sortOrder), asc(documentSigners.id));
}

/** Templates: everyone with Documents. A document: its creator, its signers, admins, and an office manager for their office. */
async function canView(a: WorkspaceActor, doc: DocRow) {
  if (doc.isTemplate || isAdmin(a) || doc.createdByUserId === a.id) return true;
  if (a.role === "office_manager" && a.clinicIds && doc.clinicId && a.clinicIds.includes(doc.clinicId)) return true;
  if ((await signersOf(doc.id)).some((s) => s.s.userId === a.id)) return true;
  // A provider whose signature was applied on their behalf can always see that document.
  const [mine] = await (await db()).select({ id: documentSignatures.id }).from(documentSignatures)
    .where(and(eq(documentSignatures.documentId, doc.id), eq(documentSignatures.onBehalfOfUserId, a.id))).limit(1);
  return !!mine;
}
/** Change the boxes / title / signers: the creator (or an admin) while it's a draft. Templates: whoever made it, or an admin. */
const canEdit = (a: WorkspaceActor, doc: DocRow) => doc.status === "draft" && (doc.createdByUserId === a.id || isAdmin(a));

async function docOr404(a: WorkspaceActor, id: number) {
  const [doc] = await (await db()).select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc || !(await canView(a, doc))) throw new WorkspaceError("That document wasn't found.", "NOT_FOUND");
  return doc;
}

/** A finished document's signed PDF, to fax it: anyone who can see the document, or (from a patient's folder) any staff for that patient's documents. */
export async function signedPdfForFax(a: WorkspaceActor, id: number, folderKey: string | null) {
  const [doc] = await (await db()).select().from(documents).where(eq(documents.id, id)).limit(1);
  const inFolder = !!doc && !!folderKey && doc.subjectKey === folderKey;
  if (!doc || !(inFolder || (await canView(a, doc)))) throw new WorkspaceError("That document wasn't found.", "NOT_FOUND");
  if (doc.status !== "completed" || !doc.finalKey) throw new WorkspaceError(`"${doc.title}" isn't signed yet.`);
  // An excuse note is faxed to an employer or school as the note alone (the certificate page stays on file).
  return { bytes: await getBytes(isExcuseNote(doc) ? await shareCopyKey(doc) : doc.finalKey), title: doc.title };
}

const pagesOf = (doc: DocRow) => (doc.pages ?? []) as DocPage[];
const fieldsOf = (doc: DocRow) => cleanFields(doc.fields ?? [], pagesOf(doc));

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export type DocView = "to_sign" | "in_progress" | "completed" | "templates";

/** The side-menu bubble: documents waiting for this person's signature (what the "To sign" tab lists), as one count. */
export async function toSignCount(userId: number) {
  const [row] = await (await db()).select({ n: sql<number>`count(distinct ${documents.id})` }).from(documentSigners)
    .innerJoin(documents, eq(documents.id, documentSigners.documentId))
    .where(and(eq(documentSigners.userId, userId), eq(documentSigners.status, "pending"), eq(documents.status, "signing")));
  return Number(row?.n ?? 0);
}

export async function listDocuments(a: WorkspaceActor, view: DocView, q?: string | null) {
  const d = await db();
  const words = (q ?? "").replace(/[%_\\]/g, " ").trim().split(/\s+/).filter((w) => w.length >= 2).slice(0, 4);
  const titleMatch = words.map((w) => sql`${documents.title} LIKE ${`%${w}%`}`);
  let where;
  if (view === "templates") where = and(eq(documents.isTemplate, true), eq(documents.status, "draft"), ...titleMatch);
  else if (view === "to_sign") {
    const mine = await d.select({ id: documentSigners.documentId }).from(documentSigners).where(and(eq(documentSigners.userId, a.id), eq(documentSigners.status, "pending")));
    if (!mine.length) return [];
    where = and(inArray(documents.id, mine.map((m) => m.id)), eq(documents.status, "signing"), ...titleMatch);
  } else {
    const statuses: DocStatus[] = view === "completed" ? ["completed"] : ["draft", "signing"];
    const signed = await d.select({ id: documentSigners.documentId }).from(documentSigners).where(eq(documentSigners.userId, a.id));
    const scope = isAdmin(a) ? undefined
      : or(eq(documents.createdByUserId, a.id), signed.length ? inArray(documents.id, signed.map((s) => s.id)) : undefined,
        a.role === "office_manager" && a.clinicIds?.length ? inArray(documents.clinicId, a.clinicIds) : undefined);
    where = and(eq(documents.isTemplate, false), inArray(documents.status, statuses), scope, ...titleMatch);
  }
  const rows = await d.select({ doc: documents, creator: users.name }).from(documents).leftJoin(users, eq(users.id, documents.createdByUserId))
    .where(where).orderBy(desc(documents.updatedAt)).limit(300);
  const ids = rows.map((r) => r.doc.id);
  const signers = ids.length ? await d.select({ documentId: documentSigners.documentId, userId: documentSigners.userId, status: documentSigners.status, name: users.name })
    .from(documentSigners).leftJoin(users, eq(users.id, documentSigners.userId)).where(inArray(documentSigners.documentId, ids)) : [];
  const names = await subjectNames(rows.map((r) => r.doc.subjectKey));
  return rows.map(({ doc, creator }) => ({
    id: doc.id, title: doc.title, status: doc.status as DocStatus, isTemplate: doc.isTemplate, pages: pagesOf(doc).length, fileName: doc.fileName,
    fieldCount: fieldsOf(doc).length, creator, createdByMe: doc.createdByUserId === a.id, updatedAt: doc.updatedAt, sentAt: doc.sentAt, completedAt: doc.completedAt,
    patientName: doc.subjectKey ? names.get(doc.subjectKey) ?? null : null, subjectKey: doc.subjectKey,
    signers: signers.filter((s) => s.documentId === doc.id).map((s) => ({ userId: s.userId, name: s.name, status: s.status as "pending" | "signed" })),
  }));
}

async function subjectNames(keys: (string | null)[]) {
  const out = new Map<string, string>();
  for (const k of Array.from(new Set(keys.filter((x): x is string => !!x)))) {
    const c = await subjectCare(k).catch(() => null);
    if (c) out.set(k, c.name);
  }
  return out;
}

/** People who can be asked to sign (anyone with Documents). */
export async function signerChoices() {
  const rows = await (await db()).select({ id: users.id, name: users.name, role: users.role }).from(users)
    .where(and(inArray(users.role, ["admin", "office_manager", "staff", "provider", "front_desk", "medical_assistant"]), sql`${users.openId} NOT LIKE 'roster:%'`)).orderBy(asc(users.name));
  return rows.filter((u) => u.name);
}

// ---------------------------------------------------------------------------
// Upload + read the PDF (page sizes, and any fillable boxes it already has)
// ---------------------------------------------------------------------------

export async function createDocument(a: WorkspaceActor, input: { title: string; fileName: string; size: number }) {
  if (input.size > MAX_PDF_BYTES) throw new WorkspaceError(`That PDF is too big (max ${MAX_PDF_BYTES / 1024 / 1024} MB).`);
  const key = `documents/${randomUUID()}.pdf`;
  const title = input.title.replace(/[\r\n<>]/g, " ").trim().slice(0, 255) || input.fileName.replace(/\.pdf$/i, "").slice(0, 255) || "Document";
  const res = await (await db()).insert(documents).values({
    title, status: "draft", fileKey: key, fileName: input.fileName.slice(0, 255), fileSize: input.size, fields: [], pages: [], createdByUserId: a.id, updatedByUserId: a.id,
    clinicId: a.clinicIds?.[0] ?? null,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  await logEvent(id, "created", { userId: a.id, detail: input.fileName.slice(0, 200) });
  return { id, upload: await uploadTarget(key) };
}

/** Local development only: the browser sends the file through the API. */
export async function uploadLocal(a: WorkspaceActor, id: number, base64: string) {
  if (onS3()) throw new WorkspaceError("Upload the file with the upload link.");
  const doc = await docOr404(a, id);
  if (!canEdit(a, doc) || !doc.fileKey) throw new WorkspaceError("This document can't be changed.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_PDF_BYTES) throw new WorkspaceError("That PDF is too big.");
  await putBytes(doc.fileKey, bytes);
  return { ok: true };
}

const NOT_A_PDF = "MyPCP couldn't read that PDF. Try saving it again as a PDF (Print → Save as PDF) and upload that.";
const pagesIn = (pdf: PDFDocument): DocPage[] => pdf.getPages().map((p) => { const { width, height } = p.getSize(); return { w: width, h: height, rotate: p.getRotation().angle }; });

/** A photo or scan (JPEG / PNG) as one more page at the end of a PDF. */
async function addImagePage(pdf: PDFDocument, bytes: Uint8Array, kind: "jpeg" | "png") {
  let img: PDFImage;
  try { img = kind === "png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes); } catch { throw new WorkspaceError("MyPCP couldn't read that picture. Try taking the photo again, or save it as a JPG."); }
  const at = imagePageLayout(img.width, img.height);
  pdf.addPage([at.pageW, at.pageH]).drawImage(img, { x: at.x, y: at.y, width: at.w, height: at.h });
}

/** After the upload: check it's a PDF (a photo becomes a one-page PDF), record its pages, and turn its own fillable boxes into ours. */
export async function fileUploaded(a: WorkspaceActor, id: number) {
  const doc = await docOr404(a, id);
  if (!canEdit(a, doc) || !doc.fileKey) throw new WorkspaceError("This document can't be changed.");
  let bytes: Buffer;
  try { bytes = await getBytes(doc.fileKey); } catch { throw new WorkspaceError("The upload didn't arrive. Please try again."); }
  if (bytes.length > MAX_PDF_BYTES) throw new WorkspaceError("That file is too big.");
  const kind = sniffFile(bytes);
  if (!kind) throw new WorkspaceError("That file isn't a PDF or a photo (JPG / PNG).");
  let pdf: PDFDocument, fileKey = doc.fileKey;
  if (kind === "pdf") {
    try { pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); } catch { throw new WorkspaceError(NOT_A_PDF); }
  } else {
    // A photo or scan: MyPCP makes the PDF (kept under its own name; the picture as sent stays where it was).
    pdf = await PDFDocument.create();
    await addImagePage(pdf, bytes, kind);
    bytes = Buffer.from(await pdf.save());
    fileKey = `documents/${randomUUID()}.pdf`;
    await putBytes(fileKey, bytes);
  }
  const pages = pagesIn(pdf);
  const fields = readFormFields(pdf);
  await (await db()).update(documents).set({ pages, fields, fileKey, fileSha256: sha256(bytes), fileSize: bytes.length, updatedByUserId: a.id }).where(eq(documents.id, id));
  await logEvent(id, "uploaded", { userId: a.id, detail: `${pages.length} page${pages.length === 1 ? "" : "s"}${fields.length ? `, ${fields.length} fillable box${fields.length === 1 ? "" : "es"} found` : ""}` });
  await audit(a, "manage_document", { entityType: "document", entityId: id, description: `Uploaded "${doc.title}" (${pages.length} pages)` });
  return { pages: pages.length, fieldsFound: fields.length };
}

/** A fillable PDF's own text boxes / checkboxes / signature boxes → our boxes (same place, same size). */
function readFormFields(pdf: PDFDocument): DocField[] {
  const out: DocField[] = [];
  let form;
  try { form = pdf.getForm(); } catch { return out; }
  const pages = pdf.getPages();
  const pageOfWidget = (widget: { P(): PDFRef | undefined; dict: unknown }) => {
    const ref = widget.P();
    if (ref) { const i = pages.findIndex((p) => p.ref === ref); if (i >= 0) return i; }
    const wref = pdf.context.getObjectRef(widget.dict as never);
    return pages.findIndex((p) => {
      const annots = p.node.Annots();
      if (!annots || !wref) return false;
      for (let k = 0; k < annots.size(); k++) if (annots.get(k) === wref) return true;
      return false;
    });
  };
  for (const f of form.getFields()) {
    const type = f instanceof PDFCheckBox ? "checkbox" : f instanceof PDFSignature ? "signature" : f instanceof PDFTextField || f instanceof PDFDropdown ? "text" : null;
    if (!type) continue;
    const name = f.getName();
    const widgets = f.acroField.getWidgets();
    widgets.forEach((w, i) => {
      const page = pageOfWidget(w);
      if (page < 0) return;
      const r = w.getRectangle();
      if (r.width < 2 || r.height < 2) return;
      const looksDate = type === "text" && /\bdate\b|dob|d\.o\.b|birth/i.test(name);
      let value: string | null = null;
      try { if (f instanceof PDFTextField) value = f.getText() ?? null; } catch { /* unreadable */ }
      out.push({
        id: `a${out.length}`, type: looksDate ? "date" : type, page, x: r.x, y: r.y, w: r.width, h: r.height, assignee: "preparer",
        label: widgets.length > 1 ? `${name} (${i + 1})` : name, required: false, fontSize: null,
        value: looksDate ? null : value, prefill: null, acroName: name,
      });
    });
  }
  return out.slice(0, 600);
}

// ---------------------------------------------------------------------------
// Page tools (drafts only): add pages from another PDF or a photo; remove, move or turn a page.
// The PDF is never changed in place: a new file is written and the document points at it, so a
// template (or another document made from it) that shares the old file is left alone.
// ---------------------------------------------------------------------------

async function loadForPages(a: WorkspaceActor, id: number) {
  const doc = await docOr404(a, id);
  if (!canEdit(a, doc) || !doc.fileKey || !pagesOf(doc).length) throw new WorkspaceError("This document can't be changed.");
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(await getBytes(doc.fileKey), { ignoreEncryption: true, updateMetadata: false }); } catch { throw new WorkspaceError(NOT_A_PDF); }
  return { doc, pdf };
}

/** Write the changed PDF under a new name and point the document (pages, boxes, fingerprint) at it. */
async function storePages(a: WorkspaceActor, doc: DocRow, pdf: PDFDocument, fields: DocField[], what: string) {
  const bytes = Buffer.from(await pdf.save({ updateFieldAppearances: false }));
  if (bytes.length > MAX_PDF_BYTES) throw new WorkspaceError(`That would make the PDF too big (max ${MAX_PDF_BYTES / 1024 / 1024} MB).`);
  // The page list is read back from the file that was just written (the library's own list can be out of
  // date after a page is removed), which also proves the new file opens.
  let pages: DocPage[];
  try { pages = pagesIn(await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })); } catch { throw new WorkspaceError("That change didn't work on this PDF. Nothing was changed."); }
  if (!pages.length) throw new WorkspaceError("A document needs at least one page.");
  const fileKey = `documents/${randomUUID()}.pdf`;
  await putBytes(fileKey, bytes);
  await (await db()).update(documents).set({ pages, fields: cleanFields(fields, pages), fileKey, fileSha256: sha256(bytes), fileSize: bytes.length, updatedByUserId: a.id }).where(eq(documents.id, doc.id));
  await logEvent(doc.id, "pages_changed", { userId: a.id, detail: what });
  await audit(a, "manage_document", { entityType: "document", entityId: doc.id, description: `Pages of "${doc.title}": ${what}`.slice(0, 250) });
  return { pages: pages.length };
}

/** A fillable PDF's own form boxes that sit on a page that is going away (removed, or redrawn turned): taken out of the form so it still flattens cleanly. */
function dropFormFieldsOn(pdf: PDFDocument, page: PDFPage) {
  try {
    const form = pdf.getForm();
    for (const f of form.getFields()) {
      const onPage = f.acroField.getWidgets().some((w) => w.P() === page.ref || (() => {
        const annots = page.node.Annots(), ref = pdf.context.getObjectRef(w.dict);
        if (!annots || !ref) return false;
        for (let k = 0; k < annots.size(); k++) if (annots.get(k) === ref) return true;
        return false;
      })());
      if (onPage) { try { form.removeField(f); } catch { /* leave it; the stamped values still print on top */ } }
    }
  } catch { /* no form */ }
}

export async function changePages(a: WorkspaceActor, id: number, change: PageChange) {
  const { doc, pdf } = await loadForPages(a, id);
  const count = pdf.getPageCount();
  const fields = fieldsOf(doc);
  const page = change.page;
  if (!Number.isInteger(page) || page < 0 || page >= count) throw new WorkspaceError("That page isn't in this document.");
  if (change.op === "remove") {
    if (count <= 1) throw new WorkspaceError("A document needs at least one page.");
    dropFormFieldsOn(pdf, pdf.getPage(page));
    pdf.removePage(page);
    return storePages(a, doc, pdf, fieldsAfterRemove(fields, page), `page ${page + 1} removed`);
  }
  if (change.op === "move") {
    const to = change.to;
    if (!Number.isInteger(to) || to < 0 || to >= count) throw new WorkspaceError("That page can't go there.");
    if (to === page) return { pages: count };
    const p = pdf.getPage(page);
    pdf.removePage(page);
    pdf.insertPage(to, p);
    return storePages(a, doc, pdf, fieldsAfterOrder(fields, movedOrder(count, page, to)), `page ${page + 1} moved to position ${to + 1}`);
  }
  if (!TURNS.includes(change.turn)) throw new WorkspaceError("Turn the page a quarter, half or three-quarter turn.");
  // Turning redraws the page's content turned on a fresh, upright page (so boxes added later are upright too).
  const old = pagesIn(pdf)[page]!;
  const by = contentTurn(old, change.turn);
  const src = pdf.getPage(page);
  if (by === 0) src.setRotation(degrees(0));
  else {
    const W = old.w, H = old.h;
    const embedded = await pdf.embedPage(src);
    const size = turnedPage(old, by);
    dropFormFieldsOn(pdf, src);
    const fresh = pdf.insertPage(page, [size.w, size.h]);
    fresh.drawPage(embedded, by === 90 ? { x: 0, y: W, rotate: degrees(-90) } : by === 180 ? { x: W, y: H, rotate: degrees(180) } : { x: H, y: 0, rotate: degrees(90) });
    pdf.removePage(page + 1);
  }
  return storePages(a, doc, pdf, fieldsAfterTurn(fields, page, by, old), `page ${page + 1} turned`);
}

// An extra file (PDF or photo) on its way in, to be added as pages at the end of a document.
const PART_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const partKey = (docId: number, part: string) => `documents/part-${docId}-${part}`;
export const PART_CONTENT_TYPE = "application/octet-stream";

export async function addPagesStart(a: WorkspaceActor, id: number, size: number) {
  const doc = await docOr404(a, id);
  if (!canEdit(a, doc) || !doc.fileKey) throw new WorkspaceError("This document can't be changed.");
  if (size > MAX_PDF_BYTES) throw new WorkspaceError(`That file is too big (max ${MAX_PDF_BYTES / 1024 / 1024} MB).`);
  const part = randomUUID();
  return { part, upload: await uploadTarget(partKey(id, part), PART_CONTENT_TYPE) };
}

/** Local development only: the browser sends the extra file through the API. */
export async function addPagesLocal(a: WorkspaceActor, id: number, part: string, base64: string) {
  if (onS3()) throw new WorkspaceError("Upload the file with the upload link.");
  const doc = await docOr404(a, id);
  if (!canEdit(a, doc) || !PART_RE.test(part)) throw new WorkspaceError("This document can't be changed.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_PDF_BYTES) throw new WorkspaceError("That file is too big.");
  await putBytes(partKey(id, part), bytes, PART_CONTENT_TYPE);
  return { ok: true };
}

/** The extra file arrived: add its pages (a PDF's pages, or a photo as one page) to the end of the document. */
export async function addPagesFinish(a: WorkspaceActor, id: number, part: string, fileName: string) {
  if (!PART_RE.test(part)) throw new WorkspaceError("The upload didn't arrive. Please try again.");
  const { doc, pdf } = await loadForPages(a, id);
  const name = fileName.replace(/[\r\n<>"]/g, " ").trim().slice(0, 120) || "file";
  let bytes: Buffer;
  try { bytes = await getBytes(partKey(id, part)); } catch { throw new WorkspaceError("The upload didn't arrive. Please try again."); }
  if (bytes.length > MAX_PDF_BYTES) throw new WorkspaceError("That file is too big.");
  const kind = sniffFile(bytes);
  if (!kind) throw new WorkspaceError(`"${name}" isn't a PDF or a photo (JPG / PNG).`);
  const before = pdf.getPageCount();
  const tooMany = new WorkspaceError(`A document can have up to ${MAX_DOC_PAGES} pages.`);
  if (kind === "pdf") {
    let extra: PDFDocument;
    try { extra = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); } catch { throw new WorkspaceError(NOT_A_PDF); }
    if (before + extra.getPageCount() > MAX_DOC_PAGES) throw tooMany;
    // That file's own fill-in boxes can't come along (they belong to its form): what was typed in them is printed onto its pages instead.
    try { const form = extra.getForm(); if (form.getFields().length) form.flatten(); } catch { /* not a form, or one that can't be flattened */ }
    for (const p of await pdf.copyPages(extra, extra.getPageIndices())) pdf.addPage(p);
  } else {
    if (before + 1 > MAX_DOC_PAGES) throw tooMany;
    await addImagePage(pdf, bytes, kind);
  }
  const added = pdf.getPageCount() - before;
  const r = await storePages(a, doc, pdf, fieldsOf(doc), `${added} page${added === 1 ? "" : "s"} added from "${name}"`);
  return { ...r, added };
}

// ---------------------------------------------------------------------------
// "Read with AI": the practice's own AWS Bedrock model (the one that reads faxes; covered by the AWS BAA)
// looks at a picture of ONE page and says where the blanks are, what each is for and who fills it.
// It only proposes boxes: the person preparing the document checks every one. Nothing is filled in by AI.
// ---------------------------------------------------------------------------

export const aiReady = () => !!process.env.BEDROCK_MODEL_ID;
let bedrock: BedrockRuntimeClient | null = null;
const JPEG_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/;

export async function aiReadPage(a: WorkspaceActor, id: number, input: { page: number; image: string }) {
  const doc = await docOr404(a, id);
  if (!canEdit(a, doc)) throw new WorkspaceError("This document can't be changed.");
  if (!aiReady()) throw new WorkspaceError("AI reading isn't set up on this copy of MyPCP.");
  const size = pagesOf(doc)[input.page];
  if (!size) throw new WorkspaceError("That page isn't in this document.");
  const m = JPEG_RE.exec(input.image);
  const bytes = m ? Buffer.from(m[1]!, "base64") : null;
  if (!bytes || bytes.length < 1500 || bytes.length > 3_500_000) throw new WorkspaceError("The picture of the page didn't arrive. Please try again.");
  let reply: string;
  try {
    bedrock ??= new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1" });
    const out = await bedrock.send(new ConverseCommand({
      modelId: process.env.BEDROCK_MODEL_ID!,
      messages: [{ role: "user", content: [{ image: { format: "jpeg", source: { bytes } } }, { text: AI_PAGE_PROMPT }] }],
      inferenceConfig: { maxTokens: 3000, temperature: 0 },
    }));
    reply = (out.output?.message?.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("");
  } catch (e) {
    console.error("[documents] AI page read failed:", (e as Error).name); // no page contents in logs
    throw new WorkspaceError("The AI couldn't read that page just now. Please try again in a moment.");
  }
  const boxes = boxesFromAi(input.page, size, parseAiFields(reply), fieldsOf(doc));
  await logEvent(id, "ai_read", { userId: a.id, detail: `page ${input.page + 1}: ${boxes.length} box${boxes.length === 1 ? "" : "es"} proposed` });
  await audit(a, "manage_document", { entityType: "document", entityId: id, description: `AI read page ${input.page + 1} of "${doc.title}"`.slice(0, 250) });
  return { boxes };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Save the layout (boxes, labels, auto-fill) to reuse. Every value and signature is left out, so one
 * patient's details never carry over to the next document (fixed wording can be typed into the template itself).
 */
export async function saveAsTemplate(a: WorkspaceActor, id: number, title: string) {
  const doc = await docOr404(a, id);
  if (!doc.fileKey || !pagesOf(doc).length) throw new WorkspaceError("Upload the PDF first.");
  // Marks drawn on the page (white-out, stamps, ticks…) are part of the layout, so they stay as they are.
  const fields = fieldsOf(doc).map((f) => (isMarkup(f.type) ? f : { ...f, value: null, assignee: "preparer" as Assignee }));
  const res = await (await db()).insert(documents).values({
    title: title.trim().slice(0, 255) || doc.title, isTemplate: true, status: "draft", fileKey: doc.fileKey, fileName: doc.fileName, fileSize: doc.fileSize, fileSha256: doc.fileSha256,
    pages: doc.pages, fields, createdByUserId: a.id, updatedByUserId: a.id,
  });
  const tid = (res as unknown as [{ insertId: number }])[0].insertId;
  await logEvent(tid, "template_saved", { userId: a.id, detail: `from document #${id}` });
  await audit(a, "manage_document", { entityType: "document", entityId: tid, description: `Saved template "${title || doc.title}"` });
  return { id: tid };
}

/** Start a new document from a template, optionally for a patient (their details fill in where the template says). */
export async function newFromTemplate(a: WorkspaceActor, templateId: number, subjectKey: string | null) {
  const [t] = await (await db()).select().from(documents).where(and(eq(documents.id, templateId), eq(documents.isTemplate, true))).limit(1);
  if (!t) throw new WorkspaceError("Template not found.", "NOT_FOUND");
  const care = subjectKey ? await subjectCare(subjectKey) : null;
  if (subjectKey && !care) throw new WorkspaceError("That patient wasn't found.", "NOT_FOUND");
  const filled = fillFromRecord(fieldsOf(t), await prefillValues(a, subjectKey)).fields;
  // A dated stamp saved in a template is dated the day the template is used, not the day it was saved.
  const fields = filled.map((f) => (f.type === "stamp" && f.design?.date ? { ...f, design: { ...f.design, date: localDateStr() } } : f));
  const res = await (await db()).insert(documents).values({
    title: care ? `${t.title}: ${care.name}`.slice(0, 255) : t.title, templateId: t.id, status: "draft", fileKey: t.fileKey, fileName: t.fileName, fileSize: t.fileSize, fileSha256: t.fileSha256,
    pages: t.pages, fields, subjectKey, patientId: care?.patientId ?? null, clinicId: care?.clinicId ?? a.clinicIds?.[0] ?? null, createdByUserId: a.id, updatedByUserId: a.id,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  await logEvent(id, "created", { userId: a.id, detail: `from template "${t.title}"`.slice(0, 200) });
  await audit(a, "manage_document", { entityType: "document", entityId: id, description: `New document from template "${t.title}"${care ? " for a patient" : ""}` });
  return { id };
}

// ---------------------------------------------------------------------------
// Excuse notes: a work / school note on a provider's letterhead
// ---------------------------------------------------------------------------

/** Providers for letters (excuse notes, letterheads): how each name prints, and their office. Names set for letters first. */
export async function letterProviders() {
  const rows = await (await db()).select({
    id: providers.id, name: providers.name, title: providers.title, letterName: providers.letterName, clinicId: providers.clinicId, userId: providers.userId, userName: users.name,
  }).from(providers).leftJoin(users, eq(users.id, providers.userId));
  return rows.map((r) => ({ id: r.id, name: letterNameOf(r), clinicId: r.clinicId, userId: r.userId, set: !!r.letterName?.trim() }))
    .filter((r) => r.name)
    .sort((a, b) => Number(b.set) - Number(a.set) || a.name.localeCompare(b.name));
}

/**
 * Start an excuse note on a provider's letterhead, optionally for a patient (name and date of birth fill in).
 * The provider signs it: themself if they make it; staff they picked apply their saved signature (with their
 * approval, as for any document); anyone else gets the provider added as a co-signer.
 */
export async function newExcuseNote(a: WorkspaceActor, input: { providerId: number; subjectKey: string | null }) {
  const d = await db();
  const [p] = await d.select({
    id: providers.id, name: providers.name, title: providers.title, letterName: providers.letterName, clinicId: providers.clinicId, userId: providers.userId, userName: users.name,
  }).from(providers).leftJoin(users, eq(users.id, providers.userId)).where(eq(providers.id, input.providerId)).limit(1);
  if (!p) throw new WorkspaceError("That provider wasn't found.", "NOT_FOUND");
  const care = input.subjectKey ? await subjectCare(input.subjectKey) : null;
  if (input.subjectKey && !care) throw new WorkspaceError("That patient wasn't found.", "NOT_FOUND");
  const who = letterNameOf(p);
  const clinicId = p.clinicId ?? care?.clinicId ?? a.clinicIds?.[0] ?? null;
  const [office] = clinicId ? await d.select({ name: clinics.name, address: clinics.address }).from(clinics).where(eq(clinics.id, clinicId)).limit(1) : [];
  const appliesForThem = !!p.userId && (await signaturesICanApply(a)).some((s) => s.providerUserId === p.userId && !!s.signaturePng);
  const coSigner = p.userId && p.userId !== a.id && !appliesForThem && (await signerChoices()).some((u) => u.id === p.userId) ? p.userId : null;
  const note = excuseNoteLayout({ who, office: office ?? null, today: localDateStr(), signer: coSigner ? `signer:${coSigner}` : "preparer" });
  const bytes = await drawExcuseNote(note);
  const key = `documents/${randomUUID()}.pdf`;
  await putBytes(key, bytes);
  const { fields } = fillFromRecord(note.fields, await prefillValues(a, input.subjectKey));
  const res = await d.insert(documents).values({
    title: `Excuse note (${who || "provider"})${care ? `: ${care.name}` : ""}`.slice(0, 255), status: "draft",
    fileKey: key, fileName: "excuse-note.pdf", fileSize: bytes.length, fileSha256: sha256(bytes), pages: [{ w: note.page.w, h: note.page.h, rotate: 0 }], fields,
    subjectKey: input.subjectKey, patientId: care?.patientId ?? null, clinicId, createdByUserId: a.id, updatedByUserId: a.id,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  if (coSigner) await d.insert(documentSigners).values({ documentId: id, userId: coSigner, sortOrder: 0, status: "pending" });
  await logEvent(id, "created", { userId: a.id, detail: `Excuse note on ${who || "a provider"}'s letterhead`.slice(0, 200) });
  await audit(a, "manage_document", { entityType: "document", entityId: id, description: `New excuse note (${who})${care ? " for a patient" : ""}` });
  return { id, coSigner: !!coSigner };
}

/** The note's page: its printed wording, the blanks, check-box squares and the rule under the letterhead (the letterhead itself is a box). */
async function drawExcuseNote(note: ReturnType<typeof excuseNoteLayout>) {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Work / school excuse");
  pdf.setProducer("MyPCP");
  const page = pdf.addPage([note.page.w, note.page.h]);
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const H = note.page.h;
  for (const t of note.texts) {
    const f = t.bold ? bold : font;
    const text = safeText(f, t.text);
    page.drawText(text, { x: t.center ? t.x - f.widthOfTextAtSize(text, t.size) / 2 : t.x, y: H - t.b, size: t.size, font: f, color: hexRgb(t.muted ? MUTED_TEXT : DARK_TEXT) });
  }
  for (const l of note.lines) {
    page.drawLine({ start: { x: l.x1, y: H - l.top }, end: { x: l.x2, y: H - l.top }, thickness: l.rule ? 1.4 : 0.6, color: l.rule ? hexRgb(BRAND_TEAL) : rgb(0.5, 0.5, 0.5) });
  }
  for (const s of note.squares) page.drawRectangle({ x: s.x, y: H - s.top - s.size, width: s.size, height: s.size, borderColor: rgb(0.3, 0.3, 0.3), borderWidth: 0.8 });
  return Buffer.from(await pdf.save());
}

/** What MyPCP knows to fill in: the patient's name, DOB, phone, office; today; the preparer's name. */
async function prefillValues(a: WorkspaceActor, subjectKey: string | null): Promise<Partial<Record<PrefillKey, string>>> {
  const out: Partial<Record<PrefillKey, string>> = { today: localDateStr(), my_name: a.name ?? "" };
  if (!subjectKey) return out;
  const d = await db();
  const care = await subjectCare(subjectKey);
  if (!care) return out;
  out.patient_name = care.name;
  const sched = (await loadScheduleSubjects()).get(subjectKey);
  let dob: Date | null = sched?.dob ?? null, phone: string | null = sched?.phone ?? null;
  if (care.patientId) {
    const [p] = await d.select({ dob: patients.dateOfBirth, phone: patients.phoneNumber }).from(patients).where(eq(patients.id, care.patientId)).limit(1);
    dob = p?.dob ?? dob; phone = p?.phone || phone;
  }
  if (dob) out.patient_dob = dob.toISOString().slice(0, 10);
  if (phone) out.patient_phone = phone;
  let providerId: number | null = sched?.providerId ?? null, insurance: string | null = null;
  if (care.patientId) {
    const [p] = await d.select({ providerId: patients.providerId, insurance: patients.insurance }).from(patients).where(eq(patients.id, care.patientId)).limit(1);
    providerId = p?.providerId ?? providerId;
    insurance = p?.insurance?.trim() || null;
  }
  // The Practice Fusion copy of the chart: email, address, sex, chart number (and a phone / date of birth we didn't have).
  const [chart] = await d.select({ dob: fhirPatients.dob, sex: fhirPatients.sex, phone: fhirPatients.phone, email: fhirPatients.email, address: fhirPatients.address, mrn: fhirPatients.mrn }).from(fhirPatients)
    .where(care.patientId ? eq(fhirPatients.patientId, care.patientId) : eq(fhirPatients.subjectKey, subjectKey)).limit(1);
  if (chart) {
    if (chart.email) out.patient_email = chart.email;
    if (chart.address) out.patient_address = chart.address;
    if (chart.sex) out.patient_sex = chart.sex === "F" ? "Female" : chart.sex === "M" ? "Male" : "Other";
    if (chart.mrn) out.patient_mrn = chart.mrn;
    if (!out.patient_phone && chart.phone) out.patient_phone = chart.phone;
    if (!out.patient_dob && chart.dob) out.patient_dob = chart.dob;
  }
  // Insurance: what is on file for eligibility checks first, else the plan name on the roster.
  const [cov] = await d.select({ payerName: coverageOnFile.payerName, memberId: coverageOnFile.memberId, groupNumber: coverageOnFile.groupNumber }).from(coverageOnFile)
    .where(care.patientId ? or(eq(coverageOnFile.subjectKey, subjectKey), eq(coverageOnFile.patientId, care.patientId)) : eq(coverageOnFile.subjectKey, subjectKey)).limit(1);
  if (cov?.payerName || insurance) out.insurance_name = cov?.payerName || insurance!;
  if (cov?.memberId) out.insurance_member_id = cov.memberId;
  if (cov?.groupNumber) out.insurance_group = cov.groupNumber;
  if (!providerId) providerId = (await import("./directoryDb").then((m) => m.directoryEntry(subjectKey)).catch(() => null))?.providerId ?? null;
  if (providerId) {
    const [pr] = await d.select({ name: providers.name, npi: providers.npi }).from(providers).where(eq(providers.id, providerId)).limit(1);
    if (pr?.name) out.provider_name = pr.name;
    if (pr?.npi) out.provider_npi = pr.npi;
  }
  if (care.clinicId) {
    const [c] = await d.select({ name: clinics.name, phone: clinics.phone, address: clinics.address }).from(clinics).where(eq(clinics.id, care.clinicId)).limit(1);
    if (c) out.clinic_name = c.name;
    if (c?.phone) out.clinic_phone = c.phone;
    if (c?.address) out.clinic_address = c.address;
  }
  return out;
}

/**
 * Fill boxes from what MyPCP holds on file. A box that says what it wants ("Fill in automatically with…") always
 * gets it. An EMPTY box of the preparer's whose label plainly asks for something on file (a suggested "Patient
 * name", "Member ID", "Office phone"…) gets it too, and remembers what it was filled with.
 */
function fillFromRecord(fields: DocField[], values: Partial<Record<PrefillKey, string>>) {
  let filled = 0;
  const out = fields.map((f) => {
    if (f.prefill) {
      const v = values[f.prefill];
      if (v == null || v === f.value) return f;
      filled++;
      return { ...f, value: v };
    }
    if (f.assignee !== "preparer" || f.value?.trim()) return f;
    const key = guessPrefill(f.label, f.type);
    const v = key ? values[key] : null;
    if (!key || v == null || (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v))) return f;
    filled++;
    return { ...f, value: v, prefill: key };
  });
  return { fields: out, filled };
}

// ---------------------------------------------------------------------------
// One document: open, save, sign boxes
// ---------------------------------------------------------------------------

export async function getDocument(a: WorkspaceActor, id: number, meta: ClientMeta) {
  const d = await db();
  const doc = await docOr404(a, id);
  const signers = await signersOf(id);
  const sigs = await d.select({ id: documentSignatures.id, png: documentSignatures.png, userId: documentSignatures.userId, signedAt: documentSignatures.signedAt, name: users.name, onBehalfOf: documentSignatures.onBehalfOfUserId })
    .from(documentSignatures).leftJoin(users, eq(users.id, documentSignatures.userId)).where(eq(documentSignatures.documentId, id));
  const onBehalfNames = await namesOf(sigs.map((s) => s.onBehalfOf).filter((x): x is number => !!x));
  const events = await d.select({ e: documentEvents, name: users.name }).from(documentEvents).leftJoin(users, eq(users.id, documentEvents.userId))
    .where(eq(documentEvents.documentId, id)).orderBy(asc(documentEvents.at), asc(documentEvents.id));
  const [creator] = await d.select({ name: users.name }).from(users).where(eq(users.id, doc.createdByUserId)).limit(1);
  const me = signers.find((s) => s.s.userId === a.id);
  const mode: "edit" | "sign" | "view" = canEdit(a, doc) ? "edit" : doc.status === "signing" && me?.s.status === "pending" ? "sign" : "view";
  const patientName = doc.subjectKey ? (await subjectCare(doc.subjectKey).catch(() => null))?.name ?? null : null;
  await logEvent(id, "viewed", { userId: a.id, meta });
  await audit(a, "view_document", { entityType: "document", entityId: id, description: `Opened "${doc.title}"` });
  return {
    id: doc.id, title: doc.title, status: doc.status as DocStatus, isTemplate: doc.isTemplate, mode, myUserId: a.id,
    fileName: doc.fileName, pages: pagesOf(doc), fields: fieldsOf(doc), message: doc.message,
    subjectKey: doc.subjectKey, patientName, creator: creator?.name ?? null, createdByMe: doc.createdByUserId === a.id,
    sentAt: doc.sentAt, completedAt: doc.completedAt, hasFile: !!doc.fileKey && pagesOf(doc).length > 0, hasFinal: !!doc.finalKey,
    /** Changes whenever the PDF itself changes (pages added, removed, moved, turned): the editor then opens the new file. */
    fileRev: doc.fileKey ? sha256(doc.fileKey).slice(0, 12) : "",
    /** Is "Read with AI" available here (the practice's AI model is set up)? */
    aiReady: aiReady(),
    /** For stamps ("Reviewed by …") and the letterhead (office name, address, phone). */
    myName: a.name ?? null,
    officeId: doc.clinicId,
    offices: await d.select({ id: clinics.id, name: clinics.name, address: clinics.address, phone: clinics.phone }).from(clinics).orderBy(asc(clinics.name)),
    /** For the letterhead's provider line. */
    letterProviders: (await letterProviders()).map((p) => ({ id: p.id, name: p.name, clinicId: p.clinicId })),
    signers: signers.map((s) => ({ userId: s.s.userId, name: s.name, status: s.s.status as "pending" | "signed", signedAt: s.s.signedAt })),
    signatures: Object.fromEntries(sigs.map((s) => [`sig:${s.id}`, {
      png: `data:image/png;base64,${s.png}`, name: s.onBehalfOf ? onBehalfNames.get(s.onBehalfOf) ?? "Provider" : s.name, signedAt: s.signedAt,
      appliedBy: s.onBehalfOf ? s.name : null,
    }])),
    events: events.map(({ e, name }) => ({ at: e.at, type: e.type, detail: e.detail, name })),
  };
}

/**
 * The PDF itself, for the editor to draw, or the signed PDF to download: "final" with its certificate page
 * (kept on file), "copy" without it (to hand to the patient, an employer or a school).
 */
export async function fileFor(a: WorkspaceActor, id: number, which: "source" | "final" | "copy", meta: ClientMeta) {
  const doc = await docOr404(a, id);
  const signed = which !== "source";
  if (signed && !doc.finalKey) throw new WorkspaceError("The signed PDF isn't ready yet.");
  const key = which === "copy" ? await shareCopyKey(doc) : which === "final" ? doc.finalKey : doc.fileKey;
  if (!key) throw new WorkspaceError("No PDF uploaded yet.");
  if (signed) {
    await logEvent(id, "downloaded", { userId: a.id, meta, detail: which === "copy" ? "copy without the certificate page" : null });
    await audit(a, "view_document", { entityType: "document", entityId: id, description: `Downloaded signed "${doc.title}"${which === "copy" ? " (without certificate page)" : ""}` });
  }
  return readTarget(key, signed ? `${doc.title}${which === "copy" ? "" : " (signed)"}.pdf` : null);
}

/** An excuse note (made by MyPCP): what goes to a patient, employer or school is the note alone. */
const isExcuseNote = (doc: DocRow) => doc.fileName === "excuse-note.pdf";

/** The signed pages without the certificate page; made the first time it's asked for, then kept beside the signed PDF. */
async function shareCopyKey(doc: DocRow) {
  if (!doc.finalKey) throw new WorkspaceError("The signed PDF isn't ready yet.");
  const key = `${doc.finalKey.replace(/\.pdf$/, "")}-copy.pdf`;
  if (await exists(key)) return key;
  const pdf = await PDFDocument.load(await getBytes(doc.finalKey), { ignoreEncryption: true });
  const keep = Math.max(1, pagesOf(doc).length);
  for (let i = pdf.getPageCount() - 1; i >= keep; i--) pdf.removePage(i);
  pdf.setTitle(doc.title);
  await putBytes(key, await pdf.save());
  return key;
}

/** Save the preparer's work: title, boxes (and their values), patient, message. Drafts only. */
export async function saveDocument(a: WorkspaceActor, id: number, input: { title?: string; fields?: unknown[]; subjectKey?: string | null; message?: string | null }) {
  const doc = await docOr404(a, id);
  if (!canEdit(a, doc)) throw new WorkspaceError(doc.status === "draft" ? "Only the person who started this document can change it." : "This document was already sent; it can't be changed.");
  const patch: Partial<typeof documents.$inferInsert> = { updatedByUserId: a.id };
  if (input.title !== undefined) patch.title = input.title.replace(/[\r\n<>]/g, " ").trim().slice(0, 255) || doc.title;
  if (input.message !== undefined) patch.message = input.message?.trim().slice(0, 1000) || null;
  if (input.fields !== undefined) {
    // Signature boxes keep only signatures actually made on this document.
    const made = new Set((await (await db()).select({ id: documentSignatures.id }).from(documentSignatures).where(eq(documentSignatures.documentId, id))).map((s) => `sig:${s.id}`));
    patch.fields = cleanFields(input.fields, pagesOf(doc)).map((f) => ((f.type === "signature" || f.type === "initials") && f.value && !made.has(f.value) ? { ...f, value: null } : f));
  }
  if (input.subjectKey !== undefined) {
    const care = input.subjectKey ? await subjectCare(input.subjectKey) : null;
    if (input.subjectKey && !care) throw new WorkspaceError("That patient wasn't found.", "NOT_FOUND");
    patch.subjectKey = input.subjectKey || null;
    patch.patientId = care?.patientId ?? null;
    if (care?.clinicId) patch.clinicId = care.clinicId;
  }
  await (await db()).update(documents).set(patch).where(eq(documents.id, id));
  return { ok: true };
}

/** Fill a template's "prefill" boxes for the linked patient now (after picking the patient in the editor). */
export async function applyPrefill(a: WorkspaceActor, id: number) {
  const doc = await docOr404(a, id);
  if (!canEdit(a, doc)) throw new WorkspaceError("This document can't be changed.");
  const { fields, filled } = fillFromRecord(fieldsOf(doc), await prefillValues(a, doc.subjectKey));
  await (await db()).update(documents).set({ fields, updatedByUserId: a.id }).where(eq(documents.id, id));
  return { fields, filled };
}

export async function setSigners(a: WorkspaceActor, id: number, userIds: number[]) {
  const doc = await docOr404(a, id);
  if (!canEdit(a, doc)) throw new WorkspaceError("This document can't be changed.");
  const d = await db();
  const ids = Array.from(new Set(userIds)).slice(0, 10);
  const valid = new Set((await signerChoices()).map((u) => u.id));
  if (ids.some((u) => !valid.has(u))) throw new WorkspaceError("Pick signers from your team.");
  await d.delete(documentSigners).where(eq(documentSigners.documentId, id));
  if (ids.length) await d.insert(documentSigners).values(ids.map((userId, i) => ({ documentId: id, userId, sortOrder: i, status: "pending" })));
  // Boxes assigned to someone who's no longer a signer go back to the preparer.
  const keep = new Set(ids);
  const fields = fieldsOf(doc).map((f) => { const s = signerOf(f.assignee); return s && !keep.has(s) ? { ...f, assignee: "preparer" as Assignee, value: null } : f; });
  await d.update(documents).set({ fields, updatedByUserId: a.id }).where(eq(documents.id, id));
  return { ok: true };
}

const PNG_RE = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;

/**
 * Sign one signature / initials box: the preparer on a draft, or a signer on their own box while it's out
 * for signature. The image is kept with who / when / where, and the box points at it.
 */
export interface OnBehalfOf { providerUserId: number; approval: ApprovalMethod; note?: string | null }

export async function signField(a: WorkspaceActor, id: number, input: { fieldId: string; png?: string | null; saveAsMine?: boolean; onBehalfOf?: OnBehalfOf | null }, meta: ClientMeta) {
  const doc = await docOr404(a, id);
  const fields = fieldsOf(doc);
  const f = fields.find((x) => x.id === input.fieldId);
  if (!f || (f.type !== "signature" && f.type !== "initials")) throw new WorkspaceError("That box isn't a signature box.");
  const mine = f.assignee === "preparer" ? canEdit(a, doc) : signerOf(f.assignee) === a.id && doc.status === "signing" && (await pendingSigner(id, a.id));
  if (!mine) throw new WorkspaceError("That box is for someone else to sign.", "FORBIDDEN");
  const d = await db();
  let b64: string, onBehalf: OnBehalfOf | null = null, providerName: string | null = null;
  if (input.onBehalfOf) {
    // A provider's stored signature, applied by someone they picked, with their approval (confirmed by the staff member).
    const o = input.onBehalfOf;
    if (f.assignee !== "preparer") throw new WorkspaceError("A provider's signature can only go in your own boxes.");
    if (!APPROVAL_METHODS.includes(o.approval)) throw new WorkspaceError("Say how the provider approved it.");
    const note = o.note?.replace(/[\r\n<>]/g, " ").trim().slice(0, 255) || null;
    if (o.approval === "other" && !note) throw new WorkspaceError("Add a short note on how the provider approved it.");
    const usable = (await signaturesICanApply(a)).find((p) => p.providerUserId === o.providerUserId);
    const stored = f.type === "initials" ? usable?.initialsPng : usable?.signaturePng;
    if (!usable || !stored) throw new WorkspaceError(usable ? `${usable.name} has no saved ${f.type === "initials" ? "initials" : "signature"}.` : "You're not set up to use that provider's signature.", "FORBIDDEN");
    b64 = PNG_RE.exec(stored)![1]!;
    onBehalf = { ...o, note };
    providerName = usable.name;
  } else {
    const m = PNG_RE.exec(input.png ?? "");
    if (!m) throw new WorkspaceError("Please sign again.");
    b64 = m[1]!;
  }
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length < 100 || bytes.length > 600_000) throw new WorkspaceError("Please sign again.");
  const res = await d.insert(documentSignatures).values({
    documentId: id, fieldId: f.id, userId: a.id, kind: f.type, png: b64, sha256: sha256(bytes), signedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
    onBehalfOfUserId: onBehalf?.providerUserId ?? null, approvalMethod: onBehalf?.approval ?? null, approvalNote: onBehalf?.note ?? null,
    ip: meta.ip?.slice(0, 64) ?? null, userAgent: meta.userAgent?.slice(0, 255) ?? null,
  });
  const sigId = (res as unknown as [{ insertId: number }])[0].insertId;
  const value = `sig:${sigId}`;
  await d.update(documents).set({ fields: fields.map((x) => (x.id === f.id ? { ...x, value } : x)), updatedByUserId: a.id }).where(eq(documents.id, id));
  if (input.saveAsMine && !onBehalf && input.png) await saveMySignature(a, f.type === "initials" ? { initialsPng: input.png } : { signaturePng: input.png });
  if (onBehalf) {
    const how = `${APPROVAL_LABELS[onBehalf.approval].toLowerCase()}${onBehalf.note ? `: ${onBehalf.note}` : ""}`;
    await logEvent(id, "provider_signature", { userId: a.id, meta, detail: `${providerName}'s ${f.type} applied with their approval (${how})` });
    await audit(a, "manage_document", { entityType: "document", entityId: id, description: `Applied ${providerName}'s ${f.type} to "${doc.title}" (approved ${how})` });
    await notifyTask(onBehalf.providerUserId, `Your ${f.type} was used`, `${doc.title}: applied by ${a.name ?? "a teammate"} (you approved ${how}).`, doc.patientId);
  } else {
    await logEvent(id, f.type === "initials" ? "initialed" : "signed_box", { userId: a.id, meta, detail: f.label ?? null });
  }
  return { value, png: `data:image/png;base64,${b64}`, name: providerName };
}

async function pendingSigner(documentId: number, userId: number) {
  const [s] = await (await db()).select({ status: documentSigners.status }).from(documentSigners)
    .where(and(eq(documentSigners.documentId, documentId), eq(documentSigners.userId, userId))).limit(1);
  return s?.status === "pending";
}

// ---------------------------------------------------------------------------
// Send, sign, finish
// ---------------------------------------------------------------------------

/** Preparer is done: finish now (nobody else signs), or send it to the signers. */
export async function sendOrFinish(a: WorkspaceActor, id: number, meta: ClientMeta) {
  const doc = await docOr404(a, id);
  if (!canEdit(a, doc)) throw new WorkspaceError("This document can't be changed.");
  if (!doc.fileKey || !pagesOf(doc).length) throw new WorkspaceError("Upload the PDF first.");
  const fields = fieldsOf(doc);
  const missing = missingFor(fields, "preparer");
  if (missing.length) throw new WorkspaceError(`Fill in ${missing.length === 1 ? `"${missing[0]!.label || "the required box"}"` : `the ${missing.length} required boxes`} first.`);
  const signers = await signersOf(id);
  const d = await db();
  if (!signers.length) {
    await finalize(id, a);
    await audit(a, "manage_document", { entityType: "document", entityId: id, description: `Completed "${doc.title}"` });
    return { status: "completed" as const };
  }
  const unassigned = signers.filter((s) => !fields.some((f) => signerOf(f.assignee) === s.s.userId));
  if (unassigned.length) throw new WorkspaceError(`Give ${unassigned[0]!.name ?? "each signer"} at least one box to fill or sign (choose them under "Who fills this box").`);
  await d.update(documents).set({ status: "signing", sentAt: new Date(), updatedByUserId: a.id }).where(eq(documents.id, id));
  for (const s of signers) {
    const task = await createTask(a, {
      title: `Sign: ${doc.title}`.slice(0, 250),
      description: [`${a.name ?? "A teammate"} sent you a document to sign.`, doc.message ? `\n"${doc.message}"` : null, `\nOpen /documents/${id}, fill in and sign your boxes, then click "Finish signing".`].filter(Boolean).join("\n"),
      patientId: doc.patientId, clinicId: doc.clinicId, assignedUserId: s.s.userId, priority: "normal", category: "form", dueDate: localDateStr(),
      sourceType: "document", sourceRef: String(id),
    });
    await d.update(documentSigners).set({ taskId: task.id }).where(eq(documentSigners.id, s.s.id));
    if (s.s.userId === a.id) await notifyTask(a.id, "Document to sign", doc.title, doc.patientId);
  }
  await logEvent(id, "sent", { userId: a.id, meta, detail: `to ${signers.map((s) => s.name ?? "a teammate").join(", ")}`.slice(0, 250) });
  await audit(a, "manage_document", { entityType: "document", entityId: id, description: `Sent "${doc.title}" for signature (${signers.length})` });
  return { status: "signing" as const };
}

/** A signer fills their boxes (text / date / checkbox; signatures were stamped with signField) and finishes. */
export async function signerFinish(a: WorkspaceActor, id: number, values: Record<string, string>, meta: ClientMeta) {
  const doc = await docOr404(a, id);
  if (doc.status !== "signing" || !(await pendingSigner(id, a.id))) throw new WorkspaceError("There's nothing for you to sign on this document.");
  const me: Assignee = `signer:${a.id}`;
  const fields = fieldsOf(doc).map((f) => {
    if (f.assignee !== me || f.type === "signature" || f.type === "initials" || !(f.id in values)) return f;
    const v = String(values[f.id] ?? "").slice(0, 2000);
    return { ...f, value: f.type === "checkbox" ? (v ? "x" : "") : f.type === "date" ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null) : v };
  });
  const missing = missingFor(fields, me);
  if (missing.length) throw new WorkspaceError(`Fill in ${missing.length === 1 ? `"${missing[0]!.label || "the required box"}"` : `the ${missing.length} required boxes`} first.`);
  const d = await db();
  await d.update(documents).set({ fields }).where(eq(documents.id, id));
  const [row] = await d.select().from(documentSigners).where(and(eq(documentSigners.documentId, id), eq(documentSigners.userId, a.id))).limit(1);
  await d.update(documentSigners).set({ status: "signed", signedAt: new Date(), ip: meta.ip?.slice(0, 64) ?? null, userAgent: meta.userAgent?.slice(0, 255) ?? null }).where(eq(documentSigners.id, row!.id));
  await closeTask(a, row!.taskId, "Signed");
  await logEvent(id, "signer_finished", { userId: a.id, meta });
  await audit(a, "manage_document", { entityType: "document", entityId: id, description: `Signed "${doc.title}"` });
  const left = (await signersOf(id)).filter((s) => s.s.status !== "signed");
  if (!left.length) {
    await finalize(id, a);
    const [creatorRow] = await d.select({ id: users.id }).from(users).where(eq(users.id, doc.createdByUserId)).limit(1);
    if (creatorRow && creatorRow.id !== a.id) await notifyTask(creatorRow.id, "Document signed by everyone", doc.title, doc.patientId);
    return { status: "completed" as const };
  }
  return { status: "signing" as const };
}

async function closeTask(a: WorkspaceActor, taskId: number | null, reason: string, to: "completed" | "cancelled" = "completed") {
  if (!taskId) return;
  const d = await db();
  const [t] = await d.select({ status: workTasks.status }).from(workTasks).where(eq(workTasks.id, taskId)).limit(1);
  if (!t || t.status === "completed" || t.status === "cancelled") return;
  await d.update(workTasks).set({ status: to, completedAt: to === "completed" ? new Date() : null }).where(eq(workTasks.id, taskId));
  await d.insert(workTaskActivities).values({ taskId, userId: a.id, type: "status_changed", meta: { from: t.status, to, reason } });
}

/** Cancel a draft or a document out for signature (signers' tasks close). Completed documents stay. */
export async function cancelDocument(a: WorkspaceActor, id: number) {
  const doc = await docOr404(a, id);
  if (!(doc.createdByUserId === a.id || isAdmin(a))) throw new WorkspaceError("Only the person who started this document can cancel it.", "FORBIDDEN");
  if (doc.isTemplate) {
    await (await db()).update(documents).set({ status: "cancelled" }).where(eq(documents.id, id));
    await audit(a, "manage_document", { entityType: "document", entityId: id, description: `Deleted template "${doc.title}"` });
    return { ok: true };
  }
  if (doc.status === "completed" || doc.status === "cancelled") throw new WorkspaceError("This document is already finished.");
  for (const s of await signersOf(id)) await closeTask(a, s.s.taskId, "Document cancelled", "cancelled");
  await (await db()).update(documents).set({ status: "cancelled", updatedByUserId: a.id }).where(eq(documents.id, id));
  await logEvent(id, "cancelled", { userId: a.id });
  await audit(a, "manage_document", { entityType: "document", entityId: id, description: `Cancelled "${doc.title}"` });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Provider signatures: stored by admins (or the provider), applied by staff each provider picked,
// with the provider's approval. Every use is logged, on the certificate, and sent to the provider.
// ---------------------------------------------------------------------------

async function namesOf(ids: number[]) {
  const uniq = Array.from(new Set(ids));
  if (!uniq.length) return new Map<number, string>();
  return new Map((await (await db()).select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uniq))).map((u) => [u.id, u.name ?? `User #${u.id}`]));
}

async function providerUsers() {
  return (await db()).select({ id: users.id, name: users.name }).from(users)
    .where(and(eq(users.role, "provider"), sql`${users.openId} NOT LIKE 'roster:%'`)).orderBy(asc(users.name));
}

/** Manage a provider's stored signature / who may use it: an admin, or the provider themself. */
async function canManageProvider(a: WorkspaceActor, providerUserId: number) {
  if (!(await providerUsers()).some((p) => p.id === providerUserId)) throw new WorkspaceError("That person isn't a provider.", "NOT_FOUND");
  if (!(isAdmin(a) || a.id === providerUserId)) throw new WorkspaceError("Only an admin or the provider can change this.", "FORBIDDEN");
}

/** The Provider signatures tab: admins see every provider; a provider sees their own. */
export async function providerSignatureOverview(a: WorkspaceActor) {
  const d = await db();
  const providers = (await providerUsers()).filter((p) => isAdmin(a) || p.id === a.id);
  if (!providers.length) return { providers: [], canManage: false };
  const ids = providers.map((p) => p.id);
  const sigs = await d.select().from(providerSignatures).where(inArray(providerSignatures.providerUserId, ids));
  const dels = await d.select({ providerUserId: providerSignatureDelegates.providerUserId, userId: providerSignatureDelegates.delegateUserId, name: users.name })
    .from(providerSignatureDelegates).leftJoin(users, eq(users.id, providerSignatureDelegates.delegateUserId)).where(inArray(providerSignatureDelegates.providerUserId, ids));
  const uses = await d.select({ p: documentSignatures.onBehalfOfUserId, n: sql<number>`COUNT(*)` }).from(documentSignatures)
    .where(inArray(documentSignatures.onBehalfOfUserId, ids)).groupBy(documentSignatures.onBehalfOfUserId);
  return {
    canManage: true,
    providers: providers.map((p) => {
      const s = sigs.find((x) => x.providerUserId === p.id);
      return {
        providerUserId: p.id, name: p.name ?? "Provider", isMe: p.id === a.id,
        signaturePng: s?.signaturePng ?? null, initialsPng: s?.initialsPng ?? null, enabled: s?.enabled ?? true, updatedAt: s?.updatedAt ?? null,
        delegates: dels.filter((x) => x.providerUserId === p.id).map((x) => ({ userId: x.userId, name: x.name })),
        uses: Number(uses.find((u) => u.p === p.id)?.n ?? 0),
      };
    }),
  };
}

export async function saveProviderSignature(a: WorkspaceActor, providerUserId: number, input: { signaturePng?: string | null; initialsPng?: string | null; enabled?: boolean }) {
  await canManageProvider(a, providerUserId);
  const patch: { signaturePng?: string | null; initialsPng?: string | null; enabled?: boolean; updatedByUserId: number } = { updatedByUserId: a.id };
  for (const k of ["signaturePng", "initialsPng"] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (v !== null && (!PNG_RE.test(v) || v.length > 800_000)) throw new WorkspaceError("That image didn't work. Try a clearer photo or draw it.");
    patch[k] = v;
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  await (await db()).insert(providerSignatures).values({ providerUserId, ...patch }).onDuplicateKeyUpdate({ set: patch });
  const [p] = await (await db()).select({ name: users.name }).from(users).where(eq(users.id, providerUserId)).limit(1);
  const what = [input.signaturePng !== undefined ? (input.signaturePng ? "signature saved" : "signature removed") : null,
    input.initialsPng !== undefined ? (input.initialsPng ? "initials saved" : "initials removed") : null,
    input.enabled !== undefined ? (input.enabled ? "staff use turned on" : "staff use turned off") : null].filter(Boolean).join(", ");
  await audit(a, "manage_document", { entityType: "providerSignature", entityId: providerUserId, description: `Provider signature for ${p?.name ?? providerUserId}: ${what}` });
  if (a.id !== providerUserId) await notifyTask(providerUserId, "Your stored signature was updated", `${a.name ?? "An admin"}: ${what}.`, null);
  return { ok: true };
}

/** Who may apply this provider's signature (the provider, or an admin, picks). */
export async function setProviderDelegates(a: WorkspaceActor, providerUserId: number, userIds: number[]) {
  await canManageProvider(a, providerUserId);
  const valid = new Set((await signerChoices()).map((u) => u.id));
  const ids = Array.from(new Set(userIds)).filter((u) => u !== providerUserId).slice(0, 50);
  if (ids.some((u) => !valid.has(u))) throw new WorkspaceError("Pick people from your team.");
  const d = await db();
  await d.delete(providerSignatureDelegates).where(eq(providerSignatureDelegates.providerUserId, providerUserId));
  if (ids.length) await d.insert(providerSignatureDelegates).values(ids.map((delegateUserId) => ({ providerUserId, delegateUserId, createdByUserId: a.id })));
  const names = await namesOf([providerUserId, ...ids]);
  await audit(a, "manage_document", { entityType: "providerSignature", entityId: providerUserId, description: `Who may use ${names.get(providerUserId)}'s signature: ${ids.map((i) => names.get(i)).join(", ") || "nobody"}` });
  return { ok: true };
}

/** Providers whose stored signature this person may apply right now (picked by the provider, switched on, saved). */
export async function signaturesICanApply(a: WorkspaceActor) {
  const d = await db();
  const rows = await d.select({ providerUserId: providerSignatureDelegates.providerUserId, name: users.name, s: providerSignatures })
    .from(providerSignatureDelegates)
    .innerJoin(providerSignatures, eq(providerSignatures.providerUserId, providerSignatureDelegates.providerUserId))
    .leftJoin(users, eq(users.id, providerSignatureDelegates.providerUserId))
    .where(and(eq(providerSignatureDelegates.delegateUserId, a.id), eq(providerSignatures.enabled, true)));
  return rows.filter((r) => r.s.signaturePng || r.s.initialsPng)
    .map((r) => ({ providerUserId: r.providerUserId, name: r.name ?? "Provider", signaturePng: r.s.signaturePng, initialsPng: r.s.initialsPng }));
}

/** A provider's list of everything their signature was applied to. */
export async function signedForMe(a: WorkspaceActor) {
  const rows = await (await db()).select({ s: documentSignatures, title: documents.title, status: documents.status, appliedBy: users.name })
    .from(documentSignatures).innerJoin(documents, eq(documents.id, documentSignatures.documentId)).leftJoin(users, eq(users.id, documentSignatures.userId))
    .where(eq(documentSignatures.onBehalfOfUserId, a.id)).orderBy(desc(documentSignatures.signedAt)).limit(300);
  return rows.map((r) => ({
    documentId: r.s.documentId, title: r.title, status: r.status as DocStatus, kind: r.s.kind, appliedBy: r.appliedBy, at: r.s.signedAt,
    approval: r.s.approvalMethod as ApprovalMethod | null, note: r.s.approvalNote,
  }));
}

// ---------------------------------------------------------------------------
// Saved signature
// ---------------------------------------------------------------------------

export async function mySignature(a: WorkspaceActor) {
  const [s] = await (await db()).select().from(userSignatures).where(eq(userSignatures.userId, a.id)).limit(1);
  return { signaturePng: s?.signaturePng ?? null, initialsPng: s?.initialsPng ?? null };
}

export async function saveMySignature(a: WorkspaceActor, input: { signaturePng?: string | null; initialsPng?: string | null }) {
  const patch: { signaturePng?: string | null; initialsPng?: string | null } = {};
  for (const k of ["signaturePng", "initialsPng"] as const) {
    const v = input[k];
    if (v === undefined) continue;
    if (v !== null && (!PNG_RE.test(v) || v.length > 800_000)) throw new WorkspaceError("Please draw your signature again.");
    patch[k] = v;
  }
  await (await db()).insert(userSignatures).values({ userId: a.id, ...patch }).onDuplicateKeyUpdate({ set: patch });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The final PDF
// ---------------------------------------------------------------------------

const CT = "America/Chicago";
const fmt = (d: Date | null | undefined) => (d ? `${d.toLocaleString("en-US", { timeZone: CT, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })} CT` : "");

/** Text in the standard PDF font only covers Western characters; anything else becomes "?" rather than failing. */
function safeText(font: PDFFont, s: string) {
  try { font.encodeText(s); return s; } catch { return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?"); }
}

const inkRgb = (c: InkColor) => { const n = parseInt(INK_HEX[c].slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };

const hexRgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };

/** The MyPCP Dr mark, `size` points square, its top-left at (left, top) in PDF points. Drawn as lines, so it prints sharp. */
function drawBrand(page: PDFPage, left: number, top: number, size: number) {
  const k = size / BRAND_VIEW.size;
  // pdf-lib draws an SVG path with its origin at (x, y) and y running down the page. Its `scale` shrinks the
  // line width too, so the width stays in the drawing's own units.
  const x0 = left - BRAND_VIEW.x * k, y0 = top + BRAND_VIEW.y * k;
  for (const p of BRAND_PATHS) page.drawSvgPath(p.d, { x: x0, y: y0, scale: k, borderColor: hexRgb(p.color), borderWidth: p.width, borderLineCap: LineCapStyle.Round });
  for (const c of BRAND_CIRCLES) {
    page.drawCircle({
      x: x0 + c.cx * k, y: y0 - c.cy * k, size: c.r * k,
      ...(c.fill ? { color: hexRgb(c.fill) } : {}), ...(c.stroke ? { borderColor: hexRgb(c.stroke), borderWidth: c.width * k } : {}),
    });
  }
}

/** Draw a stamp's or the logo's pieces (see shared/stamps.ts), exactly as the editor shows them. */
function drawPrims(page: PDFPage, f: DocField, prims: Prim[], ink: ReturnType<typeof rgb>, font: PDFFont, bold: PDFFont) {
  const X = (x: number) => f.x + x, Y = (y: number) => f.y + f.h - y;
  const colorOf = (c: PrimColor | undefined) => (c === "brand" ? hexRgb(BRAND_TEAL) : c === "dark" ? hexRgb(DARK_TEXT) : c === "muted" ? hexRgb(MUTED_TEXT) : ink);
  // Stamp ink is a touch see-through, like a real rubber stamp; the logo prints solid.
  const inkOpacity = f.type === "stamp" ? 0.9 : 1;
  for (const p of prims) {
    if (p.t === "rect") page.drawSvgPath(roundedRectPath(p.w, p.h, p.r), { x: X(p.x), y: Y(p.y), borderColor: ink, borderWidth: p.stroke, borderOpacity: inkOpacity });
    else if (p.t === "circle") page.drawCircle({ x: X(p.cx), y: Y(p.cy), size: p.r, borderColor: ink, borderWidth: p.stroke, borderOpacity: inkOpacity });
    else if (p.t === "line") page.drawLine({ start: { x: X(p.x1), y: Y(p.y1) }, end: { x: X(p.x2), y: Y(p.y2) }, thickness: p.stroke, color: ink, opacity: inkOpacity });
    else if (p.t === "brand") drawBrand(page, X(p.x), Y(p.y), p.size);
    else {
      const fnt = p.bold ? bold : font;
      const text = safeText(fnt, p.text);
      if (!text.trim()) continue;
      const turn = ((p.rotate ?? 0) * Math.PI) / 180;
      const back = p.anchor === "middle" ? fnt.widthOfTextAtSize(text, p.size) / 2 : 0;
      // Where the words start, in the box (screen directions), then turned the PDF's way (counter-clockwise).
      const sx = p.x - back * Math.cos(turn), sy = p.y - back * Math.sin(turn);
      page.drawText(text, { x: X(sx), y: Y(sy), size: p.size, font: fnt, color: colorOf(p.color), opacity: p.color ? 1 : inkOpacity, rotate: p.rotate ? degrees(-p.rotate) : undefined });
    }
  }
}

/** A mark the preparer drew on the page: white-out, highlight, tick / cross / circle, line, stamp, logo. */
function drawMarkup(page: PDFPage, f: DocField, font: PDFFont, bold: PDFFont) {
  const { x, y, w, h } = f;
  if (f.type === "whiteout") { page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 1, 1) }); return; }
  if (f.type === "highlight") { page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 0.92, 0.23), opacity: 0.45, blendMode: BlendMode.Multiply }); return; }
  if (f.type === "logo") { drawPrims(page, f, logoPrims(f), rgb(0, 0, 0), font, bold); return; }
  const color = inkRgb(inkOf(f.color, f.type === "stamp" ? "red" : "black"));
  if (f.type === "line") {
    page.drawLine({ start: { x, y: y + h / 2 }, end: { x: x + w, y: y + h / 2 }, thickness: Math.max(0.75, Math.min(3, h / 5)), color });
    return;
  }
  if (f.type === "mark") {
    const t = markPen(f);
    if (f.value === "circle") { page.drawEllipse({ x: x + w / 2, y: y + h / 2, xScale: Math.max(1, w / 2 - t), yScale: Math.max(1, h / 2 - t), borderColor: color, borderWidth: t }); return; }
    if (f.value === "x") {
      const pad = Math.min(w, h) * 0.15;
      page.drawLine({ start: { x: x + pad, y: y + pad }, end: { x: x + w - pad, y: y + h - pad }, thickness: t, color });
      page.drawLine({ start: { x: x + pad, y: y + h - pad }, end: { x: x + w - pad, y: y + pad }, thickness: t, color });
      return;
    }
    // A tick: short stroke down, long stroke up.
    page.drawLine({ start: { x: x + w * 0.12, y: y + h * 0.5 }, end: { x: x + w * 0.4, y: y + h * 0.18 }, thickness: t, color });
    page.drawLine({ start: { x: x + w * 0.4, y: y + h * 0.18 }, end: { x: x + w * 0.9, y: y + h * 0.86 }, thickness: t, color });
    return;
  }
  if (f.type === "stamp") drawPrims(page, f, stampPrims(f), color, font, bold);
}

function drawValue(page: PDFPage, f: DocField, font: PDFFont, sigImages: Map<string, Awaited<ReturnType<PDFDocument["embedPng"]>>>) {
  const rot = page.getRotation().angle;
  if (f.type === "checkbox") {
    if (f.value !== "x") return;
    const pad = Math.min(f.w, f.h) * 0.2;
    const c = rgb(0.05, 0.05, 0.1), t = Math.max(1, Math.min(f.w, f.h) * 0.12);
    page.drawLine({ start: { x: f.x + pad, y: f.y + pad }, end: { x: f.x + f.w - pad, y: f.y + f.h - pad }, thickness: t, color: c });
    page.drawLine({ start: { x: f.x + pad, y: f.y + f.h - pad }, end: { x: f.x + f.w - pad, y: f.y + pad }, thickness: t, color: c });
    return;
  }
  if (f.type === "signature" || f.type === "initials") {
    const img = f.value ? sigImages.get(f.value) : null;
    if (!img) return;
    const scale = Math.min(f.w / img.width, f.h / img.height);
    const w = img.width * scale, h = img.height * scale;
    page.drawImage(img, { x: f.x + 1, y: f.y + (f.h - h) / 2, width: w, height: h });
    return;
  }
  const raw = f.type === "date" ? usDate(f.value) : (f.value ?? "");
  if (!raw.trim()) return;
  const lines = raw.split(/\r?\n/).slice(0, 20).map((l) => safeText(font, l));
  let size = f.fontSize ?? Math.max(6, Math.min(11, (f.h / Math.max(1, lines.length)) * 0.72));
  const widest = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size)));
  if (widest > f.w - 4) size = Math.max(5, size * ((f.w - 4) / widest));
  const lineH = size * 1.15;
  const top = f.y + f.h - Math.max(1, (f.h - lineH * lines.length) / 2) - size * 0.85;
  lines.forEach((l, i) => page.drawText(l, { x: f.x + 2, y: top - i * lineH, size, font, color: rgb(0.02, 0.02, 0.1), rotate: rot ? degrees(rot) : undefined }));
}

/** Stamp every value and signature onto the original pages, flatten, add the certificate page, store it. */
async function finalize(id: number, a: WorkspaceActor) {
  const d = await db();
  const [doc] = await d.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc?.fileKey) throw new WorkspaceError("No PDF uploaded.");
  const src = await getBytes(doc.fileKey);
  const pdf = await PDFDocument.load(src, { ignoreEncryption: true });
  const fields = fieldsOf(doc);
  // The PDF's own form boxes: emptied and flattened, so our stamped values are the only ones showing.
  try {
    const form = pdf.getForm();
    const ours = new Set(fields.map((f) => f.acroName).filter(Boolean));
    for (const f of form.getFields()) {
      if (!ours.has(f.getName())) continue;
      try { if (f instanceof PDFTextField) f.setText(""); else if (f instanceof PDFCheckBox) f.uncheck(); } catch { /* keep going */ }
    }
    if (form.getFields().length) form.flatten();
  } catch { /* some PDFs' forms can't be flattened; the stamped values still print on top */ }
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sigRows = await d.select().from(documentSignatures).where(eq(documentSignatures.documentId, id));
  const sigImages = new Map<string, Awaited<ReturnType<PDFDocument["embedPng"]>>>();
  for (const s of sigRows) sigImages.set(`sig:${s.id}`, await pdf.embedPng(Buffer.from(s.png, "base64")));
  const pages = pdf.getPages();
  // White-out goes down first, then highlight, then everything else, so words typed over a covered spot still show.
  const layer = (f: DocField) => (f.type === "whiteout" ? 0 : f.type === "highlight" ? 1 : 2);
  for (const f of [...fields].sort((x, z) => layer(x) - layer(z))) {
    const page = pages[f.page];
    if (!page) continue;
    if (isMarkup(f.type)) drawMarkup(page, f, font, bold);
    else drawValue(page, f, f.bold ? bold : font, sigImages);
  }
  await addCertificate(pdf, doc, fields, sigRows, font, bold);
  pdf.setTitle(doc.title);
  pdf.setProducer("MyPCP Documents");
  const out = await pdf.save();
  const finalKey = doc.fileKey.replace(/\.pdf$/, "") + `-signed-${id}.pdf`;
  await putBytes(finalKey, out);
  await d.update(documents).set({ status: "completed", completedAt: new Date(), finalKey, finalSha256: sha256(out), updatedByUserId: a.id }).where(eq(documents.id, id));
  await logEvent(id, "completed", { userId: a.id, detail: `signed PDF ${sha256(out).slice(0, 16)}…` });
}

async function addCertificate(pdf: PDFDocument, doc: DocRow, fields: DocField[], sigRows: (typeof documentSignatures.$inferSelect)[], font: PDFFont, bold: PDFFont) {
  const d = await db();
  const userIds = Array.from(new Set([doc.createdByUserId, ...sigRows.map((s) => s.userId), ...sigRows.map((s) => s.onBehalfOfUserId).filter((x): x is number => !!x)]));
  const signerRows = await d.select().from(documentSigners).where(eq(documentSigners.documentId, doc.id));
  for (const s of signerRows) if (!userIds.includes(s.userId)) userIds.push(s.userId);
  const people = new Map((await d.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))).map((u) => [u.id, u.name ?? `User #${u.id}`]));
  const events = await d.select().from(documentEvents).where(eq(documentEvents.documentId, doc.id)).orderBy(asc(documentEvents.at), asc(documentEvents.id));
  let page = pdf.addPage([612, 792]);
  let y = 740;
  const line = (text: string, opts: { size?: number; b?: boolean; indent?: number; color?: number } = {}) => {
    const size = opts.size ?? 9, f = opts.b ? bold : font, x = 50 + (opts.indent ?? 0);
    const words = safeText(f, text).split(" ");
    let cur = "";
    const flush = () => {
      if (y < 60) { page = pdf.addPage([612, 792]); y = 740; }
      page.drawText(cur, { x, y, size, font: f, color: rgb(opts.color ?? 0.1, opts.color ?? 0.1, opts.color ?? 0.15) });
      y -= size * 1.45; cur = "";
    };
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > 512 - (opts.indent ?? 0) && cur) { flush(); cur = w; } else cur = next;
    }
    flush();
  };
  line("Signature certificate", { size: 16, b: true });
  y -= 4;
  line(`Document: ${doc.title}`, { b: true });
  line(`Document ID: MyPCP-DOC-${doc.id} · Original file: ${doc.fileName ?? "PDF"} (${pdf.getPageCount() - 1} pages)`);
  line(`Original PDF fingerprint (SHA-256): ${doc.fileSha256 ?? ""}`, { size: 7.5 });
  line(`Prepared by: ${people.get(doc.createdByUserId)} · Completed: ${fmt(new Date())}`);
  // Anything drawn over the original pages is said plainly, so a reader knows the page was marked up.
  const marks = new Map<string, number>();
  for (const f of fields) if (isMarkup(f.type)) marks.set(f.type, (marks.get(f.type) ?? 0) + 1);
  if (marks.size) {
    const names: Record<string, string> = { whiteout: "white-out", highlight: "highlight", mark: "tick / cross / circle", line: "line", stamp: "stamp", logo: "logo" };
    line(`Marks added to the pages by the preparer before signing: ${Array.from(marks).map(([t, n]) => `${n} ${names[t] ?? t}`).join(", ")}.`);
  }
  y -= 8;
  line("Signatures", { size: 12, b: true });
  for (const s of sigRows.sort((x, z) => x.signedAt.getTime() - z.signedAt.getTime())) {
    const f = fields.find((x) => x.id === s.fieldId);
    const whose = s.onBehalfOfUserId ?? s.userId;
    line(`${people.get(whose)}: ${s.kind === "initials" ? "initials" : "signature"}${f?.label ? ` ("${f.label}")` : ""}, page ${f ? f.page + 1 : "?"}`, { b: true, indent: 8 });
    if (s.onBehalfOfUserId) line(`Applied by ${people.get(s.userId)} with ${people.get(s.onBehalfOfUserId)}'s approval (${(APPROVAL_LABELS[s.approvalMethod as ApprovalMethod] ?? s.approvalMethod ?? "").toLowerCase()}${s.approvalNote ? `: ${s.approvalNote}` : ""}).`, { indent: 16, size: 8 });
    line(`${fmt(s.signedAt)} · IP ${s.ip ?? "unknown"} · image fingerprint ${s.sha256.slice(0, 24)}…`, { indent: 16, size: 8, color: 0.35 });
  }
  if (!sigRows.length) line("No signature boxes on this document.", { indent: 8, color: 0.4 });
  if (signerRows.length) {
    y -= 6;
    line("Signers", { size: 12, b: true });
    for (const s of signerRows) line(`${people.get(s.userId)}: ${s.status === "signed" ? `finished ${fmt(s.signedAt)} (IP ${s.ip ?? "unknown"})` : "did not sign"}`, { indent: 8 });
  }
  y -= 6;
  line("History (US Central time)", { size: 12, b: true });
  for (const e of events.filter((x) => x.type !== "viewed")) {
    line(`${fmt(e.at)}  ${e.type.replace(/_/g, " ")}${e.userId ? ` · ${people.get(e.userId) ?? `user #${e.userId}`}` : ""}${e.detail ? ` · ${e.detail}` : ""}`, { indent: 8, size: 8 });
  }
  y -= 8;
  line("Each person signed inside MyPCP while signed in with their own account. The fingerprints above change if the original file or a signature image is altered.", { size: 7.5, color: 0.4 });
}


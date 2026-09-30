// Documents: our own DocuSign, for the team.
//
// Someone uploads a PDF (or starts from a saved template), places boxes on it (text, date, checkbox,
// signature, initials), fills in their own part and signs it. If teammates need to sign too, it goes out
// for signature: each signer gets a task, opens it in MyPCP and fills in / signs their boxes. When the last
// signer is done, MyPCP builds the final PDF: every value and signature stamped onto the original pages,
// the form flattened, and a certificate page (who signed what, when, from where, document fingerprints).
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFRef, PDFSignature, PDFTextField, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { getDb } from "./db";
import { clinics, documentEvents, documentSignatures, documentSigners, documents, patients, userSignatures, users, workTaskActivities, workTasks } from "../drizzle/schema";
import {
  cleanFields, missingFor, signerOf, usDate, type Assignee, type DocField, type DocPage, type DocStatus, type PrefillKey,
} from "../shared/documents";
import { localDateStr } from "../shared/workforce";
import { MAX_PDF_BYTES, getBytes, onS3, putBytes, readTarget, uploadTarget } from "./docStore";
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
  return (await signersOf(doc.id)).some((s) => s.s.userId === a.id);
}
/** Change the boxes / title / signers: the creator (or an admin) while it's a draft. Templates: whoever made it, or an admin. */
const canEdit = (a: WorkspaceActor, doc: DocRow) => doc.status === "draft" && (doc.createdByUserId === a.id || isAdmin(a));

async function docOr404(a: WorkspaceActor, id: number) {
  const [doc] = await (await db()).select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc || !(await canView(a, doc))) throw new WorkspaceError("That document wasn't found.", "NOT_FOUND");
  return doc;
}

const pagesOf = (doc: DocRow) => (doc.pages ?? []) as DocPage[];
const fieldsOf = (doc: DocRow) => cleanFields(doc.fields ?? [], pagesOf(doc));

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export type DocView = "to_sign" | "in_progress" | "completed" | "templates";

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
    .where(and(inArray(users.role, ["admin", "office_manager", "staff", "provider", "front_desk"]), sql`${users.openId} NOT LIKE 'roster:%'`)).orderBy(asc(users.name));
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

/** After the upload: check it's a PDF, record its pages, and turn its own fillable boxes into ours. */
export async function fileUploaded(a: WorkspaceActor, id: number) {
  const doc = await docOr404(a, id);
  if (!canEdit(a, doc) || !doc.fileKey) throw new WorkspaceError("This document can't be changed.");
  let bytes: Buffer;
  try { bytes = await getBytes(doc.fileKey); } catch { throw new WorkspaceError("The upload didn't arrive. Please try again."); }
  if (bytes.length > MAX_PDF_BYTES) throw new WorkspaceError("That PDF is too big.");
  if (bytes.subarray(0, 1024).indexOf("%PDF") < 0) throw new WorkspaceError("That file isn't a PDF.");
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); } catch { throw new WorkspaceError("MyPCP couldn't read that PDF. Try saving it again as a PDF (Print → Save as PDF) and upload that."); }
  const pages: DocPage[] = pdf.getPages().map((p) => { const { width, height } = p.getSize(); return { w: width, h: height, rotate: p.getRotation().angle }; });
  const fields = readFormFields(pdf);
  await (await db()).update(documents).set({ pages, fields, fileSha256: sha256(bytes), fileSize: bytes.length, updatedByUserId: a.id }).where(eq(documents.id, id));
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
// Templates
// ---------------------------------------------------------------------------

/**
 * Save the layout (boxes, labels, auto-fill) to reuse. Every value and signature is left out, so one
 * patient's details never carry over to the next document (fixed wording can be typed into the template itself).
 */
export async function saveAsTemplate(a: WorkspaceActor, id: number, title: string) {
  const doc = await docOr404(a, id);
  if (!doc.fileKey || !pagesOf(doc).length) throw new WorkspaceError("Upload the PDF first.");
  const fields = fieldsOf(doc).map((f) => ({ ...f, value: null, assignee: "preparer" as Assignee }));
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
  if (care && a.clinicIds && !(care.clinicId && a.clinicIds.includes(care.clinicId))) throw new WorkspaceError("That patient isn't at your office.", "FORBIDDEN");
  const values = await prefillValues(a, subjectKey);
  const fields = fieldsOf(t).map((f) => ({ ...f, value: f.prefill && values[f.prefill] != null ? values[f.prefill]! : f.value ?? null }));
  const res = await (await db()).insert(documents).values({
    title: care ? `${t.title}: ${care.name}`.slice(0, 255) : t.title, templateId: t.id, status: "draft", fileKey: t.fileKey, fileName: t.fileName, fileSize: t.fileSize, fileSha256: t.fileSha256,
    pages: t.pages, fields, subjectKey, patientId: care?.patientId ?? null, clinicId: care?.clinicId ?? a.clinicIds?.[0] ?? null, createdByUserId: a.id, updatedByUserId: a.id,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  await logEvent(id, "created", { userId: a.id, detail: `from template "${t.title}"`.slice(0, 200) });
  await audit(a, "manage_document", { entityType: "document", entityId: id, description: `New document from template "${t.title}"${care ? " for a patient" : ""}` });
  return { id };
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
  if (care.clinicId) {
    const [c] = await d.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, care.clinicId)).limit(1);
    if (c) out.clinic_name = c.name;
  }
  return out;
}

// ---------------------------------------------------------------------------
// One document: open, save, sign boxes
// ---------------------------------------------------------------------------

export async function getDocument(a: WorkspaceActor, id: number, meta: ClientMeta) {
  const d = await db();
  const doc = await docOr404(a, id);
  const signers = await signersOf(id);
  const sigs = await d.select({ id: documentSignatures.id, png: documentSignatures.png, userId: documentSignatures.userId, signedAt: documentSignatures.signedAt, name: users.name })
    .from(documentSignatures).leftJoin(users, eq(users.id, documentSignatures.userId)).where(eq(documentSignatures.documentId, id));
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
    signers: signers.map((s) => ({ userId: s.s.userId, name: s.name, status: s.s.status as "pending" | "signed", signedAt: s.s.signedAt })),
    signatures: Object.fromEntries(sigs.map((s) => [`sig:${s.id}`, { png: `data:image/png;base64,${s.png}`, name: s.name, signedAt: s.signedAt }])),
    events: events.map(({ e, name }) => ({ at: e.at, type: e.type, detail: e.detail, name })),
  };
}

/** The PDF itself, for the editor to draw (or the signed PDF to download). */
export async function fileFor(a: WorkspaceActor, id: number, which: "source" | "final", meta: ClientMeta) {
  const doc = await docOr404(a, id);
  const key = which === "final" ? doc.finalKey : doc.fileKey;
  if (!key) throw new WorkspaceError(which === "final" ? "The signed PDF isn't ready yet." : "No PDF uploaded yet.");
  if (which === "final") {
    await logEvent(id, "downloaded", { userId: a.id, meta });
    await audit(a, "view_document", { entityType: "document", entityId: id, description: `Downloaded signed "${doc.title}"` });
  }
  const name = which === "final" ? `${doc.title} (signed).pdf` : doc.fileName;
  return readTarget(key, which === "final" ? name : null);
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
  const values = await prefillValues(a, doc.subjectKey);
  const fields = fieldsOf(doc).map((f) => (f.prefill && values[f.prefill] != null ? { ...f, value: values[f.prefill]! } : f));
  await (await db()).update(documents).set({ fields, updatedByUserId: a.id }).where(eq(documents.id, id));
  return { fields };
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
export async function signField(a: WorkspaceActor, id: number, input: { fieldId: string; png: string; saveAsMine?: boolean }, meta: ClientMeta) {
  const doc = await docOr404(a, id);
  const fields = fieldsOf(doc);
  const f = fields.find((x) => x.id === input.fieldId);
  if (!f || (f.type !== "signature" && f.type !== "initials")) throw new WorkspaceError("That box isn't a signature box.");
  const mine = f.assignee === "preparer" ? canEdit(a, doc) : signerOf(f.assignee) === a.id && doc.status === "signing" && (await pendingSigner(id, a.id));
  if (!mine) throw new WorkspaceError("That box is for someone else to sign.", "FORBIDDEN");
  const m = PNG_RE.exec(input.png);
  const bytes = m ? Buffer.from(m[1]!, "base64") : null;
  if (!m || !bytes || bytes.length < 100 || bytes.length > 600_000) throw new WorkspaceError("Please sign again.");
  const d = await db();
  const res = await d.insert(documentSignatures).values({
    documentId: id, fieldId: f.id, userId: a.id, kind: f.type, png: m[1]!, sha256: sha256(bytes), signedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
    ip: meta.ip?.slice(0, 64) ?? null, userAgent: meta.userAgent?.slice(0, 255) ?? null,
  });
  const sigId = (res as unknown as [{ insertId: number }])[0].insertId;
  const value = `sig:${sigId}`;
  await d.update(documents).set({ fields: fields.map((x) => (x.id === f.id ? { ...x, value } : x)), updatedByUserId: a.id }).where(eq(documents.id, id));
  if (input.saveAsMine) await saveMySignature(a, f.type === "initials" ? { initialsPng: input.png } : { signaturePng: input.png });
  await logEvent(id, f.type === "initials" ? "initialed" : "signed_box", { userId: a.id, meta, detail: f.label ?? null });
  return { value, png: input.png };
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
  for (const f of fields) {
    const page = pages[f.page];
    if (page) drawValue(page, f, font, sigImages);
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
  const userIds = Array.from(new Set([doc.createdByUserId, ...sigRows.map((s) => s.userId)]));
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
  y -= 8;
  line("Signatures", { size: 12, b: true });
  for (const s of sigRows.sort((x, z) => x.signedAt.getTime() - z.signedAt.getTime())) {
    const f = fields.find((x) => x.id === s.fieldId);
    line(`${people.get(s.userId)}: ${s.kind === "initials" ? "initials" : "signature"}${f?.label ? ` ("${f.label}")` : ""}, page ${f ? f.page + 1 : "?"}`, { b: true, indent: 8 });
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


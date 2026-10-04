// Sending faxes from MyPCP through RingCentral (BAA in place), from each clinic's own fax number.
//
// RingCentral sends from the fax number of the RingCentral user it's sent "as". By default MyPCP uses
// the RingCentral server app already connected for the call log (Integrations) and sends as the
// user an admin picked for each clinic (needs the Faxes permission, and the RingCentral admin who made
// the sign-in key needs fax rights for that user). A clinic can instead have its own sign-in key (JWT)
// made by that clinic's fax user. Files go to RingCentral through the allowlist relay (~4 MB per fax).
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { getDb } from "./db";
import { appSettings, clinics, documents, faxContacts, faxes, outboundFaxes, patientFiles, users } from "../drizzle/schema";
import { WorkspaceError, audit, subjectCare, type WorkspaceActor } from "./workspaceDb";
import { exists, getBytes, onS3, putBytes, uploadTarget } from "./docStore";
import { openSecret, sealSecret } from "./secretBox";
import { relayFetch } from "./egress";
import { loadCredentials } from "./ringcentralSync";
import {
  CONFIDENTIALITY_NOTICE, FAX_UPLOAD_TYPES, MAX_FAX_BYTES, OUTBOUND_FAX_STATUS, faxFileName, faxStatusFrom, normalizeFaxNumber,
  type FaxAttachmentRef, type OutboundFaxStatus,
} from "../shared/faxSend";
import { formatPhone } from "../shared/phone";
import { can } from "../shared/workspace";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

// Local development can point at a stand-in RingCentral (never on AWS).
const API = !process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.RINGCENTRAL_API_BASE ? process.env.RINGCENTRAL_API_BASE.replace(/\/$/, "") : "https://platform.ringcentral.com";
const SETTINGS_KEY = "fax_send";
const MAX_FILES = 10;

interface ClinicFaxConfig { extensionId: string | null; extensionName: string | null; fromNumber: string | null; jwtEnc: string | null }
interface FaxSendSettings { clinics: Record<string, ClinicFaxConfig> }

async function settings(): Promise<FaxSendSettings> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, SETTINGS_KEY)).limit(1);
  const v = (row?.value ?? {}) as Partial<FaxSendSettings>;
  return { clinics: v.clinics ?? {} };
}

// ---------------------------------------------------------------------------
// RingCentral sign-in
// ---------------------------------------------------------------------------

const tokens = new Map<string, { token: string; exp: number }>();

export async function tokenFor(cfg: { clientId: string; clientSecret: string; jwt: string }): Promise<string> {
  const k = createHash("sha256").update(`${cfg.clientId}:${cfg.jwt}`).digest("hex");
  const hit = tokens.get(k);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const res = await relayFetch(`${API}/restapi/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: cfg.jwt }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; message?: string };
  if (!res.ok || !body.access_token) throw new WorkspaceError(`RingCentral sign-in failed: ${body.error_description ?? body.message ?? res.statusText}. Check the sign-in key in Admin → Integrations.`);
  tokens.set(k, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

export async function serverCredentials() {
  const creds = await loadCredentials();
  if (!creds) throw new WorkspaceError("RingCentral isn't connected yet. An admin adds the RingCentral server app in Admin → Integrations.");
  return creds;
}

/** How to send for a clinic: the token, and the RingCentral user ("~" = whoever the key belongs to). */
async function senderFor(clinicId: number) {
  const creds = await serverCredentials();
  const c = (await settings()).clinics[String(clinicId)];
  if (!c || (!c.extensionId && !c.jwtEnc)) {
    const [cl] = await (await db()).select({ name: clinics.name }).from(clinics).where(eq(clinics.id, clinicId)).limit(1);
    throw new WorkspaceError(`Faxing isn't set up for ${cl?.name ?? "this clinic"} yet. An admin picks its fax number in Admin → Integrations.`);
  }
  if (c.jwtEnc) return { token: await tokenFor({ clientId: creds.clientId, clientSecret: creds.clientSecret, jwt: openSecret(c.jwtEnc) }), ext: "~", config: c };
  return { token: await tokenFor(creds), ext: c.extensionId!, config: c };
}

async function rcJson<T>(res: Response): Promise<T & { message?: string; errorCode?: string; errors?: { message?: string }[] }> {
  return (await res.json().catch(() => ({}))) as T & { message?: string; errorCode?: string };
}

// ---------------------------------------------------------------------------
// Admin: which RingCentral user sends for each clinic
// ---------------------------------------------------------------------------

export async function faxSetup() {
  const creds = await loadCredentials().catch(() => null);
  const s = await settings();
  const rows = await (await db()).select({ id: clinics.id, name: clinics.name, phone: clinics.phone }).from(clinics).orderBy(asc(clinics.name));
  return {
    connected: !!creds,
    clinics: rows.map((c) => {
      const cfg = s.clinics[String(c.id)];
      return { id: c.id, name: c.name, extensionId: cfg?.extensionId ?? null, extensionName: cfg?.extensionName ?? null, fromNumber: cfg?.fromNumber ?? null, ownKey: !!cfg?.jwtEnc, ready: !!(cfg?.extensionId || cfg?.jwtEnc) };
    }),
  };
}

/** The company's fax-capable numbers and whose they are (to pick each clinic's sender). */
export async function faxNumbers() {
  const token = await tokenFor(await serverCredentials());
  const get = async <T>(path: string) => {
    const res = await relayFetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const body = await rcJson<T>(res);
    if (!res.ok) throw new WorkspaceError(res.status === 403 ? "RingCentral didn't allow reading the company's numbers. The server app needs the Read Accounts permission." : `RingCentral ${res.status}: ${body.message ?? res.statusText}`);
    return body;
  };
  const names = new Map<string, string>();
  for (let page = 1; page <= 5; page++) {
    const r = await get<{ records?: { id: number; name?: string; extensionNumber?: string }[]; navigation?: { nextPage?: unknown } }>(`/restapi/v1.0/account/~/extension?perPage=1000&page=${page}`);
    for (const e of r.records ?? []) names.set(String(e.id), `${e.name ?? "RingCentral user"}${e.extensionNumber ? ` (ext. ${e.extensionNumber})` : ""}`);
    if (!r.navigation?.nextPage) break;
  }
  const out: { extensionId: string; extensionName: string; number: string }[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await get<{ records?: { phoneNumber?: string; type?: string; extension?: { id?: number } }[]; navigation?: { nextPage?: unknown } }>(`/restapi/v1.0/account/~/phone-number?perPage=1000&page=${page}`);
    for (const n of r.records ?? []) {
      if (!n.extension?.id || !/fax/i.test(n.type ?? "")) continue;
      const ext = String(n.extension.id);
      out.push({ extensionId: ext, extensionName: names.get(ext) ?? `RingCentral user ${ext}`, number: normalizeFaxNumber(n.phoneNumber) ?? String(n.phoneNumber ?? "") });
    }
    if (!r.navigation?.nextPage) break;
  }
  return out.sort((a, b) => a.extensionName.localeCompare(b.extensionName));
}

export async function saveClinicFax(actor: WorkspaceActor, input: { clinicId: number; extensionId?: string | null; extensionName?: string | null; fromNumber?: string | null; jwt?: string | null; clearKey?: boolean }) {
  const s = await settings();
  const prev = s.clinics[String(input.clinicId)];
  s.clinics[String(input.clinicId)] = {
    extensionId: input.extensionId?.trim() || null,
    extensionName: input.extensionName?.trim().slice(0, 120) || null,
    fromNumber: normalizeFaxNumber(input.fromNumber) ?? null,
    // Blank = keep the stored key (the screen never shows it).
    jwtEnc: input.clearKey ? null : input.jwt?.trim() ? sealSecret(input.jwt.trim()) : prev?.jwtEnc ?? null,
  };
  await (await db()).insert(appSettings).values({ key: SETTINGS_KEY, value: s, updatedByUserId: actor.id }).onDuplicateKeyUpdate({ set: { value: s, updatedByUserId: actor.id } });
  await audit(actor, "manage_access", { entityType: "integration", description: `Fax sending for clinic #${input.clinicId}: ${s.clinics[String(input.clinicId)]!.extensionName ?? "own sign-in key"}` });
  return { ok: true };
}

/** Which clinics can send right now, and from which number (for the send screen). */
export async function sendFrom() {
  const s = await settings();
  const rows = await (await db()).select({ id: clinics.id, name: clinics.name, phone: clinics.phone }).from(clinics).orderBy(asc(clinics.name));
  return rows.map((c) => {
    const cfg = s.clinics[String(c.id)];
    return { id: c.id, name: c.name, fromNumber: cfg?.fromNumber ?? null, ready: !!(cfg?.extensionId || cfg?.jwtEnc) };
  });
}

// ---------------------------------------------------------------------------
// Contacts (specialists, pharmacies, hospitals…)
// ---------------------------------------------------------------------------

export async function listContacts(q?: string | null) {
  const words = (q ?? "").replace(/[%_\\]/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 4);
  const digits = (q ?? "").replace(/\D/g, "");
  const match = words.length ? (digits.length >= 3 ? sql`${faxContacts.faxNumber} LIKE ${`%${digits}%`}` : and(...words.map((w) => sql`${faxContacts.name} LIKE ${`%${w}%`}`))) : undefined;
  return (await db()).select({ id: faxContacts.id, name: faxContacts.name, faxNumber: faxContacts.faxNumber, note: faxContacts.note, lastUsedAt: faxContacts.lastUsedAt })
    .from(faxContacts).where(and(isNull(faxContacts.removedAt), match)).orderBy(sql`${faxContacts.lastUsedAt} IS NULL`, desc(faxContacts.lastUsedAt), asc(faxContacts.name)).limit(200);
}

export async function saveContact(actor: WorkspaceActor, input: { id?: number | null; name: string; faxNumber: string; note?: string | null }) {
  const number = normalizeFaxNumber(input.faxNumber);
  if (!number) throw new WorkspaceError("That isn't a valid US fax number (10 digits).");
  const name = input.name.replace(/[\r\n<>]/g, " ").trim().slice(0, 160);
  if (!name) throw new WorkspaceError("Give the contact a name.");
  const d = await db();
  const values = { name, faxNumber: number, note: input.note?.trim().slice(0, 255) || null };
  if (input.id) {
    await d.update(faxContacts).set(values).where(eq(faxContacts.id, input.id));
    return { id: input.id };
  }
  const [same] = await d.select({ id: faxContacts.id }).from(faxContacts).where(and(eq(faxContacts.faxNumber, number), isNull(faxContacts.removedAt))).limit(1);
  if (same) { await d.update(faxContacts).set(values).where(eq(faxContacts.id, same.id)); return { id: same.id }; }
  const res = await d.insert(faxContacts).values({ ...values, createdByUserId: actor.id });
  return { id: Number((res as unknown as [{ insertId: number }])[0]?.insertId) };
}

export async function removeContact(actor: WorkspaceActor, id: number) {
  await (await db()).update(faxContacts).set({ removedAt: new Date() }).where(eq(faxContacts.id, id));
  await audit(actor, "manage_access", { entityType: "faxContact", entityId: id, description: "Fax contact removed" });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// What can be attached
// ---------------------------------------------------------------------------

const uploadPrefix = (userId: number) => `faxes/outbound/${userId}/`;

/** Upload a file from the computer (straight to the private bucket; locally through the API). */
export async function startUpload(actor: WorkspaceActor, input: { fileName: string; mimeType: string; size: number }) {
  if (!FAX_UPLOAD_TYPES[input.mimeType]) throw new WorkspaceError("Attach a PDF, Word file, JPG, PNG or TIFF.");
  if (input.size <= 0 || input.size > MAX_FAX_BYTES) throw new WorkspaceError("Files can be up to 4 MB in one fax.");
  const key = `${uploadPrefix(actor.id)}${randomUUID()}`;
  return { key, upload: await uploadTarget(key, input.mimeType) };
}

export async function uploadLocal(actor: WorkspaceActor, key: string, base64: string) {
  if (onS3()) throw new WorkspaceError("Upload straight to storage.");
  if (!key.startsWith(uploadPrefix(actor.id))) throw new WorkspaceError("That upload wasn't found.", "NOT_FOUND");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_FAX_BYTES) throw new WorkspaceError("Files can be up to 4 MB in one fax.");
  await putBytes(key, bytes, "application/octet-stream");
  return { ok: true };
}

const pidOf = (key: string) => (/^p:\d+$/.test(key) ? Number(key.slice(2)) : null);
function whose(subjectCol: Parameters<typeof eq>[0], patientCol: Parameters<typeof eq>[0], key: string): SQL {
  const pid = pidOf(key);
  return pid ? or(eq(subjectCol, key), eq(patientCol, pid))! : eq(subjectCol, key);
}

/** The patient's folder files, signed documents and received faxes (faxes: for people who see the fax inbox). */
export async function attachables(actor: WorkspaceActor, subjectKey: string) {
  const d = await db();
  const files = can(actor.role, "documents")
    ? await d.select({ id: patientFiles.id, title: patientFiles.title, mimeType: patientFiles.mimeType, size: patientFiles.sizeBytes, at: patientFiles.createdAt }).from(patientFiles)
      .where(and(whose(patientFiles.subjectKey, patientFiles.patientId, subjectKey), eq(patientFiles.status, "ready"), isNull(patientFiles.removedAt))).orderBy(desc(patientFiles.createdAt)).limit(100)
    : [];
  const docs = await d.select({ id: documents.id, title: documents.title, at: documents.completedAt }).from(documents)
    .where(and(whose(documents.subjectKey, documents.patientId, subjectKey), eq(documents.status, "completed"), isNotNull(documents.finalKey))).orderBy(desc(documents.completedAt)).limit(100);
  const received = can(actor.role, "emailTriage")
    ? await d.select({ id: faxes.id, summary: faxes.aiSummary, filename: faxes.filename, size: faxes.sizeBytes, at: faxes.receivedAt, mimeType: faxes.mimeType }).from(faxes)
      .where(and(whose(faxes.subjectKey, faxes.patientId, subjectKey), isNotNull(faxes.attachmentId))).orderBy(desc(faxes.receivedAt)).limit(100)
    : [];
  return [
    ...files.map((f) => ({ ref: { kind: "file" as const, id: f.id }, name: f.title, detail: "Folder file", size: f.size, at: f.at })),
    ...docs.map((x) => ({ ref: { kind: "document" as const, id: x.id }, name: x.title, detail: "Signed document", size: null as number | null, at: x.at })),
    ...received.map((f) => ({ ref: { kind: "fax" as const, id: f.id }, name: f.summary || f.filename || "Fax", detail: "Fax we received", size: f.size, at: f.at })),
  ];
}

const EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/tiff": "tif", "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx" };

interface Gathered { name: string; mimeType: string; bytes: Buffer }

/** The bytes of everything attached, each checked against who may see it. */
async function gather(actor: WorkspaceActor, refs: FaxAttachmentRef[], subjectKey: string | null, extraUploadKeys: Set<string> = new Set()): Promise<{ files: Gathered[]; names: string[] }> {
  const d = await db();
  const files: Gathered[] = [];
  const names: string[] = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    let g: Gathered;
    if (ref.kind === "upload") {
      if (!ref.key.startsWith(uploadPrefix(actor.id)) && !extraUploadKeys.has(ref.key)) throw new WorkspaceError("That upload wasn't found.", "NOT_FOUND");
      if (!FAX_UPLOAD_TYPES[ref.mimeType]) throw new WorkspaceError("Attach a PDF, Word file, JPG, PNG or TIFF.");
      if (!(await exists(ref.key))) throw new WorkspaceError(`"${ref.name}" didn't finish uploading. Attach it again.`);
      g = { name: ref.name, mimeType: ref.mimeType, bytes: await getBytes(ref.key) };
    } else if (ref.kind === "file") {
      if (!can(actor.role, "documents")) throw new WorkspaceError("You don't have access to folder files.", "FORBIDDEN");
      const [f] = await d.select().from(patientFiles).where(and(eq(patientFiles.id, ref.id), eq(patientFiles.status, "ready"), isNull(patientFiles.removedAt))).limit(1);
      if (!f) throw new WorkspaceError("A folder file wasn't found.", "NOT_FOUND");
      g = { name: f.title, mimeType: f.mimeType, bytes: await getBytes(f.storageKey) };
    } else if (ref.kind === "document") {
      const { signedPdfForFax } = await import("./documentsDb");
      const doc = await signedPdfForFax(actor, ref.id, subjectKey);
      g = { name: doc.title, mimeType: "application/pdf", bytes: doc.bytes };
    } else {
      const { faxFile } = await import("./faxInbox");
      const f = await faxFile(actor, ref.id);
      g = { name: f.filename, mimeType: f.mimeType, bytes: Buffer.from(f.base64, "base64") };
    }
    const ext = EXT[g.mimeType] ?? "pdf";
    const base = faxFileName(g.name.replace(/\.[a-z0-9]{2,4}$/i, ""), `attachment-${i + 1}`);
    files.push({ ...g, name: `${base}.${ext}` });
    names.push(g.name);
  }
  return { files, names };
}

async function pageCount(g: Gathered): Promise<number | null> {
  if (g.mimeType.startsWith("image/") && g.mimeType !== "image/tiff") return 1;
  if (g.mimeType !== "application/pdf") return null;
  try { return (await PDFDocument.load(g.bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount(); } catch { return null; }
}

// ---------------------------------------------------------------------------
// The cover sheet
// ---------------------------------------------------------------------------

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}

export async function coverSheet(o: { clinicName: string; clinicPhone: string | null; fromFax: string | null; toName: string; toFax: string; sender: string; date: string; pages: number | null; note: string | null }) {
  const pdf = await PDFDocument.create();
  const page: PDFPage = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const gray = rgb(0.4, 0.4, 0.45);
  // Fonts here only cover basic Latin: drop anything else rather than fail.
  const safe = (s: string) => s.replace(/[^\x20-\x7E\n]/g, "");
  let y = 730;
  page.drawText("FAX", { x: 50, y, size: 34, font: bold, color: ink });
  page.drawText(safe(o.clinicName), { x: 50, y: y - 30, size: 14, font: bold, color: ink });
  const contact = [o.clinicPhone ? `Phone ${formatPhone(o.clinicPhone)}` : null, o.fromFax ? `Fax ${formatPhone(o.fromFax)}` : null].filter(Boolean).join("   ");
  if (contact) page.drawText(contact, { x: 50, y: y - 48, size: 11, font, color: gray });
  y -= 90;
  page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 1, color: rgb(0.8, 0.8, 0.82) });
  y -= 30;
  const row = (label: string, value: string) => {
    page.drawText(label, { x: 50, y, size: 11, font: bold, color: gray });
    wrap(safe(value), font, 13, 400).forEach((l, i) => page.drawText(l, { x: 140, y: y - i * 16, size: 13, font, color: ink }));
    y -= 30;
  };
  row("TO", o.toName);
  row("FAX", formatPhone(o.toFax));
  row("FROM", `${o.sender}, ${o.clinicName}`);
  row("DATE", o.date);
  row("PAGES", o.pages ? `${o.pages} (including this cover sheet)` : "See attached");
  if (o.note?.trim()) {
    y -= 6;
    page.drawText("MESSAGE", { x: 50, y, size: 11, font: bold, color: gray });
    y -= 20;
    for (const l of wrap(safe(o.note.trim()), font, 12, 510).slice(0, 18)) { page.drawText(l, { x: 50, y, size: 12, font, color: ink }); y -= 16; }
  }
  let ny = 150;
  page.drawLine({ start: { x: 50, y: ny + 20 }, end: { x: 562, y: ny + 20 }, thickness: 1, color: rgb(0.8, 0.8, 0.82) });
  for (const l of wrap(CONFIDENTIALITY_NOTICE, font, 9, 510)) { page.drawText(l, { x: 50, y: ny, size: 9, font, color: gray }); ny -= 12; }
  return Buffer.from(await pdf.save());
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export function multipart(meta: unknown, files: Gathered[]) {
  const boundary = `MyPCPFax${randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n`)];
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Type: ${f.mimeType}\r\nContent-Disposition: attachment; filename="${f.name}"\r\n\r\n`), f.bytes, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/mixed; boundary=${boundary}` };
}

function rcError(status: number, body: { message?: string; errorCode?: string }, extName: string | null) {
  if (status === 403) {
    return extName
      ? `RingCentral didn't let MyPCP send from ${extName}'s fax number. The RingCentral admin who made MyPCP's sign-in key needs fax rights for that user (or add a sign-in key for this clinic in Admin → Integrations), and the app needs the Faxes permission.`
      : "RingCentral refused to send: the app needs the Faxes permission (Admin → Integrations explains how).";
  }
  if (status === 429) return "RingCentral is busy (too many requests). Try again in a minute.";
  return `RingCentral couldn't send it (${status}${body.message ? `: ${body.message}` : ""}).`;
}

export async function sendFax(actor: WorkspaceActor, input: {
  clinicId: number; toNumber: string; toName: string; saveContact?: boolean; subjectKey?: string | null; coverNote?: string | null;
  attachments: FaxAttachmentRef[]; resendOfId?: number | null;
}, extraUploadKeys?: Set<string>) {
  const toNumber = normalizeFaxNumber(input.toNumber);
  if (!toNumber) throw new WorkspaceError("That isn't a valid US fax number (10 digits).");
  const toName = input.toName.replace(/[\r\n<>]/g, " ").trim().slice(0, 160);
  if (!toName) throw new WorkspaceError("Who is it going to? Add the recipient's name.");
  if (!input.attachments.length) throw new WorkspaceError("Attach at least one file.");
  if (input.attachments.length > MAX_FILES) throw new WorkspaceError(`Up to ${MAX_FILES} files in one fax.`);
  const d = await db();
  const [clinic] = await d.select().from(clinics).where(eq(clinics.id, input.clinicId)).limit(1);
  if (!clinic) throw new WorkspaceError("Pick the clinic it's sent from.");
  // People limited to their clinic(s) (MAs, office managers) send from those clinics' numbers.
  if (actor.clinicIds && !actor.clinicIds.includes(clinic.id)) throw new WorkspaceError("You can send from your own clinic's fax number.", "FORBIDDEN");
  const sender = await senderFor(clinic.id);

  let patient: { patientId: number | null; name: string } | null = null;
  if (input.subjectKey) {
    patient = await subjectCare(input.subjectKey);
    if (!patient) { const { directoryEntry } = await import("./directoryDb"); const e = await directoryEntry(input.subjectKey); patient = e ? { patientId: e.patientId, name: e.name } : null; }
    if (!patient) throw new WorkspaceError("That patient wasn't found.");
  }

  const { files, names } = await gather(actor, input.attachments, input.subjectKey ?? null, extraUploadKeys);
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (total > MAX_FAX_BYTES) throw new WorkspaceError(`That's ${(total / 1_000_000).toFixed(1)} MB; one fax can carry up to 4 MB. Send it as two faxes.`);
  const counts = await Promise.all(files.map(pageCount));
  const pages = counts.every((c) => c !== null) ? 1 + (counts as number[]).reduce((n, c) => n + c, 0) : null;
  const date = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const cover = await coverSheet({
    clinicName: clinic.name, clinicPhone: clinic.phone, fromFax: sender.config.fromNumber, toName, toFax: toNumber,
    sender: (actor.name ?? "MyPCP").replace(/\s*\(.*?\)/, ""), date, pages, note: input.coverNote ?? null,
  });

  const res0 = await d.insert(outboundFaxes).values({
    clinicId: clinic.id, toNumber, toName, subjectKey: input.subjectKey ?? null, patientId: patient?.patientId ?? null, patientName: patient?.name.slice(0, 255) ?? null,
    coverNote: input.coverNote?.trim().slice(0, 2000) || null, attachments: input.attachments.map((ref, i) => ({ ref, name: names[i] ?? "File" })),
    pages, status: "sending", rcExtensionId: sender.ext === "~" ? null : sender.ext, sentByUserId: actor.id, resendOfId: input.resendOfId ?? null,
  });
  const id = Number((res0 as unknown as [{ insertId: number }])[0]?.insertId);

  const { body, contentType } = multipart({ to: [{ phoneNumber: `+1${toNumber}` }], faxResolution: "High", coverIndex: 0 }, [{ name: "Cover-sheet.pdf", mimeType: "application/pdf", bytes: cover }, ...files]);
  let res: Response;
  try {
    res = await relayFetch(`${API}/restapi/v1.0/account/~/extension/${sender.ext}/fax`, { method: "POST", headers: { Authorization: `Bearer ${sender.token}`, "Content-Type": contentType, Accept: "application/json" }, bodyBytes: body });
  } catch {
    await d.update(outboundFaxes).set({ status: "failed", error: "Couldn't reach RingCentral" }).where(eq(outboundFaxes.id, id));
    throw new WorkspaceError("Couldn't reach RingCentral. Nothing was sent; try again.");
  }
  const out = await rcJson<{ id?: number | string; messageStatus?: string; faxPageCount?: number }>(res);
  if (!res.ok || !out.id) {
    const msg = rcError(res.status, out, sender.ext === "~" ? null : sender.config.extensionName);
    await d.update(outboundFaxes).set({ status: "failed", error: msg.slice(0, 255) }).where(eq(outboundFaxes.id, id));
    throw new WorkspaceError(msg);
  }
  const status = faxStatusFrom(out.messageStatus);
  await d.update(outboundFaxes).set({ status, rcMessageId: String(out.id), pages: out.faxPageCount ?? pages, checkedAt: new Date(), ...(status === "sent" ? { sentAt: new Date() } : {}) }).where(eq(outboundFaxes.id, id));

  // Remember the number (or mark a saved contact as just used).
  const [contact] = await d.select({ id: faxContacts.id }).from(faxContacts).where(and(eq(faxContacts.faxNumber, toNumber), isNull(faxContacts.removedAt))).limit(1);
  if (contact) await d.update(faxContacts).set({ lastUsedAt: new Date() }).where(eq(faxContacts.id, contact.id));
  else if (input.saveContact) await d.insert(faxContacts).values({ name: toName, faxNumber: toNumber, createdByUserId: actor.id, lastUsedAt: new Date() });

  await audit(actor, "export_data", { entityType: "outboundFax", entityId: id, description: `Fax sent to ${toName} (…${toNumber.slice(-4)}), ${files.length} file${files.length === 1 ? "" : "s"}${patient ? ", about a patient" : ""}` });
  return { id, status };
}

/** Send a fax again (same recipient, cover note and files). */
export async function resendFax(actor: WorkspaceActor, id: number) {
  const [f] = await (await db()).select().from(outboundFaxes).where(eq(outboundFaxes.id, id)).limit(1);
  if (!f) throw new WorkspaceError("That fax wasn't found.", "NOT_FOUND");
  const refs = (f.attachments ?? []).map((a) => a.ref as FaxAttachmentRef);
  const uploads = new Set(refs.flatMap((r) => (r.kind === "upload" ? [r.key] : [])));
  return sendFax(actor, { clinicId: f.clinicId, toNumber: f.toNumber, toName: f.toName, subjectKey: f.subjectKey, coverNote: f.coverNote, attachments: refs, resendOfId: f.id }, uploads);
}

// ---------------------------------------------------------------------------
// Status (RingCentral queues the fax, then reports Sent or failed)
// ---------------------------------------------------------------------------

export async function refreshFaxStatuses(opts: { deadline: number; ids?: number[] }) {
  const d = await db();
  // Never reached RingCentral (the request died half-way): failed.
  await d.update(outboundFaxes).set({ status: "failed", error: "Didn't reach RingCentral" })
    .where(and(eq(outboundFaxes.status, "sending"), isNull(outboundFaxes.rcMessageId), lt(outboundFaxes.createdAt, new Date(Date.now() - 5 * 60_000))));
  const rows = await d.select().from(outboundFaxes).where(and(
    eq(outboundFaxes.status, "queued"), isNotNull(outboundFaxes.rcMessageId), gte(outboundFaxes.createdAt, new Date(Date.now() - 3 * 86_400_000)),
    ...(opts.ids?.length ? [inArray(outboundFaxes.id, opts.ids)] : []),
  )).orderBy(sql`${outboundFaxes.checkedAt} IS NOT NULL`, asc(outboundFaxes.checkedAt)).limit(20);
  const senders = new Map<number, Awaited<ReturnType<typeof senderFor>> | null>();
  let checked = 0;
  for (const f of rows) {
    if (Date.now() > opts.deadline) break;
    if (!senders.has(f.clinicId)) senders.set(f.clinicId, await senderFor(f.clinicId).catch(() => null));
    const s = senders.get(f.clinicId);
    if (!s) continue;
    const ext = f.rcExtensionId ?? "~";
    const res = await relayFetch(`${API}/restapi/v1.0/account/~/extension/${ext}/message-store/${f.rcMessageId}`, { headers: { Authorization: `Bearer ${s.token}`, Accept: "application/json" } }).catch(() => null);
    if (!res) continue;
    const m = await rcJson<{ messageStatus?: string; faxPageCount?: number; to?: { messageStatus?: string; faxErrorCode?: string }[] }>(res);
    if (!res.ok) { await d.update(outboundFaxes).set({ checkedAt: new Date() }).where(eq(outboundFaxes.id, f.id)); continue; }
    const raw = m.to?.[0]?.messageStatus ?? m.messageStatus;
    const status: OutboundFaxStatus = faxStatusFrom(raw);
    await d.update(outboundFaxes).set({
      status, checkedAt: new Date(), pages: m.faxPageCount ?? f.pages,
      ...(status === "sent" ? { sentAt: new Date() } : {}),
      ...(status === "failed" ? { error: (`RingCentral: ${m.to?.[0]?.faxErrorCode ?? raw ?? "failed"}`).slice(0, 255) } : {}),
    }).where(eq(outboundFaxes.id, f.id));
    checked++;
  }
  return { checked };
}

/** Sent faxes, newest first (checks RingCentral for a few that are still queued). */
export async function listSent(actor: WorkspaceActor, input: { subjectKey?: string | null }) {
  const d = await db();
  const waiting = await d.select({ id: outboundFaxes.id }).from(outboundFaxes)
    .where(and(eq(outboundFaxes.status, "queued"), lt(outboundFaxes.createdAt, new Date(Date.now() - 20_000)), or(isNull(outboundFaxes.checkedAt), lt(outboundFaxes.checkedAt, new Date(Date.now() - 30_000)))))
    .limit(5);
  if (waiting.length) await refreshFaxStatuses({ deadline: Date.now() + 6_000, ids: waiting.map((w) => w.id) }).catch(() => undefined);
  const where = input.subjectKey ? whose(outboundFaxes.subjectKey, outboundFaxes.patientId, input.subjectKey) : undefined;
  const rows = await d.select({ f: outboundFaxes, by: users.name, clinic: clinics.name }).from(outboundFaxes)
    .leftJoin(users, eq(users.id, outboundFaxes.sentByUserId)).leftJoin(clinics, eq(clinics.id, outboundFaxes.clinicId))
    .where(where).orderBy(desc(outboundFaxes.createdAt)).limit(200);
  return rows.map(({ f, by, clinic }) => ({
    id: f.id, toName: f.toName, toNumber: f.toNumber, clinic, by, at: f.createdAt, sentAt: f.sentAt,
    status: f.status as OutboundFaxStatus, statusLabel: OUTBOUND_FAX_STATUS[f.status as OutboundFaxStatus] ?? f.status, error: f.error, pages: f.pages,
    files: (f.attachments ?? []).map((a) => a.name), patient: f.subjectKey ? { key: f.subjectKey, id: f.patientId, name: f.patientName } : null,
    coverNote: f.coverNote, mine: f.sentByUserId === actor.id,
  }));
}

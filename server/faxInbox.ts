// Fax inbox: incoming faxes (arriving by email) → matched to a patient → a "File in Practice
// Fusion" task for the right person. Practice Fusion's API is read-only for documents, so staff do
// the upload; MyPCP finds the patient, routes the work and tracks what's still unfiled.
//
// The fax PDF is never stored here: it stays in the mailbox and is fetched on demand. The AI read
// uses the practice's AWS Bedrock model (covered by the AWS BAA) and only suggests; a fax is filed
// automatically only when its name AND date of birth match exactly one patient.
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { getDb } from "./db";
import { appSettings, faxes, users, workTaskActivities, workTasks } from "../drizzle/schema";
import {
  DEFAULT_FAX_SETTINGS, FAX_AI_PROMPT, FAX_DOC_TYPES, matchFaxPatient, parseFaxMeta, parseFaxReading,
  type FaxAttachment, type FaxDocType, type FaxSettings, type PersonRef,
} from "../shared/fax";
import { gmailMessageLink } from "../shared/email";
import { localDateStr } from "../shared/workforce";
import { WorkspaceError, audit, buildNameDobIndex, careTeamAssignee, createTask, subjectCare, type WorkspaceActor } from "./workspaceDb";
import type { MailSlot } from "./gmailSync";

const SETTINGS_KEY = "fax_settings";
/** Bedrock takes documents up to 4.5 MB; the relay returns at most ~6 MB. */
const MAX_AI_BYTES = 4_000_000;
const MAX_VIEW_BYTES = 4_000_000;

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export async function getFaxSettings(): Promise<FaxSettings> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, SETTINGS_KEY)).limit(1);
  return { ...DEFAULT_FAX_SETTINGS, ...((row?.value as Partial<FaxSettings> | undefined) ?? {}) };
}

export async function saveFaxSettings(actor: WorkspaceActor, input: FaxSettings) {
  const clean: FaxSettings = {
    senders: Array.from(new Set(input.senders.map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9._%+@-]+\.[a-z]{2,}$/.test(s)))).slice(0, 50),
    routing: input.routing,
    routeUserId: input.routing === "user" ? input.routeUserId : null,
    ai: input.ai,
  };
  if (clean.routing === "user" && !clean.routeUserId) throw new WorkspaceError("Pick the person who files faxes.");
  await (await db()).insert(appSettings).values({ key: SETTINGS_KEY, value: clean, updatedByUserId: actor.id }).onDuplicateKeyUpdate({ set: { value: clean, updatedByUserId: actor.id } });
  await audit(actor, "manage_access", { entityType: "integration", description: "Fax inbox settings saved" });
  return clean;
}

const aiReady = () => !!process.env.BEDROCK_MODEL_ID;

// ---- Arrival (called by the mailbox sync) ----

export async function ingestFax(f: {
  mailbox: MailSlot; gmailId: string; threadId: string; messageIdHeader: string | null; fromEmail: string | null; fromName: string | null;
  subject: string; body: string; receivedAt: Date; attachment: FaxAttachment;
}) {
  const settings = await getFaxSettings();
  const meta = parseFaxMeta(f.subject, f.body);
  const isPdf = /pdf/i.test(f.attachment.mimeType) || /\.pdf$/i.test(f.attachment.filename);
  const why = !settings.ai ? null : !aiReady() ? "AI reading isn't set up" : !isPdf ? "TIFF faxes can't be read automatically" : f.attachment.size > MAX_AI_BYTES ? "Too large to read automatically" : null;
  const canRead = settings.ai && !why;
  await (await db()).insert(faxes).values({
    mailbox: f.mailbox, gmailId: f.gmailId, threadId: f.threadId, messageIdHeader: f.messageIdHeader, fromEmail: f.fromEmail, fromName: f.fromName,
    fromNumber: meta.fromNumber, subject: f.subject, receivedAt: f.receivedAt, attachmentId: f.attachment.attachmentId,
    filename: f.attachment.filename.slice(0, 255), mimeType: f.attachment.mimeType.slice(0, 80), sizeBytes: f.attachment.size, pages: meta.pages,
    status: canRead ? "new" : "needs_patient", aiError: why,
  }).onDuplicateKeyUpdate({ set: { gmailId: f.gmailId } });
}

// ---- AI read (a few per scheduled run, and on demand) ----

let bedrock: BedrockRuntimeClient | null = null;

async function askBedrock(pdf: Buffer): Promise<string> {
  bedrock ??= new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1" });
  const out = await bedrock.send(new ConverseCommand({
    modelId: process.env.BEDROCK_MODEL_ID!,
    messages: [{ role: "user", content: [{ document: { format: "pdf", name: "incoming fax", source: { bytes: pdf } } }, { text: FAX_AI_PROMPT }] }],
    inferenceConfig: { maxTokens: 400, temperature: 0 },
  }));
  return (out.output?.message?.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("");
}

/** Everyone a fax could be about (CCM roster + schedule), with date of birth. */
async function peopleRefs(): Promise<PersonRef[]> {
  const idx = await buildNameDobIndex();
  return Array.from(idx.entries()).map(([k, v]) => ({ ...v, dob: k.split("|")[1] ?? null }));
}

async function readOne(id: number, people?: PersonRef[]) {
  const d = await db();
  const [f] = await d.select().from(faxes).where(eq(faxes.id, id)).limit(1);
  if (!f?.attachmentId) return;
  try {
    const { gmailAttachment, systemActor } = await import("./gmailSync");
    const pdf = await gmailAttachment(f.mailbox as MailSlot, f.gmailId, f.attachmentId);
    if (pdf.length > MAX_AI_BYTES) throw new Error("Too large to read automatically");
    const reading = parseFaxReading(await askBedrock(pdf));
    if (!reading) throw new Error("The AI couldn't read this fax");
    await d.update(faxes).set({
      docType: reading.documentType, aiPatientName: reading.patientName?.slice(0, 255) ?? null, aiDob: reading.dob, aiSender: reading.sender?.slice(0, 255) ?? null,
      aiSummary: reading.summary?.slice(0, 255) ?? null, aiError: null, aiAt: new Date(),
    }).where(eq(faxes.id, id));
    const match = matchFaxPatient(reading.patientName, reading.dob, people ?? await peopleRefs());
    if (match?.sure) {
      await assign(await systemActor(f.mailbox as MailSlot), id, match.person.key, "ai");
    } else {
      await d.update(faxes).set({ status: "needs_patient", suggestedKey: match?.person.key ?? null, suggestedName: match?.person.name.slice(0, 255) ?? null }).where(eq(faxes.id, id));
    }
  } catch (e) {
    await d.update(faxes).set({ status: "needs_patient", aiError: (e as Error).message.slice(0, 255), aiAt: new Date() }).where(eq(faxes.id, id));
  }
}

/** Read waiting faxes until the deadline. Each read takes a few seconds, so only start one with time to spare. */
export async function readPendingFaxes(opts: { deadline: number }) {
  if (!aiReady()) return { read: 0 };
  const d = await db();
  let read = 0;
  let people: PersonRef[] | undefined;
  while (Date.now() < opts.deadline) {
    const [f] = await d.select({ id: faxes.id }).from(faxes).where(eq(faxes.status, "new")).orderBy(faxes.receivedAt).limit(1);
    if (!f) break;
    people ??= await peopleRefs();
    await readOne(f.id, people);
    read++;
  }
  if (read) console.log(`[fax-read] ${JSON.stringify({ read })}`); // counts only
  return { read };
}

// ---- Assign / file ----

async function assign(actor: WorkspaceActor, faxId: number, subjectKey: string, method: "ai" | "manual", docType?: FaxDocType) {
  const d = await db();
  const [f] = await d.select().from(faxes).where(eq(faxes.id, faxId)).limit(1);
  if (!f) throw new WorkspaceError("Fax not found.", "NOT_FOUND");
  const care = await subjectCare(subjectKey);
  if (!care) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
  const settings = await getFaxSettings();
  const who = settings.routing === "user" && settings.routeUserId
    ? { assignedUserId: settings.routeUserId as number | null, assignedRole: null as string | null, clinicId: care.clinicId, who: "fax filer" }
    : await careTeamAssignee(subjectKey, { skipCoordinator: settings.routing === "front_desk" });
  const type = docType ?? (f.docType as FaxDocType | null) ?? "other";
  const from = f.aiSender ?? f.fromName ?? (f.fromNumber ? `fax ${f.fromNumber}` : f.fromEmail ?? "unknown sender");
  const title = `File fax in Practice Fusion: ${care.name} — ${FAX_DOC_TYPES[type]}${f.pages ? ` (${f.pages} page${f.pages === 1 ? "" : "s"})` : ""}`.slice(0, 250);
  const description = [
    `From: ${from}`,
    `Received: ${f.receivedAt.toLocaleString("en-US", { timeZone: "America/Chicago" })}`,
    f.aiSummary ? `About: ${f.aiSummary}` : null,
    `Matched to ${care.name} ${method === "ai" ? "by name and date of birth" : "by staff"}.`,
    "",
    `Open the fax in MyPCP: Fax inbox → /faxes?fax=${f.id}`,
    `Upload it to ${care.name}'s chart in Practice Fusion (Documents → Upload), then mark this task done.`,
  ].filter((x) => x !== null).join("\n");
  let taskId = f.taskId;
  if (taskId) {
    await d.update(workTasks).set({ title, description, patientId: care.patientId, clinicId: who.clinicId, assignedUserId: who.assignedUserId, assignedRole: who.assignedRole }).where(eq(workTasks.id, taskId));
    await d.insert(workTaskActivities).values({ taskId, userId: actor.id, type: "assigned", meta: { to: who.assignedUserId ? String(who.assignedUserId) : who.assignedRole } });
  } else {
    taskId = (await createTask({ ...actor, clinicIds: null }, {
      title, description, patientId: care.patientId, clinicId: who.clinicId, assignedUserId: who.assignedUserId, assignedRole: who.assignedRole,
      priority: "normal", category: "fax_filing", dueDate: localDateStr(), sourceType: "fax", sourceRef: String(f.id),
    })).id;
  }
  await d.update(faxes).set({
    status: "to_file", subjectKey, patientId: care.patientId, patientName: care.name.slice(0, 255), matchMethod: method, taskId, docType: type,
    suggestedKey: null, suggestedName: null,
  }).where(eq(faxes.id, faxId));
  return { assignedTo: who.who };
}

export async function assignFax(actor: WorkspaceActor, input: { faxId: number; subjectKey: string; docType?: FaxDocType | null }) {
  const r = await assign(actor, input.faxId, input.subjectKey, "manual", input.docType ?? undefined);
  await audit(actor, "update_task", { entityType: "fax", entityId: input.faxId, description: "Fax matched to a patient" });
  return r;
}

async function closeTask(actor: WorkspaceActor, taskId: number | null, to: "completed" | "cancelled") {
  if (!taskId) return;
  const d = await db();
  const [t] = await d.select({ status: workTasks.status }).from(workTasks).where(eq(workTasks.id, taskId)).limit(1);
  if (!t || t.status === "completed" || t.status === "cancelled") return;
  await d.update(workTasks).set({ status: to, completedAt: to === "completed" ? new Date() : null }).where(eq(workTasks.id, taskId));
  await d.insert(workTaskActivities).values({ taskId, userId: actor.id, type: "status_changed", meta: { from: t.status, to } });
}

export async function markFiled(actor: WorkspaceActor, faxId: number) {
  const d = await db();
  const [f] = await d.select().from(faxes).where(eq(faxes.id, faxId)).limit(1);
  if (!f) throw new WorkspaceError("Fax not found.", "NOT_FOUND");
  if (!f.subjectKey) throw new WorkspaceError("Pick the patient first.");
  await closeTask(actor, f.taskId, "completed");
  await d.update(faxes).set({ status: "filed", filedByUserId: actor.id, filedAt: new Date() }).where(eq(faxes.id, faxId));
  await audit(actor, "update_task", { entityType: "fax", entityId: faxId, description: "Fax filed in Practice Fusion" });
  return { ok: true };
}

export async function markNotPatient(actor: WorkspaceActor, faxId: number) {
  const d = await db();
  const [f] = await d.select().from(faxes).where(eq(faxes.id, faxId)).limit(1);
  if (!f) throw new WorkspaceError("Fax not found.", "NOT_FOUND");
  await closeTask(actor, f.taskId, "cancelled");
  await d.update(faxes).set({ status: "not_patient" }).where(eq(faxes.id, faxId));
  await audit(actor, "update_task", { entityType: "fax", entityId: faxId, description: "Fax set aside (not for a patient)" });
  return { ok: true };
}

/** Read (or re-read) one fax with the AI now. */
export async function rereadFax(actor: WorkspaceActor, faxId: number) {
  if (!aiReady()) throw new WorkspaceError("AI reading isn't set up on this server.");
  const d = await db();
  const [f] = await d.select({ status: faxes.status, mimeType: faxes.mimeType, filename: faxes.filename }).from(faxes).where(eq(faxes.id, faxId)).limit(1);
  if (!f) throw new WorkspaceError("Fax not found.", "NOT_FOUND");
  if (f.status === "to_file" || f.status === "filed") throw new WorkspaceError("This fax is already matched to a patient.");
  if (!/pdf/i.test(f.mimeType ?? "") && !/\.pdf$/i.test(f.filename ?? "")) throw new WorkspaceError("Only PDF faxes can be read automatically.");
  await d.update(faxes).set({ status: "new" }).where(eq(faxes.id, faxId));
  await readOne(faxId);
  await audit(actor, "update_task", { entityType: "fax", entityId: faxId, description: "Fax read with AI" });
  const [after] = await d.select({ status: faxes.status, aiError: faxes.aiError }).from(faxes).where(eq(faxes.id, faxId)).limit(1);
  return after;
}

// ---- The Fax inbox page ----

export type FaxFilter = "needs_patient" | "to_file" | "filed" | "not_patient" | "all";

export async function listFaxes(filter: FaxFilter) {
  const d = await db();
  const since = new Date(Date.now() - 60 * 86_400_000);
  const conds = [gte(faxes.receivedAt, since)];
  if (filter === "needs_patient") conds.push(inArray(faxes.status, ["new", "needs_patient"]));
  else if (filter === "to_file" || filter === "filed") conds.push(inArray(faxes.status, ["to_file", "filed"]));
  else if (filter === "not_patient") conds.push(eq(faxes.status, "not_patient"));
  const rows = await d.select({ f: faxes, assignee: users.name, taskStatus: workTasks.status, taskAssigned: workTasks.assignedUserId, taskRole: workTasks.assignedRole })
    .from(faxes).leftJoin(workTasks, eq(workTasks.id, faxes.taskId)).leftJoin(users, eq(users.id, workTasks.assignedUserId))
    .where(and(...conds)).orderBy(desc(faxes.receivedAt)).limit(500);
  // A filing task completed in My Work means the fax was filed.
  const doneInMyWork = rows.filter((r) => r.f.status === "to_file" && r.taskStatus === "completed").map((r) => r.f.id);
  if (doneInMyWork.length) await d.update(faxes).set({ status: "filed", filedAt: new Date() }).where(inArray(faxes.id, doneInMyWork));
  const { mailboxAddress } = await import("./gmailSync");
  const boxes: Record<string, string | null> = { practice: await mailboxAddress("practice"), fax: await mailboxAddress("fax") };
  return rows
    .map(({ f, assignee, taskRole }) => ({ ...f, status: doneInMyWork.includes(f.id) ? ("filed" as const) : f.status, assignee: assignee ?? (taskRole ? "Front desk queue" : null) }))
    .filter((f) => filter === "all" || filter === "needs_patient" || filter === "not_patient" || (filter === "to_file" ? f.status === "to_file" : f.status === "filed"))
    .map((f) => ({
      id: f.id, receivedAt: f.receivedAt, status: f.status, fromName: f.fromName, fromEmail: f.fromEmail, fromNumber: f.fromNumber, subject: f.subject,
      pages: f.pages, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.sizeBytes, docType: f.docType as FaxDocType | null, aiPatientName: f.aiPatientName, aiDob: f.aiDob,
      aiSender: f.aiSender, aiSummary: f.aiSummary, aiError: f.aiError, suggestedKey: f.suggestedKey, suggestedName: f.suggestedName,
      subjectKey: f.subjectKey, patientId: f.patientId, patientName: f.patientName, matchMethod: f.matchMethod, taskId: f.taskId, assignee: f.assignee,
      filedAt: f.filedAt, link: boxes[f.mailbox] ? gmailMessageLink(boxes[f.mailbox]!, f.messageIdHeader, f.threadId ?? "") : null,
    }));
}

/** The fax PDF for viewing, straight from the mailbox (not stored in MyPCP). */
export async function faxFile(actor: WorkspaceActor, faxId: number) {
  const d = await db();
  const [f] = await d.select().from(faxes).where(eq(faxes.id, faxId)).limit(1);
  if (!f?.attachmentId) throw new WorkspaceError("Fax not found.", "NOT_FOUND");
  if ((f.sizeBytes ?? 0) > MAX_VIEW_BYTES) throw new WorkspaceError("This fax is too large to open here. Use the Gmail link instead.");
  const { gmailAttachment } = await import("./gmailSync");
  const bytes = await gmailAttachment(f.mailbox as MailSlot, f.gmailId, f.attachmentId);
  await audit(actor, "view_patient", { entityType: "fax", entityId: faxId, description: "Viewed a fax" });
  return { base64: bytes.toString("base64"), mimeType: f.mimeType || "application/pdf", filename: f.filename || `fax-${f.id}.pdf` };
}

export async function faxCounts() {
  const d = await db();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await d.select({ status: faxes.status }).from(faxes).where(gte(faxes.receivedAt, since));
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  return { needsPatient: n("new") + n("needs_patient"), toFile: n("to_file"), filed: n("filed"), total: rows.length };
}

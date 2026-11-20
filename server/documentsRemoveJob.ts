// IAM-only job "documents-remove" (2026-11-20, Asim: "delete all aspley court pdfs from the documents").
// The app can only cancel drafts / documents out for signature; signed ones can't be removed. This job
// takes document ids and either
//   - "hide":   marks them cancelled (gone from the Documents tab, files and history kept, can be undone), or
//   - "delete": erases the document rows (boxes, signatures, history, signer tasks, their bell notices).
// The Lambda role can't delete from S3, so "delete" returns the stored file keys and the person running
// the job removes those (all versions) from the bucket. Keys another document still uses are never listed.
// Dry run unless apply. Audited under the named admin. Returns ids, counts and keys only (no titles).
import { and, eq, gte, inArray, notInArray, or } from "drizzle-orm";
import { getDb } from "./db";
import { auditLogs, documentEvents, documentSignatures, documentSigners, documents, notifications, users, workTaskActivities, workTasks } from "../drizzle/schema";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const copyKeyOf = (finalKey: string) => `${finalKey.replace(/\.pdf$/, "")}-copy.pdf`;

export async function documentsRemoveJob(input: { ids: number[]; mode: string; asUser: string; apply: boolean }) {
  const d = await db();
  const ids = Array.from(new Set(input.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)));
  if (!ids.length) return { error: "No document ids given." };
  if (input.mode !== "hide" && input.mode !== "delete") return { error: 'mode must be "hide" or "delete".' };
  const needle = input.asUser.trim().toLowerCase();
  const admins = (await d.select({ id: users.id, name: users.name }).from(users).where(eq(users.role, "admin")))
    .filter((u) => needle && (u.name ?? "").toLowerCase().includes(needle));
  if (admins.length !== 1) return { error: `asUser must match exactly one admin (matched ${admins.length}).` };
  const actor = admins[0]!;

  const docs = await d.select().from(documents).where(inArray(documents.id, ids));
  const missing = ids.filter((id) => !docs.some((x) => x.id === id));
  if (missing.length) return { error: `No document with id ${missing.join(", ")}.` };
  const linked = docs.filter((x) => x.subjectKey || x.patientId || x.patientPacketId).map((x) => x.id);
  if (linked.length) return { error: `Documents ${linked.join(", ")} belong to a patient: not handled by this job.` };
  const usedAsTemplate = (await d.select({ id: documents.id }).from(documents).where(and(inArray(documents.templateId, ids), notInArray(documents.id, ids)))).length;

  const signers = await d.select().from(documentSigners).where(inArray(documentSigners.documentId, ids));
  const sigCount = (await d.select({ id: documentSignatures.id }).from(documentSignatures).where(inArray(documentSignatures.documentId, ids))).length;
  const eventCount = (await d.select({ id: documentEvents.id }).from(documentEvents).where(inArray(documentEvents.documentId, ids))).length;
  const taskIds = Array.from(new Set([
    ...signers.map((s) => s.taskId).filter((t): t is number => !!t),
    ...(await d.select({ id: workTasks.id }).from(workTasks).where(and(eq(workTasks.sourceType, "document"), inArray(workTasks.sourceRef, ids.map(String))))).map((t) => t.id),
  ]));
  const tasks = taskIds.length ? await d.select({ id: workTasks.id, status: workTasks.status }).from(workTasks).where(inArray(workTasks.id, taskIds)) : [];

  // Stored files: the PDF, the signed copy, its no-certificate copy, and pages added later. Keep any another document shares.
  const keys = new Set<string>();
  for (const x of docs) {
    if (x.fileKey) keys.add(x.fileKey);
    if (x.finalKey) { keys.add(x.finalKey); keys.add(copyKeyOf(x.finalKey)); }
  }
  const shared = keys.size ? (await d.select({ fileKey: documents.fileKey, finalKey: documents.finalKey }).from(documents)
    .where(and(notInArray(documents.id, ids), or(inArray(documents.fileKey, Array.from(keys)), inArray(documents.finalKey, Array.from(keys)))))) : [];
  const keep = new Set(shared.flatMap((s) => [s.fileKey, s.finalKey]).filter(Boolean) as string[]);
  const fileKeys = Array.from(keys).filter((k) => !keep.has(k));
  const partPrefixes = ids.map((id) => `documents/part-${id}-`);

  const notices = await d.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.type, "task"),
    or(...docs.map((x) => and(gte(notifications.createdAt, x.createdAt), eq(notifications.content, x.title)))))).limit(500);

  const report = {
    mode: input.mode, asUser: actor.name,
    documents: docs.map((x) => ({ id: x.id, status: x.status, template: x.isTemplate, pages: Array.isArray(x.pages) ? x.pages.length : null, signed: !!x.finalKey })),
    signers: signers.length, signatures: sigCount, events: eventCount, tasks: tasks.length, openTasks: tasks.filter((t) => t.status !== "completed" && t.status !== "cancelled").length,
    notices: notices.length, usedAsTemplateBy: usedAsTemplate, sharedFilesKept: keys.size - fileKeys.length,
  };
  if (!input.apply) return { dryRun: true, ...report, ...(input.mode === "delete" ? { fileKeys, partPrefixes } : {}) };
  if (input.mode === "delete" && usedAsTemplate) return { error: `${usedAsTemplate} other document(s) were made from these; not deleting.`, ...report };

  const audit = (id: number, description: string) => d.insert(auditLogs).values({
    userId: actor.id, userName: actor.name, userRole: "admin", action: "manage_document", entityType: "document", entityId: id, description,
  });
  const openTaskIds = tasks.filter((t) => t.status !== "completed" && t.status !== "cancelled").map((t) => t.id);

  if (input.mode === "hide") {
    for (const tid of openTaskIds) {
      await d.update(workTasks).set({ status: "cancelled", completedAt: null }).where(eq(workTasks.id, tid));
      await d.insert(workTaskActivities).values({ taskId: tid, userId: actor.id, type: "status_changed", meta: { to: "cancelled", reason: "Document removed" } });
    }
    for (const x of docs) {
      if (x.status !== "cancelled") await d.update(documents).set({ status: "cancelled", updatedByUserId: actor.id }).where(eq(documents.id, x.id));
      await d.insert(documentEvents).values({ documentId: x.id, at: new Date(), type: "cancelled", userId: actor.id, detail: "Removed from Documents (owner's request)" });
      await audit(x.id, `Removed document #${x.id} from Documents (was ${x.status}; IAM job)`);
    }
    return { hidden: docs.map((x) => x.id), tasksCancelled: openTaskIds.length };
  }

  if (taskIds.length) {
    await d.delete(workTaskActivities).where(inArray(workTaskActivities.taskId, taskIds));
    await d.delete(workTasks).where(inArray(workTasks.id, taskIds));
  }
  if (notices.length) await d.delete(notifications).where(inArray(notifications.id, notices.map((n) => n.id)));
  await d.delete(documentSignatures).where(inArray(documentSignatures.documentId, ids));
  await d.delete(documentEvents).where(inArray(documentEvents.documentId, ids));
  await d.delete(documentSigners).where(inArray(documentSigners.documentId, ids));
  await d.delete(documents).where(inArray(documents.id, ids));
  for (const x of docs) await audit(x.id, `Deleted document #${x.id} for good (was ${x.status}; IAM job)`);
  return { deleted: ids, tasksDeleted: taskIds.length, noticesDeleted: notices.length, fileKeys, partPrefixes };
}

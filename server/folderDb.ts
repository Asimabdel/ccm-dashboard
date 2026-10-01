// Patient folders: everything MyPCP has about one patient, in one place, for every patient
// (CCM roster "p:", schedule-only "s:", Practice Fusion-only "f:").
//
// Each sub-folder follows the access rules already in place for that kind of record (the chart
// for clinical roles / limited for the front desk, payments for the payment roles, and so on);
// office managers and MAs only reach patients at their clinic. Opening anything is audited.
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { getDb } from "./db";
import {
  clinics, documents, eligibilityChecks, emailMessages, faxes, fhirPatients, fhirResources, intakePackets, patientFiles, patients, phoneCalls, squarePayments, users, workTasks,
} from "../drizzle/schema";
import { can, FLOW_LABELS, TASK_CATEGORY_LABELS, TASK_STATUS_LABELS, type FlowStatus, type TaskCategory, type TaskStatus, type WorkspaceCap } from "../shared/workspace";
import {
  FOLDER_SECTIONS, FOLDER_SECTION_LIST, MAX_PATIENT_FILE_BYTES, PATIENT_FILE_MIME, PATIENT_FILE_TYPES, snippetAround, sortItems,
  type FolderItem, type FolderSection, type PatientFileType,
} from "../shared/folder";
import { CHART_SECTIONS, type FhirResource } from "../shared/fhir";
import { FAX_DOC_TYPES } from "../shared/fax";
import { CALL_OUTCOMES, type CallOutcome } from "../shared/phone";
import { PAYMENT_CATEGORIES, methodText, money, type PaymentCategory } from "../shared/payments";
import { gmailMessageLink } from "../shared/email";
import { exists, getBytes, onS3, putBytes, readTarget, uploadTarget } from "./docStore";
import { WorkspaceError, audit, loadScheduleSubjects, subjectCare, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const pidOf = (key: string) => { const m = /^p:(\d+)$/.exec(key); return m ? Number(m[1]) : null; };
const iso = (d: Date | string | null | undefined) => (d ? (d instanceof Date ? d.toISOString() : d) : null);
const unpack = (raw: string | null): FhirResource | null => {
  if (!raw) return null;
  try { return JSON.parse(gunzipSync(Buffer.from(raw, "base64")).toString("utf8")) as FhirResource; } catch { return null; }
};

// ---------------------------------------------------------------------------
// Who sees which sub-folders (the rules each kind of record already has)
// ---------------------------------------------------------------------------

const SECTION_CAPS: Record<FolderSection, WorkspaceCap[]> = {
  chart: ["chartBasic"],
  visits: ["flowView"],
  tasks: ["tasks"],
  comms: ["patientFull"],
  forms: ["intakeForms"],
  files: ["documents"],
  faxes: ["emailTriage", "chartFull"],
  payments: ["payments"],
  care: ["patientFull"],
  insurance: ["eligibility"],
};

export function folderSectionsFor(role: string): FolderSection[] {
  if (!can(role, "chartBasic") && !can(role, "flowView")) return [];
  return FOLDER_SECTION_LIST.filter((s) => SECTION_CAPS[s].some((c) => can(role, c)));
}

async function assertFolder(actor: WorkspaceActor, key: string, section?: FolderSection) {
  const sections = folderSectionsFor(actor.role);
  if (!sections.length) throw new WorkspaceError("You don't have access to patient folders.", "FORBIDDEN");
  if (section && !sections.includes(section)) throw new WorkspaceError(`You don't have access to ${FOLDER_SECTIONS[section].toLowerCase()}.`, "FORBIDDEN");
  const care = await subjectCare(key);
  // Any staff member can open any patient's folder (2026-10-01); payments inside stay limited to their clinic.
  return { sections, care };
}

/** Rows that belong to this patient: by patient key, or (roster patients) by patient id too. */
function whose(subjectCol: Parameters<typeof eq>[0], patientCol: Parameters<typeof eq>[0] | null, key: string): SQL {
  const pid = pidOf(key);
  return pid && patientCol ? or(eq(subjectCol, key), eq(patientCol, pid))! : eq(subjectCol, key);
}

// ---------------------------------------------------------------------------
// The folder's front page: who it is, and how much is in each sub-folder
// ---------------------------------------------------------------------------

export async function folderSummary(actor: WorkspaceActor, key: string) {
  const { sections, care } = await assertFolder(actor, key);
  const d = await db();
  const pid = pidOf(key);
  const [roster] = pid ? await d.select().from(patients).where(eq(patients.id, pid)).limit(1) : [];
  const sched = (await loadScheduleSubjects()).get(key);
  const [pf] = await d.select().from(fhirPatients).where(pid ? or(eq(fhirPatients.subjectKey, key), eq(fhirPatients.patientId, pid))! : eq(fhirPatients.subjectKey, key)).limit(1);
  if (!roster && !sched && !pf && !care) throw new WorkspaceError("That patient wasn't found.", "NOT_FOUND");
  const clinicId = roster?.clinicId ?? care?.clinicId ?? sched?.clinicId ?? null;
  const clinicName = clinicId ? (await d.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, clinicId)).limit(1))[0]?.name ?? null : null;
  const items = await collect(actor, key, sections.filter((s) => s !== "chart" && s !== "care"));
  const counts: Partial<Record<FolderSection, number>> = {};
  for (const s of sections) counts[s] = items.filter((i) => i.section === s).length;
  if (sections.includes("chart")) {
    const [c] = await d.select({ n: sql<number>`count(*)` }).from(fhirResources).where(and(eq(fhirResources.subjectKey, key), ne(fhirResources.resourceType, "Patient")));
    counts.chart = Number(c?.n ?? 0);
  }
  const programs = roster ? {
    ccm: roster.ccmEnrollmentStatus, ccmConsent: roster.consentStatus,
    bhi: roster.bhiEnrollmentStatus, bhiConsent: roster.bhiConsentStatus,
    apcm: roster.apcmEnrollmentStatus, apcmLevel: roster.apcmLevel, apcmConsent: roster.apcmConsentStatus,
    rpm: roster.rpmStatus ?? (roster.rpmEnrolled ? "enrolled" : null), rpmConsent: roster.rpmConsentStatus,
  } : null;
  if (sections.includes("care")) counts.care = programs ? Object.entries(programs).filter(([k, v]) => !/Consent|Level/.test(k) && v && !/^(not_enrolled|none|inactive|declined)$/i.test(String(v))).length : 0;
  await audit(actor, "view_patient", { entityType: "folder", entityId: pid ?? undefined, description: `Opened patient folder (${key.slice(0, 2)})` });
  return {
    key,
    patientId: pid,
    name: roster?.name ?? care?.name ?? sched?.name ?? pf?.name ?? "Patient",
    dob: (roster?.dateOfBirth ? new Date(roster.dateOfBirth).toISOString().slice(0, 10) : null) ?? (sched?.dob ? sched.dob.toISOString().slice(0, 10) : null) ?? pf?.dob ?? null,
    phone: roster?.phoneNumber || sched?.phone || pf?.phone || null,
    email: can(actor.role, "patientFull") ? pf?.email ?? null : null,
    address: can(actor.role, "chartBasic") ? pf?.address ?? null : null,
    mrn: pf?.mrn ?? null,
    clinicId,
    clinicName,
    providerName: sched?.providerName ?? null,
    language: roster?.preferredLanguage ?? null,
    sources: { roster: !!roster, schedule: !!sched, practiceFusion: !!pf },
    programs: sections.includes("care") ? programs : null,
    sections,
    counts,
    canUpload: sections.includes("files"),
    canRemoveFiles: actor.role === "admin",
    canExport: actor.role === "admin",
  };
}

// ---------------------------------------------------------------------------
// What's in each sub-folder, as one kind of row
// ---------------------------------------------------------------------------

async function collect(actor: WorkspaceActor, key: string, sections: FolderSection[], opts: { deep?: boolean } = {}): Promise<FolderItem[]> {
  const d = await db();
  const pid = pidOf(key);
  const want = (s: FolderSection) => sections.includes(s);
  const out: FolderItem[] = [];
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));

  if (want("visits")) {
    const sched = (await loadScheduleSubjects()).get(key);
    for (const v of sched?.visits ?? []) {
      out.push({
        key: `visit:${v.startsAt.toISOString()}`, section: "visits", kind: "visit",
        title: v.visitType || "Visit", detail: [v.providerName, v.clinicId ? clinicName.get(v.clinicId) : null].filter(Boolean).join(" · ") || null,
        date: v.startsAt.toISOString(), status: FLOW_LABELS[v.status as FlowStatus] ?? v.status, open: { type: "none" },
      });
    }
  }

  // Emails and faxes first: their tasks belong in the folder even when the task has no roster patient.
  const emails = want("comms") || want("tasks")
    ? await d.select().from(emailMessages).where(whose(emailMessages.subjectKey, emailMessages.patientId, key)).orderBy(desc(emailMessages.receivedAt)).limit(300)
    : [];
  const faxRows = want("faxes") || want("tasks")
    ? await d.select().from(faxes).where(whose(faxes.subjectKey, faxes.patientId, key)).orderBy(desc(faxes.receivedAt)).limit(300)
    : [];

  if (want("comms")) {
    const calls = await d.select({ c: phoneCalls, by: users.name }).from(phoneCalls).leftJoin(users, eq(users.id, phoneCalls.userId))
      .where(whose(phoneCalls.subjectKey, phoneCalls.patientId, key)).orderBy(desc(phoneCalls.startedAt)).limit(300);
    for (const { c, by } of calls) {
      const mins = c.durationSec ? `${Math.max(1, Math.round(c.durationSec / 60))} min` : null;
      out.push({
        key: `call:${c.id}`, section: "comms", kind: "call",
        title: c.direction === "inbound" ? "Call from the patient" : "Call to the patient",
        detail: [c.outcome ? CALL_OUTCOMES[c.outcome as CallOutcome] ?? c.outcome : c.result, mins, by ? `by ${by}` : null, c.note].filter(Boolean).join(" · ") || null,
        date: iso(c.startedAt), status: null, open: { type: "none" }, ...(opts.deep ? { snippet: c.note ?? null } : {}),
      });
    }
    const { practiceMailSender } = await import("./gmailSync");
    const mailbox = emails.length ? (await practiceMailSender()).mailbox : null;
    for (const e of emails) {
      out.push({
        key: `email:${e.id}`, section: "comms", kind: "email",
        title: `Email: ${e.subject || "(no subject)"}`, detail: e.preview ? e.preview.slice(0, 220) : null,
        date: iso(e.receivedAt), status: e.historical ? "Earlier email" : null,
        open: mailbox ? { type: "link", url: gmailMessageLink(mailbox, e.messageIdHeader, e.threadId ?? "") } : { type: "none" },
      });
    }
  }

  if (want("faxes")) {
    for (const f of faxRows) {
      out.push({
        key: `fax:${f.id}`, section: "faxes", kind: "fax",
        title: f.aiSummary || (f.docType ? FAX_DOC_TYPES[f.docType as keyof typeof FAX_DOC_TYPES] ?? "Fax" : "Fax"),
        detail: [f.aiSender || f.fromName || f.fromNumber, f.pages ? `${f.pages} page${f.pages === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ") || null,
        date: iso(f.receivedAt), status: f.status === "filed" ? "Filed in Practice Fusion" : f.status === "to_file" ? "To file" : f.status,
        open: f.attachmentId ? { type: "fax", id: f.id } : { type: "none" },
      });
    }
  }

  let packets: Awaited<ReturnType<typeof import("./intakeDb")["subjectForms"]>>["packets"] = [];
  if (want("forms") || want("tasks")) {
    const { subjectForms } = await import("./intakeDb");
    packets = (await subjectForms(actor, key).catch(() => ({ packets: [] }))).packets ?? [];
  }
  if (want("forms")) {
    for (const p of packets) {
      const signed = p.forms.filter((f) => f.signed).length;
      out.push({
        key: `form:${p.id}`, section: "forms", kind: "form",
        title: p.forms.map((f) => f.title).join(", ") || "Forms",
        detail: `${signed} of ${p.forms.length} signed${p.source === "website" ? " · from the website" : ""}${p.createdBy ? ` · sent by ${p.createdBy}` : ""}`,
        date: iso(p.completedAt ?? p.sentAt ?? p.createdAt), status: p.status, open: { type: "form", id: p.id },
      });
    }
  }

  if (want("tasks")) {
    const linked = [...emails.map((e) => e.taskId), ...faxRows.map((f) => f.taskId)].filter((x): x is number => !!x);
    const conds: SQL[] = [];
    if (pid) conds.push(eq(workTasks.patientId, pid));
    if (linked.length) conds.push(inArray(workTasks.id, linked));
    if (conds.length) {
      const tasks = await d.select({ t: workTasks, assignee: users.name }).from(workTasks).leftJoin(users, eq(users.id, workTasks.assignedUserId))
        .where(or(...conds)).orderBy(desc(workTasks.createdAt)).limit(300);
      for (const { t, assignee } of tasks) {
        out.push({
          key: `task:${t.id}`, section: "tasks", kind: "task", title: t.title,
          detail: [TASK_CATEGORY_LABELS[t.category as TaskCategory] ?? t.category, assignee ? `for ${assignee}` : null].filter(Boolean).join(" · "),
          date: iso(t.createdAt), status: TASK_STATUS_LABELS[t.status as TaskStatus] ?? t.status, open: { type: "task", id: t.id },
          ...(opts.deep ? { snippet: t.description ?? null } : {}),
        });
      }
    }
  }

  if (want("files")) {
    const docs = await d.select().from(documents).where(and(whose(documents.subjectKey, documents.patientId, key), eq(documents.isTemplate, false))).orderBy(desc(documents.createdAt)).limit(200);
    for (const doc of docs) {
      const ready = doc.status === "completed" && !!doc.finalKey;
      out.push({
        key: `document:${doc.id}`, section: "files", kind: "document", title: doc.title,
        detail: ready ? "Signed document" : "Document being signed", date: iso(doc.completedAt ?? doc.createdAt), status: doc.status,
        open: { type: "document", id: doc.id, ready },
      });
    }
    const files = await d.select({ f: patientFiles, by: users.name }).from(patientFiles).leftJoin(users, eq(users.id, patientFiles.uploadedByUserId))
      .where(and(whose(patientFiles.subjectKey, patientFiles.patientId, key), eq(patientFiles.status, "ready"), isNull(patientFiles.removedAt)))
      .orderBy(desc(patientFiles.createdAt)).limit(300);
    for (const { f, by } of files) {
      out.push({
        key: `file:${f.id}`, section: "files", kind: "file", title: f.title,
        detail: [PATIENT_FILE_TYPES[f.fileType as PatientFileType] ?? f.fileType, by ? `added by ${by}` : null, f.note].filter(Boolean).join(" · "),
        date: iso(f.createdAt), status: null, open: { type: "file", id: f.id },
      });
    }
  }

  if (want("payments")) {
    const pays = await d.select().from(squarePayments)
      .where(and(eq(squarePayments.subjectKey, key), or(isNull(squarePayments.category), ne(squarePayments.category, "dexafit"))!, ...(actor.clinicIds ? [inArray(squarePayments.clinicId, actor.clinicIds.length ? actor.clinicIds : [-1])] : [])))
      .orderBy(desc(squarePayments.createdAt)).limit(300);
    for (const p of pays) {
      out.push({
        key: `payment:${p.id}`, section: "payments", kind: "payment",
        title: `${money(p.totalCents)} · ${p.category ? PAYMENT_CATEGORIES[p.category as PaymentCategory] : "Payment"}`,
        detail: [methodText(p), p.refundedCents ? `${money(p.refundedCents)} refunded` : null].filter(Boolean).join(" · "),
        date: iso(p.createdAt), status: p.status === "COMPLETED" ? "Paid" : p.status, open: { type: "payment", id: p.id },
      });
    }
  }

  if (want("insurance")) {
    const checks = await d.select().from(eligibilityChecks).where(whose(eligibilityChecks.subjectKey, eligibilityChecks.patientId, key)).orderBy(desc(eligibilityChecks.createdAt)).limit(100);
    for (const c of checks) {
      const s = (c.summary ?? null) as { active?: boolean | null; planName?: string | null } | null;
      out.push({
        key: `insurance:${c.id}`, section: "insurance", kind: "eligibility",
        title: `Insurance check: ${c.payerName ?? c.payerId}`,
        detail: [s?.planName, s?.active === true ? "Active" : s?.active === false ? "Not active" : null, c.trigger === "nightly" ? "nightly check" : null].filter(Boolean).join(" · ") || null,
        date: iso(c.createdAt), status: c.status === "error" ? "Couldn't check" : null, open: { type: "none" },
      });
    }
  }

  // Chart notes and reports also show in "Everything" (clinical roles); the Chart sub-folder has the whole chart.
  if (want("chart") && can(actor.role, "chartFull")) {
    const rows = await d.select({ id: fhirResources.id, resourceType: fhirResources.resourceType, title: fhirResources.title, value: fhirResources.value, date: fhirResources.date, status: fhirResources.status })
      .from(fhirResources).where(and(eq(fhirResources.subjectKey, key), inArray(fhirResources.resourceType, ["DocumentReference", "DiagnosticReport"])))
      .orderBy(desc(fhirResources.date)).limit(200);
    for (const r of rows) {
      out.push({
        key: `chart:${r.id}`, section: "chart", kind: r.resourceType === "DocumentReference" ? "note" : "report",
        title: r.title || (r.resourceType === "DocumentReference" ? "Note" : "Report"), detail: r.value, date: r.date, status: r.status,
        open: r.resourceType === "DocumentReference" ? { type: "note", id: r.id } : { type: "none" },
      });
    }
  }
  return out;
}

export async function folderItems(actor: WorkspaceActor, key: string, section: FolderSection | "everything") {
  const { sections } = await assertFolder(actor, key, section === "everything" ? undefined : section);
  const wanted = section === "everything" ? sections : [section];
  return sortItems(await collect(actor, key, wanted)).slice(0, 1000);
}

/** Search inside one folder: titles, notes, form answers, fax summaries, file notes and the chart. */
export async function folderSearch(actor: WorkspaceActor, key: string, q: string) {
  const { sections } = await assertFolder(actor, key);
  const needle = q.trim();
  if (needle.length < 2) return [];
  const lower = needle.toLowerCase();
  const d = await db();
  const items = await collect(actor, key, sections, { deep: true });
  const hits: FolderItem[] = [];
  for (const it of items) {
    const snippet = snippetAround(it.title, needle) ?? snippetAround(it.detail, needle) ?? snippetAround(it.snippet ?? null, needle);
    if (snippet) hits.push({ ...it, snippet });
  }
  // Deeper text that isn't on the rows themselves.
  if (sections.includes("faxes")) {
    const rows = await d.select({ id: faxes.id, s: faxes.aiSummary, sender: faxes.aiSender, subject: faxes.subject, file: faxes.filename }).from(faxes).where(whose(faxes.subjectKey, faxes.patientId, key)).limit(300);
    for (const r of rows) {
      const sn = snippetAround([r.s, r.sender, r.subject, r.file].filter(Boolean).join(" · "), needle);
      const it = items.find((i) => i.key === `fax:${r.id}`);
      if (sn && it && !hits.some((h) => h.key === it.key)) hits.push({ ...it, snippet: sn });
    }
  }
  if (sections.includes("forms")) {
    const rows = await d.select({ id: intakePackets.id, answers: intakePackets.answers }).from(intakePackets).where(whose(intakePackets.subjectKey, intakePackets.patientId, key)).limit(100);
    for (const r of rows) {
      const text = r.answers ? Object.values(r.answers as Record<string, unknown>).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" · ") : "";
      const sn = snippetAround(text, needle);
      const it = items.find((i) => i.key === `form:${r.id}`);
      if (sn && it && !hits.some((h) => h.key === it.key)) hits.push({ ...it, snippet: sn });
    }
  }
  if (sections.includes("chart")) {
    const full = can(actor.role, "chartFull");
    const allowed = Object.values(CHART_SECTIONS).filter((v) => full || !v.full).flatMap((v) => v.types as readonly string[]);
    const like = `%${needle.replace(/[%_]/g, "")}%`;
    const rows = await d.select({ id: fhirResources.id, section: fhirResources.section, resourceType: fhirResources.resourceType, title: fhirResources.title, value: fhirResources.value, date: fhirResources.date, status: fhirResources.status })
      .from(fhirResources).where(and(eq(fhirResources.subjectKey, key), inArray(fhirResources.section, allowed), or(sql`${fhirResources.title} LIKE ${like}`, sql`${fhirResources.value} LIKE ${like}`)))
      .orderBy(desc(fhirResources.date)).limit(100);
    for (const r of rows) {
      if (hits.some((h) => h.key === `chart:${r.id}`)) continue;
      hits.push({
        key: `chart:${r.id}`, section: "chart", kind: r.resourceType === "DocumentReference" ? "note" : "chart",
        title: r.title || r.resourceType, detail: r.value, date: r.date, status: r.status,
        open: r.resourceType === "DocumentReference" && full ? { type: "note", id: r.id } : { type: "none" },
        snippet: snippetAround(`${r.title ?? ""} ${r.value ?? ""}`, needle),
      });
    }
    // The text of notes kept inside the chart copy (clinical roles only).
    if (full) {
      const notes = await d.select({ id: fhirResources.id, title: fhirResources.title, date: fhirResources.date, raw: fhirResources.raw })
        .from(fhirResources).where(and(eq(fhirResources.subjectKey, key), eq(fhirResources.resourceType, "DocumentReference"))).orderBy(desc(fhirResources.date)).limit(300);
      for (const n of notes) {
        if (hits.some((h) => h.key === `chart:${n.id}`)) continue;
        const doc = unpack(n.raw);
        const atts = ((doc?.content as { attachment?: { contentType?: string; data?: string } }[] | undefined) ?? []).map((c) => c.attachment).filter((a) => a?.data && /text|html|xml/i.test(a.contentType ?? ""));
        const text = atts.map((a) => Buffer.from(a!.data!, "base64").toString("utf8").replace(/<[^>]+>/g, " ")).join(" ");
        if (!text.toLowerCase().includes(lower)) continue;
        hits.push({ key: `chart:${n.id}`, section: "chart", kind: "note", title: n.title || "Note", detail: null, date: n.date, status: null, open: { type: "note", id: n.id }, snippet: snippetAround(text, needle) });
      }
    }
  }
  await audit(actor, "view_patient", { entityType: "folder", entityId: pidOf(key) ?? undefined, description: "Searched a patient folder" });
  return sortItems(hits).slice(0, 200);
}

// ---------------------------------------------------------------------------
// Files staff put in the folder
// ---------------------------------------------------------------------------

export async function startFileUpload(actor: WorkspaceActor, input: { subjectKey: string; fileName: string; mimeType: string; size: number; fileType: PatientFileType; title: string; note?: string | null }) {
  const { care } = await assertFolder(actor, input.subjectKey, "files");
  if (!(PATIENT_FILE_MIME as readonly string[]).includes(input.mimeType)) throw new WorkspaceError("Add a PDF, JPG or PNG.");
  if (input.size <= 0 || input.size > MAX_PATIENT_FILE_BYTES) throw new WorkspaceError("Files can be up to 25 MB.");
  const storageKey = `documents/patient-files/${randomUUID()}`;
  const res = await (await db()).insert(patientFiles).values({
    subjectKey: input.subjectKey, patientId: pidOf(input.subjectKey), clinicId: care?.clinicId ?? null, fileType: input.fileType,
    title: input.title.replace(/[\r\n<>]/g, " ").trim().slice(0, 255) || PATIENT_FILE_TYPES[input.fileType],
    note: input.note?.trim().slice(0, 500) || null, storageKey, fileName: input.fileName.slice(0, 255), mimeType: input.mimeType, sizeBytes: input.size,
    status: "uploading", uploadedByUserId: actor.id,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  return { id, upload: await uploadTarget(storageKey, input.mimeType) };
}

async function uploadingFile(actor: WorkspaceActor, id: number) {
  const [f] = await (await db()).select().from(patientFiles).where(eq(patientFiles.id, id)).limit(1);
  if (!f || f.uploadedByUserId !== actor.id || f.status !== "uploading") throw new WorkspaceError("That upload wasn't found.", "NOT_FOUND");
  return f;
}

/** Local development only: the bytes come through the API. */
export async function uploadFileLocal(actor: WorkspaceActor, id: number, base64: string) {
  if (onS3()) throw new WorkspaceError("Upload straight to storage.");
  const f = await uploadingFile(actor, id);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_PATIENT_FILE_BYTES) throw new WorkspaceError("Files can be up to 25 MB.");
  await putBytes(f.storageKey, bytes, f.mimeType);
  return { ok: true };
}

export async function finishFileUpload(actor: WorkspaceActor, id: number) {
  const f = await uploadingFile(actor, id);
  if (!(await exists(f.storageKey))) throw new WorkspaceError("The file didn't arrive. Try again.");
  await (await db()).update(patientFiles).set({ status: "ready" }).where(eq(patientFiles.id, id));
  await audit(actor, "update_patient", { entityType: "patientFile", entityId: id, description: `Added to the patient's folder: ${PATIENT_FILE_TYPES[f.fileType as PatientFileType] ?? f.fileType}` });
  return { ok: true };
}

async function readyFile(actor: WorkspaceActor, id: number) {
  const [f] = await (await db()).select().from(patientFiles).where(and(eq(patientFiles.id, id), eq(patientFiles.status, "ready"), isNull(patientFiles.removedAt))).limit(1);
  if (!f) throw new WorkspaceError("That file wasn't found.", "NOT_FOUND");
  await assertFolder(actor, f.subjectKey, "files");
  return f;
}

export async function openFile(actor: WorkspaceActor, id: number) {
  const f = await readyFile(actor, id);
  await audit(actor, "view_document", { entityType: "patientFile", entityId: id, description: "Opened a file in a patient's folder" });
  return { ...(await readTarget(f.storageKey, null, f.mimeType)), mimeType: f.mimeType, title: f.title };
}

export async function removeFile(actor: WorkspaceActor, id: number) {
  if (actor.role !== "admin") throw new WorkspaceError("Only an admin can remove a file from a folder.", "FORBIDDEN");
  const f = await readyFile(actor, id);
  // Hidden from the folder, kept for the record.
  await (await db()).update(patientFiles).set({ removedAt: new Date(), removedByUserId: actor.id }).where(eq(patientFiles.id, id));
  await audit(actor, "update_patient", { entityType: "patientFile", entityId: id, description: `Removed from the patient's folder: ${f.title}` });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Opening faxes and signed documents from the folder
// ---------------------------------------------------------------------------

export async function openFolderFax(actor: WorkspaceActor, key: string, faxId: number) {
  await assertFolder(actor, key, "faxes");
  const pid = pidOf(key);
  const [f] = await (await db()).select({ subjectKey: faxes.subjectKey, patientId: faxes.patientId }).from(faxes).where(eq(faxes.id, faxId)).limit(1);
  if (!f || (f.subjectKey !== key && !(pid && f.patientId === pid))) throw new WorkspaceError("That fax isn't in this folder.", "NOT_FOUND");
  const { faxFile } = await import("./faxInbox");
  return faxFile(actor, faxId);
}

export async function openFolderDocument(actor: WorkspaceActor, key: string, docId: number) {
  await assertFolder(actor, key, "files");
  const pid = pidOf(key);
  const [doc] = await (await db()).select().from(documents).where(eq(documents.id, docId)).limit(1);
  if (!doc || (doc.subjectKey !== key && !(pid && doc.patientId === pid))) throw new WorkspaceError("That document isn't in this folder.", "NOT_FOUND");
  if (doc.status !== "completed" || !doc.finalKey) throw new WorkspaceError("This document isn't signed yet. Open it in Documents.");
  await audit(actor, "view_document", { entityType: "document", entityId: docId, description: `Opened signed "${doc.title}" from a patient's folder` });
  return { ...(await readTarget(doc.finalKey, null)), mimeType: "application/pdf", title: doc.title };
}

// ---------------------------------------------------------------------------
// Download the whole folder as one PDF (admins only; e.g. a records request)
// ---------------------------------------------------------------------------

const PAGE = { w: 612, h: 792, margin: 50 };
const INK = rgb(0.08, 0.09, 0.12);
const MUTED = rgb(0.4, 0.43, 0.48);

/** The standard PDF font only covers Western characters: anything else becomes "?" rather than failing. */
function safe(font: PDFFont, s: string) {
  const clean = s.replace(/[\r\t]/g, " ");
  try { font.encodeText(clean); return clean; } catch { return clean.replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?"); }
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont, private footer: string) { this.newPage(); }
  newPage() {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    this.y = PAGE.h - PAGE.margin;
    this.page.drawText(safe(this.font, this.footer), { x: PAGE.margin, y: 24, size: 8, font: this.font, color: MUTED });
  }
  private ensure(h: number) { if (this.y - h < PAGE.margin) this.newPage(); }
  private wrap(text: string, size: number, font: PDFFont, width: number) {
    const out: string[] = [];
    for (const para of safe(font, text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
        if (line) out.push(line);
        // A single word wider than the line: cut it.
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
          let cut = w.length;
          while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        line = w;
      }
      out.push(line);
    }
    return out;
  }
  text(text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    const x = PAGE.margin + (opts.indent ?? 0);
    for (const line of this.wrap(text, size, font, PAGE.w - PAGE.margin - x)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: opts.color ?? INK });
      this.y -= size + 4;
    }
    this.y -= opts.gap ?? 0;
  }
  heading(text: string) {
    this.ensure(60);
    this.y -= 8;
    this.text(text, { size: 14, bold: true, gap: 4 });
  }
}

export async function exportFolder(actor: WorkspaceActor, key: string) {
  if (actor.role !== "admin") throw new WorkspaceError("Only an admin can download a whole folder.", "FORBIDDEN");
  const started = Date.now();
  const budget = started + 20_000; // the request has ~29 seconds; leave room to save and answer
  const summary = await folderSummary(actor, key);
  const items = sortItems(await collect(actor, key, summary.sections));
  const d = await db();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const when = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });
  const w = new Writer(pdf, font, bold, `${summary.name} · patient folder · generated ${when} CT by ${actor.name ?? "admin"} · contains protected health information`);
  const fmt = (x: string | null) => (x ? new Date(x.length === 10 ? `${x}T12:00:00Z` : x).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" }) : "");

  // Cover
  w.text("Patient folder", { size: 22, bold: true, gap: 6 });
  w.text(summary.name, { size: 16, bold: true });
  w.text([summary.dob ? `DOB ${fmt(summary.dob)}` : null, summary.phone, summary.clinicName, summary.mrn ? `PF MRN ${summary.mrn}` : null].filter(Boolean).join("  ·  "), { color: MUTED, gap: 10 });
  w.text(`Generated ${when} (Central) by ${actor.name ?? "an admin"} from MyPCP. This packet contains protected health information: handle and send it according to practice policy.`, { size: 9, color: MUTED, gap: 10 });
  w.text("Contents", { bold: true });
  for (const s of summary.sections) w.text(`${FOLDER_SECTIONS[s]}${s !== "care" && summary.counts[s] != null ? ` (${summary.counts[s]})` : ""}`, { indent: 12 });

  // Care programs
  if (summary.programs) {
    w.heading("Care programs");
    const p = summary.programs;
    const say = (v: unknown, none: string) => (v ? String(v).replace(/^level_/, "").replace(/_/g, " ") : none);
    w.text(`CCM: ${say(p.ccm, "not enrolled")} (consent: ${say(p.ccmConsent, "none")})`);
    w.text(`BHI: ${say(p.bhi, "not enrolled")} (consent: ${say(p.bhiConsent, "none")})`);
    w.text(`APCM: ${say(p.apcm, "not enrolled")}${p.apcmLevel ? `, level ${say(p.apcmLevel, "")}` : ""} (consent: ${say(p.apcmConsent, "none")})`);
    w.text(`RPM: ${say(p.rpm, "not enrolled")} (consent: ${say(p.rpmConsent, "none")})`);
  }

  // The chart copy (clinical roles' full chart)
  if (summary.sections.includes("chart")) {
    const rows = await d.select({ section: fhirResources.section, title: fhirResources.title, value: fhirResources.value, status: fhirResources.status, date: fhirResources.date })
      .from(fhirResources).where(eq(fhirResources.subjectKey, key)).orderBy(desc(fhirResources.date)).limit(5000);
    if (rows.length) {
      w.heading("Chart (copy from Practice Fusion)");
      for (const [, v] of Object.entries(CHART_SECTIONS)) {
        const mine = rows.filter((r) => (v.types as readonly string[]).includes(r.section)).slice(0, 300);
        if (!mine.length) continue;
        w.text(v.label, { bold: true, size: 11, gap: 2 });
        for (const r of mine) w.text([fmt(r.date), r.title, r.value, r.status].filter(Boolean).join(" — "), { indent: 12, size: 9 });
        w.y -= 6;
      }
    }
  }

  // Everything else, sub-folder by sub-folder
  for (const s of summary.sections.filter((x) => x !== "chart" && x !== "care")) {
    const mine = items.filter((i) => i.section === s);
    if (!mine.length) continue;
    w.heading(FOLDER_SECTIONS[s]);
    for (const it of mine) {
      w.text([fmt(it.date), it.title, it.status].filter(Boolean).join(" — "), { size: 9, bold: true });
      if (it.detail) w.text(it.detail, { size: 9, indent: 12, color: MUTED });
    }
  }

  // Attachments: signed documents, uploaded files, faxes and chart notes, while time allows.
  const included: string[] = [];
  const skipped: string[] = [];
  const appendPdf = async (bytes: Uint8Array) => {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await pdf.copyPages(src, src.getPageIndices());
    pages.forEach((p) => pdf.addPage(p));
  };
  const appendImage = async (bytes: Uint8Array, mime: string) => {
    const img = mime === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const page = pdf.addPage([PAGE.w, PAGE.h]);
    const scale = Math.min((PAGE.w - 2 * PAGE.margin) / img.width, (PAGE.h - 2 * PAGE.margin) / img.height, 1);
    page.drawImage(img, { x: (PAGE.w - img.width * scale) / 2, y: (PAGE.h - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
  };
  const attach = async (label: string, fn: () => Promise<void>) => {
    if (Date.now() > budget) { skipped.push(`${label} (out of time: open it in MyPCP)`); return; }
    try { await fn(); included.push(label); } catch { skipped.push(`${label} (couldn't be added)`); }
  };
  for (const it of items) {
    if (it.open.type === "document" && it.open.ready) {
      const [doc] = await d.select({ finalKey: documents.finalKey }).from(documents).where(eq(documents.id, it.open.id)).limit(1);
      if (doc?.finalKey) await attach(`Signed document: ${it.title}`, async () => appendPdf(await getBytes(doc.finalKey!)));
    } else if (it.open.type === "file") {
      const [f] = await d.select().from(patientFiles).where(eq(patientFiles.id, it.open.id)).limit(1);
      if (f) await attach(`File: ${it.title}`, async () => { const b = await getBytes(f.storageKey); return f.mimeType === "application/pdf" ? appendPdf(b) : appendImage(b, f.mimeType); });
    } else if (it.open.type === "fax") {
      const faxId = it.open.id;
      await attach(`Fax: ${it.title}`, async () => {
        const { faxFile } = await import("./faxInbox");
        const r = await faxFile(actor, faxId);
        if (!/pdf/i.test(r.mimeType)) throw new Error("not a PDF");
        await appendPdf(Buffer.from(r.base64, "base64"));
      });
    } else if (it.open.type === "note") {
      const [n] = await d.select({ raw: fhirResources.raw }).from(fhirResources).where(eq(fhirResources.id, it.open.id)).limit(1);
      const doc = unpack(n?.raw ?? null);
      const att = ((doc?.content as { attachment?: { contentType?: string; data?: string } }[] | undefined) ?? []).map((c) => c.attachment).find((a) => a?.data);
      if (!att?.data) { skipped.push(`Note: ${it.title} (kept in Practice Fusion: open it in MyPCP)`); continue; }
      await attach(`Note: ${it.title}`, async () => {
        const bytes = Buffer.from(att.data!, "base64");
        if (/pdf/i.test(att.contentType ?? "")) return appendPdf(bytes);
        w.newPage();
        w.text(`Note: ${it.title}${it.date ? ` (${fmt(it.date)})` : ""}`, { bold: true, size: 12, gap: 4 });
        w.text(bytes.toString("utf8").replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").slice(0, 60_000), { size: 9 });
      });
    }
  }
  if (included.length || skipped.length) {
    w.newPage();
    w.heading("Attachments");
    if (included.length) { w.text("Included (in the pages before this one):", { bold: true }); for (const x of included) w.text(x, { indent: 12, size: 9 }); }
    if (skipped.length) { w.text("Not included:", { bold: true }); for (const x of skipped) w.text(x, { indent: 12, size: 9 }); }
  }

  const bytes = await pdf.save();
  const name = `${summary.name.replace(/[^\w .-]/g, "")} - patient folder ${new Date().toISOString().slice(0, 10)}.pdf`;
  const storeKey = `documents/exports/${randomUUID()}.pdf`;
  await putBytes(storeKey, bytes);
  await audit(actor, "export_data", { entityType: "folder", entityId: pidOf(key) ?? undefined, description: `Downloaded a patient's whole folder (${pdf.getPageCount()} pages, ${included.length} attachments${skipped.length ? `, ${skipped.length} not included` : ""})` });
  return { ...(await readTarget(storeKey, name)), name, pages: pdf.getPageCount(), skipped: skipped.length };
}

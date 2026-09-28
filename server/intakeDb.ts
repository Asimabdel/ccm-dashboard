// Patient forms (replaces BoldSign for intake). Staff send a private link by text or email; the
// patient confirms their date of birth, fills in the health-history form and the practice's
// agreements on their phone, and signs. Completed packets become a "file in Practice Fusion" task
// (PF has no document-upload API), with a printable signed copy and a full audit trail.
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { ENV } from "./_core/env";
import { sealSecret, openSecret } from "./secretBox";
import {
  bookingRequests, clinics, emailContacts, fhirPatients, intakeDocuments, intakeEvents, intakeFiles, intakePackets, intakeSignatures,
  patients, users, workTaskActivities, workTasks,
} from "../drizzle/schema";
import {
  MEDICAL_INTAKE, MEDICAL_INTAKE_KEY, OPEN_PACKET, PACKET_EXPIRY_DAYS, PHOTO_KINDS, RELATION_LABELS, SIGNER_RELATIONS, agreementIn, cleanAnswers,
  docIdOf, docKey, formatUsPhone, inviteText, isIntakeLang, langFromPreferred, missingRequired, stableStringify, tr, type Answers, type IntakeLang,
  type PacketStatus, type PhotoKind, type SignerRelation,
} from "../shared/intake";
import { normalizePhone } from "../shared/phone";
import { localDateStr } from "../shared/workforce";
import { WorkspaceError, audit, createTask, frontDeskFor, loadScheduleSubjects, subjectCare, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const PUBLIC_ORIGIN = "https://mypcpcare.com";
const ALLOWED_ORIGINS = [PUBLIC_ORIGIN, "https://www.mypcpcare.com", "http://localhost:3001", "http://localhost:3000"];
const MAX_DOB_TRIES = 5;
const LOCK_MINUTES = 30;
const SESSION_TTL = "4h";
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
// Patient sessions get their own key (derived from the app secret), separate from staff logins.
const secret = () => new TextEncoder().encode(sha256(`patient-forms:${ENV.cookieSecret}`));
const ymd = (dt: Date | null | undefined) => (dt ? dt.toISOString().slice(0, 10) : null);

export interface ClientMeta { ip: string | null; userAgent: string | null }

async function logEvent(packetId: number, type: string, opts: { userId?: number | null; meta?: ClientMeta; detail?: string | null } = {}) {
  await (await db()).insert(intakeEvents).values({
    packetId, at: new Date(), type, userId: opts.userId ?? null,
    ip: opts.meta?.ip?.slice(0, 64) ?? null, userAgent: opts.meta?.userAgent?.slice(0, 255) ?? null, detail: opts.detail?.slice(0, 255) ?? null,
  });
}

export function linkFor(origin: string | null | undefined, token: string) {
  const base = origin && ALLOWED_ORIGINS.includes(origin) ? origin : PUBLIC_ORIGIN;
  return `${base}/f/${token}`;
}

// ---------------------------------------------------------------------------
// Form library (agreements / consents; wording pasted in by an admin)
// ---------------------------------------------------------------------------

export async function listDocuments(includeInactive = false) {
  const d = await db();
  const rows = await d.select().from(intakeDocuments).where(includeInactive ? undefined : eq(intakeDocuments.active, true)).orderBy(asc(intakeDocuments.sortOrder), asc(intakeDocuments.id));
  return rows.map((r) => ({ id: r.id, key: docKey(r.id), title: r.title, body: r.body, version: r.version, active: r.active, updatedAt: r.updatedAt }));
}

const cleanL10n = (v: Record<string, string | null | undefined>, max: number) =>
  Object.fromEntries(Object.entries(v).filter(([k, x]) => isIntakeLang(k) && typeof x === "string" && x.trim()).map(([k, x]) => [k, x!.trim().slice(0, max)]));

export async function saveDocument(actor: WorkspaceActor, input: { id?: number | null; title: Record<string, string | null | undefined>; body: Record<string, string | null | undefined>; active: boolean }) {
  const title = cleanL10n(input.title, 200);
  const body = cleanL10n(input.body, 60_000);
  if (!title.en || !body.en) throw new WorkspaceError("Every form needs at least an English title and wording.");
  const d = await db();
  if (input.id) {
    const [cur] = await d.select().from(intakeDocuments).where(eq(intakeDocuments.id, input.id)).limit(1);
    if (!cur) throw new WorkspaceError("Form not found.", "NOT_FOUND");
    const changed = stableStringify(cur.title) !== stableStringify(title) || stableStringify(cur.body) !== stableStringify(body);
    await d.update(intakeDocuments).set({ title, body, active: input.active, version: changed ? cur.version + 1 : cur.version, updatedByUserId: actor.id }).where(eq(intakeDocuments.id, cur.id));
    await audit(actor, "manage_playbook", { entityType: "intakeDocument", entityId: cur.id, description: `Patient form "${title.en}" ${changed ? `updated (v${cur.version + 1})` : input.active ? "turned on" : "turned off"}` });
    return { id: cur.id };
  }
  const res = await d.insert(intakeDocuments).values({ title, body, active: input.active, updatedByUserId: actor.id });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  await audit(actor, "manage_playbook", { entityType: "intakeDocument", entityId: id, description: `Patient form "${title.en}" added` });
  return { id };
}

/** Load forms by English title (adds new ones, updates changed ones). Used by an IAM-only Lambda job. */
export async function importDocuments(docs: { title: Record<string, string>; body: Record<string, string>; active?: boolean }[]) {
  const actor = { ...(await filingActor(null)), name: "Form library import" };
  const existing = await listDocuments(true);
  const out: { title: string; id: number; action: "added" | "updated" }[] = [];
  for (const doc of docs.slice(0, 20)) {
    const cur = existing.find((x) => (x.title.en ?? "").trim().toLowerCase() === (doc.title?.en ?? "").trim().toLowerCase());
    const r = await saveDocument(actor, { id: cur?.id ?? null, title: doc.title ?? {}, body: doc.body ?? {}, active: doc.active ?? true });
    out.push({ title: doc.title?.en ?? "", id: r.id, action: cur ? "updated" : "added" });
  }
  return { ok: true, docs: out };
}

/** Forms staff can pick when sending: the built-in health history + every active agreement. */
export async function formChoices() {
  const docs = await listDocuments();
  return [
    { key: MEDICAL_INTAKE_KEY, title: MEDICAL_INTAKE.title.en, builtIn: true, langs: ["en", "es", "ar"] as string[] },
    ...docs.map((x) => ({ key: x.key, title: x.title.en ?? "Form", builtIn: false, langs: Object.keys(x.body) })),
  ];
}

// ---------------------------------------------------------------------------
// Staff: who is this, create & send
// ---------------------------------------------------------------------------

/** Name, date of birth, phone, email and clinic we already have for a person (to prefill "Send forms"). */
export async function intakeContact(actor: WorkspaceActor, subjectKey: string) {
  const d = await db();
  const care = await subjectCare(subjectKey);
  let name = care?.name ?? null, dob: string | null = null, phone: string | null = null, email: string | null = null, language: IntakeLang = "en";
  const pid = care?.patientId ?? null;
  if (pid) {
    const [p] = await d.select({ name: patients.name, dob: patients.dateOfBirth, phone: patients.phoneNumber, lang: patients.preferredLanguage }).from(patients).where(eq(patients.id, pid)).limit(1);
    if (p) { name = p.name; dob = ymd(p.dob); phone = p.phone || null; language = langFromPreferred(p.lang); }
  }
  const sched = (await loadScheduleSubjects()).get(subjectKey);
  if (sched) { dob = dob ?? ymd(sched.dob); phone = phone ?? sched.phone ?? null; name = name ?? sched.name; }
  const [f] = await d.select({ name: fhirPatients.name, dob: fhirPatients.dob, phone: fhirPatients.phone, email: fhirPatients.email }).from(fhirPatients)
    .where(pid ? eq(fhirPatients.patientId, pid) : eq(fhirPatients.subjectKey, subjectKey)).limit(1);
  if (f) { name = name ?? f.name; dob = dob ?? f.dob; phone = phone ?? f.phone; email = f.email ?? null; }
  const [ec] = await d.select({ email: emailContacts.email }).from(emailContacts)
    .where(and(eq(emailContacts.kind, "patient"), pid ? eq(emailContacts.patientId, pid) : eq(emailContacts.subjectKey, subjectKey))).limit(1);
  email = email ?? ec?.email ?? null;
  if (actor.clinicIds && !inScope(actor, care?.clinicId ?? null)) throw new WorkspaceError("That patient isn't at your office.", "FORBIDDEN");
  const [open] = await d.select({ id: intakePackets.id }).from(intakePackets).where(and(eq(intakePackets.subjectKey, subjectKey), inArray(intakePackets.status, OPEN_PACKET))).limit(1);
  return { subjectKey, patientId: pid, name, dob, phone: normalizePhone(phone) ?? phone, email, language, clinicId: care?.clinicId ?? null, openPacketId: open?.id ?? null };
}

export interface CreatePacketInput {
  subjectKey?: string | null;
  name: string;
  dob: string;
  phone?: string | null;
  email?: string | null;
  language: IntakeLang;
  forms: string[];
  clinicId?: number | null;
  bookingRequestId?: number | null;
}

export async function createPacket(actor: WorkspaceActor, input: CreatePacketInput, origin: string | null) {
  const name = input.name.replace(/[\r\n<>]/g, " ").trim().slice(0, 255);
  if (!name) throw new WorkspaceError("Enter the patient's name.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dob)) throw new WorkspaceError("Enter the patient's date of birth; they use it to open the forms.");
  const active = new Set((await listDocuments()).map((x) => x.key));
  const forms = Array.from(new Set(input.forms)).filter((k) => k === MEDICAL_INTAKE_KEY || active.has(k));
  if (!forms.length) throw new WorkspaceError("Pick at least one form.");
  const d = await db();
  const care = input.subjectKey ? await subjectCare(input.subjectKey) : null;
  let clinicId = input.clinicId ?? care?.clinicId ?? null;
  if (!clinicId && input.bookingRequestId) clinicId = (await d.select({ c: bookingRequests.clinicId }).from(bookingRequests).where(eq(bookingRequests.id, input.bookingRequestId)).limit(1))[0]?.c ?? null;
  if (actor.clinicIds) {
    clinicId = clinicId ?? actor.clinicIds[0] ?? null;
    if (!inScope(actor, clinicId)) throw new WorkspaceError("You can only send forms for patients at your office.", "FORBIDDEN");
  }
  const token = randomBytes(24).toString("base64url");
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new WorkspaceError("That email address doesn't look right.");
  const res = await d.insert(intakePackets).values({
    tokenHash: sha256(token), tokenSealed: sealSecret(token), subjectKey: input.subjectKey ?? null, patientId: care?.patientId ?? null, name, dob: input.dob,
    phone: normalizePhone(input.phone ?? null) ?? (input.phone?.trim() || null), email, language: input.language, forms, clinicId,
    status: "waiting", expiresAt: new Date(Date.now() + PACKET_EXPIRY_DAYS * 86_400_000), bookingRequestId: input.bookingRequestId ?? null, createdByUserId: actor.id,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  await logEvent(id, "created", { userId: actor.id, detail: `${forms.length} form${forms.length === 1 ? "" : "s"} · ${input.language}` });
  await audit(actor, "update_patient", { entityType: "intakePacket", entityId: id, description: `Patient forms created (${forms.length})` });
  return { id, link: linkFor(origin, token) };
}

/** Office managers only reach their office's packets. */
const inScope = (actor: WorkspaceActor, clinicId: number | null) => !actor.clinicIds || (clinicId != null && actor.clinicIds.includes(clinicId));

async function packetOr404(id: number, actor: WorkspaceActor) {
  const [p] = await (await db()).select().from(intakePackets).where(eq(intakePackets.id, id)).limit(1);
  if (!p || !inScope(actor, p.clinicId)) throw new WorkspaceError("Those forms weren't found.", "NOT_FOUND");
  return p;
}
const isExpired = (p: { expiresAt: Date }) => p.expiresAt.getTime() < Date.now();

async function clinicPhone(clinicId: number | null) {
  if (!clinicId) return null;
  return (await (await db()).select({ phone: clinics.phone }).from(clinics).where(eq(clinics.id, clinicId)).limit(1))[0]?.phone ?? null;
}

async function markSent(p: typeof intakePackets.$inferSelect, via: "email" | "text" | "link") {
  await (await db()).update(intakePackets).set({ sentVia: via, sentAt: p.sentAt ?? new Date(), sendCount: p.sendCount + 1 }).where(eq(intakePackets.id, p.id));
}

function assertSendable(p: typeof intakePackets.$inferSelect) {
  if (p.status === "cancelled") throw new WorkspaceError("These forms were cancelled. Send new ones instead.");
  if (p.status === "completed" || p.status === "filed") throw new WorkspaceError("The patient already finished these forms.");
  if (isExpired(p)) throw new WorkspaceError("This link expired. Click \"Give 14 more days\" first.");
}

/** Email the link from the practice mailbox. The email has no health details, only the link. */
export async function sendByEmail(actor: WorkspaceActor, id: number, origin: string | null, to?: string | null) {
  const p = await packetOr404(id, actor);
  assertSendable(p);
  const email = (to?.trim().toLowerCase() || p.email || "").trim();
  if (!email) throw new WorkspaceError("There's no email address for this patient.");
  const { sendPracticeEmail } = await import("./gmailSync");
  const link = linkFor(origin, openSecret(p.tokenSealed));
  const phone = await clinicPhone(p.clinicId);
  await sendPracticeEmail({ to: email, fromName: "MyPCP Dr", ...inviteEmail(p.language, link, phone) });
  if (email !== p.email) await (await db()).update(intakePackets).set({ email }).where(eq(intakePackets.id, p.id));
  await markSent(p, "email");
  await logEvent(p.id, "sent_email", { userId: actor.id, detail: maskEmail(email) });
  await audit(actor, "update_patient", { entityType: "intakePacket", entityId: p.id, description: "Patient forms emailed" });
  return { ok: true, to: maskEmail(email) };
}

/** The text message for the RingCentral phone (staff press Send there). */
export async function textMessage(actor: WorkspaceActor, id: number, origin: string | null) {
  const p = await packetOr404(id, actor);
  assertSendable(p);
  if (!p.phone) throw new WorkspaceError("There's no phone number for this patient.");
  const message = inviteText(p.language, linkFor(origin, openSecret(p.tokenSealed)), await clinicPhone(p.clinicId));
  await markSent(p, "text");
  await logEvent(p.id, "sent_text", { userId: actor.id, detail: `…${p.phone.slice(-4)} (RingCentral)` });
  return { phone: p.phone, message };
}

export async function copyLink(actor: WorkspaceActor, id: number, origin: string | null) {
  const p = await packetOr404(id, actor);
  assertSendable(p);
  const link = linkFor(origin, openSecret(p.tokenSealed));
  if (!p.sentVia) await markSent(p, "link");
  await logEvent(p.id, "link_copied", { userId: actor.id });
  return { link, message: inviteText(p.language, link, await clinicPhone(p.clinicId)) };
}

function maskEmail(e: string) {
  const [u, dom] = e.split("@");
  return `${(u ?? "").slice(0, 2)}…@${dom ?? ""}`;
}

function inviteEmail(lang: string, link: string, phone: string | null) {
  const ph = phone ? formatUsPhone(phone) : null;
  const copy = {
    en: { subject: "Your forms from MyPCP Dr", hi: "Hello,", body: "Please fill out your forms before your visit. It takes about 10 minutes, and you can use your phone or computer.", button: "Open my forms", dob: "You'll be asked for your date of birth to open them.", call: ph ? `Questions or need help? Call us at ${ph}.` : "Questions or need help? Call the clinic.", ignore: "If you weren't expecting this, you can ignore this email." },
    es: { subject: "Sus formularios de MyPCP Dr", hi: "Hola,", body: "Por favor llene sus formularios antes de su cita. Toma unos 10 minutos y puede usar su teléfono o computadora.", button: "Abrir mis formularios", dob: "Le pediremos su fecha de nacimiento para abrirlos.", call: ph ? `¿Preguntas o necesita ayuda? Llámenos al ${ph}.` : "¿Preguntas o necesita ayuda? Llame a la clínica.", ignore: "Si no esperaba este mensaje, puede ignorarlo." },
    ar: { subject: "النماذج الخاصة بك من MyPCP Dr", hi: "مرحبًا،", body: "يرجى تعبئة النماذج قبل موعدك. يستغرق ذلك حوالي 10 دقائق، ويمكنك استخدام هاتفك أو جهاز الكمبيوتر.", button: "افتح النماذج", dob: "سنطلب منك تاريخ ميلادك لفتحها.", call: ph ? `للاستفسار أو المساعدة اتصل بنا على ${ph}.` : "للاستفسار أو المساعدة اتصل بالعيادة.", ignore: "إذا لم تكن تتوقع هذه الرسالة، يمكنك تجاهلها." },
  } as const;
  const langs: (keyof typeof copy)[] = lang === "es" || lang === "ar" ? [lang, "en"] : ["en", "es"];
  const main = copy[langs[0]!];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const block = (c: (typeof copy)[keyof typeof copy], dir: string) => `
    <div dir="${dir}" style="font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.5;color:#0f172a;text-align:${dir === "rtl" ? "right" : "left"}">
      <p style="margin:0 0 12px">${esc(c.hi)}</p>
      <p style="margin:0 0 20px">${esc(c.body)}</p>
      <p style="margin:0 0 20px"><a href="${esc(link)}" style="display:inline-block;background:#0e7490;color:#ffffff;text-decoration:none;font-weight:bold;font-size:20px;padding:16px 28px;border-radius:10px">${esc(c.button)}</a></p>
      <p style="margin:0 0 8px;color:#334155">${esc(c.dob)}</p>
      <p style="margin:0 0 8px;color:#334155">${esc(c.call)}</p>
    </div>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:28px">
      <p style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:#0e7490">MyPCP Dr</p>
      ${langs.map((k, i) => `${i ? '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">' : ""}${block(copy[k], k === "ar" ? "rtl" : "ltr")}`).join("")}
      <p style="margin:24px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#64748b">${esc(main.ignore)}</p>
    </div></body></html>`;
  const text = langs.map((k) => { const c = copy[k]; return [c.hi, "", c.body, "", `${c.button}: ${link}`, "", c.dob, c.call].join("\n"); }).join("\n\n———\n\n") + `\n\n${main.ignore}`;
  return { subject: langs.map((k) => copy[k].subject).join(" / "), text, html };
}

// ---------------------------------------------------------------------------
// Staff: list, detail, file, cancel, extend
// ---------------------------------------------------------------------------

export type PacketFilter = "waiting" | "to_file" | "filed" | "all";

export async function listPackets(actor: WorkspaceActor, filter: PacketFilter) {
  const d = await db();
  const since = new Date(Date.now() - 180 * 86_400_000);
  const conds = [gte(intakePackets.createdAt, since), packetScope(actor)];
  if (filter === "waiting") conds.push(inArray(intakePackets.status, OPEN_PACKET));
  else if (filter === "to_file") conds.push(eq(intakePackets.status, "completed"));
  else if (filter === "filed") conds.push(eq(intakePackets.status, "filed"));
  const rows = await d.select({ p: intakePackets, clinicName: clinics.name, createdBy: users.name }).from(intakePackets)
    .leftJoin(clinics, eq(clinics.id, intakePackets.clinicId)).leftJoin(users, eq(users.id, intakePackets.createdByUserId))
    .where(and(...conds)).orderBy(desc(intakePackets.createdAt)).limit(400);
  const ids = rows.map((r) => r.p.id);
  const signed = ids.length ? await d.select({ packetId: intakeSignatures.packetId, formKey: intakeSignatures.formKey }).from(intakeSignatures).where(inArray(intakeSignatures.packetId, ids)) : [];
  const titles = new Map((await listDocuments(true)).map((x) => [x.key, x.title.en ?? "Form"]));
  titles.set(MEDICAL_INTAKE_KEY, MEDICAL_INTAKE.title.en);
  return rows.map(({ p, clinicName, createdBy }) => ({
    id: p.id, name: p.name, subjectKey: p.subjectKey, patientId: p.patientId, language: p.language, status: p.status as PacketStatus,
    expired: OPEN_PACKET.includes(p.status as PacketStatus) && isExpired(p), expiresAt: p.expiresAt,
    forms: (p.forms as string[]).map((k) => ({ key: k, title: titles.get(k) ?? "Form", signed: signed.some((s) => s.packetId === p.id && s.formKey === k) })),
    sentVia: p.sentVia, sentAt: p.sentAt, sendCount: p.sendCount, openedAt: p.openedAt, completedAt: p.completedAt, filedAt: p.filedAt, createdAt: p.createdAt,
    hasPhone: !!p.phone, hasEmail: !!p.email, phoneLast4: p.phone?.slice(-4) ?? null, clinicName, createdBy, locked: !!p.lockedUntil && p.lockedUntil.getTime() > Date.now(),
  }));
}

const packetScope = (actor: WorkspaceActor) =>
  actor.clinicIds ? (actor.clinicIds.length ? inArray(intakePackets.clinicId, actor.clinicIds) : sql`1 = 0`) : undefined;

export async function packetStats(actor: WorkspaceActor) {
  const d = await db();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await d.select({ status: intakePackets.status, createdAt: intakePackets.createdAt, sentAt: intakePackets.sentAt, completedAt: intakePackets.completedAt, expiresAt: intakePackets.expiresAt })
    .from(intakePackets).where(and(gte(intakePackets.createdAt, since), packetScope(actor)));
  const hours = rows.filter((r) => r.completedAt && r.sentAt).map((r) => (r.completedAt!.getTime() - r.sentAt!.getTime()) / 3_600_000).sort((a, b) => a - b);
  const toFile = (await d.select({ id: intakePackets.id }).from(intakePackets).where(and(eq(intakePackets.status, "completed"), packetScope(actor))).limit(500)).length;
  return {
    waiting: rows.filter((r) => OPEN_PACKET.includes(r.status as PacketStatus) && r.expiresAt.getTime() > Date.now()).length,
    toFile,
    sent30: rows.filter((r) => r.status !== "cancelled").length,
    done30: rows.filter((r) => r.status === "completed" || r.status === "filed").length,
    medianHours: hours.length ? Math.round(hours[Math.floor(hours.length / 2)]! * 10) / 10 : null,
  };
}

/** Everything about one packet, for the staff view and the printed copy (no photo bytes). */
export async function packetDetail(actor: WorkspaceActor, id: number) {
  const d = await db();
  const p = await packetOr404(id, actor);
  const [sigs, files, events, clinic] = await Promise.all([
    d.select().from(intakeSignatures).where(eq(intakeSignatures.packetId, id)).orderBy(asc(intakeSignatures.signedAt)),
    d.select({ id: intakeFiles.id, kind: intakeFiles.kind, mime: intakeFiles.mime, size: intakeFiles.size, sha256: intakeFiles.sha256, createdAt: intakeFiles.createdAt }).from(intakeFiles).where(eq(intakeFiles.packetId, id)),
    d.select({ e: intakeEvents, userName: users.name }).from(intakeEvents).leftJoin(users, eq(users.id, intakeEvents.userId)).where(eq(intakeEvents.packetId, id)).orderBy(asc(intakeEvents.at), asc(intakeEvents.id)),
    p.clinicId ? d.select({ name: clinics.name, phone: clinics.phone, address: clinics.address }).from(clinics).where(eq(clinics.id, p.clinicId)).limit(1).then((r) => r[0] ?? null) : Promise.resolve(null),
  ]);
  const docs = new Map((await listDocuments(true)).map((x) => [x.key, x]));
  await logEvent(id, "viewed", { userId: actor.id });
  await audit(actor, "view_patient", { entityType: "intakePacket", entityId: id, description: "Viewed patient forms" });
  return {
    id: p.id, name: p.name, dob: p.dob, phone: p.phone, email: p.email, language: p.language, status: p.status as PacketStatus, subjectKey: p.subjectKey, patientId: p.patientId,
    expired: OPEN_PACKET.includes(p.status as PacketStatus) && isExpired(p), expiresAt: p.expiresAt, createdAt: p.createdAt, sentAt: p.sentAt, openedAt: p.openedAt, completedAt: p.completedAt, filedAt: p.filedAt,
    clinic, taskId: p.taskId,
    forms: (p.forms as string[]).map((k) => ({ key: k, title: k === MEDICAL_INTAKE_KEY ? MEDICAL_INTAKE.title.en : docs.get(k)?.title.en ?? "Form", kind: k === MEDICAL_INTAKE_KEY ? "questionnaire" as const : "agreement" as const })),
    answers: ((p.answers ?? {}) as Record<string, Answers>)[MEDICAL_INTAKE_KEY] ?? {},
    signatures: sigs.map((s) => ({
      formKey: s.formKey, formTitle: s.formTitle, language: s.language, formVersion: s.formVersion, signerName: s.signerName, signerRelation: s.signerRelation,
      relationLabel: RELATION_LABELS[s.signerRelation as SignerRelation]?.en ?? s.signerRelation, method: s.method, signatureFileId: s.signatureFileId,
      signedAt: s.signedAt, ip: s.ip, userAgent: s.userAgent, textHash: s.textHash, docHash: s.docHash,
      text: s.formKey === MEDICAL_INTAKE_KEY ? null : (JSON.parse(s.snapshot) as { title: string; body: string }),
    })),
    files,
    events: events.map(({ e, userName }) => ({ at: e.at, type: e.type, detail: e.detail, ip: e.ip, userAgent: e.userAgent, userName })),
  };
}

export async function packetFile(actor: WorkspaceActor, packetId: number, fileId: number) {
  const [f] = await (await db()).select().from(intakeFiles).where(and(eq(intakeFiles.id, fileId), eq(intakeFiles.packetId, packetId))).limit(1);
  if (!f) throw new WorkspaceError("File not found.", "NOT_FOUND");
  if (f.kind !== "signature") await logEvent(packetId, "photo_viewed", { userId: actor.id, detail: f.kind });
  return { kind: f.kind, dataUrl: `data:${f.mime};base64,${f.data}` };
}

async function closeTask(actor: WorkspaceActor, taskId: number | null, to: "completed" | "cancelled", reason: string) {
  if (!taskId) return;
  const d = await db();
  const [t] = await d.select({ status: workTasks.status }).from(workTasks).where(eq(workTasks.id, taskId)).limit(1);
  if (!t || t.status === "completed" || t.status === "cancelled") return;
  await d.update(workTasks).set({ status: to, completedAt: to === "completed" ? new Date() : null }).where(eq(workTasks.id, taskId));
  await d.insert(workTaskActivities).values({ taskId, userId: actor.id, type: "status_changed", meta: { from: t.status, to, reason } });
}

export async function markFiled(actor: WorkspaceActor, id: number) {
  const p = await packetOr404(id, actor);
  if (p.status !== "completed") throw new WorkspaceError(p.status === "filed" ? "Already marked as filed." : "The patient hasn't finished these forms yet.");
  await (await db()).update(intakePackets).set({ status: "filed", filedAt: new Date(), filedByUserId: actor.id }).where(eq(intakePackets.id, id));
  await closeTask(actor, p.taskId, "completed", "Filed in Practice Fusion");
  await logEvent(id, "filed", { userId: actor.id });
  await audit(actor, "update_patient", { entityType: "intakePacket", entityId: id, description: "Patient forms filed in Practice Fusion" });
  return { ok: true };
}

export async function cancelPacket(actor: WorkspaceActor, id: number) {
  const p = await packetOr404(id, actor);
  if (!OPEN_PACKET.includes(p.status as PacketStatus)) throw new WorkspaceError("Only forms the patient hasn't finished can be cancelled.");
  await (await db()).update(intakePackets).set({ status: "cancelled" }).where(eq(intakePackets.id, id));
  await logEvent(id, "cancelled", { userId: actor.id });
  await audit(actor, "update_patient", { entityType: "intakePacket", entityId: id, description: "Patient forms cancelled" });
  return { ok: true };
}

export async function extendPacket(actor: WorkspaceActor, id: number) {
  const p = await packetOr404(id, actor);
  if (!OPEN_PACKET.includes(p.status as PacketStatus)) throw new WorkspaceError("Only forms the patient hasn't finished can be extended.");
  await (await db()).update(intakePackets).set({ expiresAt: new Date(Date.now() + PACKET_EXPIRY_DAYS * 86_400_000), lockedUntil: null, failedDobAttempts: 0 }).where(eq(intakePackets.id, id));
  await logEvent(id, "extended", { userId: actor.id, detail: `${PACKET_EXPIRY_DAYS} more days` });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Patient side (public; the link token + date of birth are the only keys)
// ---------------------------------------------------------------------------

export class PatientFormError extends Error {}

async function byToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [p] = await (await db()).select().from(intakePackets).where(eq(intakePackets.tokenHash, sha256(token))).limit(1);
  return p ?? null;
}

type PublicState = "ok" | "not_found" | "expired" | "cancelled" | "done" | "locked";
function stateOf(p: typeof intakePackets.$inferSelect | null): PublicState {
  if (!p) return "not_found";
  if (p.status === "cancelled") return "cancelled";
  if (p.status === "completed" || p.status === "filed") return "done";
  if (isExpired(p)) return "expired";
  if (p.lockedUntil && p.lockedUntil.getTime() > Date.now()) return "locked";
  return "ok";
}

async function publicClinic(clinicId: number | null) {
  if (!clinicId) return { name: null as string | null, phone: null as string | null };
  const [c] = await (await db()).select({ name: clinics.name, phone: clinics.phone }).from(clinics).where(eq(clinics.id, clinicId)).limit(1);
  return { name: c?.name ?? null, phone: c?.phone ?? null };
}

/** First step: is this link good? Reveals nothing about the patient. */
export async function patientOpen(token: string, meta: ClientMeta) {
  const p = await byToken(token);
  const state = stateOf(p);
  if (!p) return { state, language: "en" as string, clinic: { name: null, phone: null }, formCount: 0 };
  if (state === "ok" && !p.openedAt) {
    await (await db()).update(intakePackets).set({ openedAt: new Date(), status: p.status === "waiting" ? "opened" : p.status }).where(eq(intakePackets.id, p.id));
    await logEvent(p.id, "opened", { meta });
  }
  return { state, language: p.language, clinic: await publicClinic(p.clinicId), formCount: (p.forms as string[]).length };
}

export async function patientVerify(token: string, dob: string | null, meta: ClientMeta) {
  const p = await byToken(token);
  const state = stateOf(p);
  if (!p || state !== "ok") return { ok: false as const, state, triesLeft: 0 };
  const d = await db();
  if (!dob || dob !== p.dob) {
    const tries = p.failedDobAttempts + 1;
    const lock = tries >= MAX_DOB_TRIES;
    await d.update(intakePackets).set({ failedDobAttempts: lock ? 0 : tries, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null }).where(eq(intakePackets.id, p.id));
    await logEvent(p.id, lock ? "locked" : "dob_failed", { meta, detail: lock ? `${MAX_DOB_TRIES} wrong dates of birth: locked ${LOCK_MINUTES} min` : `attempt ${tries}` });
    return { ok: false as const, state: lock ? ("locked" as const) : ("ok" as const), triesLeft: lock ? 0 : MAX_DOB_TRIES - tries };
  }
  if (p.failedDobAttempts) await d.update(intakePackets).set({ failedDobAttempts: 0 }).where(eq(intakePackets.id, p.id));
  await logEvent(p.id, "dob_ok", { meta });
  const session = await new SignJWT({ pid: p.id, th: p.tokenHash.slice(0, 16), purpose: "patient-forms" })
    .setProtectedHeader({ alg: "HS256" }).setExpirationTime(SESSION_TTL).sign(secret());
  return { ok: true as const, state, session, packet: await payload(p) };
}

async function fromSession(session: string) {
  let claims: { pid?: number; th?: string; purpose?: string };
  try {
    claims = (await jwtVerify(session, secret())).payload as typeof claims;
  } catch {
    throw new PatientFormError("session");
  }
  if (claims.purpose !== "patient-forms" || !claims.pid) throw new PatientFormError("session");
  const [p] = await (await db()).select().from(intakePackets).where(eq(intakePackets.id, claims.pid)).limit(1);
  if (!p || p.tokenHash.slice(0, 16) !== claims.th) throw new PatientFormError("session");
  const state = stateOf(p);
  if (state === "done") throw new PatientFormError("done");
  if (state !== "ok") throw new PatientFormError(state);
  return p;
}

/** What the patient's page needs after the date-of-birth check. */
async function payload(p: typeof intakePackets.$inferSelect) {
  const d = await db();
  const sigs = await d.select({ formKey: intakeSignatures.formKey, signerName: intakeSignatures.signerName, signedAt: intakeSignatures.signedAt }).from(intakeSignatures).where(eq(intakeSignatures.packetId, p.id));
  const photos = await d.select({ kind: intakeFiles.kind }).from(intakeFiles).where(eq(intakeFiles.packetId, p.id));
  const docs = new Map((await listDocuments(true)).map((x) => [x.key, x]));
  const forms = (p.forms as string[]).map((k) => {
    const sig = sigs.find((s) => s.formKey === k);
    if (k === MEDICAL_INTAKE_KEY) return { key: k, kind: "questionnaire" as const, version: MEDICAL_INTAKE.version, signed: !!sig, signedAt: sig?.signedAt ?? null, doc: null };
    const doc = docs.get(k);
    return { key: k, kind: "agreement" as const, version: doc?.version ?? 0, signed: !!sig, signedAt: sig?.signedAt ?? null, doc: doc ? { title: doc.title, body: doc.body } : null };
  }).filter((f) => f.kind === "questionnaire" || f.doc);
  // "LAST, FIRST" (Practice Fusion style) or "First Last" → the first name, for "Hello, …".
  const given = (p.name.includes(",") ? p.name.split(",")[1] : p.name) ?? "";
  return {
    firstName: given.trim().split(/\s+/)[0] ?? "",
    language: p.language,
    clinic: await publicClinic(p.clinicId),
    forms,
    answers: ((p.answers ?? {}) as Record<string, Answers>)[MEDICAL_INTAKE_KEY] ?? {},
    prefill: { name: p.name, phone: p.phone ?? "", email: p.email ?? "" },
    photos: PHOTO_KINDS.filter((k) => photos.some((x) => x.kind === k)),
  };
}

export async function patientLoad(session: string) {
  return payload(await fromSession(session));
}

export async function patientSetLanguage(token: string, language: IntakeLang) {
  const p = await byToken(token);
  if (!p || stateOf(p) !== "ok") return { ok: false };
  if (p.language !== language) await (await db()).update(intakePackets).set({ language }).where(eq(intakePackets.id, p.id));
  return { ok: true };
}

/** Save the health-history answers as the patient goes (so they can stop and come back). */
export async function patientSave(session: string, raw: unknown) {
  const p = await fromSession(session);
  if (!(p.forms as string[]).includes(MEDICAL_INTAKE_KEY)) throw new PatientFormError("bad");
  const d = await db();
  const [signed] = await d.select({ id: intakeSignatures.id }).from(intakeSignatures).where(and(eq(intakeSignatures.packetId, p.id), eq(intakeSignatures.formKey, MEDICAL_INTAKE_KEY))).limit(1);
  if (signed) return { ok: true, locked: true };
  const prev = ((p.answers ?? {}) as Record<string, Answers>)[MEDICAL_INTAKE_KEY] ?? {};
  const keepPhotos = Object.fromEntries(Object.entries(prev).filter(([k]) => MEDICAL_INTAKE.sections.some((s) => s.fields.some((f) => f.id === k && f.type === "photo"))));
  const answers = { ...cleanAnswers(MEDICAL_INTAKE, raw), ...keepPhotos };
  if (JSON.stringify(answers).length > 64_000) throw new PatientFormError("too_big");
  const first = p.status !== "in_progress";
  await d.update(intakePackets).set({ answers: { ...((p.answers ?? {}) as Record<string, Answers>), [MEDICAL_INTAKE_KEY]: answers }, status: "in_progress" }).where(eq(intakePackets.id, p.id));
  if (first) await logEvent(p.id, "started");
  return { ok: true, locked: false };
}

const IMAGE_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

/** Insurance card / ID photo (the page shrinks it first). Replaces an earlier photo of the same kind. */
export async function patientPhoto(session: string, input: { kind: PhotoKind; dataUrl: string | null }, meta: ClientMeta) {
  const p = await fromSession(session);
  const d = await db();
  const [signed] = await d.select({ id: intakeSignatures.id }).from(intakeSignatures).where(and(eq(intakeSignatures.packetId, p.id), eq(intakeSignatures.formKey, MEDICAL_INTAKE_KEY))).limit(1);
  if (signed) throw new PatientFormError("locked");
  const m = input.dataUrl ? IMAGE_RE.exec(input.dataUrl) : null;
  if (input.dataUrl && !m) throw new PatientFormError("bad_image");
  const bytes = m ? Buffer.from(m[2]!, "base64") : null;
  if (bytes && bytes.length > 4_000_000) throw new PatientFormError("too_big");
  await d.delete(intakeFiles).where(and(eq(intakeFiles.packetId, p.id), eq(intakeFiles.kind, input.kind)));
  const field = MEDICAL_INTAKE.sections.flatMap((s) => s.fields).find((f) => f.photo === input.kind)!;
  const all = (p.answers ?? {}) as Record<string, Answers>;
  const answers = { ...(all[MEDICAL_INTAKE_KEY] ?? {}) };
  if (!m || !bytes) {
    delete answers[field.id];
  } else {
    const res = await d.insert(intakeFiles).values({ packetId: p.id, kind: input.kind, mime: m[1]!, data: m[2]!, size: bytes.length, sha256: sha256(bytes) });
    answers[field.id] = `photo:${(res as unknown as [{ insertId: number }])[0].insertId}`;
    await logEvent(p.id, "photo_added", { meta, detail: input.kind });
  }
  await d.update(intakePackets).set({ answers: { ...all, [MEDICAL_INTAKE_KEY]: answers }, status: "in_progress" }).where(eq(intakePackets.id, p.id));
  return { ok: true };
}

export interface SignInput {
  formKey: string;
  version: number;
  language: string;
  signerName: string;
  relation: SignerRelation;
  method: "typed" | "drawn";
  drawn?: string | null;
  esignConsent: boolean;
}

/** Sign one form. The questionnaire must be complete; an agreement must be the version the patient read. */
export async function patientSign(session: string, input: SignInput, meta: ClientMeta) {
  const p = await fromSession(session);
  const d = await db();
  if (!input.esignConsent) throw new PatientFormError("consent");
  if (!(p.forms as string[]).includes(input.formKey)) throw new PatientFormError("bad");
  const signerName = input.signerName.replace(/[\r\n<>]/g, " ").trim().slice(0, 160);
  if (signerName.length < 2) throw new PatientFormError("name");
  if (!SIGNER_RELATIONS.includes(input.relation)) throw new PatientFormError("bad");
  const lang: IntakeLang = isIntakeLang(input.language) ? input.language : "en";
  const [already] = await d.select({ id: intakeSignatures.id }).from(intakeSignatures).where(and(eq(intakeSignatures.packetId, p.id), eq(intakeSignatures.formKey, input.formKey))).limit(1);
  if (already) return patientAfterSign(p.id);

  let formTitle: string, formVersion: number, snapshot: string;
  if (input.formKey === MEDICAL_INTAKE_KEY) {
    const answers = ((p.answers ?? {}) as Record<string, Answers>)[MEDICAL_INTAKE_KEY] ?? {};
    if (missingRequired(MEDICAL_INTAKE, answers).length) throw new PatientFormError("incomplete");
    formTitle = tr(MEDICAL_INTAKE.title, lang);
    formVersion = MEDICAL_INTAKE.version;
    snapshot = stableStringify({ form: MEDICAL_INTAKE_KEY, version: MEDICAL_INTAKE.version, language: lang, attestation: tr(MEDICAL_INTAKE.attestation, lang), answers });
  } else {
    const id = docIdOf(input.formKey);
    const [doc] = id ? await d.select().from(intakeDocuments).where(eq(intakeDocuments.id, id)).limit(1) : [];
    if (!doc) throw new PatientFormError("bad");
    // The wording changed while the patient was reading: show them the new version first.
    if (doc.version !== input.version) throw new PatientFormError("changed");
    const text = agreementIn({ title: doc.title, body: doc.body }, lang);
    formTitle = text.title;
    formVersion = doc.version;
    snapshot = JSON.stringify({ title: text.title, body: text.body, language: text.lang });
  }

  let signatureFileId: number | null = null, signatureHash: string | null = null;
  if (input.method === "drawn") {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input.drawn ?? "");
    if (!m) throw new PatientFormError("drawn");
    const bytes = Buffer.from(m[1]!, "base64");
    if (bytes.length > 400_000 || bytes.length < 100) throw new PatientFormError("drawn");
    signatureHash = sha256(bytes);
    const res = await d.insert(intakeFiles).values({ packetId: p.id, kind: "signature", mime: "image/png", data: m[1]!, size: bytes.length, sha256: signatureHash });
    signatureFileId = (res as unknown as [{ insertId: number }])[0].insertId;
  }
  const signedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const textHash = sha256(snapshot);
  const ip = meta.ip?.slice(0, 64) ?? null;
  const userAgent = meta.userAgent?.slice(0, 255) ?? null;
  const docHash = sha256(stableStringify({ packetId: p.id, formKey: input.formKey, formVersion, language: lang, textHash, signerName, relation: input.relation, method: input.method, signatureHash, signedAt: signedAt.toISOString(), ip }));
  await d.insert(intakeSignatures).values({
    packetId: p.id, formKey: input.formKey, formTitle: formTitle.slice(0, 255), language: lang, formVersion, snapshot, textHash, signerName, signerRelation: input.relation,
    method: input.method, signatureFileId, signedAt, ip, userAgent, docHash,
  });
  await logEvent(p.id, "signed", { meta, detail: `${formTitle.slice(0, 120)} · ${input.method}${input.relation === "self" ? "" : ` · by ${input.relation}`}` });
  if (p.status === "waiting" || p.status === "opened") await d.update(intakePackets).set({ status: "in_progress" }).where(eq(intakePackets.id, p.id));
  return patientAfterSign(p.id);
}

/** After each signature: when every form is signed, the packet is done and the front desk gets a task. */
async function patientAfterSign(packetId: number) {
  const d = await db();
  const [p] = await d.select().from(intakePackets).where(eq(intakePackets.id, packetId)).limit(1);
  if (!p) throw new PatientFormError("bad");
  const signed = new Set((await d.select({ k: intakeSignatures.formKey }).from(intakeSignatures).where(eq(intakeSignatures.packetId, packetId))).map((r) => r.k));
  const all = (p.forms as string[]).every((k) => signed.has(k));
  if (!all || p.status === "completed" || p.status === "filed") return { ok: true, completed: all };
  await d.update(intakePackets).set({ status: "completed", completedAt: new Date() }).where(eq(intakePackets.id, packetId));
  await logEvent(packetId, "completed");
  try {
    const actor = await filingActor(p.createdByUserId);
    const desk = await frontDeskFor(p.clinicId);
    const task = await createTask(actor, {
      title: `File patient forms in Practice Fusion: ${p.name}`.slice(0, 250),
      description: [
        `${p.name} finished their forms (${(p.forms as string[]).length}).`,
        p.patientId || p.subjectKey ? null : "New patient: add them in Practice Fusion first.",
        "",
        `Open /intake-forms?p=${packetId}, click "Save signed copy (PDF)", upload it to the patient's chart in Practice Fusion (Documents), then click "Mark filed".`,
      ].filter((x) => x !== null).join("\n"),
      patientId: p.patientId, clinicId: p.clinicId, assignedUserId: desk.assignedUserId, assignedRole: desk.assignedRole,
      priority: "normal", category: "form", dueDate: localDateStr(), sourceType: "intake_packet", sourceRef: String(packetId),
    });
    await d.update(intakePackets).set({ taskId: task.id }).where(eq(intakePackets.id, packetId));
  } catch (e) {
    console.error("[patient-forms] filing task failed:", (e as Error).message);
  }
  console.log(`[patient-forms] ${JSON.stringify({ id: packetId, completed: true })}`); // no patient details in logs
  return { ok: true, completed: true };
}

async function filingActor(userId: number | null): Promise<WorkspaceActor> {
  const d = await db();
  const [u] = userId ? await d.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1) : [];
  const [admin] = u ? [u] : await d.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  if (!admin) throw new Error("No user to file patient forms under.");
  return { id: admin.id, name: "Patient forms", role: "admin", clinicIds: null };
}

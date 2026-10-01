// Patient forms (replaces BoldSign for intake). Staff send a private link by text or email; the
// patient confirms their date of birth, fills in the health-history form and the practice's
// agreements on their phone, and signs. Completed packets become a "file in Practice Fusion" task
// (PF has no document-upload API), with a printable signed copy and a full audit trail.
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { and, asc, desc, eq, inArray, like, not, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";
import { ENV } from "./_core/env";
import { sealSecret, openSecret } from "./secretBox";
import {
  bookingRequests, clinics, emailContacts, fhirPatients, intakeDocuments, intakeEvents, intakeFiles, intakePackets, intakeSignatures,
  patients, users, workTaskActivities, workTasks,
} from "../drizzle/schema";
import {
  AUTHORITY_LABELS, CHOICES_CONSENT, CONSENT_LABELS, MEDICAL_INTAKE, MEDICAL_INTAKE_KEY, OPEN_PACKET, PACKET_EXPIRY_DAYS, PHOTO_KINDS, PUBLIC_SLUG_RE, RELATION_LABELS,
  SIGNER_AUTHORITIES, SIGNER_RELATIONS, WEBSITE_PACKET_HOURS, agreementIn, choiceIn, cleanAnswers, cleanChoices, docIdOf, docKey, formatUsPhone, inviteText, isConsentKind,
  isIntakeLang, langFromPreferred, missingRequired, needsAuthority, stableStringify, tr, type Answers, type ConsentKind, type IntakeLang, type PacketSource,
  type ChoiceAnswer, type ConsentChoice, type PacketStatus, type PhotoKind, type SignDecision, type SignerAuthority, type SignerRelation,
} from "../shared/intake";
import { enrollmentsForSubject, recordConsent, type ConsentEvent } from "./enrollDb";
import { matchFaxPatient } from "../shared/fax";
import { normalizePhone } from "../shared/phone";
import { localDateStr } from "../shared/workforce";
import { WorkspaceError, audit, buildNameDobIndex, createTask, frontDeskFor, loadScheduleSubjects, subjectCare, type WorkspaceActor } from "./workspaceDb";

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
  return rows.map((r) => ({
    id: r.id, key: docKey(r.id), title: r.title, body: r.body, version: r.version, active: r.active, updatedAt: r.updatedAt,
    consentKind: isConsentKind(r.consentKind) ? r.consentKind : null, publicSlug: r.publicSlug ?? null, choices: cleanChoices(r.choices),
  }));
}

const cleanL10n = (v: Record<string, string | null | undefined>, max: number) =>
  Object.fromEntries(Object.entries(v).filter(([k, x]) => isIntakeLang(k) && typeof x === "string" && x.trim()).map(([k, x]) => [k, x!.trim().slice(0, max)]));

export interface SaveDocumentInput {
  id?: number | null;
  title: Record<string, string | null | undefined>;
  body: Record<string, string | null | undefined>;
  active: boolean;
  /** undefined = leave as is */
  consentKind?: ConsentKind | null;
  publicSlug?: string | null;
  /** Yes/No consent questions in this form; undefined = leave as is. */
  choices?: unknown[] | null;
}

export async function saveDocument(actor: WorkspaceActor, input: SaveDocumentInput) {
  const title = cleanL10n(input.title, 200);
  const body = cleanL10n(input.body, 60_000);
  if (!title.en || !body.en) throw new WorkspaceError("Every form needs at least an English title and wording.");
  const d = await db();
  const settings: { consentKind?: ConsentKind | null; publicSlug?: string | null; choices?: ConsentChoice[] | null } = {};
  if (input.choices !== undefined) settings.choices = input.choices ? cleanChoices(input.choices) : null;
  if (settings.choices && !settings.choices.length) settings.choices = null;
  if (input.consentKind !== undefined) settings.consentKind = input.consentKind && isConsentKind(input.consentKind) ? input.consentKind : null;
  if (input.publicSlug !== undefined) {
    const slug = input.publicSlug?.trim().toLowerCase() || null;
    if (slug && !PUBLIC_SLUG_RE.test(slug)) throw new WorkspaceError("The website link can use only lowercase letters, numbers and dashes (for example: consent).");
    if (slug) {
      const [taken] = await d.select({ id: intakeDocuments.id }).from(intakeDocuments).where(eq(intakeDocuments.publicSlug, slug)).limit(1);
      if (taken && taken.id !== input.id) throw new WorkspaceError(`Another form already uses the website link "${slug}".`);
    }
    settings.publicSlug = slug;
  }
  if (input.id) {
    const [cur] = await d.select().from(intakeDocuments).where(eq(intakeDocuments.id, input.id)).limit(1);
    if (!cur) throw new WorkspaceError("Form not found.", "NOT_FOUND");
    // The Yes/No questions are part of the wording patients sign: changing them makes a new version too.
    const changed = stableStringify(cur.title) !== stableStringify(title) || stableStringify(cur.body) !== stableStringify(body)
      || (settings.choices !== undefined && stableStringify(cleanChoices(cur.choices)) !== stableStringify(settings.choices ?? []));
    await d.update(intakeDocuments).set({ title, body, active: input.active, version: changed ? cur.version + 1 : cur.version, updatedByUserId: actor.id, ...settings }).where(eq(intakeDocuments.id, cur.id));
    const what = [
      changed ? `updated (v${cur.version + 1})` : null,
      cur.active !== input.active ? (input.active ? "turned on" : "turned off") : null,
      settings.consentKind !== undefined && settings.consentKind !== (cur.consentKind ?? null) ? `records ${settings.consentKind ? CONSENT_LABELS[settings.consentKind] : "no consent"}` : null,
      settings.publicSlug !== undefined && settings.publicSlug !== (cur.publicSlug ?? null) ? (settings.publicSlug ? `website link /sign/${settings.publicSlug}` : "website link removed") : null,
    ].filter(Boolean).join(", ") || "saved";
    await audit(actor, "manage_playbook", { entityType: "intakeDocument", entityId: cur.id, description: `Patient form "${title.en}" ${what}` });
    return { id: cur.id };
  }
  const res = await d.insert(intakeDocuments).values({ title, body, active: input.active, updatedByUserId: actor.id, ...settings });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  await audit(actor, "manage_playbook", { entityType: "intakeDocument", entityId: id, description: `Patient form "${title.en}" added` });
  return { id };
}

/** Load forms by English title (adds new ones, updates changed ones). Used by an IAM-only Lambda job. */
export async function importDocuments(docs: { title: Record<string, string>; body: Record<string, string>; active?: boolean; consentKind?: string | null; publicSlug?: string | null; choices?: unknown[] | null }[]) {
  const actor = { ...(await filingActor(null)), name: "Form library import" };
  const existing = await listDocuments(true);
  const out: { title: string; id: number; action: "added" | "updated" }[] = [];
  for (const doc of docs.slice(0, 20)) {
    const cur = existing.find((x) => (x.title.en ?? "").trim().toLowerCase() === (doc.title?.en ?? "").trim().toLowerCase());
    const r = await saveDocument(actor, {
      id: cur?.id ?? null, title: doc.title ?? {}, body: doc.body ?? {}, active: doc.active ?? cur?.active ?? true,
      consentKind: doc.consentKind === undefined ? undefined : isConsentKind(doc.consentKind) ? doc.consentKind : null,
      publicSlug: doc.publicSlug,
      choices: doc.choices,
    });
    out.push({ title: doc.title?.en ?? "", id: r.id, action: cur ? "updated" : "added" });
  }
  return { ok: true, docs: out };
}

/** Forms staff can pick when sending: the built-in health history + every active agreement. */
export async function formChoices() {
  const docs = await listDocuments();
  return [
    { key: MEDICAL_INTAKE_KEY, title: MEDICAL_INTAKE.title.en, builtIn: true, langs: ["en", "es", "ar"] as string[], consentKind: null as ConsentKind | null },
    ...docs.map((x) => ({ key: x.key, title: x.title.en ?? "Form", builtIn: false, langs: Object.keys(x.body), consentKind: x.consentKind })),
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
  // Any staff member can send forms to any patient; the packet belongs to the patient's clinic.
  let clinicId = care?.clinicId ?? input.clinicId ?? null;
  if (!clinicId && input.bookingRequestId) clinicId = (await d.select({ c: bookingRequests.clinicId }).from(bookingRequests).where(eq(bookingRequests.id, input.bookingRequestId)).limit(1))[0]?.c ?? null;
  clinicId = clinicId ?? actor.clinicIds?.[0] ?? null;
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

/** The wording that was signed, as kept with the signature (plus any Yes/No questions and the answers given). */
interface SignedText { title: string; body: string; language?: string; choices?: { kind: ConsentKind; title: string; body: string; answer: ChoiceAnswer }[] }

/** Any staff member can open any patient's forms (2026-10-01); the inbox lists are scoped below. */
async function packetOr404(id: number, _actor: WorkspaceActor) {
  const [p] = await (await db()).select().from(intakePackets).where(eq(intakePackets.id, id)).limit(1);
  if (!p) throw new WorkspaceError("Those forms weren't found.", "NOT_FOUND");
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

/** Rows in the staff lists. Signed forms are kept for good: nothing drops off by age, and search covers every year. */
async function packetRows(where: SQL | undefined, limit: number) {
  const d = await db();
  const rows = await d.select({ p: intakePackets, clinicName: clinics.name, createdBy: users.name }).from(intakePackets)
    .leftJoin(clinics, eq(clinics.id, intakePackets.clinicId)).leftJoin(users, eq(users.id, intakePackets.createdByUserId))
    .where(where).orderBy(desc(intakePackets.createdAt)).limit(limit);
  const ids = rows.map((r) => r.p.id);
  const signed = ids.length ? await d.select({ packetId: intakeSignatures.packetId, formKey: intakeSignatures.formKey, decision: intakeSignatures.decision }).from(intakeSignatures).where(inArray(intakeSignatures.packetId, ids)) : [];
  const titles = new Map((await listDocuments(true)).map((x) => [x.key, x.title.en ?? "Form"]));
  titles.set(MEDICAL_INTAKE_KEY, MEDICAL_INTAKE.title.en);
  return rows.map(({ p, clinicName, createdBy }) => ({
    id: p.id, name: p.name, subjectKey: p.subjectKey, patientId: p.patientId, language: p.language, status: p.status as PacketStatus, source: p.source as PacketSource,
    expired: OPEN_PACKET.includes(p.status as PacketStatus) && isExpired(p), expiresAt: p.expiresAt,
    forms: (p.forms as string[]).map((k) => {
      const s = signed.find((x) => x.packetId === p.id && x.formKey === k);
      return { key: k, title: titles.get(k) ?? "Form", signed: !!s, declined: s?.decision === "declined" };
    }),
    sentVia: p.sentVia, sentAt: p.sentAt, sendCount: p.sendCount, openedAt: p.openedAt, completedAt: p.completedAt, filedAt: p.filedAt, createdAt: p.createdAt,
    hasPhone: !!p.phone, hasEmail: !!p.email, phoneLast4: p.phone?.slice(-4) ?? null, clinicName, createdBy, locked: !!p.lockedUntil && p.lockedUntil.getTime() > Date.now(),
  }));
}

/** A website visitor who opened a form but didn't finish isn't anyone's to-do: hide those. */
const notAbandonedWebsite = not(and(eq(intakePackets.source, "website"), inArray(intakePackets.status, OPEN_PACKET))!);

export async function listPackets(actor: WorkspaceActor, filter: PacketFilter, q?: string | null) {
  const conds: (SQL | undefined)[] = [packetScope(actor), notAbandonedWebsite];
  if (filter === "waiting") conds.push(inArray(intakePackets.status, OPEN_PACKET));
  else if (filter === "to_file") conds.push(eq(intakePackets.status, "completed"));
  else if (filter === "filed") conds.push(eq(intakePackets.status, "filed"));
  const words = (q ?? "").replace(/[%_\\]/g, " ").trim().split(/[\s,]+/).filter((w) => w.length >= 2).slice(0, 4);
  for (const w of words) conds.push(like(intakePackets.name, `%${w}%`));
  return packetRows(and(...conds), words.length ? 200 : 400);
}

/** Every form a person was sent or signed (all years), newest first, plus where each consent stands. */
export async function subjectForms(actor: WorkspaceActor, subjectKey: string) {
  const d = await db();
  const pid = /^p:(\d+)$/.exec(subjectKey)?.[1];
  const who = pid ? or(eq(intakePackets.subjectKey, subjectKey), eq(intakePackets.patientId, Number(pid))) : eq(intakePackets.subjectKey, subjectKey);
  // A patient's own Forms tab shows everything sent to them, whichever office sent it.
  const packets = await packetRows(who, 100);
  const ids = packets.map((p) => p.id);
  const sigRows = ids.length ? await d.select({ packetId: intakeSignatures.packetId, kind: intakeSignatures.consentKind, decision: intakeSignatures.decision, choices: intakeSignatures.choices, at: intakeSignatures.signedAt, title: intakeSignatures.formTitle })
    .from(intakeSignatures).where(and(inArray(intakeSignatures.packetId, ids), sql`(${intakeSignatures.consentKind} IS NOT NULL OR ${intakeSignatures.choices} IS NOT NULL)`)).orderBy(desc(intakeSignatures.signedAt)) : [];
  // Every program answer on a form, newest first (a form's own yes/no, and each Yes/No question in it).
  const answers = sigRows.flatMap((s) => answersOf({ consentKind: s.kind, decision: s.decision, choices: s.choices }).map((a) => ({ ...a, packetId: s.packetId, at: s.at, title: s.title })));
  const [pt] = pid ? await d.select({
    ccm: patients.consentStatus, ccmAt: patients.ccmConsentDate, bhi: patients.bhiConsentStatus, bhiAt: patients.bhiConsentDate,
    apcm: patients.apcmConsentStatus, apcmAt: patients.apcmConsentDate, rpm: patients.rpmConsentStatus, rpmAt: patients.rpmConsentDate,
  }).from(patients).where(eq(patients.id, Number(pid))).limit(1) : [];
  const enrollments = await enrollmentsForSubject(subjectKey);
  const consents = (["communications", "ccm", "apcm", "bhi", "rpm"] as ConsentKind[]).map((kind) => {
    const last = answers.find((a) => a.kind === kind);
    const status = kind === "communications" ? null : pt?.[kind];
    const since = kind === "communications" ? null : pt?.[`${kind}At` as "ccmAt"];
    return {
      kind, label: CONSENT_LABELS[kind],
      /** What the patient record says (CCM / APCM / BHI / RPM); null for communications or people not on the roster. */
      status: status ?? null, since: since ?? null,
      lastForm: last ? { packetId: last.packetId, decision: (last.answer === "no" ? "declined" : "signed") as SignDecision, at: last.at, title: last.title } : null,
      /** After a Yes: enrolled automatically, or waiting (and why). */
      enrollment: (enrollments as Record<string, { status: "waiting" | "enrolled"; note: string | null; enrolledAt: Date | null }>)[kind] ?? null,
    };
  });
  return { packets, consents };
}

/** The Patient forms inbox: clinic-limited staff see their office's forms, plus any they sent themselves. */
const packetScope = (actor: WorkspaceActor) =>
  actor.clinicIds ? or(actor.clinicIds.length ? inArray(intakePackets.clinicId, actor.clinicIds) : sql`1 = 0`, eq(intakePackets.createdByUserId, actor.id)) : undefined;

export async function packetStats(actor: WorkspaceActor) {
  const d = await db();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await d.select({ status: intakePackets.status, createdAt: intakePackets.createdAt, sentAt: intakePackets.sentAt, completedAt: intakePackets.completedAt, expiresAt: intakePackets.expiresAt })
    .from(intakePackets).where(and(sql`${intakePackets.createdAt} >= ${since}`, packetScope(actor), notAbandonedWebsite));
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
    source: p.source as PacketSource,
    expired: OPEN_PACKET.includes(p.status as PacketStatus) && isExpired(p), expiresAt: p.expiresAt, createdAt: p.createdAt, sentAt: p.sentAt, openedAt: p.openedAt, completedAt: p.completedAt, filedAt: p.filedAt,
    clinic, taskId: p.taskId,
    forms: (p.forms as string[]).map((k) => ({ key: k, title: k === MEDICAL_INTAKE_KEY ? MEDICAL_INTAKE.title.en : docs.get(k)?.title.en ?? "Form", kind: k === MEDICAL_INTAKE_KEY ? "questionnaire" as const : "agreement" as const })),
    answers: ((p.answers ?? {}) as Record<string, Answers>)[MEDICAL_INTAKE_KEY] ?? {},
    signatures: sigs.map((s) => ({
      formKey: s.formKey, formTitle: s.formTitle, language: s.language, formVersion: s.formVersion, signerName: s.signerName, signerRelation: s.signerRelation,
      relationLabel: RELATION_LABELS[s.signerRelation as SignerRelation]?.en ?? s.signerRelation, method: s.method, signatureFileId: s.signatureFileId,
      decision: s.decision as SignDecision, consentKind: isConsentKind(s.consentKind) ? s.consentKind : null,
      authority: s.signerAuthority as SignerAuthority | null, authorityLabel: s.signerAuthority ? AUTHORITY_LABELS[s.signerAuthority as SignerAuthority]?.en ?? s.signerAuthority : null, authorityNote: s.authorityNote,
      signedAt: s.signedAt, ip: s.ip, userAgent: s.userAgent, textHash: s.textHash, docHash: s.docHash,
      text: s.formKey === MEDICAL_INTAKE_KEY ? null : (JSON.parse(s.snapshot) as SignedText),
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

/** Forms that came in without a match (e.g. from the website): say whose they are. Consents then apply to that patient. */
export async function linkPacket(actor: WorkspaceActor, id: number, subjectKey: string) {
  const p = await packetOr404(id, actor);
  const care = await subjectCare(subjectKey);
  if (!care) throw new WorkspaceError("That patient wasn't found.", "NOT_FOUND");
  const d = await db();
  await d.update(intakePackets).set({ subjectKey, patientId: care.patientId, clinicId: p.clinicId ?? care.clinicId }).where(eq(intakePackets.id, id));
  if (p.taskId) await d.update(workTasks).set({ patientId: care.patientId }).where(eq(workTasks.id, p.taskId));
  await logEvent(id, "linked", { userId: actor.id, detail: care.name.slice(0, 120) });
  await audit(actor, "update_patient", { entityType: "intakePacket", entityId: id, description: "Patient forms linked to a patient" });
  const applied = await applyPacketConsents(id, actor);
  return { ok: true, applied };
}

/**
 * The program answers in one signature: a consent form's own yes/no (signed = yes, declined = no) and every
 * Yes/No question inside it.
 */
function answersOf(sig: { consentKind: string | null; decision: string; choices: unknown }): { kind: ConsentKind; answer: ChoiceAnswer }[] {
  const out: { kind: ConsentKind; answer: ChoiceAnswer }[] = [];
  if (isConsentKind(sig.consentKind)) out.push({ kind: sig.consentKind, answer: sig.decision === "declined" ? "no" : "yes" });
  const c = (sig.choices && typeof sig.choices === "object" ? sig.choices : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(c)) if (isConsentKind(k) && (v === "yes" || v === "no")) out.push({ kind: k, answer: v });
  return out;
}

/**
 * Everything the patient agreed to or declined in this packet → their consent status, and (for Yes) enrollment
 * when they qualify. Only for packets that belong to someone: an unverified website form waits for staff to link it.
 */
async function applyPacketConsents(packetId: number, actor: WorkspaceActor | null, onlyFormKey?: string) {
  const d = await db();
  const [p] = await d.select().from(intakePackets).where(eq(intakePackets.id, packetId)).limit(1);
  if (!p?.subjectKey) return [];
  const sigs = await d.select().from(intakeSignatures)
    .where(onlyFormKey ? and(eq(intakeSignatures.packetId, packetId), eq(intakeSignatures.formKey, onlyFormKey)) : eq(intakeSignatures.packetId, packetId))
    .orderBy(asc(intakeSignatures.signedAt));
  const notes: string[] = [];
  for (const s of sigs) {
    for (const a of answersOf(s)) {
      const e: ConsentEvent = { ...a, at: s.signedAt, packetId, subjectKey: p.subjectKey, patientId: p.patientId, name: p.name, dob: p.dob };
      try {
        const note = await recordConsent(e, actor);
        if (note) notes.push(note);
      } catch (err) {
        console.error("[patient-forms] consent update failed:", (err as Error).message);
      }
    }
  }
  if (notes.length) await logEvent(packetId, "consents", { detail: notes.join("; ") });
  return notes;
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

const isLocked = (p: { lockedUntil: Date | null }) => !!p.lockedUntil && p.lockedUntil.getTime() > Date.now();
/** A finished packet can still be opened (date of birth again) to see or save a copy, until its link expires. */
const copyOpen = (p: typeof intakePackets.$inferSelect) => (p.status === "completed" || p.status === "filed") && !isExpired(p) && !isLocked(p);

export async function patientVerify(token: string, dob: string | null, meta: ClientMeta) {
  const p = await byToken(token);
  const state = stateOf(p);
  if (!p || (state !== "ok" && !copyOpen(p))) return { ok: false as const, state: p && state === "done" && isLocked(p) ? "locked" as const : state, triesLeft: 0 };
  const d = await db();
  if (!dob || dob !== p.dob) {
    const tries = p.failedDobAttempts + 1;
    const lock = tries >= MAX_DOB_TRIES;
    await d.update(intakePackets).set({ failedDobAttempts: lock ? 0 : tries, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null }).where(eq(intakePackets.id, p.id));
    await logEvent(p.id, lock ? "locked" : "dob_failed", { meta, detail: lock ? `${MAX_DOB_TRIES} wrong dates of birth: locked ${LOCK_MINUTES} min` : `attempt ${tries}` });
    return { ok: false as const, state: lock ? ("locked" as const) : ("ok" as const), triesLeft: lock ? 0 : MAX_DOB_TRIES - tries };
  }
  if (p.failedDobAttempts) await d.update(intakePackets).set({ failedDobAttempts: 0 }).where(eq(intakePackets.id, p.id));
  await logEvent(p.id, state === "done" ? "dob_ok_copy" : "dob_ok", { meta });
  return { ok: true as const, state, session: await sessionFor(p), packet: await payload(p) };
}

const sessionFor = (p: typeof intakePackets.$inferSelect) =>
  new SignJWT({ pid: p.id, th: p.tokenHash.slice(0, 16), purpose: "patient-forms" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime(SESSION_TTL).sign(secret());

/** The packet behind a patient session. Finished packets are only reachable for their copy (allowDone). */
async function fromSession(session: string, allowDone = false) {
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
  if (state === "done") {
    // The session (4 hours) proves they passed the date-of-birth check or just signed: the copy stays available to it.
    if (allowDone) return p;
    throw new PatientFormError("done");
  }
  if (state !== "ok") throw new PatientFormError(state);
  return p;
}

/** What the patient's page needs after the date-of-birth check. */
async function payload(p: typeof intakePackets.$inferSelect) {
  const d = await db();
  const sigs = await d.select({ formKey: intakeSignatures.formKey, signerName: intakeSignatures.signerName, signedAt: intakeSignatures.signedAt, decision: intakeSignatures.decision }).from(intakeSignatures).where(eq(intakeSignatures.packetId, p.id));
  const photos = await d.select({ kind: intakeFiles.kind }).from(intakeFiles).where(eq(intakeFiles.packetId, p.id));
  const docs = new Map((await listDocuments(true)).map((x) => [x.key, x]));
  const forms = (p.forms as string[]).map((k) => {
    const sig = sigs.find((s) => s.formKey === k);
    const done = { signed: !!sig, declined: sig?.decision === "declined", signedAt: sig?.signedAt ?? null };
    if (k === MEDICAL_INTAKE_KEY) return { key: k, kind: "questionnaire" as const, version: MEDICAL_INTAKE.version, ...done, canDecline: false, doc: null };
    const doc = docs.get(k);
    // Consents are a choice: the patient may say no. Other agreements must be signed.
    return {
      key: k, kind: "agreement" as const, version: doc?.version ?? 0, ...done, canDecline: !!doc?.consentKind && !doc.choices.length,
      doc: doc ? { title: doc.title, body: doc.body, choices: doc.choices } : null,
    };
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
  /** "declined" = the patient says no to a consent (typed name only). */
  decision?: SignDecision;
  /** Someone else answering an agreement for the patient: their legal authority. */
  authority?: SignerAuthority | null;
  authorityNote?: string | null;
  /** Answers to the form's Yes/No consent questions ({ ccm: "yes", rpm: "no", … }). Every question must be answered. */
  choices?: Record<string, string> | null;
}

/** Sign (or decline) one form. The questionnaire must be complete; an agreement must be the version the patient read. */
export async function patientSign(session: string, input: SignInput, meta: ClientMeta) {
  const p = await fromSession(session);
  const d = await db();
  if (!input.esignConsent) throw new PatientFormError("consent");
  if (!(p.forms as string[]).includes(input.formKey)) throw new PatientFormError("bad");
  const signerName = input.signerName.replace(/[\r\n<>]/g, " ").trim().slice(0, 160);
  if (signerName.length < 2) throw new PatientFormError("name");
  if (!SIGNER_RELATIONS.includes(input.relation)) throw new PatientFormError("bad");
  const decision: SignDecision = input.decision === "declined" ? "declined" : "signed";
  if (decision === "declined" && input.method !== "typed") throw new PatientFormError("bad");
  // Only the patient or their legal representative can agree to (or turn down) an agreement for them.
  let authority: SignerAuthority | null = null, authorityNote: string | null = null;
  if (needsAuthority(input.formKey, input.relation)) {
    if (!input.authority || !SIGNER_AUTHORITIES.includes(input.authority)) throw new PatientFormError("authority");
    authority = input.authority;
    authorityNote = input.authorityNote?.replace(/[\r\n<>]/g, " ").trim().slice(0, 160) || null;
    if (authority === "other" && (authorityNote?.length ?? 0) < 3) throw new PatientFormError("authority_note");
  }
  const lang: IntakeLang = isIntakeLang(input.language) ? input.language : "en";
  const [already] = await d.select({ id: intakeSignatures.id }).from(intakeSignatures).where(and(eq(intakeSignatures.packetId, p.id), eq(intakeSignatures.formKey, input.formKey))).limit(1);
  if (already) return patientAfterSign(p.id);

  let formTitle: string, formVersion: number, snapshot: string, consentKind: ConsentKind | null = null;
  let answers: Record<string, ChoiceAnswer> | null = null;
  if (input.formKey === MEDICAL_INTAKE_KEY) {
    if (decision === "declined") throw new PatientFormError("bad");
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
    consentKind = isConsentKind(doc.consentKind) ? doc.consentKind : null;
    // Only consents are optional; practice agreements (e.g. a treatment agreement) must be signed.
    if (decision === "declined" && !consentKind) throw new PatientFormError("bad");
    const text = agreementIn({ title: doc.title, body: doc.body }, lang);
    formTitle = text.title;
    formVersion = doc.version;
    const choices = cleanChoices(doc.choices);
    if (choices.length) {
      // A form with Yes/No questions is signed (never declined as a whole); every question needs an answer.
      if (decision === "declined") throw new PatientFormError("bad");
      answers = {};
      for (const c of choices) {
        const a = input.choices?.[c.kind];
        if (a !== "yes" && a !== "no") throw new PatientFormError("choices");
        answers[c.kind] = a;
      }
      // What they read and what they answered, in the language they read it.
      const shown = choices.map((c) => { const t = choiceIn(c, lang); return { kind: c.kind, title: t.title, body: t.body, answer: answers![c.kind] }; });
      snapshot = JSON.stringify({ title: text.title, body: text.body, language: text.lang, choices: shown });
    } else {
      snapshot = JSON.stringify({ title: text.title, body: text.body, language: text.lang });
    }
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
  // Older signatures hashed only the original fields; the new ones are added only when present, so those hashes still match.
  const docHash = sha256(stableStringify({
    packetId: p.id, formKey: input.formKey, formVersion, language: lang, textHash, signerName, relation: input.relation, method: input.method, signatureHash, signedAt: signedAt.toISOString(), ip,
    ...(decision === "declined" ? { decision } : {}), ...(authority ? { authority, authorityNote } : {}), ...(consentKind ? { consentKind } : {}),
    ...(answers ? { choices: answers } : {}),
  }));
  await d.insert(intakeSignatures).values({
    packetId: p.id, formKey: input.formKey, formTitle: formTitle.slice(0, 255), language: lang, formVersion, snapshot, textHash, signerName, signerRelation: input.relation,
    signerAuthority: authority, authorityNote, decision, consentKind, choices: answers, method: input.method, signatureFileId, signedAt, ip, userAgent, docHash,
  });
  const by = input.relation === "self" ? "" : ` · by ${input.relation}${authority ? ` (${authority})` : ""}`;
  await logEvent(p.id, decision === "declined" ? "declined" : "signed", { meta, detail: `${formTitle.slice(0, 120)} · ${decision === "declined" ? "said no" : input.method}${by}` });
  if (p.status === "waiting" || p.status === "opened") await d.update(intakePackets).set({ status: "in_progress" }).where(eq(intakePackets.id, p.id));
  // A consent takes effect when it's signed, not when the rest of the forms are done.
  if (consentKind || answers) await applyPacketConsents(p.id, null, input.formKey);
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
        p.source === "website" ? `${p.name} signed a form on the website.` : `${p.name} finished their forms (${(p.forms as string[]).length}).`,
        p.patientId || p.subjectKey ? null
          : p.source === "website" ? "We couldn't match them to a patient: open it and click \"Link to patient\" (or add them in Practice Fusion first if they're new)."
          : "New patient: add them in Practice Fusion first.",
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

// ---------------------------------------------------------------------------
// The patient's own copy (right after signing, or later from the same link + date of birth)
// ---------------------------------------------------------------------------

export async function patientCopy(session: string, meta: ClientMeta) {
  const p = await fromSession(session, true);
  const d = await db();
  const sigs = await d.select().from(intakeSignatures).where(eq(intakeSignatures.packetId, p.id)).orderBy(asc(intakeSignatures.signedAt));
  const drawnIds = sigs.map((s) => s.signatureFileId).filter((x): x is number => !!x);
  const drawn = drawnIds.length ? await d.select({ id: intakeFiles.id, mime: intakeFiles.mime, data: intakeFiles.data }).from(intakeFiles).where(and(eq(intakeFiles.packetId, p.id), inArray(intakeFiles.id, drawnIds), eq(intakeFiles.kind, "signature"))) : [];
  await logEvent(p.id, "copy_viewed", { meta });
  const order = p.forms as string[];
  return {
    name: p.name, dob: p.dob, language: p.language, completedAt: p.completedAt, clinic: await publicClinic(p.clinicId),
    answers: ((p.answers ?? {}) as Record<string, Answers>)[MEDICAL_INTAKE_KEY] ?? {},
    forms: sigs.sort((a, b) => order.indexOf(a.formKey) - order.indexOf(b.formKey)).map((s) => {
      const file = drawn.find((f) => f.id === s.signatureFileId);
      return {
        key: s.formKey, kind: s.formKey === MEDICAL_INTAKE_KEY ? "questionnaire" as const : "agreement" as const, title: s.formTitle, language: s.language,
        decision: s.decision as SignDecision, signerName: s.signerName, relation: s.signerRelation as SignerRelation, authority: s.signerAuthority as SignerAuthority | null,
        authorityNote: s.authorityNote, method: s.method, signedAt: s.signedAt, signature: file ? `data:${file.mime};base64,${file.data}` : null, docHash: s.docHash,
        text: s.formKey === MEDICAL_INTAKE_KEY ? null : (JSON.parse(s.snapshot) as SignedText),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Open website links: mypcpcare.com/sign/<slug> (no link was sent, so the person tells us who they are)
// ---------------------------------------------------------------------------

async function publicDoc(slug: string) {
  if (!PUBLIC_SLUG_RE.test(slug)) return null;
  const [doc] = await (await db()).select().from(intakeDocuments).where(and(eq(intakeDocuments.publicSlug, slug), eq(intakeDocuments.active, true))).limit(1);
  return doc ?? null;
}

/** What the website page shows before anyone types anything: the form's title and the offices. Nothing about patients. */
export async function publicFormInfo(slug: string) {
  const doc = await publicDoc(slug);
  if (!doc) return { ok: false as const };
  const offices = await (await db()).select({ id: clinics.id, name: clinics.name, phone: clinics.phone }).from(clinics).orderBy(asc(clinics.name));
  return { ok: true as const, title: doc.title, langs: Object.keys(doc.body), offices };
}

export interface PublicStartInput {
  firstName: string;
  lastName: string;
  dob: string | null;
  phone: string;
  email?: string | null;
  language: IntakeLang;
  clinicId?: number | null;
}

/** Every phone number we have for a person (roster, schedule, Practice Fusion), normalized. */
async function phonesOnFile(subjectKey: string): Promise<string[]> {
  const d = await db();
  const out: (string | null | undefined)[] = [];
  const pid = /^p:(\d+)$/.exec(subjectKey)?.[1];
  if (pid) out.push((await d.select({ phone: patients.phoneNumber }).from(patients).where(eq(patients.id, Number(pid))).limit(1))[0]?.phone);
  out.push((await loadScheduleSubjects()).get(subjectKey)?.phone);
  const f = await d.select({ phone: fhirPatients.phone }).from(fhirPatients).where(pid ? eq(fhirPatients.patientId, Number(pid)) : eq(fhirPatients.subjectKey, subjectKey)).limit(3);
  out.push(...f.map((x) => x.phone));
  return out.map((x) => normalizePhone(x ?? null)).filter((x): x is string => !!x);
}

/**
 * Someone on the website starts a form: we record who they say they are and hand back a session to read and
 * sign. A name + date of birth is easy for someone else to know, so they're linked to a patient only when the
 * phone number they give ALSO matches the one on file (and they're never told either way). Everyone else is
 * linked by the front desk, and only then do their consents change the patient's record.
 */
export async function patientStartPublic(slug: string, input: PublicStartInput, meta: ClientMeta) {
  const doc = await publicDoc(slug);
  if (!doc) throw new PatientFormError("not_found");
  const clean = (s: string) => s.replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  const first = clean(input.firstName), last = clean(input.lastName);
  if (first.length < 1 || last.length < 1) throw new PatientFormError("name");
  if (!input.dob) throw new PatientFormError("dob");
  const phone = normalizePhone(input.phone);
  if (!phone) throw new PatientFormError("phone");
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new PatientFormError("email");
  const d = await db();
  const name = `${first} ${last}`;
  const people = Array.from((await buildNameDobIndex()).entries()).map(([k, v]) => ({ ...v, dob: k.split("|")[1] ?? null }));
  const match = matchFaxPatient(name, input.dob, people);
  const subjectKey = match?.sure && (await phonesOnFile(match.person.key)).includes(phone) ? match.person.key : null;
  const care = subjectKey ? await subjectCare(subjectKey) : null;
  let clinicId = input.clinicId ?? null;
  if (clinicId) clinicId = (await d.select({ id: clinics.id }).from(clinics).where(eq(clinics.id, clinicId)).limit(1))[0]?.id ?? null;
  clinicId = clinicId ?? care?.clinicId ?? null;
  const token = randomBytes(24).toString("base64url");
  const now = new Date();
  const res = await d.insert(intakePackets).values({
    tokenHash: sha256(token), tokenSealed: sealSecret(token), subjectKey, patientId: care?.patientId ?? null, name, dob: input.dob, phone, email,
    language: input.language, forms: [docKey(doc.id)], clinicId, status: "opened", openedAt: now, source: "website",
    expiresAt: new Date(now.getTime() + WEBSITE_PACKET_HOURS * 3_600_000),
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  await logEvent(id, "created", { meta, detail: `website: /sign/${slug}` });
  const [p] = await d.select().from(intakePackets).where(eq(intakePackets.id, id)).limit(1);
  return { session: await sessionFor(p!), packet: await payload(p!) };
}

async function filingActor(userId: number | null): Promise<WorkspaceActor> {
  const d = await db();
  const [u] = userId ? await d.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1) : [];
  const [admin] = u ? [u] : await d.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  if (!admin) throw new Error("No user to file patient forms under.");
  return { id: admin.id, name: "Patient forms", role: "admin", clinicIds: null };
}

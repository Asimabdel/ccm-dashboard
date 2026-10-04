// Patient texts on the practice's main number (2026-10-04, the practice's choices): one shared inbox in
// Messages; each conversation goes to the patient's clinic (that clinic's front desk, MAs and office manager,
// and the admins); a number nobody's matched yet is seen by everyone who handles texts; texts that come in
// after hours get one automatic reply (English / Spanish).
//
// RingCentral (BAA in place) is reached through the allowlist relay. Sending: the SMS API, as the RingCentral
// user who owns the texting number (the server app already connected for the call log, or that user's own
// sign-in key). Receiving: MyPCP reads that user's message store every minute (and right away while someone
// has the inbox open). Pictures (MMS) stay in RingCentral. A patient who texts STOP gets nothing more until
// they text START; a patient who said No to texts on a consent form isn't texted first.
import { and, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, clinics, fhirPatients, patients, textMessages, textThreads, users } from "../drizzle/schema";
import { WorkspaceError, audit, loadScheduleSubjects, opportunityScope, subjectCare, type WorkspaceActor } from "./workspaceDb";
import { relayFetch } from "./egress";
import { serverCredentials, tokenFor } from "./faxSendDb";
import { openSecret, sealSecret } from "./secretBox";
import { formatPhone, normalizePhone } from "../shared/phone";
import {
  AUTO_REPLY_EVERY_HOURS, DEFAULT_TEXTING, MAX_TEXT_LENGTH, autoReplyText, isAfterHours, isStartText, isStopText, textStatusFrom,
  type TextFilter, type TextingSettings,
} from "../shared/texts";
import { can, nameKey } from "../shared/workspace";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

// Local development can point at a stand-in RingCentral (never on AWS).
const API = !process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.RINGCENTRAL_API_BASE ? process.env.RINGCENTRAL_API_BASE.replace(/\/$/, "") : "https://platform.ringcentral.com";
const SETTINGS_KEY = "texting";
const CURSOR_KEY = "texting_sync";
const insertId = (res: unknown) => Number((res as [{ insertId: number }])[0]?.insertId);
const e164 = (ten: string) => `+1${ten}`;

// ---------------------------------------------------------------------------
// Settings (Admin → Integrations)
// ---------------------------------------------------------------------------

async function readSetting<T>(key: string): Promise<T | null> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return (row?.value ?? null) as T | null;
}
async function writeSetting(key: string, value: unknown, userId: number | null) {
  await (await db()).insert(appSettings).values({ key, value, updatedByUserId: userId }).onDuplicateKeyUpdate({ set: { value, updatedByUserId: userId } });
}

export async function textingSettings(): Promise<TextingSettings> {
  const v = (await readSetting<Partial<TextingSettings>>(SETTINGS_KEY)) ?? {};
  return {
    ...DEFAULT_TEXTING, ...v,
    hours: { ...DEFAULT_TEXTING.hours, ...(v.hours ?? {}) },
    autoReply: { ...DEFAULT_TEXTING.autoReply, ...(v.autoReply ?? {}) },
  };
}

/** What the admin screen shows (never the sign-in key itself). */
export async function textingSetup() {
  const s = await textingSettings();
  const creds = await serverCredentials().catch(() => null);
  const sync = await readSetting<{ ranAt?: string; from?: string; error?: string | null; received?: number }>(CURSOR_KEY);
  return {
    connected: !!creds, enabled: s.enabled, extensionId: s.extensionId, extensionName: s.extensionName, number: s.number, ownKey: !!s.jwtEnc,
    hours: s.hours, autoReply: s.autoReply, lastSync: sync?.ranAt ?? null, lastError: sync?.error ?? null,
  };
}

export async function saveTextingSettings(actor: WorkspaceActor, input: {
  enabled: boolean; extensionId?: string | null; extensionName?: string | null; number?: string | null; jwt?: string | null; clearKey?: boolean;
  hours: { days: number[]; start: string; end: string }; autoReply: { enabled: boolean; en: string; es: string };
}) {
  if (actor.role !== "admin") throw new WorkspaceError("Only an admin can set up patient texting.", "FORBIDDEN");
  const prev = await textingSettings();
  const number = normalizePhone(input.number ?? null);
  if (input.enabled && !number) throw new WorkspaceError("Pick the number patients will text.");
  if (!/^\d{2}:\d{2}$/.test(input.hours.start) || !/^\d{2}:\d{2}$/.test(input.hours.end) || input.hours.start >= input.hours.end) throw new WorkspaceError("Office hours need a start before the end (e.g. 09:00 to 17:00).");
  const en = input.autoReply.en.trim().slice(0, MAX_TEXT_LENGTH), es = input.autoReply.es.trim().slice(0, MAX_TEXT_LENGTH);
  if (input.autoReply.enabled && (!en || !es)) throw new WorkspaceError("Write the after-hours reply in English and Spanish.");
  const next: TextingSettings = {
    enabled: input.enabled,
    extensionId: input.extensionId?.trim() || null,
    extensionName: input.extensionName?.trim().slice(0, 120) || null,
    number,
    // Blank = keep the stored key (the screen never shows it).
    jwtEnc: input.clearKey ? null : input.jwt?.trim() ? sealSecret(input.jwt.trim()) : prev.jwtEnc,
    hours: { days: Array.from(new Set(input.hours.days.filter((d) => d >= 0 && d <= 6))).sort(), start: input.hours.start, end: input.hours.end },
    autoReply: { enabled: input.autoReply.enabled, en: en || DEFAULT_TEXTING.autoReply.en, es: es || DEFAULT_TEXTING.autoReply.es },
  };
  if (next.enabled && !next.extensionId && !next.jwtEnc) throw new WorkspaceError("Pick which RingCentral user's number patients text.");
  await writeSetting(SETTINGS_KEY, next, actor.id);
  await audit(actor, "manage_access", { entityType: "integration", description: `Patient texting ${next.enabled ? `on (${formatPhone(next.number)})` : "off"}` });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// RingCentral
// ---------------------------------------------------------------------------

async function sender(s: TextingSettings) {
  if (!s.enabled || !s.number || (!s.extensionId && !s.jwtEnc)) throw new WorkspaceError("Patient texting isn't set up yet. An admin picks the texting number in Admin → Integrations.");
  const creds = await serverCredentials();
  if (s.jwtEnc) return { token: await tokenFor({ clientId: creds.clientId, clientSecret: creds.clientSecret, jwt: openSecret(s.jwtEnc) }), ext: "~" };
  return { token: await tokenFor(creds), ext: s.extensionId! };
}

function rcProblem(status: number, body: { message?: string; errorCode?: string; errors?: { message?: string; errorCode?: string }[] }) {
  const msg = body.errors?.[0]?.message ?? body.message ?? "";
  if (status === 403 || status === 401) return `RingCentral didn't allow it (${msg || status}). The RingCentral app needs the SMS and Read Messages permissions, and the number must be text-enabled and registered for business texting.`;
  return `RingCentral ${status}: ${msg || "error"}`;
}

async function rc<T>(token: string, path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const res = await relayFetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; errorCode?: string; errors?: { message?: string }[] };
  if (!res.ok) throw new WorkspaceError(rcProblem(res.status, body));
  return body;
}

/** Text-capable numbers in the RingCentral account and whose they are (to pick the texting number). */
export async function textingNumbers() {
  const token = await tokenFor(await serverCredentials());
  const names = new Map<string, string>();
  for (let page = 1; page <= 5; page++) {
    const r = await rc<{ records?: { id: number; name?: string; extensionNumber?: string; status?: string }[]; navigation?: { nextPage?: unknown } }>(token, `/restapi/v1.0/account/~/extension?perPage=1000&page=${page}`);
    for (const e of r.records ?? []) if (e.status !== "Disabled") names.set(String(e.id), `${e.name ?? "RingCentral user"}${e.extensionNumber ? ` (ext. ${e.extensionNumber})` : ""}`);
    if (!r.navigation?.nextPage) break;
  }
  // The account's numbers say whose they are; each user's own list says which can send texts.
  const owners = new Set<string>();
  for (let page = 1; page <= 5; page++) {
    const r = await rc<{ records?: { extension?: { id?: number } }[]; navigation?: { nextPage?: unknown } }>(token, `/restapi/v1.0/account/~/phone-number?perPage=1000&page=${page}`);
    for (const n of r.records ?? []) if (n.extension?.id) owners.add(String(n.extension.id));
    if (!r.navigation?.nextPage) break;
  }
  const out: { extensionId: string; extensionName: string; number: string }[] = [];
  for (const ext of Array.from(owners).slice(0, 60)) {
    const r = await rc<{ records?: { phoneNumber?: string; features?: string[] }[] }>(token, `/restapi/v1.0/account/~/extension/${ext}/phone-number?perPage=100`).catch(() => ({ records: [] }));
    for (const n of r.records ?? []) {
      const num = normalizePhone(n.phoneNumber ?? null);
      if (num && (n.features ?? []).includes("SmsSender")) out.push({ extensionId: ext, extensionName: names.get(ext) ?? `RingCentral user ${ext}`, number: num });
    }
  }
  return out.sort((a, b) => a.extensionName.localeCompare(b.extensionName));
}

async function sendRaw(s: TextingSettings, to: string, text: string) {
  const { token, ext } = await sender(s);
  return rc<{ id: number | string; messageStatus?: string }>(token, `/restapi/v1.0/account/~/extension/${ext}/sms`, {
    method: "POST",
    body: { from: { phoneNumber: e164(s.number!) }, to: [{ phoneNumber: e164(to) }], text },
  });
}

// ---------------------------------------------------------------------------
// Who a number belongs to
// ---------------------------------------------------------------------------

type Person = { key: string; patientId: number | null; name: string };

/** Everyone MyPCP knows by phone (roster, imported schedule, Practice Fusion), as people (one person may have several records). */
async function phoneBook(): Promise<Map<string, Person[]>> {
  const d = await db();
  const raw = new Map<string, Person[]>();
  const add = (phone: string | null | undefined, p: Person) => {
    const n = normalizePhone(phone ?? null);
    if (!n || !p.name) return;
    raw.set(n, [...(raw.get(n) ?? []), p]);
  };
  for (const p of await d.select({ id: patients.id, name: patients.name, phone: patients.phoneNumber }).from(patients)) add(p.phone, { key: `p:${p.id}`, patientId: p.id, name: p.name });
  for (const s of Array.from((await loadScheduleSubjects()).values())) add(s.phone, { key: s.key, patientId: s.patientId, name: s.name });
  for (const f of await d.select({ key: fhirPatients.subjectKey, patientId: fhirPatients.patientId, name: fhirPatients.name, phone: fhirPatients.phone }).from(fhirPatients)) add(f.phone, { key: f.key, patientId: f.patientId, name: f.name ?? "" });
  // The same person under several records (roster + schedule + chart) counts once: by roster id, else by name.
  const out = new Map<string, Person[]>();
  for (const [phone, list] of Array.from(raw)) {
    const people = new Map<string, Person>();
    for (const p of list) {
      const id = p.patientId ? `id:${p.patientId}` : `name:${nameKey(p.name)}`;
      const had = people.get(id);
      // Prefer the roster record, then the chart, then the schedule.
      const rank = (k: string) => (k.startsWith("p:") ? 0 : k.startsWith("f:") ? 1 : 2);
      if (!had || rank(p.key) < rank(had.key)) people.set(id, p.patientId && !p.key.startsWith("p:") ? { ...p, key: `p:${p.patientId}` } : p);
    }
    // A roster patient and an unlinked record with the same name are the same person.
    const byName = new Map<string, Person>();
    for (const p of Array.from(people.values())) {
      const k = nameKey(p.name);
      const had = byName.get(k);
      if (!had || (p.key.startsWith("p:") && !had.key.startsWith("p:"))) byName.set(k, p);
    }
    out.set(phone, Array.from(byName.values()));
  }
  return out;
}

async function clinicOf(key: string): Promise<number | null> {
  const care = await subjectCare(key).catch(() => null);
  if (care?.clinicId) return care.clinicId;
  const { directoryEntry } = await import("./directoryDb");
  return (await directoryEntry(key).catch(() => null))?.clinicId ?? null;
}

/** The conversation for a number (made the first time: matched to the patient when exactly one person has it). */
async function ensureThread(phone: string, known?: Person | null, book?: Map<string, Person[]>) {
  const d = await db();
  const [have] = await d.select().from(textThreads).where(eq(textThreads.phone, phone)).limit(1);
  if (have) return have;
  const people = known ? [known] : (book ?? (await phoneBook())).get(phone) ?? [];
  const one = people.length === 1 ? people[0]! : null;
  await d.insert(textThreads).values({
    phone, subjectKey: one?.key ?? null, patientId: one?.patientId ?? null, patientName: one?.name.slice(0, 255) ?? null,
    clinicId: one ? await clinicOf(one.key) : null,
    candidates: people.length > 1 ? people.slice(0, 6).map((p) => ({ key: p.key, name: p.name })) : null,
  }).onDuplicateKeyUpdate({ set: { phone: sql`phone` } });
  const [made] = await d.select().from(textThreads).where(eq(textThreads.phone, phone)).limit(1);
  return made!;
}

// ---------------------------------------------------------------------------
// Pulling texts from RingCentral (every minute, and while the inbox is open)
// ---------------------------------------------------------------------------

interface RcMessage {
  id: number | string; type?: string; direction?: "Inbound" | "Outbound"; subject?: string; creationTime?: string; messageStatus?: string;
  from?: { phoneNumber?: string }; to?: { phoneNumber?: string }[]; attachments?: { type?: string; contentType?: string }[];
}

type SyncResult = { skipped: string } | { received: number; autoReplies: number; newest: Date };
let running: Promise<SyncResult> | null = null;

/** Bring in new texts (and delivery updates). At most every 15 seconds unless forced (the scheduled job). */
export async function syncTexts(opts: { force?: boolean } = {}): Promise<SyncResult> {
  if (running) return { skipped: "already running" };
  running = (async (): Promise<SyncResult> => {
    const s = await textingSettings();
    if (!s.enabled || !s.number) return { skipped: "texting is off" };
    const cursor = (await readSetting<{ ranAt?: string; from?: string }>(CURSOR_KEY)) ?? {};
    if (!opts.force && cursor.ranAt && Date.now() - new Date(cursor.ranAt).getTime() < 15_000) return { skipped: "ran just now" };
    try {
      const out = await pull(s, cursor.from ? new Date(cursor.from) : null);
      await writeSetting(CURSOR_KEY, { ranAt: new Date().toISOString(), from: out.newest.toISOString(), error: null, received: out.received }, null);
      return out;
    } catch (e) {
      await writeSetting(CURSOR_KEY, { ...cursor, ranAt: new Date().toISOString(), error: (e as Error).message.slice(0, 300) }, null);
      throw e;
    }
  })();
  try { return await running; } finally { running = null; }
}

async function pull(s: TextingSettings, from: Date | null) {
  const d = await db();
  const { token, ext } = await sender(s);
  // From a little before the last text seen (first run: the last 3 days).
  const since = new Date(Math.max((from?.getTime() ?? 0) - 2 * 60_000, Date.now() - 3 * 86_400_000));
  const records: RcMessage[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await rc<{ records?: RcMessage[]; navigation?: { nextPage?: unknown } }>(token, `/restapi/v1.0/account/~/extension/${ext}/message-store?messageType=SMS&dateFrom=${encodeURIComponent(since.toISOString())}&perPage=100&page=${page}`);
    records.push(...(r.records ?? []));
    if (!r.navigation?.nextPage) break;
  }
  records.sort((a, b) => new Date(a.creationTime ?? 0).getTime() - new Date(b.creationTime ?? 0).getTime());
  const known = new Map((records.length ? await d.select({ id: textMessages.id, rc: textMessages.rcMessageId, status: textMessages.status }).from(textMessages)
    .where(inArray(textMessages.rcMessageId, records.map((r) => String(r.id)))) : []).map((m) => [m.rc!, m]));
  let book: Map<string, Person[]> | undefined;
  let newest = from ?? since;
  let received = 0;
  const inbound: { threadId: number; at: Date; body: string }[] = [];
  for (const r of records) {
    const at = r.creationTime ? new Date(r.creationTime) : new Date();
    if (at > newest) newest = at;
    const rcId = String(r.id);
    const dir = r.direction === "Inbound" ? "in" as const : "out" as const;
    const status = textStatusFrom(r.messageStatus, dir);
    const had = known.get(rcId);
    if (had) {
      if (dir === "out" && had.status !== status) await d.update(textMessages).set({ status }).where(eq(textMessages.id, had.id));
      continue;
    }
    // Only texts on the practice's texting number.
    const ours = dir === "in" ? (r.to ?? []).some((t) => normalizePhone(t.phoneNumber ?? null) === s.number) : normalizePhone(r.from?.phoneNumber ?? null) === s.number;
    const phone = normalizePhone(dir === "in" ? r.from?.phoneNumber ?? null : r.to?.[0]?.phoneNumber ?? null);
    if (!ours || !phone || phone === s.number) continue;
    book ??= await phoneBook();
    const thread = await ensureThread(phone, null, book);
    const body = (r.subject ?? "").slice(0, 4000);
    const hasMedia = (r.attachments ?? []).some((a) => a.type === "MmsAttachment" || /^image\//.test(a.contentType ?? ""));
    await d.insert(textMessages).values({ threadId: thread.id, direction: dir, body, status, rcMessageId: rcId, hasMedia, at }).onDuplicateKeyUpdate({ set: { status } });
    const set: Partial<typeof textThreads.$inferInsert> = { lastMessageAt: sql`GREATEST(COALESCE(${textThreads.lastMessageAt}, ${at}), ${at})` as unknown as Date };
    if (dir === "in") {
      received++;
      Object.assign(set, { lastInboundAt: at, status: "open" });
      if (isStopText(body)) set.optedOutAt = at;
      else if (isStartText(body)) set.optedOutAt = null;
      inbound.push({ threadId: thread.id, at, body });
    }
    await d.update(textThreads).set(set).where(eq(textThreads.id, thread.id));
  }
  // Delivery updates for texts sent in the last 2 hours that are still on their way.
  const pending = await d.select({ id: textMessages.id, rc: textMessages.rcMessageId }).from(textMessages)
    .where(and(eq(textMessages.direction, "out"), inArray(textMessages.status, ["sending", "sent"]), gte(textMessages.at, new Date(Date.now() - 2 * 3_600_000)), lt(textMessages.at, since))).limit(10);
  for (const p of pending) {
    if (!p.rc) continue;
    const r = await rc<RcMessage>(token, `/restapi/v1.0/account/~/extension/${ext}/message-store/${p.rc}`).catch(() => null);
    if (r) await d.update(textMessages).set({ status: textStatusFrom(r.messageStatus, "out") }).where(eq(textMessages.id, p.id));
  }
  const replied = await autoReplies(s, inbound);
  return { received, autoReplies: replied, newest };
}

/** After hours: one reply per number per 12 hours, only for texts that just came in (not an old backlog). */
async function autoReplies(s: TextingSettings, inbound: { threadId: number; at: Date; body: string }[]) {
  if (!s.autoReply.enabled || !inbound.length) return 0;
  const d = await db();
  let sent = 0;
  for (const m of inbound) {
    if (!isAfterHours(m.at, s.hours) || Date.now() - m.at.getTime() > 30 * 60_000 || isStopText(m.body) || isStartText(m.body)) continue;
    const [t] = await d.select().from(textThreads).where(eq(textThreads.id, m.threadId)).limit(1);
    if (!t || t.optedOutAt || (t.lastAutoReplyAt && Date.now() - t.lastAutoReplyAt.getTime() < AUTO_REPLY_EVERY_HOURS * 3_600_000)) continue;
    const [p] = t.patientId ? await d.select({ lang: patients.preferredLanguage }).from(patients).where(eq(patients.id, t.patientId)).limit(1) : [];
    const text = autoReplyText(s.autoReply, p?.lang ?? null);
    const now = new Date();
    try {
      const r = await sendRaw(s, t.phone, text);
      await d.insert(textMessages).values({ threadId: t.id, direction: "out", body: text, status: textStatusFrom(r.messageStatus, "out"), rcMessageId: String(r.id), autoReply: true, at: now });
    } catch (e) {
      await d.insert(textMessages).values({ threadId: t.id, direction: "out", body: text, status: "failed", autoReply: true, error: (e as Error).message.slice(0, 255), at: now });
    }
    await d.update(textThreads).set({ lastAutoReplyAt: now, lastMessageAt: now }).where(eq(textThreads.id, t.id));
    sent++;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

/** Which clinics' conversations someone sees: admins and people not tied to a clinic see all. */
async function scopeOf(actor: WorkspaceActor): Promise<number[] | null> {
  if (actor.role === "admin") return null;
  if (actor.clinicIds) return actor.clinicIds;
  return (await opportunityScope({ id: actor.id, name: actor.name, role: actor.role })).clinicIds;
}
/** Their clinics' conversations, plus every one nobody's matched yet. */
const visible = (clinicIds: number[] | null): SQL | undefined =>
  clinicIds ? or(isNull(textThreads.clinicId), clinicIds.length ? inArray(textThreads.clinicId, clinicIds) : sql`1 = 0`) : undefined;

async function threadOr404(actor: WorkspaceActor, id: number) {
  const [t] = await (await db()).select().from(textThreads).where(and(eq(textThreads.id, id), visible(await scopeOf(actor)))).limit(1);
  if (!t) throw new WorkspaceError("Conversation not found.", "NOT_FOUND");
  return t;
}

const unreadSql = sql`${textThreads.lastInboundAt} IS NOT NULL AND (${textThreads.readAt} IS NULL OR ${textThreads.lastInboundAt} > ${textThreads.readAt})`;

export async function listThreads(actor: WorkspaceActor, input: { filter: TextFilter; q?: string | null }) {
  const d = await db();
  const conds: (SQL | undefined)[] = [visible(await scopeOf(actor))];
  if (input.filter === "open") conds.push(eq(textThreads.status, "open"));
  else if (input.filter === "mine") conds.push(eq(textThreads.status, "open"), eq(textThreads.assignedUserId, actor.id));
  else if (input.filter === "unknown") conds.push(isNull(textThreads.subjectKey));
  else if (input.filter === "closed") conds.push(eq(textThreads.status, "closed"));
  const q = (input.q ?? "").trim();
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 3) conds.push(sql`${textThreads.phone} LIKE ${`%${digits}%`}`);
  else if (q.length >= 2) for (const w of q.replace(/[%_\\]/g, " ").split(/\s+/).filter(Boolean).slice(0, 3)) conds.push(sql`${textThreads.patientName} LIKE ${`%${w}%`}`);
  const rows = await d.select({ t: textThreads, assignee: users.name, clinic: clinics.name }).from(textThreads)
    .leftJoin(users, eq(users.id, textThreads.assignedUserId)).leftJoin(clinics, eq(clinics.id, textThreads.clinicId))
    .where(and(...conds)).orderBy(desc(textThreads.lastMessageAt)).limit(200);
  const ids = rows.map((r) => r.t.id);
  const lastIds = ids.length ? await d.select({ threadId: textMessages.threadId, id: sql<number>`max(${textMessages.id})` }).from(textMessages)
    // The preview: the latest real text (not a team note, not the automatic reply).
    .where(and(inArray(textMessages.threadId, ids), sql`${textMessages.direction} <> 'note'`, eq(textMessages.autoReply, false))).groupBy(textMessages.threadId) : [];
  const last = new Map((lastIds.length ? await d.select({ threadId: textMessages.threadId, body: textMessages.body, direction: textMessages.direction, hasMedia: textMessages.hasMedia, at: textMessages.at })
    .from(textMessages).where(inArray(textMessages.id, lastIds.map((l) => Number(l.id)))) : []).map((m) => [m.threadId, m]));
  return rows.map(({ t, assignee, clinic }) => {
    const l = last.get(t.id);
    return {
      id: t.id, phone: formatPhone(t.phone), name: t.patientName, subjectKey: t.subjectKey, ambiguous: !t.subjectKey && !!t.candidates?.length,
      clinic, assignee, status: t.status, optedOut: !!t.optedOutAt,
      unread: !!t.lastInboundAt && (!t.readAt || t.lastInboundAt > t.readAt),
      last: l ? { text: l.body || (l.hasMedia ? "Picture" : ""), fromPatient: l.direction === "in", at: l.at } : null,
      lastAt: t.lastMessageAt ?? t.createdAt,
    };
  });
}

/** The badge (open conversations with a text nobody's read yet) and the newest one, for the pop-up (no names or text). */
export async function unreadTexts(actor: WorkspaceActor) {
  const rows = await (await db()).select({ id: textThreads.id, at: textThreads.lastInboundAt }).from(textThreads)
    .where(and(visible(await scopeOf(actor)), eq(textThreads.status, "open"), unreadSql)).orderBy(desc(textThreads.lastInboundAt)).limit(200);
  return { total: rows.length, newest: rows[0] ? { threadId: rows[0].id, at: rows[0].at } : null };
}

/** People a conversation can be assigned to: everyone who handles texts for that clinic (and the admins). */
async function assignableFor(clinicId: number | null) {
  const { staffDirectory } = await import("./chatDb");
  const people = (await staffDirectory()).filter((u) => can(u.role, "texts"));
  return people.filter((u) => u.role === "admin" || !clinicId || !u.clinicId || u.clinicId === clinicId).map((u) => ({ id: u.id, name: u.name }));
}

export async function threadDetail(actor: WorkspaceActor, id: number) {
  const t = await threadOr404(actor, id);
  const d = await db();
  const rows = await d.select({ m: textMessages, by: users.name }).from(textMessages).leftJoin(users, eq(users.id, textMessages.sentByUserId))
    .where(eq(textMessages.threadId, id)).orderBy(desc(textMessages.id)).limit(200);
  // Opening it marks it read for the team (logged once per new text).
  if (t.lastInboundAt && (!t.readAt || t.lastInboundAt > t.readAt)) {
    await d.update(textThreads).set({ readAt: new Date() }).where(eq(textThreads.id, id));
    await audit(actor, "view_patient", { entityType: "text", entityId: id, description: "Read a patient's texts" });
  }
  let consent: "yes" | "no" | null = null;
  if (t.subjectKey) {
    const { latestConsentAnswer } = await import("./intakeDb");
    consent = (await latestConsentAnswer(t.subjectKey, "communications").catch(() => null))?.answer ?? null;
  }
  const [clinic] = t.clinicId ? await d.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, t.clinicId)).limit(1) : [];
  const [assignee] = t.assignedUserId ? await d.select({ name: users.name }).from(users).where(eq(users.id, t.assignedUserId)).limit(1) : [];
  return {
    thread: {
      id: t.id, phone: formatPhone(t.phone), name: t.patientName, subjectKey: t.subjectKey, candidates: t.subjectKey ? [] : t.candidates ?? [],
      clinicId: t.clinicId, clinic: clinic?.name ?? null, assignedUserId: t.assignedUserId, assignee: assignee?.name ?? null, status: t.status,
      optedOut: !!t.optedOutAt, consent,
      /** The patient texted in the last day: replying is fine even without a Yes on file. */
      recentInbound: !!t.lastInboundAt && Date.now() - t.lastInboundAt.getTime() < 86_400_000,
    },
    assignable: await assignableFor(t.clinicId),
    messages: rows.reverse().map(({ m, by }) => ({
      id: m.id, direction: m.direction as "in" | "out" | "note", body: m.body, status: m.status, at: m.at, by: m.autoReply ? "Automatic reply" : by ?? (m.direction === "out" ? "Sent from RingCentral" : null),
      hasMedia: m.hasMedia, error: m.error,
    })),
  };
}

/** Text a patient: in a conversation, or starting one from their record. */
export async function sendText(actor: WorkspaceActor, input: { threadId?: number | null; subjectKey?: string | null; body: string }) {
  const body = input.body.trim();
  if (!body) throw new WorkspaceError("Type a text.");
  if (body.length > MAX_TEXT_LENGTH) throw new WorkspaceError(`Texts can be up to ${MAX_TEXT_LENGTH} characters.`);
  const s = await textingSettings();
  const d = await db();
  let t;
  if (input.threadId) t = await threadOr404(actor, input.threadId);
  else if (input.subjectKey) t = await threadFor(actor, input.subjectKey);
  else throw new WorkspaceError("Pick a patient.");
  if (t.optedOutAt) throw new WorkspaceError("This patient texted STOP, so they can't get texts until they text START. Call them instead.");
  if (t.subjectKey) {
    const { latestConsentAnswer } = await import("./intakeDb");
    const said = await latestConsentAnswer(t.subjectKey, "communications").catch(() => null);
    const recent = !!t.lastInboundAt && Date.now() - t.lastInboundAt.getTime() < 86_400_000;
    if (said?.answer === "no" && !recent) throw new WorkspaceError("This patient said No to texts on their consent form. Call them instead (if they text us first, you can reply).");
  }
  const now = new Date();
  let rcId: string | null = null, status = "sending", error: string | null = null;
  try {
    const r = await sendRaw(s, t.phone, body);
    rcId = String(r.id);
    status = textStatusFrom(r.messageStatus, "out");
  } catch (e) {
    if (e instanceof WorkspaceError && /isn't set up/.test(e.message)) throw e;
    status = "failed";
    error = (e as Error).message.slice(0, 255);
  }
  const res = await d.insert(textMessages).values({ threadId: t.id, direction: "out", body, status, rcMessageId: rcId, sentByUserId: actor.id, error, at: now });
  await d.update(textThreads).set({ lastMessageAt: now, readAt: now, assignedUserId: t.assignedUserId ?? actor.id }).where(eq(textThreads.id, t.id));
  await audit(actor, "update_patient", { entityType: "text", entityId: t.id, description: status === "failed" ? "Text to a patient failed" : "Texted a patient" });
  if (status === "failed") throw new WorkspaceError(`The text didn't go: ${error}`);
  return { id: insertId(res), threadId: t.id };
}

/** The conversation with a patient (made if needed), from their record's phone number. */
async function threadFor(actor: WorkspaceActor, subjectKey: string) {
  const { intakeContact } = await import("./intakeDb");
  const c = await intakeContact(actor, subjectKey);
  const phone = normalizePhone(c.phone ?? null);
  if (!phone) throw new WorkspaceError("There's no mobile number on file for this patient.");
  const t = await ensureThread(phone, { key: subjectKey, patientId: c.patientId ?? null, name: c.name ?? "Patient" });
  return threadOr404(actor, t.id);
}

/** Open (or start) the conversation with a patient, without sending anything yet. */
export async function openForPatient(actor: WorkspaceActor, subjectKey: string) {
  const t = await threadFor(actor, subjectKey);
  return { id: t.id };
}

/** A note for the team inside the conversation (never sent to the patient). */
export async function addNote(actor: WorkspaceActor, threadId: number, body: string) {
  const text = body.trim();
  if (!text) throw new WorkspaceError("Type a note.");
  if (text.length > 2000) throw new WorkspaceError("Notes can be up to 2,000 characters.");
  const t = await threadOr404(actor, threadId);
  const now = new Date();
  await (await db()).insert(textMessages).values({ threadId: t.id, direction: "note", body: text, status: "sent", sentByUserId: actor.id, at: now });
  return { ok: true };
}

export async function assignThread(actor: WorkspaceActor, threadId: number, userId: number | null) {
  const t = await threadOr404(actor, threadId);
  if (userId && !(await assignableFor(t.clinicId)).some((u) => u.id === userId)) throw new WorkspaceError("That person doesn't handle texts for this clinic.");
  await (await db()).update(textThreads).set({ assignedUserId: userId }).where(eq(textThreads.id, threadId));
  return { ok: true };
}

export async function setThreadStatus(actor: WorkspaceActor, threadId: number, status: "open" | "closed") {
  await threadOr404(actor, threadId);
  await (await db()).update(textThreads).set({ status, ...(status === "closed" ? { readAt: new Date() } : {}) }).where(eq(textThreads.id, threadId));
  return { ok: true };
}

/** Say who this number belongs to (it then goes to that patient's clinic). */
export async function matchThread(actor: WorkspaceActor, threadId: number, subjectKey: string) {
  await threadOr404(actor, threadId);
  const care = await subjectCare(subjectKey).catch(() => null);
  const { directoryEntry } = await import("./directoryDb");
  const e = care ? null : await directoryEntry(subjectKey).catch(() => null);
  const name = care?.name ?? e?.name;
  if (!name) throw new WorkspaceError("That patient wasn't found.");
  const pid = /^p:(\d+)$/.exec(subjectKey)?.[1];
  await (await db()).update(textThreads).set({
    subjectKey, patientId: care?.patientId ?? (pid ? Number(pid) : e?.patientId ?? null), patientName: name.slice(0, 255), clinicId: await clinicOf(subjectKey), candidates: null,
  }).where(eq(textThreads.id, threadId));
  await audit(actor, "update_patient", { entityType: "text", entityId: threadId, description: "Matched a texting number to a patient" });
  return { ok: true };
}

/** Patient 360: the texting conversation with this patient, if there is one. */
export async function threadForSubject(actor: WorkspaceActor, subjectKey: string) {
  const [t] = await (await db()).select({ id: textThreads.id }).from(textThreads).where(and(eq(textThreads.subjectKey, subjectKey), visible(await scopeOf(actor)))).orderBy(desc(textThreads.lastMessageAt)).limit(1);
  return t ? { id: t.id } : null;
}

/** Is texting on (for showing the inbox at all)? */
export async function textingStatus() {
  const s = await textingSettings();
  return { enabled: s.enabled && !!s.number, number: s.number ? formatPhone(s.number) : null };
}


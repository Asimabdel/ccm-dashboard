// Practice mailbox (Google Workspace / Gmail): read-only. New inbox emails are matched to a
// patient (remembered/imported address → sender's full name → phone number the sender wrote)
// and become a "Patient email" task for the patient's care coordinator, or else the front desk
// at the patient's clinic. Emails nobody can match wait on the Patient emails page until a
// staff member picks the patient; that address is then remembered.
//
// Runs every 2 minutes from an EventBridge schedule (lambda.ts, {"__job":"gmail-sync"}).
// "Load the last 30 days" pulls in earlier inbox emails a chunk per run; those are matched
// and shown on the Patient emails page but never create tasks (they were handled in Gmail).
// Google is reached through the allowlist relay (server/egress.ts). Scope: gmail.readonly.
import { SignJWT, jwtVerify } from "jose";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { ENV } from "./_core/env";
import { appSettings, emailContacts, emailMessages, users, workTaskActivities, workTasks } from "../drizzle/schema";
import { gmailMessageLink, matchEmailSender, parseFromHeader, stripQuotedText, type EmailMatchIndex, type EmailSubject } from "../shared/email";
import { nameKey, parseCsvRows, parseDateValue } from "../shared/workspace";
import { localDateStr } from "../shared/workforce";
import { openSecret, sealSecret } from "./secretBox";
import { relayFetch } from "./egress";
import {
  WorkspaceError, audit, buildNameDobIndex, buildNameIndex, buildPhoneIndex, careTeamAssignee, createTask, searchSubjects, subjectCare, type WorkspaceActor,
} from "./workspaceDb";

const CONFIG_KEY = "gmail";
const STATE_KEY = "gmail_state";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALLBACK_PATH = "/api/integrations/google/callback";
const ALLOWED_ORIGINS = ["https://mypcpcare.com", "https://www.mypcpcare.com", "http://localhost:3001", "http://localhost:3000"];
const SKIP_LABELS = ["SENT", "DRAFT", "SPAM", "TRASH", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"];
const AUTOMATED_SENDER = /(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounce)([._-]|@)/i;
const OPEN_STATUSES = ["open", "in_progress", "waiting"] as const;

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

interface GmailConfig {
  enabled: boolean;
  clientId: string;
  clientSecretEnc: string;
  refreshTokenEnc: string;
  mailbox: string | null;
  connectedByUserId: number | null;
  historyId: string | null;
}
interface GmailState { lastRunAt: string | null; lastSuccessAt: string | null; lastError: string | null; processed: number; assigned: number; needsPatient: number }
const EMPTY_STATE: GmailState = { lastRunAt: null, lastSuccessAt: null, lastError: null, processed: 0, assigned: 0, needsPatient: 0 };

async function readSetting<T>(key: string): Promise<T | null> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}
async function writeSetting(key: string, value: unknown, userId: number | null) {
  await (await db()).insert(appSettings).values({ key, value, updatedByUserId: userId }).onDuplicateKeyUpdate({ set: { value, updatedByUserId: userId } });
}
async function config(): Promise<GmailConfig> {
  return { enabled: false, clientId: "", clientSecretEnc: "", refreshTokenEnc: "", mailbox: null, connectedByUserId: null, historyId: null, ...((await readSetting<GmailConfig>(CONFIG_KEY)) ?? {}) };
}

// ---- Admin: status, app credentials, connect / disconnect ----

export async function getGmailStatus() {
  const c = await config();
  const state = { ...EMPTY_STATE, ...((await readSetting<GmailState>(STATE_KEY)) ?? {}) };
  const d = await db();
  const [waiting] = await d.select({ id: emailMessages.id }).from(emailMessages).where(eq(emailMessages.status, "needs_patient")).limit(1);
  const [contacts] = await d.select({ id: emailContacts.id }).from(emailContacts).where(eq(emailContacts.kind, "patient")).limit(1);
  return {
    appSaved: !!(c.clientId && c.clientSecretEnc),
    clientIdHint: c.clientId ? `…${c.clientId.slice(-10)}` : null,
    connected: !!c.refreshTokenEnc,
    mailbox: c.mailbox,
    enabled: c.enabled,
    state,
    hasWaiting: !!waiting,
    hasContacts: !!contacts,
    callbackPath: CALLBACK_PATH,
    backfill: await getBackfill(),
  };
}

export async function saveGmailApp(actor: WorkspaceActor, input: { clientId: string; clientSecret?: string | null }) {
  const c = await config();
  const next: GmailConfig = { ...c, clientId: input.clientId.trim(), clientSecretEnc: input.clientSecret?.trim() ? sealSecret(input.clientSecret.trim()) : c.clientSecretEnc };
  if (next.clientId !== c.clientId) { next.refreshTokenEnc = ""; next.mailbox = null; next.historyId = null; next.enabled = false; tokenCache = null; }
  await writeSetting(CONFIG_KEY, next, actor.id);
  await audit(actor, "manage_access", { entityType: "integration", description: "Gmail: saved Google app credentials" });
  return { ok: true };
}

/** Google sign-in URL for connecting the mailbox. The signed `state` ties the reply to this admin. */
export async function gmailConnectUrl(actor: WorkspaceActor, origin: string) {
  const c = await config();
  if (!c.clientId || !c.clientSecretEnc) throw new WorkspaceError("Save the Google Client ID and Client Secret first.");
  if (!ALLOWED_ORIGINS.includes(origin)) throw new WorkspaceError("Connect the mailbox from mypcpcare.com.");
  const redirectUri = `${origin}${CALLBACK_PATH}`;
  const state = await new SignJWT({ uid: actor.id, redirectUri, purpose: "gmail-connect" })
    .setProtectedHeader({ alg: "HS256" }).setExpirationTime("15m").sign(new TextEncoder().encode(ENV.cookieSecret));
  const params = new URLSearchParams({ client_id: c.clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "false", state });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, redirectUri };
}

/** Google redirects here after sign-in. Returns where to send the browser next. */
export async function handleGmailCallback(query: Record<string, unknown>): Promise<string> {
  const back = (msg: string) => `/integrations?gmail=${encodeURIComponent(msg)}`;
  if (query.error) return back(`Google sign-in was cancelled (${String(query.error)}).`);
  let claims: { uid?: number; redirectUri?: string; purpose?: string };
  try {
    claims = (await jwtVerify(String(query.state ?? ""), new TextEncoder().encode(ENV.cookieSecret))).payload as typeof claims;
  } catch {
    return back("That sign-in link expired. Click Connect mailbox again.");
  }
  if (claims.purpose !== "gmail-connect" || !claims.uid || !claims.redirectUri) return back("That sign-in link isn't valid.");
  const d = await db();
  const [admin] = await d.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.id, claims.uid)).limit(1);
  if (admin?.role !== "admin") return back("Only an admin can connect the practice mailbox.");
  const c = await config();
  const res = await relayFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: String(query.code ?? ""), client_id: c.clientId, client_secret: openSecret(c.clientSecretEnc), redirect_uri: claims.redirectUri, grant_type: "authorization_code" }).toString(),
  });
  const tok = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error_description?: string };
  if (!res.ok || !tok.access_token || !tok.refresh_token) return back(`Google didn't grant access: ${tok.error_description ?? res.statusText}.`);
  if (!String(tok.scope ?? "").includes("gmail.readonly")) return back("Google didn't grant read access to Gmail. Try again and tick the Gmail permission.");
  tokenCache = { token: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
  const profile = await gmailGet<{ emailAddress: string; historyId: string }>("/profile");
  await writeSetting(CONFIG_KEY, { ...c, refreshTokenEnc: sealSecret(tok.refresh_token), mailbox: profile.emailAddress.toLowerCase(), connectedByUserId: admin.id, historyId: profile.historyId, enabled: true }, admin.id);
  await writeSetting(STATE_KEY, { ...EMPTY_STATE, lastSuccessAt: new Date().toISOString() }, admin.id);
  await audit({ id: admin.id, name: admin.name, role: "admin", clinicIds: null }, "manage_access", { entityType: "integration", description: `Gmail connected (read-only): ${profile.emailAddress}` });
  return back("connected");
}

export async function setGmailEnabled(actor: WorkspaceActor, enabled: boolean) {
  const c = await config();
  if (enabled && !c.refreshTokenEnc) throw new WorkspaceError("Connect the mailbox first.");
  await writeSetting(CONFIG_KEY, { ...c, enabled }, actor.id);
  await audit(actor, "manage_access", { entityType: "integration", description: `Gmail sync ${enabled ? "on" : "paused"}` });
  return { ok: true };
}

export async function disconnectGmail(actor: WorkspaceActor) {
  const c = await config();
  await writeSetting(CONFIG_KEY, { ...c, refreshTokenEnc: "", mailbox: null, historyId: null, enabled: false }, actor.id);
  await (await db()).delete(appSettings).where(eq(appSettings.key, BACKFILL_KEY));
  tokenCache = null;
  await audit(actor, "manage_access", { entityType: "integration", description: "Gmail disconnected" });
  return { ok: true };
}

// ---- Gmail API ----

let tokenCache: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const c = await config();
  if (!c.refreshTokenEnc) throw new Error("The mailbox isn't connected.");
  const res = await relayFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: openSecret(c.clientSecretEnc), refresh_token: openSecret(c.refreshTokenEnc), grant_type: "refresh_token" }).toString(),
  });
  const tok = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !tok.access_token) {
    throw new Error(tok.error === "invalid_grant" ? "Google access was removed or expired. Click Connect mailbox to reconnect." : `Google sign-in failed (${tok.error ?? res.status}).`);
  }
  tokenCache = { token: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
  return tok.access_token;
}

async function gmailGet<T>(path: string): Promise<T> {
  const res = await relayFetch(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json" } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw Object.assign(new Error(`Gmail ${res.status}: ${body.error?.message ?? res.statusText}`), { status: res.status });
  return body;
}

interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] }
interface GmailMessage {
  id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string;
  payload?: GmailPart & { headers?: { name: string; value: string }[] };
}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
function bodyText(part: GmailPart | undefined): string {
  if (!part) return "";
  const find = (p: GmailPart, type: string): string | null => {
    if (p.mimeType === type && p.body?.data) return b64(p.body.data);
    for (const c of p.parts ?? []) { const r = find(c, type); if (r) return r; }
    return null;
  };
  const plain = find(part, "text/plain");
  if (plain) return plain;
  const html = find(part, "text/html");
  return html ? html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ") : "";
}

// ---- Matching + assignment ----

async function buildIndex(): Promise<EmailMatchIndex> {
  const d = await db();
  const byEmail = new Map<string, EmailSubject | "ignore">();
  for (const c of await d.select().from(emailContacts)) {
    byEmail.set(c.email, c.kind === "ignore" ? "ignore" : { key: c.subjectKey ?? `p:${c.patientId}`, patientId: c.patientId, name: c.name ?? "Patient" });
  }
  return { byEmail, byName: await buildNameIndex(), byPhone: await buildPhoneIndex() };
}

function taskText(m: { fromName: string | null; fromEmail: string | null; subject: string | null; receivedAt: Date; preview: string | null; link: string; method: string }, patientName: string) {
  const who = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail ?? "unknown sender";
  const how = { address: "a remembered email address", name: "the sender's name", phone: "a phone number in the email", manual: "staff" }[m.method] ?? m.method;
  return {
    title: `Email from ${patientName}: ${m.subject || "(no subject)"}`.slice(0, 250),
    description: `From: ${who}\nReceived: ${m.receivedAt.toLocaleString("en-US", { timeZone: "America/Chicago" })}\nMatched to ${patientName} by ${how}.\n\n${m.preview ?? ""}\n\nOpen in Gmail: ${m.link}\nReply from the practice mailbox; this task is only a pointer to the email.`,
  };
}

async function systemActor(): Promise<WorkspaceActor> {
  const c = await config();
  const d = await db();
  const [u] = c.connectedByUserId ? await d.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, c.connectedByUserId)).limit(1) : [];
  if (!u) throw new Error("The admin who connected the mailbox no longer exists. Reconnect it.");
  return { id: u.id, name: "Practice mailbox", role: "admin", clinicIds: null };
}

// ---- The sync ----

export async function runGmailSync(opts: { maxMs: number; manual: boolean }) {
  const started = Date.now();
  const c = await config();
  if (!c.refreshTokenEnc) return { skipped: "The practice mailbox isn't connected." };
  if (!c.enabled && !opts.manual) return { skipped: "Email sync is paused." };
  const state: GmailState = { ...EMPTY_STATE, ...((await readSetting<GmailState>(STATE_KEY)) ?? {}) };
  state.lastRunAt = new Date().toISOString();
  const stats = { processed: 0, assigned: 0, needsPatient: 0, ignored: 0 };
  try {
    const d = await db();
    // New inbox messages since the last run.
    let ids: string[] = [];
    let latestHistory = c.historyId;
    try {
      let pageToken: string | undefined;
      for (let i = 0; i < 5; i++) {
        const h = await gmailGet<{ history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; historyId?: string; nextPageToken?: string }>(
          `/history?startHistoryId=${encodeURIComponent(c.historyId ?? "")}&historyTypes=messageAdded&labelId=INBOX&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`);
        for (const e of h.history ?? []) for (const a of e.messagesAdded ?? []) ids.push(a.message.id);
        latestHistory = h.historyId ?? latestHistory;
        if (!h.nextPageToken) break;
        pageToken = h.nextPageToken;
      }
    } catch (e) {
      // History too old or missing (e.g. after a long pause): look at the last day of the inbox instead.
      if ((e as { status?: number }).status !== 404 && c.historyId) throw e;
      const list = await gmailGet<{ messages?: { id: string }[] }>(`/messages?q=${encodeURIComponent("in:inbox newer_than:1d")}&maxResults=100`);
      ids = (list.messages ?? []).map((m) => m.id);
      latestHistory = (await gmailGet<{ historyId: string }>("/profile")).historyId;
    }
    ids = Array.from(new Set(ids));
    const already = ids.length ? new Set((await d.select({ g: emailMessages.gmailId }).from(emailMessages).where(inArray(emailMessages.gmailId, ids))).map((r) => r.g)) : new Set<string>();
    const todo = ids.filter((id) => !already.has(id));
    let complete = true;
    if (todo.length) {
      const idx = await buildIndex();
      const actor = await systemActor();
      for (const id of todo) {
        if (Date.now() - started > opts.maxMs) { complete = false; break; }
        const m = await gmailGet<GmailMessage>(`/messages/${id}?format=full`);
        const r = await processMessage(m, c.mailbox ?? "", idx, actor);
        stats.processed++;
        stats[r]++;
      }
    }
    // Only move the bookmark once everything up to it has been handled.
    if (complete && latestHistory) await writeSetting(CONFIG_KEY, { ...(await config()), historyId: latestHistory }, null);
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
  } catch (e) {
    state.lastError = (e as Error).message.slice(0, 500);
  }
  state.processed += stats.processed;
  state.assigned += stats.assigned;
  state.needsPatient += stats.needsPatient;
  await writeSetting(STATE_KEY, state, null);
  console.log(`[gmail-sync] ${JSON.stringify({ ...stats, error: state.lastError })}`); // counts only
  return { stats, error: state.lastError };
}

async function processMessage(m: GmailMessage, mailbox: string, idx: EmailMatchIndex, actor: WorkspaceActor, historical = false): Promise<"assigned" | "needsPatient" | "ignored"> {
  const d = await db();
  const header = (name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
  const from = parseFromHeader(header("From"));
  const subject = (header("Subject") ?? "").slice(0, 255);
  const receivedAt = new Date(Number(m.internalDate ?? Date.now()));
  const messageIdHeader = header("Message-ID")?.slice(0, 255) ?? null;
  const labels = m.labelIds ?? [];
  const base = { gmailId: m.id, threadId: m.threadId, messageIdHeader, fromEmail: from.email, fromName: from.name?.slice(0, 255) ?? null, subject, receivedAt, historical };

  const skip = !labels.includes("INBOX") || labels.some((l) => SKIP_LABELS.includes(l)) || !from.email || from.email === mailbox || AUTOMATED_SENDER.test(from.email);
  const body = skip ? "" : bodyText(m.payload);
  const match = skip ? { ignore: true as const } : matchEmailSender({ email: from.email, name: from.name, body }, idx);
  const preview = skip ? (m.snippet ?? "").slice(0, 300) : stripQuotedText(body).replace(/\n{3,}/g, "\n\n").slice(0, 1500) || (m.snippet ?? "");
  if (!match || "ignore" in match) {
    await d.insert(emailMessages).values({ ...base, preview, status: match ? "ignored" : "needs_patient" });
    return match ? "ignored" : "needsPatient";
  }
  const matched = { patientId: match.subject.patientId, subjectKey: match.subject.key, patientName: match.subject.name.slice(0, 255), matchMethod: match.method };
  if (historical) {
    await d.insert(emailMessages).values({ ...base, preview, status: "assigned", ...matched });
    return "assigned";
  }
  const who = await careTeamAssignee(match.subject.key);
  const text = taskText({ ...base, preview, link: gmailMessageLink(mailbox, messageIdHeader, m.threadId), method: match.method }, match.subject.name);
  const task = await createTask(actor, {
    title: text.title, description: text.description, patientId: match.subject.patientId, clinicId: who.clinicId,
    assignedUserId: who.assignedUserId, assignedRole: who.assignedRole, priority: "normal", category: "patient_email",
    dueDate: localDateStr(), sourceType: "email", sourceRef: m.id,
  });
  await d.insert(emailMessages).values({ ...base, preview, status: "assigned", ...matched, taskId: task.id, assignedUserId: who.assignedUserId });
  return "assigned";
}

// ---- Earlier emails: "Load the last 30 days" ----
// Listed once (newest first, 500 per page), then fetched a few at a time on each scheduled run
// until done, so no single request runs long. Mail newer than the request is the live sync's job.

const BACKFILL_KEY = "gmail_backfill";
interface GmailBackfill {
  status: "running" | "done" | "error";
  days: number;
  after: number; // epoch seconds
  before: number; // epoch seconds (when it was requested)
  pageToken: string | null;
  listed: boolean;
  pending: string[];
  found: number; processed: number; skipped: number; assigned: number; needsPatient: number; ignored: number;
  requestedAt: string; finishedAt: string | null; error: string | null;
}
const publicBackfill = ({ pending, pageToken, after, before, ...b }: GmailBackfill) => ({ ...b, remaining: pending.length });
async function getBackfill() {
  const b = await readSetting<GmailBackfill>(BACKFILL_KEY);
  return b ? publicBackfill(b) : null;
}
const isDuplicate = (e: unknown) => /Duplicate entry|ER_DUP_ENTRY/i.test(`${(e as Error)?.message} ${(e as { code?: string })?.code ?? ""} ${(e as { cause?: { code?: string; message?: string } })?.cause?.code ?? ""} ${(e as { cause?: { message?: string } })?.cause?.message ?? ""}`);

export async function startGmailBackfill(actor: WorkspaceActor, days: number) {
  const c = await config();
  if (!c.refreshTokenEnc) throw new WorkspaceError("Connect the mailbox first.");
  const cur = await readSetting<GmailBackfill>(BACKFILL_KEY);
  if (cur?.status === "done") return publicBackfill(cur); // once per connection (disconnecting clears it)
  if (!cur) {
    const now = Math.floor(Date.now() / 1000);
    await writeSetting(BACKFILL_KEY, {
      status: "running", days, after: now - days * 86_400, before: now, pageToken: null, listed: false, pending: [],
      found: 0, processed: 0, skipped: 0, assigned: 0, needsPatient: 0, ignored: 0, requestedAt: new Date().toISOString(), finishedAt: null, error: null,
    } satisfies GmailBackfill, actor.id);
    await audit(actor, "manage_access", { entityType: "integration", description: `Gmail: loading emails from the last ${days} days` });
  }
  return runGmailBackfill({ deadline: Date.now() + 15_000 });
}

export async function runGmailBackfill(opts: { deadline: number }) {
  const b = await readSetting<GmailBackfill>(BACKFILL_KEY);
  const c = await config();
  if (!b || b.status === "done" || !c.refreshTokenEnc) return b ? publicBackfill(b) : null;
  const d = await db();
  b.status = "running";
  b.error = null;
  try {
    let idx: EmailMatchIndex | null = null;
    let actor: WorkspaceActor | null = null;
    while (Date.now() < opts.deadline) {
      if (!b.pending.length) {
        if (b.listed) break;
        const q = `in:inbox after:${b.after} before:${b.before} -category:promotions -category:social`;
        const page = await gmailGet<{ messages?: { id: string }[]; nextPageToken?: string }>(
          `/messages?q=${encodeURIComponent(q)}&maxResults=500${b.pageToken ? `&pageToken=${encodeURIComponent(b.pageToken)}` : ""}`);
        const ids = (page.messages ?? []).map((m) => m.id);
        const have = ids.length ? new Set((await d.select({ g: emailMessages.gmailId }).from(emailMessages).where(inArray(emailMessages.gmailId, ids))).map((r) => r.g)) : new Set<string>();
        b.pending = ids.filter((id) => !have.has(id));
        b.found += ids.length;
        b.skipped += ids.length - b.pending.length;
        b.pageToken = page.nextPageToken ?? null;
        b.listed = !b.pageToken;
        await writeSetting(BACKFILL_KEY, b, null);
        continue;
      }
      idx ??= await buildIndex();
      actor ??= await systemActor();
      const batch = b.pending.slice(0, 8);
      const msgs = await Promise.all(batch.map((id) => gmailGet<GmailMessage>(`/messages/${id}?format=full`)
        .catch((e) => { if ((e as { status?: number }).status === 404) return null; throw e; }))); // 404: deleted since it was listed
      for (const m of msgs) {
        if (!m) { b.skipped++; continue; }
        try {
          const r = await processMessage(m, c.mailbox ?? "", idx, actor, true);
          b.processed++;
          b[r]++;
        } catch (e) {
          if (!isDuplicate(e)) throw e;
          b.skipped++;
        }
      }
      b.pending = b.pending.slice(batch.length);
      await writeSetting(BACKFILL_KEY, b, null);
    }
    if (b.listed && !b.pending.length) { b.status = "done"; b.finishedAt = new Date().toISOString(); }
  } catch (e) {
    b.status = "error";
    b.error = (e as Error).message.slice(0, 300);
  }
  await writeSetting(BACKFILL_KEY, b, null);
  console.log(`[gmail-backfill] ${JSON.stringify({ status: b.status, found: b.found, processed: b.processed, remaining: b.pending.length, error: b.error })}`); // counts only
  return publicBackfill(b);
}

// ---- Patient emails page: list, link, ignore ----

export async function listEmails(filter: "needs_patient" | "all") {
  const d = await db();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const conds = [gte(emailMessages.receivedAt, since)];
  if (filter === "needs_patient") conds.push(eq(emailMessages.status, "needs_patient"));
  const rows = await d.select({ m: emailMessages, assignee: users.name }).from(emailMessages)
    .leftJoin(users, eq(users.id, emailMessages.assignedUserId))
    .where(and(...conds)).orderBy(desc(emailMessages.receivedAt)).limit(1000);
  const c = await config();
  return rows.map(({ m, assignee }) => ({
    id: m.id, fromEmail: m.fromEmail, fromName: m.fromName, subject: m.subject, preview: m.preview, receivedAt: m.receivedAt,
    status: m.status, patientName: m.patientName, patientId: m.patientId, matchMethod: m.matchMethod, taskId: m.taskId, historical: m.historical,
    assigneeName: assignee, link: c.mailbox ? gmailMessageLink(c.mailbox, m.messageIdHeader, m.threadId ?? "") : null,
  }));
}

export { searchSubjects };

/** Staff picked the patient: remember the address, then create (or re-route) the task. Earlier emails get no task. */
export async function linkEmail(actor: WorkspaceActor, input: { emailId: number; subjectKey: string }) {
  const d = await db();
  const [m] = await d.select().from(emailMessages).where(eq(emailMessages.id, input.emailId)).limit(1);
  if (!m) throw new WorkspaceError("Email not found.", "NOT_FOUND");
  const care = await subjectCare(input.subjectKey);
  if (!care) throw new WorkspaceError("Patient not found.", "NOT_FOUND");
  if (m.fromEmail) {
    await d.insert(emailContacts).values({ email: m.fromEmail, kind: "patient", patientId: care.patientId, subjectKey: input.subjectKey, name: care.name.slice(0, 255), source: "linked", createdByUserId: actor.id })
      .onDuplicateKeyUpdate({ set: { kind: "patient", patientId: care.patientId, subjectKey: input.subjectKey, name: care.name.slice(0, 255), source: "linked", createdByUserId: actor.id } });
  }
  const who = await careTeamAssignee(input.subjectKey);
  const c = await config();
  const text = taskText({ ...m, link: gmailMessageLink(c.mailbox ?? "", m.messageIdHeader, m.threadId ?? ""), method: "manual" }, care.name);
  let taskId = m.taskId;
  if (taskId) {
    await d.update(workTasks).set({ title: text.title, description: text.description, patientId: care.patientId, clinicId: who.clinicId, assignedUserId: who.assignedUserId, assignedRole: who.assignedRole }).where(eq(workTasks.id, taskId));
    await d.insert(workTaskActivities).values({ taskId, userId: actor.id, type: "assigned", meta: { to: who.assignedUserId ? String(who.assignedUserId) : who.assignedRole } });
  } else if (!m.historical) {
    taskId = (await createTask({ ...actor, clinicIds: null }, {
      title: text.title, description: text.description, patientId: care.patientId, clinicId: who.clinicId,
      assignedUserId: who.assignedUserId, assignedRole: who.assignedRole, priority: "normal", category: "patient_email",
      dueDate: localDateStr(), sourceType: "email", sourceRef: m.gmailId,
    })).id;
  }
  await d.update(emailMessages).set({ status: "assigned", patientId: care.patientId, subjectKey: input.subjectKey, patientName: care.name.slice(0, 255), matchMethod: "manual", taskId, assignedUserId: taskId ? who.assignedUserId : null }).where(eq(emailMessages.id, m.id));
  // Other waiting emails from the same address go to the same patient now.
  const others = m.fromEmail ? await d.select({ id: emailMessages.id }).from(emailMessages).where(and(eq(emailMessages.fromEmail, m.fromEmail), eq(emailMessages.status, "needs_patient"))) : [];
  for (const o of others) if (o.id !== m.id) await linkEmail(actor, { emailId: o.id, subjectKey: input.subjectKey });
  return { ok: true, assignedTo: who.who, task: !!taskId };
}

/** Not a patient (vendor, newsletter, etc.): hide it and ignore that address from now on. */
export async function ignoreEmailSender(actor: WorkspaceActor, emailId: number) {
  const d = await db();
  const [m] = await d.select().from(emailMessages).where(eq(emailMessages.id, emailId)).limit(1);
  if (!m) throw new WorkspaceError("Email not found.", "NOT_FOUND");
  if (m.fromEmail) {
    await d.insert(emailContacts).values({ email: m.fromEmail, kind: "ignore", source: "linked", createdByUserId: actor.id })
      .onDuplicateKeyUpdate({ set: { kind: "ignore", patientId: null, subjectKey: null, source: "linked", createdByUserId: actor.id } });
    await d.update(emailMessages).set({ status: "ignored" }).where(and(eq(emailMessages.fromEmail, m.fromEmail), eq(emailMessages.status, "needs_patient")));
  }
  await d.update(emailMessages).set({ status: "ignored" }).where(eq(emailMessages.id, m.id));
  if (m.taskId) {
    await d.update(workTasks).set({ status: "cancelled" }).where(and(eq(workTasks.id, m.taskId), inArray(workTasks.status, [...OPEN_STATUSES])));
    await d.insert(workTaskActivities).values({ taskId: m.taskId, userId: actor.id, type: "status_changed", meta: { to: "cancelled", reason: "not a patient email" } });
  }
  return { ok: true };
}

// ---- Import patient email addresses (Practice Fusion export) ----

export async function importPatientEmails(actor: WorkspaceActor, csv: string) {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) throw new WorkspaceError("That file has no rows.");
  const head = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (...names: RegExp[]) => head.findIndex((h) => names.some((n) => n.test(h)));
  const emailCol = col(/e-?mail/);
  const nameCol = col(/^patient( name)?$/, /^(full )?name$/);
  const firstCol = col(/^first( name)?$/);
  const lastCol = col(/^last( name)?$/);
  const dobCol = col(/^dob$/, /birth/);
  if (emailCol < 0 || dobCol < 0 || (nameCol < 0 && (firstCol < 0 || lastCol < 0))) {
    throw new WorkspaceError("The file needs an Email column, a DOB column, and a Patient name (or First and Last name) column.");
  }
  const d = await db();
  const people = await buildNameDobIndex();
  const existing = new Map((await d.select({ email: emailContacts.email, source: emailContacts.source }).from(emailContacts)).map((c) => [c.email, c.source]));
  const stats = { rows: rows.length - 1, withEmail: 0, matched: 0, added: 0, keptStaffLinks: 0, notFound: 0 };
  for (const r of rows.slice(1)) {
    const email = parseFromHeader(r[emailCol] ?? "").email;
    if (!email) continue;
    stats.withEmail++;
    const name = nameCol >= 0 ? r[nameCol] ?? "" : `${r[firstCol] ?? ""} ${r[lastCol] ?? ""}`;
    const dob = parseDateValue(r[dobCol] ?? "", { dob: true });
    const who = dob ? people.get(`${nameKey(name)}|${dob}`) : undefined;
    if (!who) { stats.notFound++; continue; }
    stats.matched++;
    if (existing.get(email) === "linked") { stats.keptStaffLinks++; continue; } // staff decisions win
    await d.insert(emailContacts).values({ email, kind: "patient", patientId: who.patientId, subjectKey: who.key, name: who.name.slice(0, 255), source: "import", createdByUserId: actor.id })
      .onDuplicateKeyUpdate({ set: { kind: "patient", patientId: who.patientId, subjectKey: who.key, name: who.name.slice(0, 255), source: "import" } });
    stats.added++;
  }
  await audit(actor, "manage_access", { entityType: "integration", description: `Imported patient email addresses: ${stats.added} saved of ${stats.withEmail}` });
  return stats;
}

// Exported for the admin page's list of how many addresses MyPCP knows.
export async function contactCounts() {
  const d = await db();
  const rows = await d.select({ kind: emailContacts.kind, source: emailContacts.source }).from(emailContacts).orderBy(asc(emailContacts.id));
  return { patients: rows.filter((r) => r.kind === "patient").length, imported: rows.filter((r) => r.source === "import").length, ignored: rows.filter((r) => r.kind === "ignore").length };
}

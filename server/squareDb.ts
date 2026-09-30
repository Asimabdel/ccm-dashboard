// Square payments. Square stays the source of truth for the money; MyPCP copies every payment
// (sync every few minutes + Square's webhook), matches the payer to a patient, sorts it into a
// category and an office, and lets the front desk send payment links and charge on a Square
// Terminal. Requests go out through the allowlist relay (ccm-app has no internet access).
//
// Square doesn't sign a BAA (payment processing is exempt from HIPAA), so MyPCP never sends it
// anything clinical: payment links and Terminal charges carry a plain name and a MyPCP reference
// number only. What a payment was for stays in MyPCP.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";
import { relayFetch } from "./egress";
import { sealSecret, openSecret } from "./secretBox";
import { appSettings, clinics, emailContacts, fhirPatients, squareCustomers, squarePayments, squareRefunds, squareRequests } from "../drizzle/schema";
import {
  DEXAFIT, SANDBOX_TEST_TERMINAL, guessCategory, isPaymentCategory, methodOf, money, paymentLinkText, squareItemName, clinicDayStart, clinicRange,
  type PaymentCategory, type RequestStatus,
} from "../shared/payments";
import { localDateStr } from "../shared/workforce";
import { nameKey } from "../shared/workspace";
import { normalizePhone, formatPhone } from "../shared/phone";
import { WorkspaceError, audit, buildNameIndex, buildPhoneIndex, officeClinicIds, searchSubjects, subjectCare, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const SQUARE_VERSION = "2026-09-16";
const CONFIG_KEY = "square";
const SYNC_KEY = "square_sync";
export const DEFAULT_WEBHOOK_URL = "https://mypcpcare.com/api/square/webhook";

type SquareEnv = "sandbox" | "production";
interface Terminal { deviceId: string; name: string; clinicId: number | null }
interface SquareConfig {
  env: SquareEnv;
  tokenEnc: string;
  locationId: string;
  locationName: string;
  merchantName: string;
  webhookKeyEnc: string;
  webhookUrl: string;
  /** Load payments from this clinic-local date on (YYYY-MM-DD). */
  historyFrom: string;
  terminals: Terminal[];
  /** Other Square devices (register, reader) seen on payments → the office they're at. */
  deviceClinics: Record<string, number>;
  pairing: { id: string; code: string; name: string; clinicId: number | null; pairBy: string | null } | null;
  /** Square team member id → name (who took the payment). */
  team: Record<string, string>;
  teamAt: string | null;
}
const EMPTY: SquareConfig = {
  env: "sandbox", tokenEnc: "", locationId: "", locationName: "", merchantName: "", webhookKeyEnc: "", webhookUrl: DEFAULT_WEBHOOK_URL,
  historyFrom: "", terminals: [], deviceClinics: {}, pairing: null, team: {}, teamAt: null,
};
interface SyncState { since: string | null; lastRunAt: string | null; lastOkAt: string | null; lastError: string | null; lastLoaded: number; lastWebhookAt: string | null }

async function readSetting<T>(key: string): Promise<T | null> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}
async function writeSetting(key: string, value: unknown, userId: number | null) {
  await (await db()).insert(appSettings).values({ key, value, updatedByUserId: userId }).onDuplicateKeyUpdate({ set: { value, updatedByUserId: userId } });
}
async function config(): Promise<SquareConfig> {
  return { ...EMPTY, ...((await readSetting<SquareConfig>(CONFIG_KEY)) ?? {}) };
}
async function syncState(): Promise<SyncState> {
  return { since: null, lastRunAt: null, lastOkAt: null, lastError: null, lastLoaded: 0, lastWebhookAt: null, ...((await readSetting<SyncState>(SYNC_KEY)) ?? {}) };
}
async function saveSync(patch: Partial<SyncState>) {
  await writeSetting(SYNC_KEY, { ...(await syncState()), ...patch }, null);
}
const ready = (c: SquareConfig) => !!(c.tokenEnc && c.locationId);
async function readyConfig() {
  const c = await config();
  if (!ready(c)) throw new WorkspaceError("Square isn't connected yet. An admin can connect it in Integrations.");
  return c;
}

// ---------------------------------------------------------------------------
// Square's API (through the relay)
// ---------------------------------------------------------------------------

function apiBase(env: SquareEnv) {
  // Local development only: point at a stand-in Square server with made-up data.
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.SQUARE_API_BASE) return process.env.SQUARE_API_BASE.replace(/\/$/, "");
  return env === "production" ? "https://connect.squareup.com/v2" : "https://connect.squareupsandbox.com/v2";
}

type Json = Record<string, any>;

async function sq(c: Pick<SquareConfig, "env" | "tokenEnc">, path: string, init: { method?: "GET" | "POST" | "DELETE"; body?: unknown; token?: string } = {}): Promise<Json> {
  const token = init.token ?? openSecret(c.tokenEnc);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Square-Version": SQUARE_VERSION, Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await relayFetch(`${apiBase(c.env)}${path}`, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  const text = await res.text();
  let body: Json = {};
  try { body = text ? (JSON.parse(text) as Json) : {}; } catch { body = {}; }
  if (!res.ok) {
    const e = (body.errors as { code?: string; detail?: string; category?: string }[] | undefined)?.[0];
    if (res.status === 401) throw new WorkspaceError("Square didn't accept the access token. Check that it's the right one for Sandbox or Production, and save it again.");
    if (res.status === 403) throw new WorkspaceError(`The Square access token isn't allowed to do this${e?.detail ? ` (${e.detail})` : ""}.`);
    if (res.status === 429) throw new WorkspaceError("Square's limit was reached for now. Try again in a minute.");
    throw new WorkspaceError(`Square: ${e?.detail ?? e?.code ?? `error ${res.status}`}`);
  }
  return body;
}

const cents = (m: { amount?: number | string | null } | null | undefined) => Math.round(Number(m?.amount ?? 0)) || 0;
const toDate = (iso: unknown) => (typeof iso === "string" && !Number.isNaN(Date.parse(iso)) ? new Date(iso) : null);
const cut = (s: unknown, n: number) => (typeof s === "string" && s.trim() ? s.trim().slice(0, n) : null);
const patientIdOf = (key: string | null | undefined) => { const m = /^p:(\d+)$/.exec(key ?? ""); return m ? Number(m[1]) : null; };

// ---------------------------------------------------------------------------
// Connection (admin)
// ---------------------------------------------------------------------------

export async function squareStatus(actor: WorkspaceActor) {
  const c = await config();
  const s = await syncState();
  const d = await db();
  const clinicRows = await d.select({ id: clinics.id, name: clinics.name }).from(clinics);
  const clinicName = new Map(clinicRows.map((x) => [x.id, x.name]));
  const terminals = [...c.terminals, ...(c.env === "sandbox" && ready(c) ? [{ ...SANDBOX_TEST_TERMINAL, clinicId: null }] : [])]
    // Office managers only see the Terminals at their office (and any not placed yet).
    .filter((t) => !actor.clinicIds || t.clinicId == null || actor.clinicIds.includes(t.clinicId))
    .map((t) => ({ ...t, clinicName: t.clinicId ? clinicName.get(t.clinicId) ?? null : null, test: t.deviceId === SANDBOX_TEST_TERMINAL.deviceId }));
  const base = { configured: ready(c), env: c.env, locationName: c.locationName || null, terminals, clinics: clinicRows, lastOkAt: s.lastOkAt, lastRunAt: s.lastRunAt, lastError: s.lastError };
  if (actor.role !== "admin") return { ...base, admin: null };
  const seen = await d.select({ deviceId: squarePayments.deviceId, deviceName: sql<string | null>`max(${squarePayments.deviceName})`, n: sql<number>`count(*)` })
    .from(squarePayments).where(isNotNull(squarePayments.deviceId)).groupBy(squarePayments.deviceId);
  const [counts] = await d.select({ n: sql<number>`count(*)` }).from(squarePayments);
  return {
    ...base,
    admin: {
      tokenSaved: !!c.tokenEnc,
      locationId: c.locationId || null,
      merchantName: c.merchantName || null,
      webhookKeySaved: !!c.webhookKeyEnc,
      webhookUrl: c.webhookUrl || DEFAULT_WEBHOOK_URL,
      historyFrom: c.historyFrom || null,
      pairing: c.pairing,
      devicesSeen: seen
        .filter((x) => x.deviceId && !c.terminals.some((t) => t.deviceId === x.deviceId))
        .map((x) => ({ deviceId: x.deviceId!, name: x.deviceName, payments: Number(x.n), clinicId: c.deviceClinics[x.deviceId!] ?? null })),
      payments: Number(counts?.n ?? 0),
      lastLoaded: s.lastLoaded,
      lastWebhookAt: s.lastWebhookAt,
      since: s.since,
    },
  };
}

async function listLocations(c: Pick<SquareConfig, "env" | "tokenEnc">, token?: string) {
  const r = await sq(c, "/locations", { token });
  return ((r.locations ?? []) as Json[]).map((l) => ({ id: String(l.id), name: String(l.name ?? l.business_name ?? l.id), status: String(l.status ?? ""), currency: String(l.currency ?? "USD") }));
}

export async function saveSquareConfig(actor: WorkspaceActor, input: { env: SquareEnv; token?: string | null; webhookKey?: string | null; webhookUrl?: string | null; historyFrom?: string | null }) {
  const prev = await config();
  const token = input.token?.trim() || null;
  const envChanged = input.env !== prev.env;
  if (envChanged && !token) throw new WorkspaceError(`Paste the ${input.env === "production" ? "Production" : "Sandbox"} access token too (each has its own).`);
  const next: SquareConfig = { ...prev, env: input.env };
  let locations: Awaited<ReturnType<typeof listLocations>> | null = null;
  if (token) {
    // Check the token before keeping it.
    locations = (await listLocations({ env: input.env, tokenEnc: "" }, token)).filter((l) => l.status !== "INACTIVE");
    next.tokenEnc = sealSecret(token);
    const keep = locations.find((l) => l.id === prev.locationId);
    const only = locations.length === 1 ? locations[0] : null;
    next.locationId = (keep ?? only)?.id ?? "";
    next.locationName = (keep ?? only)?.name ?? "";
    try { next.merchantName = String((await sq(next, "/merchants/me")).merchant?.business_name ?? ""); } catch { /* optional */ }
    if (envChanged || !keep) { next.terminals = []; next.deviceClinics = {}; next.pairing = null; next.team = {}; next.teamAt = null; }
  }
  if (input.webhookKey?.trim()) next.webhookKeyEnc = sealSecret(input.webhookKey.trim());
  if (input.webhookUrl?.trim()) {
    const u = input.webhookUrl.trim();
    if (!/^https:\/\/[^\s]+\/api\/square\/webhook$/.test(u)) throw new WorkspaceError("The webhook address should end in /api/square/webhook.");
    next.webhookUrl = u;
  }
  if (input.historyFrom !== undefined) {
    const h = input.historyFrom?.trim() || "";
    if (h && !/^\d{4}-\d{2}-\d{2}$/.test(h)) throw new WorkspaceError("Pick a start date for the payment history.");
    if (h !== prev.historyFrom) await saveSync({ since: null });
    next.historyFrom = h;
  }
  if (token && (envChanged || next.locationId !== prev.locationId)) await saveSync({ since: null });
  await writeSetting(CONFIG_KEY, next, actor.id);
  await audit(actor, "manage_access", { entityType: "integration", description: `Square settings saved (${next.env}${token ? ", new access token" : ""}${input.webhookKey ? ", webhook key" : ""})` });
  return { ok: true, locations, locationId: next.locationId || null };
}

export async function squareLocations() {
  const c = await config();
  if (!c.tokenEnc) throw new WorkspaceError("Save the Square access token first.");
  return listLocations(c);
}

export async function setSquareLocation(actor: WorkspaceActor, locationId: string) {
  const c = await config();
  const loc = (await squareLocations()).find((l) => l.id === locationId);
  if (!loc) throw new WorkspaceError("That location isn't on this Square account.");
  if (loc.id !== c.locationId) {
    await writeSetting(CONFIG_KEY, { ...c, locationId: loc.id, locationName: loc.name, terminals: [], deviceClinics: {}, pairing: null }, actor.id);
    await saveSync({ since: null });
  }
  await audit(actor, "manage_access", { entityType: "integration", description: `Square location set to ${loc.name}` });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Square Terminals: pair with a device code, and which office each device is at
// ---------------------------------------------------------------------------

export async function pairTerminal(actor: WorkspaceActor, input: { name: string; clinicId: number | null }) {
  const c = await readyConfig();
  const r = await sq(c, "/devices/codes", {
    method: "POST",
    body: { idempotency_key: randomUUID(), device_code: { product_type: "TERMINAL_API", location_id: c.locationId, name: input.name.trim().slice(0, 60) || "MyPCP Terminal" } },
  });
  const dc = r.device_code as Json;
  const pairing = { id: String(dc.id), code: String(dc.code), name: String(dc.name ?? input.name), clinicId: input.clinicId, pairBy: typeof dc.pair_by === "string" ? dc.pair_by : null };
  await writeSetting(CONFIG_KEY, { ...c, pairing }, actor.id);
  await audit(actor, "manage_access", { entityType: "integration", description: `Square Terminal pairing code created (${pairing.name})` });
  return pairing;
}

export async function checkPairing(actor: WorkspaceActor) {
  const c = await readyConfig();
  if (!c.pairing) return { status: "none" as const };
  const dc = (await sq(c, `/devices/codes/${encodeURIComponent(c.pairing.id)}`)).device_code as Json;
  const status = String(dc?.status ?? "");
  if (status === "PAIRED" && dc.device_id) {
    const t: Terminal = { deviceId: String(dc.device_id), name: c.pairing.name, clinicId: c.pairing.clinicId };
    await writeSetting(CONFIG_KEY, { ...c, pairing: null, terminals: [...c.terminals.filter((x) => x.deviceId !== t.deviceId), t] }, actor.id);
    await audit(actor, "manage_access", { entityType: "integration", description: `Square Terminal paired (${t.name})` });
    await resettleDevice(t.deviceId);
    return { status: "paired" as const, name: t.name };
  }
  if (status === "EXPIRED") {
    await writeSetting(CONFIG_KEY, { ...c, pairing: null }, actor.id);
    return { status: "expired" as const };
  }
  return { status: "waiting" as const };
}

export async function cancelPairing(actor: WorkspaceActor) {
  const c = await config();
  await writeSetting(CONFIG_KEY, { ...c, pairing: null }, actor.id);
  return { ok: true };
}

/** Which office a device is at: paired Terminals and other devices seen on payments. */
export async function setDeviceClinic(actor: WorkspaceActor, input: { deviceId: string; clinicId: number | null; name?: string | null }) {
  const c = await config();
  const terminal = c.terminals.find((t) => t.deviceId === input.deviceId);
  const next = { ...c };
  if (terminal) {
    next.terminals = c.terminals.map((t) => (t.deviceId === input.deviceId ? { ...t, clinicId: input.clinicId, name: input.name?.trim().slice(0, 60) || t.name } : t));
  } else {
    const map = { ...c.deviceClinics };
    if (input.clinicId) map[input.deviceId] = input.clinicId; else delete map[input.deviceId];
    next.deviceClinics = map;
  }
  await writeSetting(CONFIG_KEY, next, actor.id);
  await resettleDevice(input.deviceId);
  return { ok: true };
}

export async function removeTerminal(actor: WorkspaceActor, deviceId: string) {
  const c = await config();
  await writeSetting(CONFIG_KEY, { ...c, terminals: c.terminals.filter((t) => t.deviceId !== deviceId) }, actor.id);
  await audit(actor, "manage_access", { entityType: "integration", description: "Square Terminal removed from MyPCP" });
  return { ok: true };
}

function deviceClinic(c: SquareConfig, deviceId: string | null): number | null {
  if (!deviceId) return null;
  return c.terminals.find((t) => t.deviceId === deviceId)?.clinicId ?? c.deviceClinics[deviceId] ?? null;
}

async function resettleDevice(deviceId: string) {
  const ids = (await (await db()).select({ id: squarePayments.id }).from(squarePayments).where(eq(squarePayments.deviceId, deviceId))).map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) await settle(ids.slice(i, i + 200));
}

// ---------------------------------------------------------------------------
// Copying payments from Square
// ---------------------------------------------------------------------------

function paymentRow(p: Json, now: Date) {
  const dev = (p.device_details ?? p.card_details?.device_details ?? null) as Json | null;
  const card = (p.card_details?.card ?? null) as Json | null;
  return {
    id: String(p.id),
    createdAt: toDate(p.created_at) ?? now,
    updatedAtSq: toDate(p.updated_at),
    status: String(p.status ?? "PENDING").slice(0, 20),
    sourceType: cut(p.source_type, 30),
    amountCents: cents(p.amount_money),
    tipCents: cents(p.tip_money),
    totalCents: cents(p.total_money ?? p.amount_money),
    refundedCents: cents(p.refunded_money),
    feeCents: ((p.processing_fee ?? []) as Json[]).reduce((s, f) => s + cents(f.amount_money), 0),
    cardBrand: cut(card?.card_brand ?? p.wallet_details?.brand, 30),
    cardLast4: cut(card?.last_4, 4),
    customerId: cut(p.customer_id, 64),
    orderId: cut(p.order_id, 64),
    locationId: cut(p.location_id, 64),
    deviceId: cut(dev?.device_id, 64),
    deviceName: cut(dev?.device_name, 120),
    teamMemberId: cut(p.team_member_id ?? p.employee_id, 64),
    note: cut(p.note, 500),
    receiptUrl: cut(p.receipt_url, 500),
    receiptNumber: cut(p.receipt_number, 20),
    syncedAt: now,
  };
}

/** Save payments from Square (API or webhook), then fill in customers, items, refunds, patient, category and office. */
async function ingestPayments(c: SquareConfig, list: Json[], opts: { enrich?: boolean } = {}) {
  const mine = list.filter((p) => p?.id && (!p.location_id || p.location_id === c.locationId));
  if (!mine.length) return 0;
  const d = await db();
  const now = new Date();
  for (const p of mine) {
    const row = paymentRow(p, now);
    const { id: _id, ...squareFields } = row;
    await d.insert(squarePayments).values(row).onDuplicateKeyUpdate({ set: squareFields });
  }
  const ids = mine.map((p) => String(p.id));
  if (opts.enrich !== false) {
    await loadRefunds(c, mine).catch((e) => console.error("[square] refunds:", (e as Error).message));
    await loadCustomers(c, mine.map((p) => p.customer_id).filter(Boolean)).catch((e) => console.error("[square] customers:", (e as Error).message));
    await loadItems(c, ids).catch((e) => console.error("[square] orders:", (e as Error).message));
  }
  await settle(ids);
  return mine.length;
}

async function loadRefunds(c: SquareConfig, list: Json[]) {
  const d = await db();
  const wanted = Array.from(new Set(list.flatMap((p) => (p.refund_ids ?? []) as string[])));
  if (!wanted.length) return;
  const known = new Map((await d.select({ id: squareRefunds.id, status: squareRefunds.status }).from(squareRefunds).where(inArray(squareRefunds.id, wanted))).map((r) => [r.id, r.status]));
  for (const id of wanted) {
    const st = known.get(id);
    if (st === "COMPLETED" || st === "REJECTED" || st === "FAILED") continue;
    const r = (await sq(c, `/refunds/${encodeURIComponent(id)}`)).refund as Json | undefined;
    if (r) await saveRefund(r);
  }
}

async function saveRefund(r: Json) {
  const row = {
    id: String(r.id), paymentId: String(r.payment_id ?? ""), status: String(r.status ?? "PENDING").slice(0, 20), amountCents: cents(r.amount_money),
    reason: cut(r.reason, 255), createdAt: toDate(r.created_at) ?? new Date(), syncedAt: new Date(),
  };
  const { id: _id, ...rest } = row;
  await (await db()).insert(squareRefunds).values(row).onDuplicateKeyUpdate({ set: rest });
}

async function loadCustomers(c: SquareConfig, ids: string[]) {
  const d = await db();
  const unique = Array.from(new Set(ids.map(String)));
  if (!unique.length) return;
  const known = new Set((await d.select({ id: squareCustomers.id }).from(squareCustomers).where(inArray(squareCustomers.id, unique))).map((r) => r.id));
  const missing = unique.filter((id) => !known.has(id));
  const fresh: (typeof squareCustomers.$inferInsert)[] = [];
  for (let i = 0; i < missing.length; i += 100) {
    const r = await sq(c, "/customers/bulk-retrieve", { method: "POST", body: { customer_ids: missing.slice(i, i + 100) } });
    for (const [id, v] of Object.entries((r.responses ?? {}) as Record<string, Json>)) {
      const cu = v?.customer as Json | undefined;
      if (!cu) continue;
      fresh.push({ id, givenName: cut(cu.given_name, 120), familyName: cut(cu.family_name, 120), phone: cut(cu.phone_number, 40), email: cut(cu.email_address, 320)?.toLowerCase() ?? null, syncedAt: new Date() });
    }
  }
  if (!fresh.length) return;
  await matchCustomers(fresh);
  for (const cu of fresh) {
    const { id: _id, ...rest } = cu;
    await d.insert(squareCustomers).values(cu).onDuplicateKeyUpdate({ set: rest });
  }
}

/** Email address → patient (practice mailbox links + Practice Fusion chart copy). */
async function buildEmailIndex() {
  const d = await db();
  const out = new Map<string, { key: string; name: string }>();
  for (const e of await d.select({ email: emailContacts.email, patientId: emailContacts.patientId, subjectKey: emailContacts.subjectKey, name: emailContacts.name }).from(emailContacts).where(eq(emailContacts.kind, "patient"))) {
    const key = e.patientId ? `p:${e.patientId}` : e.subjectKey;
    if (key && e.name) out.set(e.email.toLowerCase(), { key, name: e.name });
  }
  for (const f of await d.select({ email: fhirPatients.email, patientId: fhirPatients.patientId, subjectKey: fhirPatients.subjectKey, name: fhirPatients.name }).from(fhirPatients).where(isNotNull(fhirPatients.email))) {
    const em = f.email?.toLowerCase();
    if (em && f.name && !out.has(em)) out.set(em, { key: f.patientId ? `p:${f.patientId}` : f.subjectKey, name: f.name });
  }
  return out;
}

/**
 * Match Square customers to patients. Linked automatically only when the phone number (or email)
 * on file AND the last name agree; a full-name match alone is only suggested for staff to confirm.
 */
export async function matchCustomers(list: (typeof squareCustomers.$inferInsert)[]) {
  const todo = list.filter((cu) => !cu.subjectKey && cu.matchedBy !== "manual");
  if (!todo.length) return;
  const [phones, emails, names] = await Promise.all([buildPhoneIndex(), buildEmailIndex(), buildNameIndex()]);
  for (const cu of todo) {
    const r = matchOne(cu, phones, emails, names);
    Object.assign(cu, r);
  }
}

type Hit = { key: string; name: string };
export function matchOne(
  cu: { givenName?: string | null; familyName?: string | null; phone?: string | null; email?: string | null },
  phones: Map<string, Hit>, emails: Map<string, Hit>, names: Map<string, Hit[]>,
): { subjectKey: string | null; patientName: string | null; matchedBy: string | null; suggestKey: string | null; suggestName: string | null } {
  const none = { subjectKey: null, patientName: null, matchedBy: null, suggestKey: null, suggestName: null };
  const last = nameKey(cu.familyName ?? "").split(" ").filter(Boolean).pop() ?? "";
  const sameLast = (name: string) => !!last && nameKey(name).split(" ").includes(last);
  const phone = normalizePhone(cu.phone ?? null);
  const byPhone = phone ? phones.get(phone) : undefined;
  if (byPhone && sameLast(byPhone.name)) return { ...none, subjectKey: byPhone.key, patientName: byPhone.name, matchedBy: "phone" };
  const byEmail = cu.email ? emails.get(cu.email.toLowerCase()) : undefined;
  if (byEmail && sameLast(byEmail.name)) return { ...none, subjectKey: byEmail.key, patientName: byEmail.name, matchedBy: "email" };
  const full = nameKey(`${cu.givenName ?? ""} ${cu.familyName ?? ""}`);
  const hits = full ? names.get(full) : undefined;
  if (hits?.length === 1) return { ...none, suggestKey: hits[0]!.key, suggestName: hits[0]!.name };
  return none;
}

/** What was rung up (Square order line items), for sorting payments into categories. */
async function loadItems(c: SquareConfig, paymentIds: string[]) {
  const d = await db();
  const rows = await d.select({ id: squarePayments.id, orderId: squarePayments.orderId }).from(squarePayments)
    .where(and(inArray(squarePayments.id, paymentIds), isNull(squarePayments.items), isNotNull(squarePayments.orderId)));
  const orderIds = Array.from(new Set(rows.map((r) => r.orderId!)));
  for (let i = 0; i < orderIds.length; i += 100) {
    const r = await sq(c, "/orders/batch-retrieve", { method: "POST", body: { location_id: c.locationId, order_ids: orderIds.slice(i, i + 100) } });
    for (const o of (r.orders ?? []) as Json[]) {
      const items = ((o.line_items ?? []) as Json[])
        .map((li) => `${String(li.name ?? li.variation_name ?? "Custom amount")}${Number(li.quantity) > 1 ? ` ×${li.quantity}` : ""}`)
        .join(", ").slice(0, 500) || "Custom amount";
      await d.update(squarePayments).set({ items }).where(eq(squarePayments.orderId, String(o.id)));
    }
  }
}

/** Fill in each payment's patient, category and office from its request, customer, device and patient. Staff choices always win. */
async function settle(ids: string[]) {
  if (!ids.length) return;
  const d = await db();
  const c = await config();
  const rows = await d.select().from(squarePayments).where(inArray(squarePayments.id, ids));
  const custIds = Array.from(new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x)));
  const customers = new Map(custIds.length ? (await d.select().from(squareCustomers).where(inArray(squareCustomers.id, custIds))).map((cu) => [cu.id, cu]) : []);
  const orderIds = rows.map((r) => r.orderId).filter((x): x is string => !!x);
  const reqs = await d.select().from(squareRequests).where(or(
    orderIds.length ? inArray(squareRequests.orderId, orderIds) : sql`false`,
    inArray(squareRequests.paymentId, ids),
  ));
  const clinicOfSubject = new Map<string, number | null>();
  const subjectClinic = async (key: string) => {
    if (!clinicOfSubject.has(key)) clinicOfSubject.set(key, (await subjectCare(key).catch(() => null))?.clinicId ?? null);
    return clinicOfSubject.get(key) ?? null;
  };
  for (const r of rows) {
    const req = reqs.find((x) => (r.orderId && x.orderId === r.orderId) || x.paymentId === r.id) ?? null;
    const cu = r.customerId ? customers.get(r.customerId) ?? null : null;
    const patch: Partial<typeof squarePayments.$inferInsert> = {};
    if (req && r.requestId !== req.id) patch.requestId = req.id;
    if (req && r.status === "COMPLETED" && req.status !== "paid") {
      await d.update(squareRequests).set({ status: "paid", paymentId: r.id, paidAt: r.createdAt, squareStatus: "COMPLETED" }).where(eq(squareRequests.id, req.id));
    }
    // Category
    let category = r.category as PaymentCategory | null;
    if (r.categorySource !== "manual") {
      const reqCat = req && isPaymentCategory(req.category) ? req.category : null;
      const guess = reqCat ?? guessCategory(`${r.items ?? ""} ${r.note ?? ""}`);
      const source = reqCat ? "request" : guess ? "auto" : null;
      category = guess;
      if (r.category !== guess || r.categorySource !== source) { patch.category = guess; patch.categorySource = source; }
    }
    // Patient (DexaFit is a separate business: never linked to a patient automatically)
    let subjectKey = r.subjectKey;
    if (r.matchSource !== "manual") {
      const from = category === DEXAFIT ? null
        : req?.subjectKey ? { key: req.subjectKey, name: req.patientName, source: "request" }
        : cu?.subjectKey ? { key: cu.subjectKey, name: cu.patientName, source: "customer" }
        : null;
      subjectKey = from?.key ?? null;
      if (r.subjectKey !== subjectKey || r.matchSource !== (from?.source ?? null)) {
        Object.assign(patch, { subjectKey, patientId: patientIdOf(subjectKey), patientName: from?.name ?? null, matchSource: from?.source ?? null });
      }
    }
    // Office
    if (r.clinicSource !== "manual") {
      const dev = deviceClinic(c, r.deviceId);
      const pat = !req?.clinicId && !dev && subjectKey ? await subjectClinic(subjectKey) : null;
      const clinicId = req?.clinicId ?? dev ?? pat ?? null;
      const source = req?.clinicId ? "request" : dev ? "device" : pat ? "patient" : null;
      if (r.clinicId !== clinicId || r.clinicSource !== source) { patch.clinicId = clinicId; patch.clinicSource = source; }
    }
    if (Object.keys(patch).length) await d.update(squarePayments).set(patch).where(eq(squarePayments.id, r.id));
  }
}

/** Every few minutes (EventBridge) and on request: copy new and changed payments from Square. */
export async function runSquareSync(opts: { deadline: number; manual?: boolean }) {
  const c = await config();
  if (!ready(c)) return { skipped: "Square isn't connected" };
  const state = await syncState();
  const startedAt = new Date().toISOString();
  const from = c.historyFrom || localDateStr(new Date(Date.now() - 90 * 86_400_000));
  let since = state.since ?? clinicDayStart(from).toISOString();
  let loaded = 0;
  let cursor: string | undefined;
  try {
    await refreshTeam(c).catch(() => { /* optional: needs the employees permission */ });
    do {
      const qs = new URLSearchParams({ location_id: c.locationId, updated_at_begin_time: since, sort_field: "UPDATED_AT", sort_order: "ASC", limit: "100" });
      if (cursor) qs.set("cursor", cursor);
      const r = await sq(c, `/payments?${qs.toString()}`);
      const list = (r.payments ?? []) as Json[];
      loaded += await ingestPayments(c, list);
      const last = list.map((p) => String(p.updated_at ?? "")).filter(Boolean).sort().pop();
      cursor = typeof r.cursor === "string" && r.cursor ? r.cursor : undefined;
      // Resume point for the next run (a page may repeat; saving is idempotent).
      if (last && last > since) since = last;
    } while (cursor && Date.now() < opts.deadline);
    await refreshOpenRequests(c, opts.deadline).catch((e) => console.error("[square] requests:", (e as Error).message));
    await saveSync({ since, lastRunAt: startedAt, lastOkAt: startedAt, lastError: null, lastLoaded: loaded });
    return { loaded, since, more: !!cursor };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await saveSync({ since, lastRunAt: startedAt, lastError: msg, lastLoaded: loaded });
    if (opts.manual) throw e;
    return { error: msg, loaded };
  }
}

async function refreshTeam(c: SquareConfig) {
  if (c.teamAt && Date.now() - Date.parse(c.teamAt) < 86_400_000) return;
  const r = await sq(c, "/team-members/search", { method: "POST", body: { query: { filter: { location_ids: [c.locationId] } }, limit: 200 } });
  const team: Record<string, string> = {};
  for (const m of (r.team_members ?? []) as Json[]) team[String(m.id)] = `${m.given_name ?? ""} ${m.family_name ?? ""}`.trim() || "Team member";
  const fresh = await config();
  await writeSetting(CONFIG_KEY, { ...fresh, team, teamAt: new Date().toISOString() }, null);
}

/** Terminal charges still waiting from the last day (paid payment links show up with their payment in the sync). */
async function refreshOpenRequests(c: SquareConfig, deadline: number) {
  const d = await db();
  const open = await d.select().from(squareRequests)
    .where(and(eq(squareRequests.status, "open"), eq(squareRequests.kind, "terminal"), gte(squareRequests.createdAt, new Date(Date.now() - 86_400_000))))
    .orderBy(desc(squareRequests.createdAt)).limit(10);
  for (const r of open) {
    if (Date.now() > deadline) break;
    await checkRequest(c, r).catch(() => {});
  }
}

async function checkRequest(c: SquareConfig, r: typeof squareRequests.$inferSelect) {
  const d = await db();
  if (!r.squareId) return;
  if (r.kind === "terminal") {
    const co = (await sq(c, `/terminals/checkouts/${encodeURIComponent(r.squareId)}`)).checkout as Json | undefined;
    if (co) await applyCheckout(c, co);
    return;
  }
  if (!r.orderId) return;
  const o = (await sq(c, `/orders/${encodeURIComponent(r.orderId)}`)).order as Json | undefined;
  const paymentIds = ((o?.tenders ?? []) as Json[]).map((t) => t.payment_id).filter(Boolean) as string[];
  for (const pid of paymentIds) {
    const p = (await sq(c, `/payments/${encodeURIComponent(pid)}`)).payment as Json | undefined;
    if (p) await ingestPayments(c, [p]);
  }
  if (!paymentIds.length && o?.state === "CANCELED") await d.update(squareRequests).set({ status: "canceled", squareStatus: "CANCELED" }).where(eq(squareRequests.id, r.id));
}

async function applyCheckout(c: SquareConfig, co: Json) {
  const d = await db();
  const [r] = await d.select().from(squareRequests).where(and(eq(squareRequests.kind, "terminal"), eq(squareRequests.squareId, String(co.id)))).limit(1);
  if (!r) return;
  const st = String(co.status ?? "");
  const paymentIds = ((co.payment_ids ?? []) as string[]).filter(Boolean);
  const status: RequestStatus = st === "COMPLETED" ? "paid" : st === "CANCELED" ? "canceled" : r.status === "paid" ? "paid" : "open";
  await d.update(squareRequests).set({ squareStatus: st.slice(0, 24), status, paymentId: paymentIds[0] ?? r.paymentId }).where(eq(squareRequests.id, r.id));
  for (const pid of paymentIds) {
    const p = (await sq(c, `/payments/${encodeURIComponent(pid)}`)).payment as Json | undefined;
    if (p) await ingestPayments(c, [p]);
  }
}

// ---------------------------------------------------------------------------
// Square's webhook (instant updates; the sync above is the safety net)
// ---------------------------------------------------------------------------

export function squareSignature(key: string, url: string, rawBody: string) {
  return createHmac("sha256", key).update(url + rawBody).digest("base64");
}

export function signatureMatches(expected: string, got: string) {
  const a = Buffer.from(expected), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleSquareWebhook(raw: Buffer, signature: string): Promise<{ status: number }> {
  const c = await config();
  if (!c.webhookKeyEnc) return { status: 404 };
  const body = raw.toString("utf8");
  if (!signature || !signatureMatches(squareSignature(openSecret(c.webhookKeyEnc), c.webhookUrl || DEFAULT_WEBHOOK_URL, body), signature)) return { status: 401 };
  let ev: Json;
  try { ev = JSON.parse(body) as Json; } catch { return { status: 400 }; }
  await saveSync({ lastWebhookAt: new Date().toISOString() });
  if (!ready(c)) return { status: 200 };
  const type = String(ev.type ?? "");
  const obj = (ev.data?.object ?? {}) as Json;
  try {
    if (type.startsWith("payment.") && obj.payment) await ingestPayments(c, [obj.payment as Json]);
    else if (type.startsWith("refund.") && obj.refund) {
      await saveRefund(obj.refund as Json);
      const pid = (obj.refund as Json).payment_id;
      if (pid) {
        const p = (await sq(c, `/payments/${encodeURIComponent(String(pid))}`)).payment as Json | undefined;
        if (p) await ingestPayments(c, [p]);
      }
    } else if (type.startsWith("terminal.checkout.") && obj.checkout) await applyCheckout(c, obj.checkout as Json);
  } catch (e) {
    // Square retries failed deliveries, and the sync catches anything missed.
    console.error("[square] webhook:", (e as Error).message);
    return { status: 500 };
  }
  return { status: 200 };
}

// ---------------------------------------------------------------------------
// Who sees what: admins everything; the front desk every office (not DexaFit);
// office managers only payments at their office.
// ---------------------------------------------------------------------------

export interface PaymentFilter {
  from: string;
  to: string;
  clinicId?: number | null;
  business?: "clinic" | "dexafit" | "all";
  category?: PaymentCategory | "none" | null;
  view?: "all" | "needs_patient";
  q?: string | null;
}

function scopeConds(actor: WorkspaceActor, f: { clinicId?: number | null; business?: PaymentFilter["business"] }): SQL[] {
  const conds: SQL[] = [];
  const business = actor.role === "admin" ? f.business ?? "clinic" : "clinic";
  if (business === "clinic") conds.push(or(isNull(squarePayments.category), ne(squarePayments.category, DEXAFIT))!);
  if (business === "dexafit") conds.push(eq(squarePayments.category, DEXAFIT));
  if (actor.clinicIds) conds.push(actor.clinicIds.length ? inArray(squarePayments.clinicId, actor.clinicIds) : sql`false`);
  if (f.clinicId === 0) conds.push(isNull(squarePayments.clinicId));
  else if (f.clinicId) conds.push(eq(squarePayments.clinicId, f.clinicId));
  return conds;
}

async function assertPaymentInScope(actor: WorkspaceActor, id: string) {
  const [p] = await (await db()).select().from(squarePayments).where(and(eq(squarePayments.id, id), ...scopeConds(actor, { business: "all" }))).limit(1);
  if (!p) throw new WorkspaceError("That payment isn't available.", "NOT_FOUND");
  return p;
}

async function namesFor(rows: { clinicId: number | null; teamMemberId: string | null; customerId: string | null }[]) {
  const d = await db();
  const c = await config();
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((x) => [x.id, x.name]));
  const custIds = Array.from(new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x)));
  const customers = new Map(custIds.length ? (await d.select().from(squareCustomers).where(inArray(squareCustomers.id, custIds))).map((cu) => [cu.id, cu]) : []);
  return {
    clinic: (id: number | null) => (id ? clinicName.get(id) ?? null : null),
    team: (id: string | null) => (id ? c.team[id] ?? null : null),
    customer: (id: string | null) => (id ? customers.get(id) ?? null : null),
  };
}

type PaymentRow = typeof squarePayments.$inferSelect;
function view(r: PaymentRow, n: Awaited<ReturnType<typeof namesFor>>, admin: boolean) {
  const cu = n.customer(r.customerId);
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    status: r.status,
    sourceType: r.sourceType,
    method: methodOf(r.sourceType),
    cardBrand: r.cardBrand,
    cardLast4: r.cardLast4,
    amountCents: r.amountCents,
    tipCents: r.tipCents,
    totalCents: r.totalCents,
    refundedCents: r.refundedCents,
    feeCents: admin ? r.feeCents : null,
    payer: cu ? `${cu.givenName ?? ""} ${cu.familyName ?? ""}`.trim() || null : null,
    payerPhoneLast4: cu?.phone ? normalizePhone(cu.phone)?.slice(-4) ?? null : null,
    suggest: !r.subjectKey && cu?.suggestKey ? { key: cu.suggestKey, name: cu.suggestName } : null,
    items: r.items,
    note: r.note,
    receiptUrl: r.receiptUrl,
    category: r.category as PaymentCategory | null,
    categorySource: r.categorySource,
    subjectKey: r.subjectKey,
    patientId: r.patientId,
    patientName: r.patientName,
    matchSource: r.matchSource,
    clinicId: r.clinicId,
    clinicName: n.clinic(r.clinicId),
    clinicSource: r.clinicSource,
    deviceName: r.deviceName,
    takenBy: n.team(r.teamMemberId),
    requestId: r.requestId,
    memo: r.memo,
  };
}
export type PaymentView = ReturnType<typeof view>;

function rangeOf(f: { from: string; to: string }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.from) || !/^\d{4}-\d{2}-\d{2}$/.test(f.to) || f.from > f.to) throw new WorkspaceError("Pick a date range.");
  return clinicRange(f.from, f.to);
}

/** The Payments page: totals for the range and the payments themselves. */
export async function listPayments(actor: WorkspaceActor, f: PaymentFilter) {
  const d = await db();
  const { start, end } = rangeOf(f);
  const admin = actor.role === "admin";
  const scope = scopeConds(actor, f);
  const inRange = [gte(squarePayments.createdAt, start), lt(squarePayments.createdAt, end), ...scope];
  const all = await d.select().from(squarePayments).where(and(...inRange)).orderBy(desc(squarePayments.createdAt)).limit(5000);
  const refunds = await d.select({ amountCents: squareRefunds.amountCents, category: squarePayments.category, method: squarePayments.sourceType })
    .from(squareRefunds).innerJoin(squarePayments, eq(squarePayments.id, squareRefunds.paymentId))
    .where(and(eq(squareRefunds.status, "COMPLETED"), gte(squareRefunds.createdAt, start), lt(squareRefunds.createdAt, end), ...scope));

  const paid = all.filter((p) => p.status === "COMPLETED");
  const sum = (xs: { totalCents: number }[]) => xs.reduce((s, x) => s + x.totalCents, 0);
  const byMethod = { card: 0, cash: 0, other: 0 };
  for (const p of paid) byMethod[methodOf(p.sourceType)] += p.totalCents;
  const byCategory: Record<string, number> = {};
  for (const p of paid) byCategory[p.category ?? "none"] = (byCategory[p.category ?? "none"] ?? 0) + p.totalCents;
  const byClinicMap = new Map<number | null, number>();
  for (const p of paid) byClinicMap.set(p.clinicId, (byClinicMap.get(p.clinicId) ?? 0) + p.totalCents);
  const refundsCents = refunds.reduce((s, r) => s + r.amountCents, 0);
  const needsPatient = paid.filter((p) => !p.subjectKey && p.category !== DEXAFIT).length;
  const unsorted = paid.filter((p) => !p.category).length;

  // The list itself: category / "needs a patient" / search narrow it; the totals above cover the whole range.
  const needle = f.q?.trim().toLowerCase() ?? "";
  const n = await namesFor(all);
  let rows = all;
  if (f.category === "none") rows = rows.filter((p) => !p.category);
  else if (f.category) rows = rows.filter((p) => p.category === f.category);
  if (f.view === "needs_patient") rows = rows.filter((p) => p.status === "COMPLETED" && !p.subjectKey && p.category !== DEXAFIT);
  let views = rows.map((r) => view(r, n, admin));
  if (needle) {
    const digits = needle.replace(/[^\d.]/g, "");
    views = views.filter((v) => [v.payer, v.patientName, v.items, v.memo, v.note, v.takenBy, v.cardLast4, v.receiptUrl?.split("/").pop()].some((s) => s?.toLowerCase().includes(needle))
      || (digits && (v.totalCents / 100).toFixed(2).includes(digits)));
  }
  await audit(actor, "view_payments", { entityType: "squarePayments", description: `Payments ${f.from} to ${f.to}${f.view === "needs_patient" ? " (needs a patient)" : ""}` });
  return {
    summary: {
      collectedCents: sum(paid),
      refundsCents,
      netCents: sum(paid) - refundsCents,
      count: paid.length,
      tipsCents: paid.reduce((s, p) => s + p.tipCents, 0),
      feesCents: admin ? paid.reduce((s, p) => s + p.feeCents, 0) : null,
      byMethod,
      byCategory,
      byClinic: Array.from(byClinicMap.entries()).map(([clinicId, cents]) => ({ clinicId, name: n.clinic(clinicId), cents })).sort((a, b) => b.cents - a.cents),
      needsPatient,
      unsorted,
    },
    rows: views.slice(0, 1000),
    truncated: views.length > 1000 || all.length >= 5000,
  };
}

export async function paymentDetail(actor: WorkspaceActor, id: string) {
  const p = await assertPaymentInScope(actor, id);
  const d = await db();
  const n = await namesFor([p]);
  const refunds = await d.select().from(squareRefunds).where(eq(squareRefunds.paymentId, id)).orderBy(desc(squareRefunds.createdAt));
  const [req] = p.requestId ? await d.select().from(squareRequests).where(eq(squareRequests.id, p.requestId)).limit(1) : [];
  const cu = n.customer(p.customerId);
  return {
    ...view(p, n, actor.role === "admin"),
    customer: cu ? { name: `${cu.givenName ?? ""} ${cu.familyName ?? ""}`.trim() || null, phone: cu.phone ? formatPhone(cu.phone) : null, email: cu.email, linkedTo: cu.patientName, matchedBy: cu.matchedBy } : null,
    refunds: refunds.map((r) => ({ id: r.id, amountCents: r.amountCents, status: r.status, reason: r.reason, createdAt: r.createdAt.toISOString() })),
    request: req ? { id: req.id, kind: req.kind, purpose: req.purpose, createdAt: req.createdAt.toISOString() } : null,
  };
}

/** Link a payment to a patient (or unlink it). Linking also links the Square customer, so their next payments match on their own. */
export async function linkPayment(actor: WorkspaceActor, input: { id: string; subjectKey: string | null; alsoCustomer: boolean }) {
  const p = await assertPaymentInScope(actor, input.id);
  if (p.category === DEXAFIT && input.subjectKey) throw new WorkspaceError("DexaFit payments aren't linked to MyPCP patients.");
  const d = await db();
  let name: string | null = null;
  if (input.subjectKey) {
    const care = await subjectCare(input.subjectKey);
    if (!care) throw new WorkspaceError("That patient wasn't found.", "NOT_FOUND");
    if (actor.clinicIds && (care.clinicId == null || !actor.clinicIds.includes(care.clinicId))) throw new WorkspaceError("That patient isn't at your office.", "FORBIDDEN");
    name = care.name;
  }
  await d.update(squarePayments).set({
    subjectKey: input.subjectKey, patientId: patientIdOf(input.subjectKey), patientName: name, matchSource: "manual", linkedByUserId: actor.id, linkedAt: new Date(),
  }).where(eq(squarePayments.id, p.id));
  let others = 0;
  if (input.subjectKey && input.alsoCustomer && p.customerId) {
    await d.update(squareCustomers).set({ subjectKey: input.subjectKey, patientName: name, matchedBy: "manual", suggestKey: null, suggestName: null }).where(eq(squareCustomers.id, p.customerId));
    const rest = await d.select({ id: squarePayments.id }).from(squarePayments)
      .where(and(eq(squarePayments.customerId, p.customerId), ne(squarePayments.id, p.id), or(isNull(squarePayments.matchSource), ne(squarePayments.matchSource, "manual"))));
    others = rest.length;
    await settle(rest.map((r) => r.id));
  }
  await settle([p.id]);
  await audit(actor, "manage_payment", { entityType: "squarePayment", description: input.subjectKey ? `Square payment ${money(p.totalCents)} linked to ${name}${others ? ` (+${others} more from the same Square customer)` : ""}` : `Square payment ${money(p.totalCents)} unlinked from its patient` });
  return { ok: true, others };
}

export async function updatePayment(actor: WorkspaceActor, input: { id: string; category?: PaymentCategory | null; clinicId?: number | null; memo?: string | null }) {
  const p = await assertPaymentInScope(actor, input.id);
  const d = await db();
  const patch: Partial<typeof squarePayments.$inferInsert> = {};
  const changes: string[] = [];
  if (input.category !== undefined) {
    if ((input.category === DEXAFIT || p.category === DEXAFIT) && actor.role !== "admin") throw new WorkspaceError("Only an admin can move payments to or from DexaFit.", "FORBIDDEN");
    patch.category = input.category; patch.categorySource = "manual";
    changes.push(`category ${input.category ?? "not sorted"}`);
    if (input.category === DEXAFIT && p.subjectKey) Object.assign(patch, { subjectKey: null, patientId: null, patientName: null, matchSource: "manual" });
  }
  if (input.clinicId !== undefined) {
    if (actor.clinicIds && (input.clinicId == null || !actor.clinicIds.includes(input.clinicId))) throw new WorkspaceError("You can only put payments at your office.", "FORBIDDEN");
    patch.clinicId = input.clinicId; patch.clinicSource = "manual";
    changes.push("office");
  }
  if (input.memo !== undefined) { patch.memo = input.memo?.trim().slice(0, 500) || null; changes.push("note"); }
  if (!Object.keys(patch).length) return { ok: true };
  await d.update(squarePayments).set(patch).where(eq(squarePayments.id, p.id));
  if (input.category !== undefined && input.clinicId === undefined) await settle([p.id]);
  await audit(actor, "manage_payment", { entityType: "squarePayment", description: `Square payment ${money(p.totalCents)}: ${changes.join(", ")} changed` });
  return { ok: true };
}

export async function paymentPatientSearch(actor: WorkspaceActor, q: string) {
  return searchSubjects(q, 15, actor.clinicIds);
}

// ---------------------------------------------------------------------------
// Payment links and Terminal charges
// ---------------------------------------------------------------------------

async function defaultClinic(actor: WorkspaceActor, subjectKey: string | null, requested: number | null | undefined) {
  if (requested) {
    if (actor.clinicIds && !actor.clinicIds.includes(requested)) throw new WorkspaceError("You can only take payments for your office.", "FORBIDDEN");
    return requested;
  }
  if (actor.clinicIds?.length) return actor.clinicIds[0]!;
  const pat = subjectKey ? (await subjectCare(subjectKey))?.clinicId ?? null : null;
  return pat ?? (await officeClinicIds(actor.id))[0] ?? null;
}

interface NewRequest { amountCents: number; category: PaymentCategory; purpose?: string | null; subjectKey?: string | null; clinicId?: number | null }

async function newRequest(actor: WorkspaceActor, kind: "link" | "terminal", input: NewRequest, deviceId: string | null) {
  if (input.category === DEXAFIT && actor.role !== "admin") throw new WorkspaceError("Only an admin can take DexaFit payments here.", "FORBIDDEN");
  const subjectKey = input.category === DEXAFIT ? null : input.subjectKey ?? null;
  const care = subjectKey ? await subjectCare(subjectKey) : null;
  if (subjectKey && !care) throw new WorkspaceError("That patient wasn't found.", "NOT_FOUND");
  if (care && actor.clinicIds && (care.clinicId == null || !actor.clinicIds.includes(care.clinicId))) throw new WorkspaceError("That patient isn't at your office.", "FORBIDDEN");
  const clinicId = await defaultClinic(actor, subjectKey, input.clinicId);
  const res = await (await db()).insert(squareRequests).values({
    kind, amountCents: input.amountCents, category: input.category, purpose: input.purpose?.trim().slice(0, 255) || null,
    subjectKey, patientId: patientIdOf(subjectKey), patientName: care?.name ?? null, clinicId, deviceId, status: "open", createdByUserId: actor.id,
  });
  return { id: (res as unknown as [{ insertId: number }])[0].insertId, patientName: care?.name ?? null };
}

export async function createPaymentLink(actor: WorkspaceActor, input: NewRequest) {
  const c = await readyConfig();
  const d = await db();
  const { id, patientName } = await newRequest(actor, "link", input, null);
  try {
    const r = await sq(c, "/online-checkout/payment-links", {
      method: "POST",
      body: {
        idempotency_key: `mypcp-link-${id}-${randomUUID()}`,
        // Only a plain name and our reference number go to Square, never what it's for.
        quick_pay: { name: squareItemName(input.category), price_money: { amount: input.amountCents, currency: "USD" }, location_id: c.locationId },
        payment_note: `MyPCP ref R${id}`,
        checkout_options: { allow_tipping: false, ask_for_shipping_address: false },
      },
    });
    const pl = r.payment_link as Json;
    await d.update(squareRequests).set({ squareId: cut(pl.id, 64), orderId: cut(pl.order_id, 64), url: cut(pl.url ?? pl.long_url, 500) }).where(eq(squareRequests.id, id));
    await audit(actor, "manage_payment", { entityType: "squareRequest", entityId: id, description: `Payment link for ${money(input.amountCents)}${patientName ? ` (${patientName})` : ""}` });
    return { id, url: String(pl.url ?? pl.long_url) };
  } catch (e) {
    await d.update(squareRequests).set({ status: "failed" }).where(eq(squareRequests.id, id));
    throw e;
  }
}

async function requestInScope(actor: WorkspaceActor, id: number) {
  const [r] = await (await db()).select().from(squareRequests).where(eq(squareRequests.id, id)).limit(1);
  if (!r || (r.category === DEXAFIT && actor.role !== "admin") || (actor.clinicIds && (r.clinicId == null || !actor.clinicIds.includes(r.clinicId)))) {
    throw new WorkspaceError("That payment request isn't available.", "NOT_FOUND");
  }
  return r;
}

async function clinicPhone(clinicId: number | null) {
  if (!clinicId) return null;
  const p = (await (await db()).select({ phone: clinics.phone }).from(clinics).where(eq(clinics.id, clinicId)).limit(1))[0]?.phone;
  return p ? formatPhone(p) : null;
}

/** Where to send a link: the patient's phone / email / language as MyPCP knows them. */
async function contactOf(actor: WorkspaceActor, subjectKey: string | null) {
  if (!subjectKey) return { phone: null, email: null, language: "en" };
  const { intakeContact } = await import("./intakeDb");
  const c = await intakeContact(actor, subjectKey).catch(() => null);
  return { phone: c?.phone ?? null, email: c?.email ?? null, language: c?.language ?? "en" };
}

export async function requestContact(actor: WorkspaceActor, subjectKey: string) {
  const c = await contactOf(actor, subjectKey);
  const { practiceMailSender } = await import("./gmailSync");
  return { ...c, canEmail: (await practiceMailSender()).canSend };
}

/** The text for the RingCentral phone (staff press Send there). */
export async function linkText(actor: WorkspaceActor, input: { id: number; phone?: string | null }) {
  const r = await requestInScope(actor, input.id);
  if (r.kind !== "link" || !r.url) throw new WorkspaceError("That isn't a payment link.");
  const contact = await contactOf(actor, r.subjectKey);
  const phone = normalizePhone(input.phone ?? contact.phone);
  const message = paymentLinkText(contact.language, r.amountCents, r.url, await clinicPhone(r.clinicId), r.category === DEXAFIT ? "dexafit" : "clinic");
  if (phone) await (await db()).update(squareRequests).set({ sentVia: "text", sentTo: `…${phone.slice(-4)}` }).where(eq(squareRequests.id, r.id));
  return { phone, message };
}

export async function emailLink(actor: WorkspaceActor, input: { id: number; to: string }) {
  const r = await requestInScope(actor, input.id);
  if (r.kind !== "link" || !r.url) throw new WorkspaceError("That isn't a payment link.");
  const contact = await contactOf(actor, r.subjectKey);
  const phone = await clinicPhone(r.clinicId);
  const text = paymentLinkText(contact.language, r.amountCents, r.url, phone, r.category === DEXAFIT ? "dexafit" : "clinic");
  const from = r.category === DEXAFIT ? "DexaFit Katy" : "MyPCP Dr";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const amt = money(r.amountCents);
  const copy = contact.language === "es"
    ? { hi: "Hola,", body: `Aquí está su enlace seguro para pagar ${amt}.`, button: "Pagar ahora", call: phone ? `¿Preguntas? Llámenos al ${phone}.` : "", by: "Los pagos se procesan de forma segura con Square." }
    : contact.language === "ar"
      ? { hi: "مرحبًا،", body: `هذا رابط الدفع الآمن الخاص بك لمبلغ ${amt}.`, button: "ادفع الآن", call: phone ? `للاستفسار اتصل بنا على ${phone}.` : "", by: "تتم معالجة المدفوعات بأمان عبر Square." }
      : { hi: "Hello,", body: `Here is your secure link to pay ${amt}.`, button: "Pay now", call: phone ? `Questions? Call us at ${phone}.` : "", by: "Payments are processed securely by Square." };
  const html = `<div dir="${contact.language === "ar" ? "rtl" : "ltr"}" style="font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:1.5;color:#0f172a">
    <p style="margin:0 0 12px">${esc(copy.hi)}</p>
    <p style="margin:0 0 20px">${esc(copy.body)}</p>
    <p style="margin:0 0 20px"><a href="${esc(r.url)}" style="display:inline-block;background:#0e7490;color:#ffffff;text-decoration:none;font-weight:bold;font-size:20px;padding:16px 28px;border-radius:10px">${esc(copy.button)}</a></p>
    ${copy.call ? `<p style="margin:0 0 8px;color:#334155">${esc(copy.call)}</p>` : ""}
    <p style="margin:0;color:#64748b;font-size:14px">${esc(copy.by)}</p></div>`;
  const subject = contact.language === "es" ? `Su enlace de pago de ${from}` : contact.language === "ar" ? `رابط الدفع من ${from}` : `Your payment link from ${from}`;
  const { sendPracticeEmail } = await import("./gmailSync");
  await sendPracticeEmail({ to: input.to.trim().toLowerCase(), fromName: from, subject, text, html });
  const [u, dom] = input.to.trim().split("@");
  await (await db()).update(squareRequests).set({ sentVia: "email", sentTo: `${(u ?? "").slice(0, 2)}…@${dom ?? ""}`.slice(0, 64) }).where(eq(squareRequests.id, r.id));
  await audit(actor, "manage_payment", { entityType: "squareRequest", entityId: r.id, description: "Payment link emailed" });
  return { ok: true };
}

export async function markLinkCopied(actor: WorkspaceActor, id: number) {
  const r = await requestInScope(actor, id);
  if (!r.sentVia) await (await db()).update(squareRequests).set({ sentVia: "copy" }).where(eq(squareRequests.id, r.id));
  return { ok: true };
}

export async function chargeTerminal(actor: WorkspaceActor, input: NewRequest & { deviceId: string }) {
  const c = await readyConfig();
  const known = c.terminals.find((t) => t.deviceId === input.deviceId) ?? (c.env === "sandbox" && input.deviceId === SANDBOX_TEST_TERMINAL.deviceId ? { ...SANDBOX_TEST_TERMINAL, clinicId: null } : null);
  if (!known) throw new WorkspaceError("That Terminal isn't paired with MyPCP.");
  const d = await db();
  // The office that took the payment is where the Terminal is.
  const { id, patientName } = await newRequest(actor, "terminal", { ...input, clinicId: known.clinicId ?? input.clinicId }, input.deviceId);
  try {
    const r = await sq(c, "/terminals/checkouts", {
      method: "POST",
      body: {
        idempotency_key: `mypcp-term-${id}-${randomUUID()}`,
        checkout: {
          amount_money: { amount: input.amountCents, currency: "USD" },
          reference_id: `MyPCP-R${id}`,
          note: `MyPCP ref R${id}`,
          device_options: { device_id: input.deviceId, skip_receipt_screen: false, tip_settings: { allow_tipping: false } },
        },
      },
    });
    const co = r.checkout as Json;
    await d.update(squareRequests).set({ squareId: cut(co.id, 64), squareStatus: cut(co.status, 24) }).where(eq(squareRequests.id, id));
    await audit(actor, "manage_payment", { entityType: "squareRequest", entityId: id, description: `Square Terminal charge ${money(input.amountCents)}${patientName ? ` (${patientName})` : ""}` });
    return { id };
  } catch (e) {
    await d.update(squareRequests).set({ status: "failed" }).where(eq(squareRequests.id, id));
    throw e;
  }
}

/** Where a link / Terminal charge stands (asks Square when it's still open). */
export async function requestStatus(actor: WorkspaceActor, id: number, opts: { refresh: boolean }) {
  let r = await requestInScope(actor, id);
  if (opts.refresh && r.status === "open") {
    const c = await readyConfig();
    await checkRequest(c, r);
    r = await requestInScope(actor, id);
  }
  return requestView(r, await clinicNames());
}

async function clinicNames() {
  return new Map((await (await db()).select({ id: clinics.id, name: clinics.name }).from(clinics)).map((x) => [x.id, x.name]));
}

function requestView(r: typeof squareRequests.$inferSelect, clinicName: Map<number, string>) {
  return {
    id: r.id, kind: r.kind, amountCents: r.amountCents, category: r.category as PaymentCategory, purpose: r.purpose, url: r.url,
    subjectKey: r.subjectKey, patientId: r.patientId, patientName: r.patientName, clinicId: r.clinicId, clinicName: r.clinicId ? clinicName.get(r.clinicId) ?? null : null,
    status: r.status as RequestStatus, squareStatus: r.squareStatus, paymentId: r.paymentId, sentVia: r.sentVia, sentTo: r.sentTo,
    createdAt: r.createdAt.toISOString(), paidAt: r.paidAt?.toISOString() ?? null,
  };
}

export async function cancelRequest(actor: WorkspaceActor, id: number) {
  const r = await requestInScope(actor, id);
  if (r.status !== "open") throw new WorkspaceError(r.status === "paid" ? "This one is already paid." : "This one is already closed.");
  const c = await readyConfig();
  if (r.squareId) {
    try {
      if (r.kind === "terminal") await sq(c, `/terminals/checkouts/${encodeURIComponent(r.squareId)}/cancel`, { method: "POST", body: {} });
      else await sq(c, `/online-checkout/payment-links/${encodeURIComponent(r.squareId)}`, { method: "DELETE" });
    } catch (e) {
      // Square refuses to cancel something already paid: find out before saying it's canceled.
      await checkRequest(c, r).catch(() => {});
      const [again] = await (await db()).select().from(squareRequests).where(eq(squareRequests.id, id)).limit(1);
      if (again?.status === "paid") return { ok: true, status: "paid" };
      throw e;
    }
  }
  // A Terminal checkout may be paid while the cancel is on its way: ask Square before closing it.
  if (r.kind === "terminal") await checkRequest(c, r).catch(() => {});
  const [now] = await (await db()).select().from(squareRequests).where(eq(squareRequests.id, id)).limit(1);
  if (now?.status === "open") await (await db()).update(squareRequests).set({ status: "canceled" }).where(eq(squareRequests.id, id));
  await audit(actor, "manage_payment", { entityType: "squareRequest", entityId: id, description: `${r.kind === "link" ? "Payment link" : "Terminal charge"} for ${money(r.amountCents)} canceled` });
  return { ok: true, status: (now?.status === "open" ? "canceled" : now?.status) ?? "canceled" };
}

export async function listRequests(actor: WorkspaceActor, input: { status: "open" | "all" }) {
  const d = await db();
  const conds: SQL[] = [gte(squareRequests.createdAt, new Date(Date.now() - 120 * 86_400_000)), ne(squareRequests.status, "failed")];
  if (input.status === "open") conds.push(eq(squareRequests.status, "open"));
  if (actor.role !== "admin") conds.push(ne(squareRequests.category, DEXAFIT));
  if (actor.clinicIds) conds.push(actor.clinicIds.length ? inArray(squareRequests.clinicId, actor.clinicIds) : sql`false`);
  const rows = await d.select().from(squareRequests).where(and(...conds)).orderBy(desc(squareRequests.createdAt)).limit(300);
  const names = await clinicNames();
  return rows.map((r) => requestView(r, names));
}

/** Patient 360 → Payments. */
export async function subjectPayments(actor: WorkspaceActor, subjectKey: string) {
  const d = await db();
  const rows = await d.select().from(squarePayments).where(and(eq(squarePayments.subjectKey, subjectKey), ...scopeConds(actor, { business: "clinic" }))).orderBy(desc(squarePayments.createdAt)).limit(200);
  const reqConds: SQL[] = [eq(squareRequests.subjectKey, subjectKey), ne(squareRequests.status, "failed")];
  if (actor.clinicIds) reqConds.push(actor.clinicIds.length ? inArray(squareRequests.clinicId, actor.clinicIds) : sql`false`);
  const reqs = await d.select().from(squareRequests).where(and(...reqConds)).orderBy(desc(squareRequests.createdAt)).limit(50);
  const n = await namesFor(rows);
  const names = await clinicNames();
  const yearAgo = Date.now() - 365 * 86_400_000;
  const paid = rows.filter((p) => p.status === "COMPLETED");
  await audit(actor, "view_payments", { entityType: "squarePayments", description: `Payments for a patient (${subjectKey.startsWith("p:") ? `patient #${subjectKey.slice(2)}` : "schedule patient"})` });
  return {
    payments: rows.map((r) => view(r, n, actor.role === "admin")),
    requests: reqs.map((r) => requestView(r, names)),
    paidLastYearCents: paid.filter((p) => p.createdAt.getTime() >= yearAgo).reduce((s, p) => s + p.totalCents - p.refundedCents, 0),
    lastPaidAt: paid[0]?.createdAt.toISOString() ?? null,
  };
}

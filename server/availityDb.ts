// Insurance eligibility through Availity (X12 270/271 "Coverages" API). Staff check a patient from
// Patient 360; each evening MyPCP checks everyone booked for the next clinic day who has insurance
// on file. Requests go out through the allowlist relay (ccm-app has no internet access). The demo
// plan returns Availity's sample answers; the standard plan (after Availity's contract) is live.
import { gunzipSync, gzipSync } from "node:zlib";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "./db";
import { relayFetch } from "./egress";
import { sealSecret, openSecret } from "./secretBox";
import { appSettings, appointments, clinics, coverageOnFile, eligibilityChecks, fhirPatients, patients, personDemographics, providers } from "../drizzle/schema";
import {
  COVERAGE_COMM_ERRORS, COVERAGE_DONE_CODES, COVERAGE_IN_PROGRESS, GROUP_NPI_DEFAULT, ORG_NAME_DEFAULT, pcpIsOurs, splitName, summarizeCoverage, type CoverageSummary,
} from "../shared/eligibility";
import { localDateStr } from "../shared/workforce";
import { nextClinicDay } from "../shared/workspace";
import { WorkspaceError, audit, loadScheduleSubjects, subjectCare, subjectKeyFor, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const API = "https://api.availity.com/availity/v1";
const CONFIG_KEY = "availity";
const PAYERS_KEY = "availity_payers";
const NIGHTLY_KEY = "availity_nightly";
const DEMO_SCENARIO = "Coverages-Complete-i";

interface AvailityConfig {
  clientId: string;
  clientSecretEnc: string;
  mode: "demo" | "production";
  npi: string;
  orgName: string;
  scope: string;
  nightly: boolean;
}
const EMPTY: AvailityConfig = { clientId: "", clientSecretEnc: "", mode: "demo", npi: GROUP_NPI_DEFAULT, orgName: ORG_NAME_DEFAULT, scope: "", nightly: false };
/** The OAuth scope is the subscribed product (the Demo product is "healthcare-hipaa-transactions-demo"); the app's Approved Access page lists it. */
export const defaultScope = (mode: "demo" | "production") => (mode === "demo" ? "healthcare-hipaa-transactions-demo" : "hipaa");
const scopeOf = (c: AvailityConfig) => c.scope || defaultScope(c.mode);

async function readSetting<T>(key: string): Promise<T | null> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}
async function writeSetting(key: string, value: unknown, userId: number | null) {
  await (await db()).insert(appSettings).values({ key, value, updatedByUserId: userId }).onDuplicateKeyUpdate({ set: { value, updatedByUserId: userId } });
}
async function config(): Promise<AvailityConfig> {
  return { ...EMPTY, ...((await readSetting<AvailityConfig>(CONFIG_KEY)) ?? {}) };
}
const ready = (c: AvailityConfig) => !!(c.clientId && c.clientSecretEnc && c.npi);

// ---------------------------------------------------------------------------
// Connection (admin)
// ---------------------------------------------------------------------------

export async function availityStatus() {
  const c = await config();
  const payers = await readSetting<{ at: string; payers: unknown[] }>(PAYERS_KEY);
  return {
    configured: ready(c),
    clientIdHint: c.clientId ? `…${c.clientId.slice(-6)}` : null,
    mode: c.mode,
    npi: c.npi,
    orgName: c.orgName,
    scope: scopeOf(c),
    scopeIsDefault: !c.scope,
    nightly: c.nightly,
    payerCount: payers?.payers.length ?? 0,
    payersAt: payers?.at ?? null,
    lastNightly: await readSetting<NightlyState>(NIGHTLY_KEY),
  };
}

export async function saveAvailityConfig(actor: WorkspaceActor, input: { clientId?: string | null; clientSecret?: string | null; mode: "demo" | "production"; npi: string; orgName: string; scope?: string | null; nightly: boolean }) {
  const prev = await config();
  const npi = input.npi.replace(/\D/g, "");
  if (!/^\d{10}$/.test(npi)) throw new WorkspaceError("An NPI has 10 digits.");
  const next: AvailityConfig = {
    ...prev,
    clientId: input.clientId?.trim() || prev.clientId,
    clientSecretEnc: input.clientSecret?.trim() ? sealSecret(input.clientSecret.trim()) : prev.clientSecretEnc,
    mode: input.mode,
    npi,
    orgName: input.orgName.trim().toUpperCase().slice(0, 60) || ORG_NAME_DEFAULT,
    // Blank (or the plan's usual one) = follow the plan.
    scope: input.scope?.trim() && input.scope.trim() !== defaultScope(input.mode) ? input.scope.trim().slice(0, 120) : "",
    nightly: input.nightly,
  };
  if (next.nightly && !ready(next)) throw new WorkspaceError("Save the Availity Client ID and Secret first.");
  if (next.clientId !== prev.clientId || input.clientSecret || next.mode !== prev.mode || next.scope !== prev.scope) tokenCache = null;
  await writeSetting(CONFIG_KEY, next, actor.id);
  await audit(actor, "manage_access", { entityType: "integration", description: `Availity settings saved (${next.mode}${next.nightly ? ", nightly checks on" : ""})` });
  return { ok: true };
}

let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

async function token(c: AvailityConfig): Promise<string> {
  const key = `${c.clientId}|${c.mode}|${scopeOf(c)}`;
  if (tokenCache?.key === key && tokenCache.expiresAt > Date.now() + 30_000) return tokenCache.token;
  const res = await relayFetch(`${API}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: openSecret(c.clientSecretEnc), scope: scopeOf(c) }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new WorkspaceError(`Availity sign-in failed (${res.status}): ${body.error_description ?? body.error ?? "check the Client ID and Secret"}.`);
  tokenCache = { key, token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
  return body.access_token;
}

async function call(c: AvailityConfig, path: string, init: { method?: "GET" | "POST"; form?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${await token(c)}`, Accept: "application/json" };
  if (init.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  // Demo plan: Availity answers with its sample scenario instead of asking a payer.
  if (c.mode === "demo" && path.startsWith("/coverages")) headers["X-Api-Mock-Scenario-ID"] = DEMO_SCENARIO;
  const res = await relayFetch(`${API}${path}`, { method: init.method ?? "GET", headers, body: init.form ? new URLSearchParams(init.form).toString() : undefined });
  if (res.status === 429) throw new WorkspaceError("Availity's limit was reached for now. Try again in a minute.");
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { message: text.slice(0, 300) }; }
  return { status: res.status, body };
}

export async function testAvaility() {
  const c = await config();
  if (!ready(c)) throw new WorkspaceError("Save the Availity Client ID and Secret first.");
  tokenCache = null;
  await token(c);
  const payers = await refreshPayers(c).catch((e: Error) => ({ error: e.message }));
  return { ok: true, mode: c.mode, payers: "error" in payers ? null : payers.count, payerListError: "error" in payers ? payers.error : null };
}

// ---------------------------------------------------------------------------
// Payer list (who Availity can check eligibility with)
// ---------------------------------------------------------------------------

interface Payer { id: string; name: string }

async function refreshPayers(c: AvailityConfig): Promise<{ count: number }> {
  const out = new Map<string, string>();
  const limit = 500;
  for (let offset = 0, page = 0; page < 20; page++, offset += limit) {
    const r = await call(c, `/availity-payer-list?transactionType=270&availability=AVAILABLE&limit=${limit}&offset=${offset}`);
    if (r.status === 401 || r.status === 403) throw new WorkspaceError("Your Availity app isn't subscribed to the Payer List API yet (Developer Portal → your app → subscribe to \"Availity Payer List\"). You can still type a payer ID.");
    if (r.status >= 400) throw new WorkspaceError(`Availity's payer list answered ${r.status}.`);
    const list = (Array.isArray(r.body.payers) ? r.body.payers : []) as { payerId?: string; name?: string; displayName?: string }[];
    for (const p of list) if (p.payerId) out.set(p.payerId, (p.displayName || p.name || p.payerId).trim());
    if (list.length < limit) break;
  }
  const payers: Payer[] = Array.from(out, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  await writeSetting(PAYERS_KEY, { at: new Date().toISOString(), payers }, null);
  return { count: payers.length };
}

/** Search payers by name or ID (Availity's list, refreshed weekly), plus payers already used in MyPCP. */
export async function searchPayers(q: string) {
  const needle = q.trim().toLowerCase();
  let cached = await readSetting<{ at: string; payers: Payer[] }>(PAYERS_KEY);
  if (!cached || Date.now() - new Date(cached.at).getTime() > 7 * 86_400_000) {
    const c = await config();
    if (ready(c)) { try { await refreshPayers(c); cached = await readSetting(PAYERS_KEY); } catch { /* fall back to what we have */ } }
  }
  const used = await (await db()).selectDistinct({ id: coverageOnFile.payerId, name: coverageOnFile.payerName }).from(coverageOnFile);
  const all = new Map<string, string>((cached?.payers ?? []).map((p) => [p.id, p.name]));
  for (const u of used) if (!all.has(u.id)) all.set(u.id, u.name ?? u.id);
  const hits = Array.from(all, ([id, name]) => ({ id, name })).filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.id.toLowerCase().includes(needle));
  return { payers: hits.slice(0, 30), listLoaded: !!cached?.payers.length };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function assertInScope(actor: WorkspaceActor, subjectKey: string) {
  if (!actor.clinicIds) return;
  const care = await subjectCare(subjectKey);
  if (!care?.clinicId || !actor.clinicIds.includes(care.clinicId)) throw new WorkspaceError("That patient isn't at your office.", "FORBIDDEN");
}

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** What we know to prefill a check: name, DOB, sex, clinic, and insurance on file. */
export async function checkDefaults(actor: WorkspaceActor, subjectKey: string) {
  await assertInScope(actor, subjectKey);
  const d = await db();
  const care = await subjectCare(subjectKey);
  let name = care?.name ?? null, dob: string | null = null, sex: string | null = null, insurance: string | null = null;
  if (care?.patientId) {
    const [p] = await d.select({ name: patients.name, dob: patients.dateOfBirth, insurance: patients.insurance }).from(patients).where(eq(patients.id, care.patientId)).limit(1);
    if (p) { name = p.name; dob = ymd(p.dob); insurance = p.insurance ?? null; }
  }
  const sched = (await loadScheduleSubjects()).get(subjectKey);
  if (sched) { name = name ?? sched.name; dob = dob ?? ymd(sched.dob); }
  const [demo] = await d.select({ sex: personDemographics.sex }).from(personDemographics).where(eq(personDemographics.subjectKey, subjectKey)).limit(1);
  sex = demo?.sex ?? null;
  if (!sex) {
    const [f] = await d.select({ sex: fhirPatients.sex }).from(fhirPatients).where(care?.patientId ? eq(fhirPatients.patientId, care.patientId) : eq(fhirPatients.subjectKey, subjectKey)).limit(1);
    sex = f?.sex ?? null;
  }
  const [cov] = await d.select().from(coverageOnFile).where(eq(coverageOnFile.subjectKey, subjectKey)).limit(1);
  const split = splitName(name ?? "");
  return {
    subjectKey, name, firstName: split.first, lastName: split.last, dob, sex, insuranceText: insurance, clinicId: care?.clinicId ?? null,
    onFile: cov ? { payerId: cov.payerId, payerName: cov.payerName, memberId: cov.memberId, groupNumber: cov.groupNumber, updatedAt: cov.updatedAt } : null,
    configured: ready(await config()),
  };
}

export interface CheckInput {
  subjectKey: string;
  payerId: string;
  payerName?: string | null;
  memberId: string;
  groupNumber?: string | null;
  firstName: string;
  lastName: string;
  dob: string;
  sex?: string | null;
  asOfDate?: string | null;
}

function checkView(r: typeof eligibilityChecks.$inferSelect, ourProviders: string[] = []) {
  const summary = (r.summary ?? null) as CoverageSummary | null;
  return {
    id: r.id, subjectKey: r.subjectKey, patientName: r.patientName, payerId: r.payerId, payerName: summary?.payerName ?? r.payerName, memberId: r.memberId,
    asOfDate: r.asOfDate, trigger: r.trigger, mode: r.mode, status: r.status, error: r.error, createdAt: r.createdAt, updatedAt: r.updatedAt,
    summary, pcpIsOurs: summary ? pcpIsOurs(summary.pcp, ourProviders) : null,
  };
}

async function ourProviderNames() {
  return (await (await db()).select({ name: providers.name }).from(providers)).map((p) => p.name);
}

function coverageForm(c: AvailityConfig, input: CheckInput) {
  const sex = (input.sex ?? "").toUpperCase();
  return {
    payerId: input.payerId.trim(),
    providerNpi: c.npi,
    providerLastName: c.orgName,
    memberId: input.memberId.trim(),
    patientBirthDate: input.dob,
    patientLastName: input.lastName.trim(),
    patientFirstName: input.firstName.trim(),
    patientGender: sex === "F" || sex === "M" ? sex : "U",
    patientState: "TX",
    subscriberRelationship: "18", // self
    serviceType: "30", // health benefit plan coverage
    asOfDate: input.asOfDate || localDateStr(),
    ...(input.groupNumber?.trim() ? { groupNumber: input.groupNumber.trim() } : {}),
  };
}

/** Apply Availity's answer to a check row. Returns true once it's finished (either way). */
async function applyAnswer(id: number, status: number, body: Record<string, unknown>) {
  const d = await db();
  const code = typeof body.statusCode === "string" || typeof body.statusCode === "number" ? String(body.statusCode) : null;
  const availityId = typeof body.id === "string" ? body.id : null;
  const raw = gzipSync(Buffer.from(JSON.stringify(body))).toString("base64");
  if (status >= 400 || code === "19") {
    const v = Array.isArray(body.validationMessages) ? (body.validationMessages as { field?: string; errorMessage?: string }[]).map((m) => [m.field, m.errorMessage].filter(Boolean).join(": ")).join("; ") : null;
    const msg = v || (typeof body.message === "string" ? body.message : null) || (Array.isArray(body.errors) ? JSON.stringify(body.errors).slice(0, 200) : null) || `Availity answered ${status}.`;
    await d.update(eligibilityChecks).set({ status: "error", statusCode: code, availityId, raw, error: msg.slice(0, 500) }).where(eq(eligibilityChecks.id, id));
    return true;
  }
  if (code && COVERAGE_COMM_ERRORS.includes(code)) {
    await d.update(eligibilityChecks).set({ status: "error", statusCode: code, availityId, raw, error: "The payer didn't answer Availity. Try again later." }).where(eq(eligibilityChecks.id, id));
    return true;
  }
  if (code && COVERAGE_DONE_CODES.includes(code)) {
    const summary = summarizeCoverage(body);
    await d.update(eligibilityChecks).set({ status: "complete", statusCode: code, availityId, raw, summary, error: code === "3" ? "The payer's answer was incomplete." : null }).where(eq(eligibilityChecks.id, id));
    return true;
  }
  await d.update(eligibilityChecks).set({ statusCode: code ?? COVERAGE_IN_PROGRESS, availityId }).where(eq(eligibilityChecks.id, id));
  return false;
}

async function pollOnce(c: AvailityConfig, row: typeof eligibilityChecks.$inferSelect) {
  if (!row.availityId) return true;
  const r = await call(c, `/coverages/${encodeURIComponent(row.availityId)}`);
  return applyAnswer(row.id, r.status, r.body);
}

async function send(c: AvailityConfig, id: number, input: CheckInput) {
  const r = await call(c, "/coverages", { method: "POST", form: coverageForm(c, input) });
  return applyAnswer(id, r.status, r.body);
}

/** Staff check from Patient 360. Waits up to ~12 s for the payer; otherwise the page keeps polling. */
export async function runCheck(actor: WorkspaceActor, input: CheckInput) {
  await assertInScope(actor, input.subjectKey);
  const c = await config();
  if (!ready(c)) throw new WorkspaceError("Availity isn't connected yet (Integrations → Availity).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dob)) throw new WorkspaceError("Enter the patient's date of birth.");
  if (!input.payerId.trim() || !input.memberId.trim() || !input.firstName.trim() || !input.lastName.trim()) throw new WorkspaceError("Payer, member ID and the patient's first and last name are needed.");
  const d = await db();
  const care = await subjectCare(input.subjectKey);
  // Remember the insurance for next time (and the nightly check).
  await d.insert(coverageOnFile).values({
    subjectKey: input.subjectKey, patientId: care?.patientId ?? null, payerId: input.payerId.trim(), payerName: input.payerName?.trim() || null,
    memberId: input.memberId.trim(), groupNumber: input.groupNumber?.trim() || null, source: "check", updatedByUserId: actor.id,
  }).onDuplicateKeyUpdate({ set: { payerId: input.payerId.trim(), payerName: input.payerName?.trim() || null, memberId: input.memberId.trim(), groupNumber: input.groupNumber?.trim() || null, source: "check", updatedByUserId: actor.id } });
  const res = await d.insert(eligibilityChecks).values({
    subjectKey: input.subjectKey, patientId: care?.patientId ?? null, patientName: `${input.firstName} ${input.lastName}`.slice(0, 255), payerId: input.payerId.trim(),
    payerName: input.payerName?.trim() || null, memberId: input.memberId.trim(), asOfDate: input.asOfDate || localDateStr(), trigger: "manual", mode: c.mode,
    clinicId: care?.clinicId ?? null, requestedByUserId: actor.id,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  await audit(actor, "view_patient", { entityType: "eligibilityCheck", entityId: id, description: `Insurance eligibility check (${c.mode})` });
  const deadline = Date.now() + 12_000;
  let done = await send(c, id, input);
  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const [row] = await d.select().from(eligibilityChecks).where(eq(eligibilityChecks.id, id)).limit(1);
    done = await pollOnce(c, row!);
  }
  return getCheck(actor, id);
}

export async function getCheck(actor: WorkspaceActor, id: number, poll = false) {
  const d = await db();
  let [row] = await d.select().from(eligibilityChecks).where(eq(eligibilityChecks.id, id)).limit(1);
  if (!row) throw new WorkspaceError("Check not found.", "NOT_FOUND");
  if (actor.clinicIds && !(row.clinicId && actor.clinicIds.includes(row.clinicId))) throw new WorkspaceError("Check not found.", "NOT_FOUND");
  if (poll && row.status === "pending") {
    const c = await config();
    if (ready(c)) { await pollOnce(c, row); [row] = await d.select().from(eligibilityChecks).where(eq(eligibilityChecks.id, id)).limit(1); }
  }
  return checkView(row!, await ourProviderNames());
}

/** A patient's recent checks (newest first). */
export async function checkHistory(actor: WorkspaceActor, subjectKey: string) {
  await assertInScope(actor, subjectKey);
  const rows = await (await db()).select().from(eligibilityChecks).where(eq(eligibilityChecks.subjectKey, subjectKey)).orderBy(desc(eligibilityChecks.createdAt)).limit(10);
  const ours = await ourProviderNames();
  return rows.map((r) => checkView(r, ours));
}

/** Availity's full answer for one check (staff "details" view). */
export async function checkRaw(actor: WorkspaceActor, id: number) {
  const [row] = await (await db()).select().from(eligibilityChecks).where(eq(eligibilityChecks.id, id)).limit(1);
  if (!row || (actor.clinicIds && !(row.clinicId && actor.clinicIds.includes(row.clinicId)))) throw new WorkspaceError("Check not found.", "NOT_FOUND");
  return row.raw ? (JSON.parse(gunzipSync(Buffer.from(row.raw, "base64")).toString("utf8")) as unknown) : null;
}

export async function removeCoverage(actor: WorkspaceActor, subjectKey: string) {
  await assertInScope(actor, subjectKey);
  await (await db()).delete(coverageOnFile).where(eq(coverageOnFile.subjectKey, subjectKey));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Nightly: check everyone booked for the next clinic day
// ---------------------------------------------------------------------------

interface NightlyState { date: string; lastRunAt: string; booked: number; noInsurance: number; sent: number; done: number; errors: number; finishedAt: string | null; lastError: string | null }

/** Called every few minutes in the evening (EventBridge). Sends new checks, then polls pending ones, within the deadline. */
export async function runNightly(opts: { deadline: number; date?: string }) {
  const c = await config();
  if (!ready(c) || !c.nightly) return { skipped: "Nightly checks are off." };
  const d = await db();
  const date = opts.date ?? nextClinicDay(localDateStr());
  const appts = await d.select({ id: appointments.id, patientId: appointments.patientId, name: appointments.patientName, dob: appointments.dateOfBirth, clinicId: appointments.clinicId, status: appointments.status })
    .from(appointments).where(and(eq(appointments.date, date), ne(appointments.status, "cancelled")));
  const keys = new Map<string, { patientId: number | null; name: string; dob: Date | null; clinicId: number | null }>();
  for (const a of appts) keys.set(subjectKeyFor(a.patientId, a.name, a.dob), { patientId: a.patientId, name: a.name, dob: a.dob, clinicId: a.clinicId });
  const onFile = keys.size ? await d.select().from(coverageOnFile).where(inArray(coverageOnFile.subjectKey, Array.from(keys.keys()))) : [];
  const existing = await d.select({ subjectKey: eligibilityChecks.subjectKey }).from(eligibilityChecks).where(and(eq(eligibilityChecks.asOfDate, date), eq(eligibilityChecks.trigger, "nightly")));
  const already = new Set(existing.map((e) => e.subjectKey));
  let sent = 0, lastError: string | null = null;
  for (const cov of onFile) {
    if (Date.now() > opts.deadline - 3000) break;
    if (already.has(cov.subjectKey)) continue;
    const who = keys.get(cov.subjectKey)!;
    const split = splitName(who.name);
    const [sexRow] = await d.select({ sex: personDemographics.sex }).from(personDemographics).where(eq(personDemographics.subjectKey, cov.subjectKey)).limit(1);
    const dob = ymd(who.dob);
    const res = await d.insert(eligibilityChecks).values({
      subjectKey: cov.subjectKey, patientId: who.patientId, patientName: who.name.slice(0, 255), payerId: cov.payerId, payerName: cov.payerName, memberId: cov.memberId,
      asOfDate: date, trigger: "nightly", mode: c.mode, clinicId: who.clinicId,
    });
    const id = (res as unknown as [{ insertId: number }])[0].insertId;
    if (!dob) {
      await d.update(eligibilityChecks).set({ status: "error", error: "No date of birth on the schedule." }).where(eq(eligibilityChecks.id, id));
      continue;
    }
    try {
      await send(c, id, { subjectKey: cov.subjectKey, payerId: cov.payerId, payerName: cov.payerName, memberId: cov.memberId, groupNumber: cov.groupNumber, firstName: split.first, lastName: split.last, dob, sex: sexRow?.sex ?? null, asOfDate: date });
      sent++;
    } catch (e) {
      lastError = (e as Error).message;
      await d.update(eligibilityChecks).set({ status: "error", error: lastError.slice(0, 500) }).where(eq(eligibilityChecks.id, id));
      if (/sign-in failed|limit was reached/i.test(lastError)) break;
    }
  }
  // Poll what's still waiting on the payer.
  const pending = await d.select().from(eligibilityChecks).where(and(eq(eligibilityChecks.asOfDate, date), eq(eligibilityChecks.trigger, "nightly"), eq(eligibilityChecks.status, "pending"))).orderBy(asc(eligibilityChecks.id)).limit(200);
  for (const row of pending) {
    if (Date.now() > opts.deadline - 2000) break;
    try { await pollOnce(c, row); } catch (e) { lastError = (e as Error).message; break; }
  }
  const all = await d.select({ status: eligibilityChecks.status }).from(eligibilityChecks).where(and(eq(eligibilityChecks.asOfDate, date), eq(eligibilityChecks.trigger, "nightly")));
  const state: NightlyState = {
    date, lastRunAt: new Date().toISOString(), booked: keys.size, noInsurance: keys.size - onFile.length, sent: all.length,
    done: all.filter((a) => a.status === "complete").length, errors: all.filter((a) => a.status === "error").length,
    finishedAt: all.length === onFile.length && all.every((a) => a.status !== "pending") ? new Date().toISOString() : null, lastError,
  };
  await writeSetting(NIGHTLY_KEY, state, null);
  console.log(`[availity-nightly] ${JSON.stringify({ date, booked: state.booked, sent, done: state.done, errors: state.errors })}`); // counts only
  return state;
}

/** The next clinic day's patients and how their insurance checked out (for the Insurance page). */
export async function scheduleCoverage(actor: WorkspaceActor, date?: string | null) {
  const d = await db();
  const day = date || nextClinicDay(localDateStr());
  const appts = await d.select({ id: appointments.id, patientId: appointments.patientId, name: appointments.patientName, dob: appointments.dateOfBirth, clinicId: appointments.clinicId, clinicName: clinics.name, startsAt: appointments.startsAt, providerName: appointments.providerName, providerDisplay: providers.name, status: appointments.status })
    .from(appointments).leftJoin(clinics, eq(clinics.id, appointments.clinicId)).leftJoin(providers, eq(providers.id, appointments.providerId))
    .where(and(eq(appointments.date, day), ne(appointments.status, "cancelled"))).orderBy(asc(appointments.startsAt));
  const visible = appts.filter((a) => !actor.clinicIds || (a.clinicId != null && actor.clinicIds.includes(a.clinicId)));
  const keys = Array.from(new Set(visible.map((a) => subjectKeyFor(a.patientId, a.name, a.dob))));
  const [onFile, checks, ours] = await Promise.all([
    keys.length ? d.select().from(coverageOnFile).where(inArray(coverageOnFile.subjectKey, keys)) : Promise.resolve([]),
    keys.length ? d.select().from(eligibilityChecks).where(and(inArray(eligibilityChecks.subjectKey, keys), eq(eligibilityChecks.asOfDate, day))).orderBy(desc(eligibilityChecks.createdAt)) : Promise.resolve([]),
    ourProviderNames(),
  ]);
  const cov = new Map(onFile.map((c) => [c.subjectKey, c]));
  const latest = new Map<string, typeof checks[number]>();
  for (const ch of checks) if (!latest.has(ch.subjectKey)) latest.set(ch.subjectKey, ch);
  const rows = visible.map((a) => {
    const key = subjectKeyFor(a.patientId, a.name, a.dob);
    const ch = latest.get(key);
    return {
      appointmentId: a.id, subjectKey: key, patientId: a.patientId, name: a.name, startsAt: a.startsAt, clinicName: a.clinicName, providerName: a.providerDisplay ?? a.providerName,
      onFile: cov.get(key) ? { payerName: cov.get(key)!.payerName ?? cov.get(key)!.payerId, memberId: cov.get(key)!.memberId } : null,
      check: ch ? checkView(ch, ours) : null,
    };
  });
  const c = await config();
  return { date: day, configured: ready(c), nightly: c.nightly, mode: c.mode, rows, lastNightly: await readSetting<NightlyState>(NIGHTLY_KEY) };
}

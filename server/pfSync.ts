// Practice Fusion chart sync (FHIR Bulk Data, read-only).
//
// Each night (or on demand) MyPCP asks Practice Fusion for an export of every patient's chart,
// waits for it, has the files downloaded into private storage, and loads them a chunk at a time
// (every run of the 2-minute job picks up where the last one stopped). The first run is a full
// export; after that only what changed (_since), with a full refresh weekly so deletions drop off.
// Loading fills: the Chart (fhirResources), patient contact/sex/email, and the testing tracker.
import { gzipSync } from "node:zlib";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, emailContacts, fhirPatients, fhirResources, patientTests, personDemographics } from "../drizzle/schema";
import { chartLine, patientInfo, patientOf, sectionType, type FhirResource } from "../shared/fhir";
import { makePersonMatcher, type PersonRef } from "../shared/fax";
import { recognizeTest } from "../shared/testing";
import { localDateStr, localMinutes } from "../shared/workforce";
import { relayFetch } from "./egress";
import { clientAssertion, getPfConfig } from "./pfFhir";
import { clearError, downloadStatus, readChunk, removeFile, startDownload } from "./exportStore";
import { WorkspaceError, audit, buildNameDobIndex, type WorkspaceActor } from "./workspaceDb";
import { factKindOf, saveChartFacts } from "./chartFacts";

const STATE_KEY = "pf_fhir_sync";
// PF approves read scopes one resource type at a time (the 24 ticked on MyPCP's app registration).
// Ask for exactly those; fall back to the standard bulk-export wildcard if PF rejects the list.
const RESOURCE_SCOPES = [
  "AllergyIntolerance", "CarePlan", "CareTeam", "Condition", "Coverage", "Device", "DiagnosticReport", "DocumentReference",
  "Encounter", "Goal", "Group", "Immunization", "Location", "MedicationDispense", "MedicationRequest", "Observation",
  "Organization", "Patient", "Practitioner", "Procedure", "Provenance", "RelatedPerson", "ServiceRequest", "Specimen",
].map((t) => `system/${t}.read`).join(" ");
const SCOPES = [RESOURCE_SCOPES, "system/*.read"];
let workingScope: string | null = null;
const CHUNK = 2 * 1024 * 1024;
const MAX_LINE_CHUNK = 64 * 1024 * 1024;
const MAX_RAW = 12_000_000; // mediumtext holds 16 MB
const NIGHTLY_AFTER_MIN = 2 * 60; // 2:00 am clinic time
const FULL_EVERY_DAYS = 7;

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}
async function readSetting<T>(key: string): Promise<T | null> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}
async function writeSetting(key: string, value: unknown) {
  await (await db()).insert(appSettings).values({ key, value }).onDuplicateKeyUpdate({ set: { value } });
}

interface ExportFile { type: string; url: string; key: string; size: number; offset: number; lines: number; status: "pending" | "downloading" | "ready" | "loaded" | "error"; error?: string | null }
export interface PfSyncState {
  enabled: boolean;
  phase: "idle" | "exporting" | "downloading" | "loading" | "error";
  mode: "full" | "delta" | null;
  requested: "full" | "delta" | null;
  since: string | null;
  statusUrl: string | null;
  startedAt: string | null;
  transactionTime: string | null;
  requiresAccessToken: boolean;
  progress: string | null;
  files: ExportFile[];
  counts: Record<string, number>;
  lastSuccessAt: string | null;
  lastTransactionTime: string | null;
  lastFullAt: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  lockUntil: number;
}
const EMPTY: PfSyncState = {
  enabled: false, phase: "idle", mode: null, requested: null, since: null, statusUrl: null, startedAt: null, transactionTime: null,
  requiresAccessToken: true, progress: null, files: [], counts: {}, lastSuccessAt: null, lastTransactionTime: null, lastFullAt: null, lastError: null, lastAttemptAt: null, lockUntil: 0,
};
export async function getSyncState(): Promise<PfSyncState> {
  return { ...EMPTY, ...((await readSetting<Partial<PfSyncState>>(STATE_KEY)) ?? {}) };
}
const save = (s: PfSyncState) => writeSetting(STATE_KEY, s);

// ---- Practice Fusion API (SMART Backend Services) ----

let tokenCache: { base: string; token: string; expiresAt: number } | null = null;

async function tokenEndpoint(base: string): Promise<string> {
  const res = await relayFetch(`${base}/.well-known/smart-configuration`, { headers: { Accept: "application/json" } });
  const j = (await res.json().catch(() => ({}))) as { token_endpoint?: string };
  if (!res.ok || !j.token_endpoint) throw new Error(`Couldn't read Practice Fusion's sign-in settings (${res.status}).`);
  return j.token_endpoint;
}

async function accessToken(): Promise<{ base: string; token: string }> {
  const c = await getPfConfig();
  if (!c.baseUrl || !c.clientId) throw new WorkspaceError("Save the Practice Fusion FHIR base URL and Client ID first.");
  if (tokenCache && tokenCache.base === c.baseUrl && tokenCache.expiresAt > Date.now() + 60_000) return { base: c.baseUrl, token: tokenCache.token };
  const tokenUrl = await tokenEndpoint(c.baseUrl);
  type TokenReply = { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  let res!: Response;
  let j: TokenReply = {};
  for (const scope of workingScope ? [workingScope] : SCOPES) {
    res = await relayFetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials", scope,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: await clientAssertion(c.clientId, tokenUrl),
      }).toString(),
    });
    j = (await res.json().catch(() => ({}))) as TokenReply;
    if (res.ok && j.access_token) { workingScope = scope; break; }
    if (j.error !== "invalid_scope") break;
  }
  if (!res.ok || !j.access_token) {
    throw new WorkspaceError(`Practice Fusion sign-in failed: ${j.error_description ?? j.error ?? res.status}. Check the Client ID, and that an admin clicked Authorize App in Practice Fusion.`);
  }
  tokenCache = { base: c.baseUrl, token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 300) * 1000 };
  return { base: c.baseUrl, token: j.access_token };
}

/** A signed-in GET to Practice Fusion (e.g. a note's Binary when it's opened). Relative URLs are under the base. */
export async function pfFetch(url: string, accept = "application/fhir+json") {
  const { base, token } = await accessToken();
  const full = /^https:\/\//i.test(url) ? url : `${base}/${url.replace(/^\/+/, "")}`;
  return relayFetch(full, { headers: { Authorization: `Bearer ${token}`, Accept: accept } });
}

/** Admin "Test connection": sign in and read the server's capability statement. */
export async function testConnection(actor: WorkspaceActor) {
  tokenCache = null;
  workingScope = null;
  const { base, token } = await accessToken();
  const res = await relayFetch(`${base}/metadata`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" } });
  const j = (await res.json().catch(() => ({}))) as { fhirVersion?: string; software?: { name?: string } };
  await audit(actor, "manage_access", { entityType: "integration", description: `Practice Fusion FHIR test: ${res.ok ? "ok" : res.status}` });
  if (!res.ok) throw new WorkspaceError(`Signed in, but reading Practice Fusion failed (${res.status}).`);
  return { ok: true, fhirVersion: j.fhirVersion ?? null, software: j.software?.name ?? null };
}

export async function setSyncEnabled(actor: WorkspaceActor, enabled: boolean) {
  const s = await getSyncState();
  s.enabled = enabled;
  await save(s);
  await audit(actor, "manage_access", { entityType: "integration", description: `Practice Fusion nightly sync ${enabled ? "on" : "off"}` });
  return { ok: true };
}

/** Admin "Import now": a full export on the next run. */
export async function requestImport(actor: WorkspaceActor, mode: "full" | "delta") {
  const s = await getSyncState();
  if (s.phase !== "idle" && s.phase !== "error") throw new WorkspaceError("An import is already running.");
  s.requested = mode;
  s.phase = "idle";
  s.lastError = null;
  await save(s);
  await audit(actor, "manage_access", { entityType: "integration", description: `Practice Fusion ${mode} import requested` });
  return { ok: true };
}

// ---- The job ----

function nightlyDue(s: PfSyncState) {
  if (!s.enabled) return false;
  if (localMinutes() < NIGHTLY_AFTER_MIN) return false;
  return !s.lastSuccessAt || localDateStr(new Date(s.lastSuccessAt)) < localDateStr();
}

export async function runPfSync(opts: { deadline: number }) {
  let s = await getSyncState();
  if (s.lockUntil > Date.now()) return { skipped: "Another run is working." };
  // A new export starts when asked for, or nightly; after a failure, not again for 30 minutes.
  const backoff = s.phase === "error" && !s.requested && !!s.lastAttemptAt && Date.now() - new Date(s.lastAttemptAt).getTime() < 30 * 60_000;
  if ((s.phase === "idle" || s.phase === "error") && (backoff || (!s.requested && !nightlyDue(s)))) return { skipped: "Nothing to do." };
  const cfg = await getPfConfig();
  if (!cfg.baseUrl || !cfg.clientId) return { skipped: "Practice Fusion isn't connected." };
  s.lockUntil = opts.deadline + 30_000;
  await save(s);
  try {
    if (s.phase === "idle" || s.phase === "error") { s.lastAttemptAt = new Date().toISOString(); s = await kickoff(s); }
    if (s.phase === "exporting") s = await poll(s);
    if (s.phase === "downloading") s = await checkDownloads(s, opts.deadline);
    if (s.phase === "loading") s = await load(s, opts.deadline);
  } catch (e) {
    s.phase = "error";
    s.lastError = (e as Error).message.slice(0, 400);
  }
  s.lockUntil = 0;
  await save(s);
  console.log(`[pf-sync] ${JSON.stringify({ phase: s.phase, mode: s.mode, files: s.files.length, loaded: s.files.filter((f) => f.status === "loaded").length, counts: s.counts, error: s.lastError })}`); // counts only
  return { phase: s.phase, counts: s.counts, error: s.lastError };
}

async function kickoff(s: PfSyncState): Promise<PfSyncState> {
  const full = s.requested === "full" || !s.lastTransactionTime || !s.lastFullAt || Date.now() - new Date(s.lastFullAt).getTime() > FULL_EVERY_DAYS * 86_400_000;
  const since = full ? null : s.lastTransactionTime;
  const { base, token } = await accessToken();
  const url = `${base}/Patient/$export?_outputFormat=${encodeURIComponent("application/fhir+ndjson")}${since ? `&_since=${encodeURIComponent(since)}` : ""}`;
  const res = await relayFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json", Prefer: "respond-async" } });
  const statusUrl = res.headers.get("content-location");
  if (res.status !== 202 || !statusUrl) {
    const body = await res.text().catch(() => "");
    throw new Error(`Practice Fusion didn't start the export (${res.status}). ${body.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  return {
    ...s, phase: "exporting", mode: full ? "full" : "delta", requested: null, since, statusUrl, startedAt: new Date().toISOString(),
    transactionTime: null, progress: null, files: [], counts: {}, lastError: null,
  };
}

async function poll(s: PfSyncState): Promise<PfSyncState> {
  const { token } = await accessToken();
  const res = await relayFetch(s.statusUrl!, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (res.status === 202) return { ...s, progress: res.headers.get("x-progress") };
  const body = await res.text();
  if (!res.ok) throw new Error(`The export failed at Practice Fusion (${res.status}). ${body.replace(/\s+/g, " ").slice(0, 200)}`);
  const m = JSON.parse(body) as { transactionTime?: string; requiresAccessToken?: boolean; output?: { type: string; url: string }[] };
  const run = (s.startedAt ?? new Date().toISOString()).replace(/[^0-9]/g, "").slice(0, 14);
  // Patients first: everything else is filed under the patient it belongs to.
  const out = [...(m.output ?? [])].sort((a, b) => (a.type === "Patient" ? -1 : b.type === "Patient" ? 1 : a.type.localeCompare(b.type)));
  // Only note the files here (a full export can be 700+ of them); checkDownloads fetches them a few at a time.
  const files: ExportFile[] = out.map((o, i) => ({ type: o.type, url: o.url, key: `pf/${run}/${String(i).padStart(3, "0")}-${o.type}.ndjson`, size: 0, offset: 0, lines: 0, status: "pending" }));
  return { ...s, phase: files.length ? "downloading" : "loading", transactionTime: m.transactionTime ?? s.startedAt, requiresAccessToken: m.requiresAccessToken !== false, files, progress: null };
}

/** Downloads running at once: enough to move along, not so many that one run can't keep track of them. */
const MAX_DOWNLOADING = 20;

export async function checkDownloads(s: PfSyncState, deadline: number): Promise<PfSyncState> {
  // Finished (or failed) since the last run?
  for (const f of s.files.filter((x) => x.status === "downloading")) {
    if (Date.now() > deadline) return s;
    const st = await downloadStatus(f.key);
    if (st.ready) { f.status = "ready"; f.size = st.size; }
    else if (st.error) { f.status = "error"; f.error = st.error; }
  }
  if (s.files.some((f) => f.status === "error")) throw new Error(`A file didn't download: ${s.files.find((f) => f.status === "error")!.error}`);
  // Start more, a few at a time. A file already in the store (from an earlier attempt) isn't fetched again.
  let inFlight = s.files.filter((f) => f.status === "downloading").length;
  let headers: Record<string, string> | null = null;
  for (const f of s.files.filter((x) => x.status === "pending")) {
    if (inFlight >= MAX_DOWNLOADING || Date.now() > deadline) break;
    const st = await downloadStatus(f.key);
    if (st.ready) { f.status = "ready"; f.size = st.size; continue; }
    if (!headers) {
      headers = { Accept: "application/fhir+ndjson" };
      if (s.requiresAccessToken !== false) headers.Authorization = `Bearer ${(await accessToken()).token}`;
    }
    await clearError(f.key);
    await startDownload(f.url, headers, f.key);
    f.status = "downloading";
    inFlight++;
  }
  return s.files.every((f) => f.status === "ready" || f.status === "loaded") ? { ...s, phase: "loading" } : s;
}

// ---- Loading ----

interface LoadCtx {
  byFhirPatient: Map<string, { key: string; patientId: number | null }>;
  /** Name + date of birth → the MyPCP person (built once per run: matching thousands of patients must be instant). */
  match: ReturnType<typeof makePersonMatcher>;
  syncedAt: Date;
  manualSex: Set<string>;
  linkedEmails: Set<string>;
}

async function loadCtx(syncedAt: Date): Promise<LoadCtx> {
  const d = await db();
  const pts = await d.select({ fhirId: fhirPatients.fhirId, key: fhirPatients.subjectKey, patientId: fhirPatients.patientId }).from(fhirPatients);
  const idx = await buildNameDobIndex();
  const manual = await d.select({ k: personDemographics.subjectKey }).from(personDemographics).where(eq(personDemographics.source, "manual"));
  const linked = await d.select({ e: emailContacts.email }).from(emailContacts).where(eq(emailContacts.source, "linked"));
  const people: PersonRef[] = Array.from(idx.entries()).map(([k, v]) => ({ ...v, dob: k.split("|")[1] ?? null }));
  return {
    byFhirPatient: new Map(pts.map((p) => [p.fhirId, { key: p.key, patientId: p.patientId }])),
    match: makePersonMatcher(people),
    syncedAt,
    manualSex: new Set(manual.map((m) => m.k)),
    linkedEmails: new Set(linked.map((l) => l.e)),
  };
}

/** Records loaded between saves: a run must always get some saved before the Lambda's 30-second limit. */
const SUB_BATCH = 200;

async function load(s: PfSyncState, deadline: number): Promise<PfSyncState> {
  // Whole seconds: the database keeps datetimes to the second, and the clean-up below compares against this.
  const ctx = await loadCtx(new Date(Math.floor(Date.parse(s.startedAt ?? new Date().toISOString()) / 1000) * 1000));
  for (const f of s.files) {
    if (f.status === "loaded") continue;
    while (Date.now() < deadline) {
      const chunkStart = f.offset;
      let size = CHUNK;
      let buf = await readChunk(f.key, f.offset, size);
      let end = buf.length < size ? buf.length : buf.lastIndexOf(0x0a) + 1;
      while (end === 0 && buf.length === size && size < MAX_LINE_CHUNK) { // one very long line (e.g. a note with a PDF inside)
        size *= 4;
        buf = await readChunk(f.key, f.offset, size);
        end = buf.length < size ? buf.length : buf.lastIndexOf(0x0a) + 1;
      }
      if (end === 0 && buf.length === size) throw new Error(`A ${f.type} record is too large to load.`);
      // Where each record (line) is, so progress can be saved part-way through the chunk.
      const lineEnds: number[] = [];
      for (let pos = 0; pos < end;) {
        const nl = buf.indexOf(0x0a, pos);
        pos = nl === -1 || nl >= end ? end : nl + 1;
        lineEnds.push(pos);
      }
      for (let i = 0; i < lineEnds.length; i += SUB_BATCH) {
        const from = i === 0 ? 0 : lineEnds[i - 1]!;
        const to = lineEnds[Math.min(i + SUB_BATCH, lineEnds.length) - 1]!;
        const lines = buf.subarray(from, to).toString("utf8").split("\n").filter((l) => l.trim());
        const resources: FhirResource[] = [];
        for (const l of lines) { try { resources.push(JSON.parse(l) as FhirResource); } catch { /* skip a bad line */ } }
        await loadBatch(resources, ctx);
        f.lines += lines.length;
        s.counts[f.type] = (s.counts[f.type] ?? 0) + resources.length;
        f.offset = chunkStart + to;
        if (i + SUB_BATCH < lineEnds.length) {
          await save(s); // resume point
          if (Date.now() >= deadline) return s; // out of time mid-chunk; the next run picks up here
        }
      }
      if (buf.length < size || f.offset >= f.size) { f.status = "loaded"; await removeFile(f.key); break; }
      await save(s); // resume point
    }
    if (f.status !== "loaded") return s; // out of time; next run continues
  }
  // Everything loaded.
  if (s.mode === "full") {
    const d = await db();
    const types = Array.from(new Set(s.files.map((f) => f.type)));
    if (types.length) await d.delete(fhirResources).where(and(inArray(fhirResources.resourceType, types), lt(fhirResources.syncedAt, ctx.syncedAt)));
  }
  return {
    ...s, phase: "idle", statusUrl: null, files: [], lastSuccessAt: new Date().toISOString(), lastTransactionTime: s.transactionTime,
    lastFullAt: s.mode === "full" ? new Date().toISOString() : s.lastFullAt, lastError: null,
  };
}

const packRaw = (r: FhirResource): string | null => {
  const packed = gzipSync(Buffer.from(JSON.stringify(r))).toString("base64");
  return packed.length <= MAX_RAW ? packed : null;
};
const cut = (v: string | null, n: number) => (v ? v.slice(0, n) : null);

async function loadBatch(resources: FhirResource[], ctx: LoadCtx) {
  if (!resources.length) return;
  const d = await db();
  // 1) Patients: who each one is in MyPCP (written a batch at a time).
  const ptRows: (typeof fhirPatients.$inferInsert)[] = [];
  const sexRows: (typeof personDemographics.$inferInsert)[] = [];
  const emailRows: (typeof emailContacts.$inferInsert)[] = [];
  for (const r of resources.filter((x) => x.resourceType === "Patient" && x.id)) {
    const info = patientInfo(r);
    const prev = ctx.byFhirPatient.get(info.fhirId);
    const m = ctx.match(info.name, info.dob);
    // A link to a CCM-roster record stays: Record matching, merges and staff confirmations made it, and
    // the roster spelling can differ from Practice Fusion's (re-matching by name + DOB would undo it).
    const key = prev?.key.startsWith("p:") ? prev.key : m?.sure ? m.person.key : prev && !prev.key.startsWith("f:") ? prev.key : `f:${info.fhirId}`;
    const patientId = key.startsWith("p:") ? Number(key.slice(2)) : null;
    ptRows.push({ fhirId: info.fhirId, subjectKey: key, patientId, name: cut(info.name, 255), dob: info.dob, sex: info.sex, phone: info.phone, email: info.email, address: info.address, mrn: info.mrn, syncedAt: ctx.syncedAt });
    // Re-key their chart rows through the subjectKey index (patientFhirId has none: a lookup by it alone
    // scans the whole chart table and ran past the Lambda's 30 seconds).
    if (prev && prev.key !== key) await d.update(fhirResources).set({ subjectKey: key }).where(and(eq(fhirResources.subjectKey, prev.key), eq(fhirResources.patientFhirId, info.fhirId)));
    ctx.byFhirPatient.set(info.fhirId, { key, patientId });
    // Sex for the testing tracker (staff corrections win) and the email address for patient emails.
    if (info.sex && !ctx.manualSex.has(key)) sexRows.push({ subjectKey: key, patientId, sex: info.sex, source: "import" });
    if (info.email && !ctx.linkedEmails.has(info.email)) emailRows.push({ email: info.email, kind: "patient", patientId, subjectKey: key, name: cut(info.name, 255), source: "import" });
  }
  if (ptRows.length) {
    await d.insert(fhirPatients).values(ptRows).onDuplicateKeyUpdate({
      set: {
        subjectKey: sql`VALUES(${fhirPatients.subjectKey})`, patientId: sql`VALUES(${fhirPatients.patientId})`, name: sql`VALUES(${fhirPatients.name})`,
        dob: sql`VALUES(${fhirPatients.dob})`, sex: sql`VALUES(${fhirPatients.sex})`, phone: sql`VALUES(${fhirPatients.phone})`, email: sql`VALUES(${fhirPatients.email})`,
        address: sql`VALUES(${fhirPatients.address})`, mrn: sql`VALUES(${fhirPatients.mrn})`, syncedAt: sql`VALUES(${fhirPatients.syncedAt})`,
      },
    });
  }
  if (sexRows.length) {
    await d.insert(personDemographics).values(sexRows).onDuplicateKeyUpdate({ set: { sex: sql`VALUES(${personDemographics.sex})`, source: sql`VALUES(${personDemographics.source})` } });
  }
  if (emailRows.length) {
    await d.insert(emailContacts).values(emailRows).onDuplicateKeyUpdate({
      set: {
        kind: sql`VALUES(${emailContacts.kind})`, patientId: sql`VALUES(${emailContacts.patientId})`, subjectKey: sql`VALUES(${emailContacts.subjectKey})`,
        name: sql`VALUES(${emailContacts.name})`, source: sql`VALUES(${emailContacts.source})`,
      },
    });
  }
  // 2) Every resource (patients included) into the chart copy.
  let rows: (typeof fhirResources.$inferInsert)[] = [];
  let bytes = 0;
  const tests: (typeof patientTests.$inferInsert)[] = [];
  const facts: Parameters<typeof saveChartFacts>[0] = [];
  const flush = async () => {
    if (!rows.length) return;
    await d.insert(fhirResources).values(rows).onDuplicateKeyUpdate({
      set: {
        section: sql`VALUES(${fhirResources.section})`, patientFhirId: sql`VALUES(${fhirResources.patientFhirId})`, subjectKey: sql`VALUES(${fhirResources.subjectKey})`,
        title: sql`VALUES(${fhirResources.title})`, value: sql`VALUES(${fhirResources.value})`, status: sql`VALUES(${fhirResources.status})`, date: sql`VALUES(${fhirResources.date})`,
        code: sql`VALUES(${fhirResources.code})`, raw: sql`VALUES(${fhirResources.raw})`, lastUpdated: sql`VALUES(${fhirResources.lastUpdated})`, syncedAt: sql`VALUES(${fhirResources.syncedAt})`,
      },
    });
    rows = []; bytes = 0;
  };
  for (const r of resources) {
    if (!r.id || !r.resourceType) continue;
    const pid = patientOf(r);
    const who = pid ? ctx.byFhirPatient.get(pid) : undefined;
    const line = r.resourceType === "Patient" ? { title: patientInfo(r).name, value: null, status: null, date: patientInfo(r).dob, code: null } : chartLine(r);
    const raw = packRaw(r);
    rows.push({
      resourceType: r.resourceType.slice(0, 40), section: sectionType(r).slice(0, 60), fhirId: r.id.slice(0, 128), patientFhirId: pid?.slice(0, 128) ?? null,
      subjectKey: who?.key ?? null, title: cut(line.title, 255), value: cut(line.value, 255), status: cut(line.status, 40), date: line.date, code: cut(line.code, 80),
      raw, lastUpdated: r.meta?.lastUpdated ? new Date(r.meta.lastUpdated) : null, syncedAt: ctx.syncedAt,
    });
    bytes += raw?.length ?? 0;
    if (rows.length >= 200 || bytes > 8_000_000) await flush();
    // Latest smoking status and BMI per chart (Testing tab rules).
    if (pid && r.resourceType === "Observation") {
      const kind = factKindOf({ section: sectionType(r), title: line.title, code: line.code });
      if (kind) facts.push({ patientFhirId: pid.slice(0, 128), kind, value: cut(line.value, 160), date: line.date });
    }
    // 3) Tests and screenings they've had → the testing tracker.
    const kind = sectionType(r);
    if (who && line.date && line.title && (kind === "Observation:laboratory" || r.resourceType === "Procedure" || r.resourceType === "DiagnosticReport" || r.resourceType === "Immunization")) {
      const t = recognizeTest(line.title);
      if (t && line.date <= localDateStr()) tests.push({ subjectKey: who.key, patientId: who.patientId, testKey: t.key, method: t.method, performedOn: line.date, status: "done", result: kind === "Observation:laboratory" ? cut(line.value, 120) : null, source: "import" });
    }
  }
  await flush();
  for (let i = 0; i < tests.length; i += 400) await d.insert(patientTests).ignore().values(tests.slice(i, i + 400));
  await saveChartFacts(facts);
}


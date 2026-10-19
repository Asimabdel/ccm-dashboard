// RingCentral call-log sync: pulls the company call log with a server (JWT) app so calls
// made OUTSIDE MyPCP — desk phones, the RingCentral desktop/mobile apps — land in the
// same call log as calls made through the phone built into MyPCP.
//
// Only calls to or from a known patient (CCM roster or anyone on the imported schedule)
// land in the call log. Every outside call also becomes an rcCallStats row (who handled it,
// direction, result, length; no outside number) for the per-person productivity numbers. Runs every 10 minutes from an EventBridge
// schedule (lambda.ts, {"__job":"ringcentral-sync"}) and from Admin → Integrations.
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, phoneCalls, rcCallStats, users } from "../drizzle/schema";
import { mapCallLogRecord, mapCallStats } from "../shared/phone";
import { localDateStr } from "../shared/workforce";
import { openSecret, sealSecret } from "./secretBox";
import { buildPhoneIndex, type WorkspaceActor, audit } from "./workspaceDb";
import { relayFetch as rcFetch } from "./egress";

const API = "https://platform.ringcentral.com";
const CONFIG_KEY = "ringcentral_sync";
const STATE_KEY = "ringcentral_sync_state";
/** First run looks this far back. */
const BACKFILL_DAYS = 30;
/** Call-log records can appear up to ~30s after a call ends; re-read a margin at the live edge. */
const LIVE_OVERLAP_MS = 10 * 60_000;
/** A MyPCP-logged call and a synced record within this window, same number + direction, are one call. */
const SAME_CALL_WINDOW_MS = 3 * 60_000;

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

interface StoredConfig { enabled: boolean; clientId: string; clientSecretEnc: string; jwtEnc: string }
export interface SyncState {
  cursor: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastStats: { records: number; matched: number; added: number; updated: number } | null;
  totalAdded: number;
  /** The one-time 30-day re-read for per-person call stats has started. */
  statsBackfilled?: boolean;
}
const EMPTY_STATE: SyncState = { cursor: null, lastRunAt: null, lastSuccessAt: null, lastError: null, lastStats: null, totalAdded: 0 };

async function readSetting<T>(key: string): Promise<T | null> {
  const d = await db();
  const [row] = await d.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}
async function writeSetting(key: string, value: unknown, userId: number | null) {
  const d = await db();
  await d.insert(appSettings).values({ key, value, updatedByUserId: userId }).onDuplicateKeyUpdate({ set: { value, updatedByUserId: userId } });
}

/** What the admin screen may see: never the secret or the JWT. */
export async function getSyncStatus() {
  const cfg = await readSetting<StoredConfig>(CONFIG_KEY);
  const state = { ...EMPTY_STATE, ...((await readSetting<SyncState>(STATE_KEY)) ?? {}) };
  return {
    configured: !!(cfg?.clientId && cfg.clientSecretEnc && cfg.jwtEnc),
    enabled: !!cfg?.enabled,
    clientIdHint: cfg?.clientId ? `…${cfg.clientId.slice(-4)}` : null,
    state,
  };
}

// ---- RingCentral API ----

let tokenCache: { clientId: string; token: string; expiresAt: number } | null = null;
let extCache: { at: number; byId: Map<string, { name: string; email: string | null }> } | null = null;

class RcError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function accessToken(cfg: { clientId: string; clientSecret: string; jwt: string }): Promise<string> {
  if (tokenCache && tokenCache.clientId === cfg.clientId && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const res = await rcFetch(`${API}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: cfg.jwt }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; message?: string };
  if (!res.ok || !body.access_token) {
    throw new RcError(`RingCentral sign-in failed: ${body.error_description ?? body.message ?? res.statusText}. Check the Client ID, Client Secret and JWT.`, res.status);
  }
  tokenCache = { clientId: cfg.clientId, token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

async function rcGet<T>(token: string, path: string): Promise<T> {
  const res = await rcFetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (res.status === 429) throw new RcError("RingCentral rate limit reached; the next run will continue.", 429);
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; errorCode?: string };
  if (!res.ok) {
    const hint = res.status === 403 ? " The RingCentral user who created the JWT needs admin rights to read the company call log, and the app needs the Read Call Log and Read Accounts permissions." : "";
    throw new RcError(`RingCentral ${res.status}: ${body.message ?? res.statusText}.${hint}`, res.status);
  }
  return body;
}

async function extensions(token: string) {
  if (extCache && Date.now() - extCache.at < 3600_000) return extCache.byId;
  const byId = new Map<string, { name: string; email: string | null }>();
  for (let page = 1; page <= 10; page++) {
    const r = await rcGet<{ records: { id: number; name?: string; contact?: { email?: string } }[]; navigation?: { nextPage?: unknown } }>(token, `/restapi/v1.0/account/~/extension?perPage=1000&page=${page}`);
    for (const e of r.records ?? []) byId.set(String(e.id), { name: e.name ?? "RingCentral user", email: e.contact?.email?.toLowerCase() ?? null });
    if (!r.navigation?.nextPage) break;
  }
  extCache = { at: Date.now(), byId };
  return byId;
}

export async function loadCredentials() {
  const cfg = await readSetting<StoredConfig>(CONFIG_KEY);
  if (!cfg?.clientId || !cfg.clientSecretEnc || !cfg.jwtEnc) return null;
  return { enabled: cfg.enabled, clientId: cfg.clientId, clientSecret: openSecret(cfg.clientSecretEnc), jwt: openSecret(cfg.jwtEnc) };
}

// ---- Admin: save + test ----

export async function saveSyncConfig(actor: WorkspaceActor, input: { enabled: boolean; clientId?: string | null; clientSecret?: string | null; jwt?: string | null }) {
  const prev = await readSetting<StoredConfig>(CONFIG_KEY);
  const next: StoredConfig = {
    enabled: input.enabled,
    clientId: input.clientId?.trim() || prev?.clientId || "",
    // Blank = keep what's stored (the screen never shows the saved secrets).
    clientSecretEnc: input.clientSecret?.trim() ? sealSecret(input.clientSecret.trim()) : prev?.clientSecretEnc ?? "",
    jwtEnc: input.jwt?.trim() ? sealSecret(input.jwt.trim()) : prev?.jwtEnc ?? "",
  };
  if (next.clientId !== prev?.clientId || input.clientSecret || input.jwt) { tokenCache = null; extCache = null; }
  // Check the credentials before turning anything on.
  let test: { ok: boolean; message: string } = { ok: false, message: "Enter the Client ID, Client Secret and JWT." };
  if (next.clientId && next.clientSecretEnc && next.jwtEnc) {
    try {
      const token = await accessToken({ clientId: next.clientId, clientSecret: openSecret(next.clientSecretEnc), jwt: openSecret(next.jwtEnc) });
      const exts = await extensions(token);
      await rcGet(token, `/restapi/v1.0/account/~/call-log?view=Simple&perPage=1&dateFrom=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`);
      test = { ok: true, message: `Connected — ${exts.size} RingCentral users found and the company call log is readable.` };
    } catch (e) {
      test = { ok: false, message: (e as Error).message };
    }
  }
  await writeSetting(CONFIG_KEY, { ...next, enabled: next.enabled && test.ok }, actor.id);
  await audit(actor, "manage_access", { entityType: "integration", description: `RingCentral call-log sync ${next.enabled && test.ok ? "on" : "off"}${test.ok ? "" : " (connection test failed)"}` });
  return test;
}

// ---- The sync ----

async function saveCallStats(records: unknown[], exts: Map<string, { name: string; email: string | null }>) {
  const rows = records.flatMap((r) => mapCallStats(r as Parameters<typeof mapCallStats>[0])).map((s) => {
    const ext = s.extensionId ? exts.get(s.extensionId) : undefined;
    return {
      rcId: s.rcId.slice(0, 120), startedAt: s.startedAt, workDate: localDateStr(s.startedAt), direction: s.direction,
      durationSec: Math.min(s.durationSec, 86_400), result: s.result?.slice(0, 60) ?? null, answered: s.answered, missed: s.missed,
      extensionId: s.extensionId, extensionName: ext?.name.slice(0, 120) ?? null, extensionEmail: ext?.email?.slice(0, 320) ?? null,
    };
  });
  const d = await db();
  for (let i = 0; i < rows.length; i += 200) {
    // Re-reading a window updates the same calls (RingCentral fills in results late), never duplicates.
    await d.insert(rcCallStats).values(rows.slice(i, i + 200)).onDuplicateKeyUpdate({
      set: {
        durationSec: sql`VALUES(${rcCallStats.durationSec})`, result: sql`VALUES(${rcCallStats.result})`, answered: sql`VALUES(${rcCallStats.answered})`,
        missed: sql`VALUES(${rcCallStats.missed})`, extensionId: sql`VALUES(${rcCallStats.extensionId})`, extensionName: sql`VALUES(${rcCallStats.extensionName})`,
        extensionEmail: sql`VALUES(${rcCallStats.extensionEmail})`,
      },
    });
  }
}

interface CallRow { id: number; phoneNumber: string; direction: string; startedAt: Date; rcSessionId: string | null; durationSec: number; result: string | null; userId: number | null; rcExtensionName: string | null }

/**
 * Pull the call log in day-sized windows from the saved cursor. RingCentral allows ~10
 * call-log requests a minute, so each run stops at `maxRequests`/`maxMs` and the next
 * run continues; the first runs backfill the last 30 days.
 */
export async function runRingCentralSync(opts: { maxRequests: number; maxMs: number; manual: boolean }) {
  const started = Date.now();
  const creds = await loadCredentials();
  if (!creds) return { skipped: "RingCentral call-log sync isn't set up." };
  if (!creds.enabled && !opts.manual) return { skipped: "RingCentral call-log sync is turned off." };
  const state: SyncState = { ...EMPTY_STATE, ...((await readSetting<SyncState>(STATE_KEY)) ?? {}) };
  const stats = { records: 0, matched: 0, added: 0, updated: 0 };
  state.lastRunAt = new Date().toISOString();
  try {
    const d = await db();
    const token = await accessToken(creds);
    const exts = await extensions(token);
    const userByEmail = new Map((await d.select({ id: users.id, email: users.email }).from(users)).filter((u) => u.email).map((u) => [u.email!.toLowerCase(), u.id]));
    const phones = await buildPhoneIndex();

    // Once, when per-person call stats were added (2026-09-26): re-read the last 30 days so every call
    // (not only patient calls) is counted. Re-reading is safe: calls already in the log are matched, not added.
    if (state.cursor && !state.statsBackfilled) state.cursor = null;
    state.statsBackfilled = true;
    let cursor = state.cursor ? new Date(state.cursor) : new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
    let requests = 0;
    while (requests < opts.maxRequests && Date.now() - started < opts.maxMs) {
      const liveEdge = Date.now() - 60_000;
      const from = cursor;
      const to = new Date(Math.min(from.getTime() + 86_400_000, liveEdge));
      if (to <= from) break;
      // Every page of this window, or nothing (a half-read window is simply re-read next run).
      const records: unknown[] = [];
      let complete = false;
      for (let page = 1; requests < opts.maxRequests && Date.now() - started < opts.maxMs; page++) {
        const r = await rcGet<{ records: unknown[]; navigation?: { nextPage?: unknown } }>(token,
          `/restapi/v1.0/account/~/call-log?view=Detailed&type=Voice&perPage=500&page=${page}&dateFrom=${encodeURIComponent(from.toISOString())}&dateTo=${encodeURIComponent(to.toISOString())}`);
        requests++;
        records.push(...(r.records ?? []));
        if (!r.navigation?.nextPage) { complete = true; break; }
      }
      if (!complete) break;
      stats.records += records.length;

      // Existing calls around this window, for de-duplication in memory.
      const existing: CallRow[] = await d
        .select({ id: phoneCalls.id, phoneNumber: phoneCalls.phoneNumber, direction: phoneCalls.direction, startedAt: phoneCalls.startedAt, rcSessionId: phoneCalls.rcSessionId, durationSec: phoneCalls.durationSec, result: phoneCalls.result, userId: phoneCalls.userId, rcExtensionName: phoneCalls.rcExtensionName })
        .from(phoneCalls)
        .where(and(gte(phoneCalls.startedAt, new Date(from.getTime() - 15 * 60_000)), lte(phoneCalls.startedAt, new Date(to.getTime() + 15 * 60_000))));
      // Productivity numbers: every outside call, patient or not (no outside numbers stored).
      await saveCallStats(records, exts);
      for (const raw of records) {
        const m = mapCallLogRecord(raw as Parameters<typeof mapCallLogRecord>[0]);
        if (!m?.otherNumber) continue;
        const who = phones.get(m.otherNumber);
        if (!who) continue; // not a patient: never stored
        stats.matched++;
        const ext = m.extensionId ? exts.get(m.extensionId) : undefined;
        const userId = ext?.email ? userByEmail.get(ext.email) ?? null : null;
        const same = existing.find((c) =>
          (c.rcSessionId && m.ids.includes(c.rcSessionId)) ||
          (c.phoneNumber === m.otherNumber && c.direction === m.direction && Math.abs(c.startedAt.getTime() - m.startedAt.getTime()) <= SAME_CALL_WINDOW_MS));
        if (same) {
          // Fill in what the in-app log didn't know; never overwrite staff's outcome or note.
          const patch: Partial<typeof phoneCalls.$inferInsert> = {};
          if (!same.durationSec && m.durationSec) patch.durationSec = m.durationSec;
          if (!same.result && m.result) patch.result = m.result.slice(0, 60);
          if (!same.userId && userId) patch.userId = userId;
          if (!same.rcExtensionName && ext) patch.rcExtensionName = ext.name.slice(0, 120);
          if (Object.keys(patch).length) {
            await d.update(phoneCalls).set(patch).where(eq(phoneCalls.id, same.id));
            Object.assign(same, patch);
            stats.updated++;
          }
          continue;
        }
        const rcSessionId = m.ids[0] ?? null;
        const row = {
          userId, direction: m.direction, phoneNumber: m.otherNumber, patientId: who.patientId, subjectKey: who.key, contactName: who.name,
          startedAt: m.startedAt, durationSec: Math.min(m.durationSec, 86_400), result: m.result?.slice(0, 60) ?? null,
          source: "ringcentral", rcSessionId, rcExtensionName: ext?.name.slice(0, 120) ?? null,
        };
        try {
          const res = await d.insert(phoneCalls).values(row);
          existing.push({ id: (res as unknown as [{ insertId: number }])[0].insertId, phoneNumber: row.phoneNumber, direction: row.direction, startedAt: row.startedAt, rcSessionId, durationSec: row.durationSec, result: row.result, userId, rcExtensionName: row.rcExtensionName });
          stats.added++;
        } catch (e) {
          if (!String((e as Error).message).includes("Duplicate")) throw e; // same RingCentral session already stored
        }
      }
      // Next window. At the live edge, step back a little so late-arriving records are picked up.
      const caughtUp = to.getTime() >= liveEdge - 1000;
      cursor = caughtUp ? new Date(to.getTime() - LIVE_OVERLAP_MS) : to;
      state.cursor = cursor.toISOString();
      if (caughtUp) break;
    }
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
  } catch (e) {
    state.lastError = (e as Error).message.slice(0, 500);
  }
  state.lastStats = stats;
  state.totalAdded = (state.totalAdded ?? 0) + stats.added;
  await writeSetting(STATE_KEY, state, null);
  // Counts only — no numbers or names in the logs.
  console.log(`[ringcentral-sync] ${JSON.stringify({ ...stats, cursor: state.cursor, error: state.lastError })}`);
  return { stats, cursor: state.cursor, error: state.lastError };
}

/**
 * IAM-only check (2026-10-16): how RingCentral times calls, to get "on the phone" right. The last few hours of
 * call-log records reduced to durations, results and leg shapes — no phone numbers, names or extension ids.
 */
export async function probeCallDurations(input: { hours: number }) {
  const creds = await loadCredentials();
  if (!creds) return { skipped: "not set up" };
  const token = await accessToken(creds);
  const from = new Date(Date.now() - input.hours * 3600_000).toISOString();
  const r = await rcGet<{ records: Record<string, unknown>[] }>(token, `/restapi/v1.0/account/~/call-log?view=Detailed&type=Voice&perPage=200&dateFrom=${encodeURIComponent(from)}`);
  const recs = r.records ?? [];
  type Leg = { legType?: string; direction?: string; result?: string; duration?: number; action?: string; extension?: unknown; master?: boolean; startTime?: string };
  const sample = recs.slice(0, 40).map((x) => {
    const legs = ((x.legs as Leg[] | undefined) ?? []);
    const start = Date.parse(String(x.startTime));
    return {
      dir: x.direction, result: x.result, duration: x.duration, action: x.action, hasExt: !!x.extension,
      legs: legs.map((l) => ({ type: l.legType, dir: l.direction, result: l.result, dur: l.duration, action: l.action, ext: !!l.extension, master: l.master, offsetSec: l.startTime ? Math.round((Date.parse(l.startTime) - start) / 1000) : null })),
    };
  });
  // Totals: how much of the time the record counts vs the answering legs.
  let top = 0, answeredLegs = 0, inboundAnswered = 0, outboundUnanswered = 0, outboundUnansweredSec = 0;
  for (const x of recs) {
    const legs = ((x.legs as Leg[] | undefined) ?? []);
    const dur = Number(x.duration ?? 0);
    if (String(x.direction).startsWith("In")) {
      const ans = legs.filter((l) => l.extension && /accepted|connected/i.test(l.result ?? ""));
      if (ans.length) { inboundAnswered++; top += dur; answeredLegs += ans.reduce((s, l) => s + Number(l.duration ?? 0), 0); }
    } else if (!/connected|accepted/i.test(String(x.result ?? ""))) { outboundUnanswered++; outboundUnansweredSec += dur; }
  }
  const results: Record<string, number> = {};
  for (const x of recs) { const k = `${x.direction}/${x.result}`; results[k] = (results[k] ?? 0) + 1; }
  return { records: recs.length, results, inboundAnswered, inboundTopSec: top, inboundAnsweringLegSec: answeredLegs, outboundUnanswered, outboundUnansweredSec, sample };
}

/**
 * IAM-only (2026-10-19): one person's calls on a day — RingCentral's call log read fresh vs what MyPCP saved
 * (rcCallStats). Clinic time, direction, result and seconds per call; no phone numbers. For checking talk time.
 */
export async function compareCallsForPerson(input: { name: string; date: string }) {
  const creds = await loadCredentials();
  if (!creds) return { skipped: "not set up" };
  const token = await accessToken(creds);
  const exts = await extensions(token);
  const words = input.name.toLowerCase().split(/\s+/).filter(Boolean);
  const mine = new Map(Array.from(exts.entries()).filter(([, e]) => words.length && words.every((w) => e.name.toLowerCase().includes(w))));
  if (!mine.size) return { problem: `No RingCentral line named like "${input.name}".` };
  // The clinic day sits inside these UTC hours whether it's daylight time or not; trimmed by clinic date below.
  const from = new Date(`${input.date}T04:00:00.000Z`).toISOString();
  const to = new Date(new Date(`${input.date}T07:00:00.000Z`).getTime() + 86_400_000).toISOString();
  const records: Parameters<typeof mapCallStats>[0][] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await rcGet<{ records: Parameters<typeof mapCallStats>[0][]; navigation?: { nextPage?: unknown } }>(token,
      `/restapi/v1.0/account/~/call-log?view=Detailed&type=Voice&perPage=500&page=${page}&dateFrom=${encodeURIComponent(from)}&dateTo=${encodeURIComponent(to)}`);
    records.push(...(r.records ?? []));
    if (!r.navigation?.nextPage) break;
  }
  const fresh = records.flatMap((r) => mapCallStats(r)).filter((s) => s.extensionId && mine.has(s.extensionId) && localDateStr(s.startedAt) === input.date);
  const d = await db();
  const stored = await d.select({ rcId: rcCallStats.rcId, startedAt: rcCallStats.startedAt, direction: rcCallStats.direction, durationSec: rcCallStats.durationSec, result: rcCallStats.result, answered: rcCallStats.answered })
    .from(rcCallStats).where(and(eq(rcCallStats.workDate, input.date), sql`${rcCallStats.extensionId} IN (${sql.join(Array.from(mine.keys()).map((k) => sql`${k}`), sql`, `)})`));
  const storedById = new Map(stored.map((s) => [s.rcId, s]));
  const freshIds = new Set(fresh.map((f) => f.rcId.slice(0, 120)));
  const clock = (t: Date) => t.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
  const counts = (x: { direction: string; answered: boolean; durationSec: number }[]) => {
    const made = x.filter((c) => c.direction === "outbound");
    const taken = x.filter((c) => c.direction === "inbound" && c.answered);
    return { made: made.length, answered: taken.length, talkMin: Math.round([...made, ...taken].reduce((s, c) => s + c.durationSec, 0) / 60) };
  };
  return {
    lines: Array.from(mine.values()).map((e) => e.name),
    ringcentral: counts(fresh),
    mypcp: counts(stored),
    calls: fresh.sort((a, b) => +a.startedAt - +b.startedAt).map((f) => {
      const s = storedById.get(f.rcId.slice(0, 120));
      return { at: clock(f.startedAt), dir: f.direction, rcResult: f.result, rcSec: f.durationSec, savedSec: s ? s.durationSec : null, savedResult: s ? s.result : null };
    }),
    savedButNotInRingCentral: stored.filter((s) => !freshIds.has(s.rcId)).map((s) => ({ at: clock(s.startedAt), dir: s.direction, savedSec: s.durationSec, savedResult: s.result })),
  };
}

/** IAM-only (2026-10-16): re-read the call log from a date (e.g. after changing how calls are credited). The next runs catch up. */
export async function rewindCallSync(fromIso: string) {
  const state: SyncState = { ...EMPTY_STATE, ...((await readSetting<SyncState>(STATE_KEY)) ?? {}) };
  const before = state.cursor;
  state.cursor = new Date(fromIso).toISOString();
  await writeSetting(STATE_KEY, state, null);
  return { before, cursor: state.cursor };
}

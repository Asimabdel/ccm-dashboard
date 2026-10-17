// Seen visits from Practice Fusion (2026-10-17): after each nightly chart sync, every signed visit marks that
// patient's appointment that day "Seen" (completed), or adds the visit to the schedule when it never made it
// onto an imported schedule. Practice Fusion's API has no appointments, so bookings, cancellations and no-shows
// still come from the schedule import; this keeps "seen" right (provider report, daily reports, Opportunity
// Finder, last visit) between imports. Nothing is written to Practice Fusion. Logs and results are counts only.
import { createHash } from "crypto";
import { gunzipSync } from "node:zlib";
import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray, or } from "drizzle-orm";
import { appSettings, appointments, appointmentStatusEvents, fhirPatients, fhirResources, patients, providers } from "../drizzle/schema";
import { getDb } from "./db";
import { addDays, localDateStr } from "../shared/workforce";
import { clinicLocalToUtc } from "../shared/workspace";
import { matchProviderId } from "../shared/csvImport";
import { normalizePhone } from "../shared/phone";
import { CHART_VISIT_KEY_PREFIX, IN_PROGRESS_STATUSES, parseVisitTitle, personKeys, planVisitFill, type FillVisit } from "../shared/visitFill";
import { clearScheduleCache, loadScheduleSubjects, subjectKeyFor } from "./workspaceDb";

const STATE_KEY = "pf_visit_fill";
/** Visits are often signed days later; each run looks back this far (re-runs change nothing already done). */
const WINDOW_DAYS = 45;

export interface VisitFillResult {
  from: string;
  to: string;
  visits: number;
  markedSeen: number;
  added: number;
  alreadySeen: number;
  notSeen: number;
  duplicates: number;
}
export interface VisitFillState {
  lastRunAt: string | null;
  /** The chart sync (its lastSuccessAt) this fill-in last ran after. */
  forSyncAt: string | null;
  result: VisitFillResult | null;
  error: string | null;
}

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export async function getVisitFillState(): Promise<VisitFillState> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, STATE_KEY)).limit(1);
  return { lastRunAt: null, forSyncAt: null, result: null, error: null, ...((row?.value as Partial<VisitFillState> | undefined) ?? {}) };
}
async function saveState(s: VisitFillState) {
  await (await db()).insert(appSettings).values({ key: STATE_KEY, value: s }).onDuplicateKeyUpdate({ set: { value: s } });
}

const ymd = (dt: Date | null) => (dt ? dt.toISOString().slice(0, 10) : null);
type RawEncounter = { period?: { start?: string; end?: string }; participant?: { individual?: { display?: string } }[] };
const unpack = (raw: string | null): RawEncounter | null => {
  if (!raw) return null;
  try { return JSON.parse(gunzipSync(Buffer.from(raw, "base64")).toString("utf8")) as RawEncounter; } catch { return null; }
};

/**
 * Match the last WINDOW_DAYS of signed Practice Fusion visits to the schedule. With apply false it only reports
 * what it would do (counts, plus how Practice Fusion's dates and times look; no names).
 */
export async function fillVisitsFromChart(opts: { apply: boolean; forSyncAt?: string | null }) {
  const d = await db();
  const today = localDateStr();
  const from = addDays(today, -WINDOW_DAYS);

  // The record's date can be a day off the visit's own (time zones); read a little wider, then use the visit's date.
  const encs = await d.select({
    fhirId: fhirResources.fhirId, patientFhirId: fhirResources.patientFhirId, key: fhirResources.subjectKey, title: fhirResources.title,
    value: fhirResources.value, date: fhirResources.date, raw: fhirResources.raw,
  }).from(fhirResources).where(and(
    eq(fhirResources.section, "Encounter"), isNotNull(fhirResources.subjectKey), gte(fhirResources.date, addDays(from, -2)), lte(fhirResources.date, addDays(today, 2)),
    // No visit type ("Unknown") isn't a visit: Practice Fusion created ~5,600 of those on 2026-09-28/29.
    isNotNull(fhirResources.title), ne(fhirResources.title, "Unknown"),
    or(isNull(fhirResources.status), notInArray(fhirResources.status, ["cancelled", "entered-in-error", "planned"])),
  ));

  const fhirIds = Array.from(new Set(encs.map((e) => e.patientFhirId).filter((x): x is string => !!x)));
  const pts: { fhirId: string; key: string; patientId: number | null; name: string | null; dob: string | null; phone: string | null }[] = [];
  for (let i = 0; i < fhirIds.length; i += 1000) {
    pts.push(...(await d.select({ fhirId: fhirPatients.fhirId, key: fhirPatients.subjectKey, patientId: fhirPatients.patientId, name: fhirPatients.name, dob: fhirPatients.dob, phone: fhirPatients.phone })
      .from(fhirPatients).where(inArray(fhirPatients.fhirId, fhirIds.slice(i, i + 1000)))));
  }
  const ptBy = new Map(pts.map((p) => [p.fhirId, p]));
  const rosterIds = Array.from(new Set(encs.map((e) => (e.key?.startsWith("p:") ? Number(e.key.slice(2)) : null)).filter((x): x is number => !!x)));
  const roster = new Map<number, { name: string; dob: string | null; clinicId: number | null }>();
  for (let i = 0; i < rosterIds.length; i += 1000) {
    for (const r of await d.select({ id: patients.id, name: patients.name, dob: patients.dateOfBirth, clinicId: patients.clinicId }).from(patients).where(inArray(patients.id, rosterIds.slice(i, i + 1000)))) {
      roster.set(r.id, { name: r.name, dob: ymd(r.dob), clinicId: r.clinicId });
    }
  }

  // Each visit: its day, provider, time, and who it is.
  const shape = { titleDate: 0, recordDateOnly: 0, titleAndRecordDiffer: 0, withTime: 0, withProvider: 0 };
  type Visit = FillVisit & { subjectKey: string; patientFhirId: string | null; patientId: number | null; name: string; dob: string | null; phone: string | null; provider: string | null; start: string | null; end: string | null };
  const visits: Visit[] = [];
  for (const e of encs) {
    const t = parseVisitTitle(e.title);
    const date = t.date ?? e.date;
    if (!date || date < from || date > today || !e.key) continue;
    if (t.date) { shape.titleDate++; if (e.date && e.date !== t.date) shape.titleAndRecordDiffer++; } else shape.recordDateOnly++;
    const raw = unpack(e.raw);
    const pt = e.patientFhirId ? ptBy.get(e.patientFhirId) : undefined;
    const patientId = e.key.startsWith("p:") ? Number(e.key.slice(2)) : null;
    const r = patientId ? roster.get(patientId) : undefined;
    const provider = (raw?.participant ?? []).map((p) => p.individual?.display).find(Boolean) ?? t.provider ?? (e.value ? e.value.split(" · ").pop() ?? null : null);
    const start = raw?.period?.start ?? null;
    if (start && start.includes("T")) shape.withTime++;
    if (provider) shape.withProvider++;
    const dob = pt?.dob ?? r?.dob ?? null;
    visits.push({
      id: e.fhirId, date, keys: personKeys({ patientId, names: [pt?.name, r?.name], dob }, "visit"),
      subjectKey: e.key, patientFhirId: e.patientFhirId, patientId, name: pt?.name ?? r?.name ?? "", dob, phone: pt?.phone ?? null,
      provider, start, end: raw?.period?.end ?? null,
    });
  }
  visits.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const appts = await d.select({ id: appointments.id, date: appointments.date, status: appointments.status, patientId: appointments.patientId, name: appointments.patientName, dob: appointments.dateOfBirth })
    .from(appointments).where(and(gte(appointments.date, from), lte(appointments.date, today)));
  const plan = planVisitFill(visits, appts.map((a) => ({ id: a.id, date: a.date, status: a.status, keys: personKeys({ patientId: a.patientId, names: [a.name], dob: ymd(a.dob) }, "appointment") })));
  const adds = plan.add as Visit[];
  const result: VisitFillResult = { from, to: today, visits: visits.length, markedSeen: plan.seen.length, added: adds.length, alreadySeen: plan.alreadySeen, notSeen: plan.notSeen, duplicates: plan.duplicates };

  if (!opts.apply) {
    const byKind = (k: string) => adds.filter((v) => v.subjectKey.startsWith(k)).length;
    const perDay = new Map<string, number>();
    for (const v of adds) perDay.set(v.date, (perDay.get(v.date) ?? 0) + 1);
    return {
      dryRun: true, ...result, shape,
      seenFrom: Object.fromEntries(Array.from(new Set(plan.seen.map((s) => s.from))).map((s) => [s, plan.seen.filter((x) => x.from === s).length])),
      addsBy: { roster: byKind("p:"), schedule: byKind("s:"), pfOnly: byKind("f:") },
      addsPerDay: Array.from(perDay.entries()).sort().map(([k, n]) => `${k}:${n}`),
    };
  }

  // 1) Appointments still Scheduled (or left part-way on the flow board) → Seen.
  for (const prev of ["scheduled", ...IN_PROGRESS_STATUSES]) {
    const ids = plan.seen.filter((s) => s.from === prev).map((s) => s.id);
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      await d.update(appointments).set({ status: "completed" }).where(and(inArray(appointments.id, part), eq(appointments.status, prev as "scheduled")));
      await d.insert(appointmentStatusEvents).values(part.map((id) => ({ appointmentId: id, fromStatus: prev, toStatus: "completed", changedByUserId: null })));
    }
  }

  // 2) Visits that were never on an imported schedule → added as Seen, under the same person the schedule
  // already knows (their CCM-roster record, or the spelling on their earlier appointments).
  if (adds.length) {
    const allProviders = await d.select({ id: providers.id, name: providers.name, aliases: providers.aliases, clinicId: providers.clinicId }).from(providers);
    const providerClinic = new Map(allProviders.map((p) => [p.id, p.clinicId]));
    const subjects = await loadScheduleSubjects();
    const rows: (typeof appointments.$inferInsert)[] = [];
    const rekey: { fhirId: string; from: string; to: string }[] = [];
    for (const v of adds) {
      const known = v.subjectKey.startsWith("s:") ? subjects.get(v.subjectKey) : undefined;
      const name = (known?.name ?? v.name).slice(0, 255);
      if (!name) continue;
      const dob = known ? ymd(known.dob) : v.dob;
      const providerId = matchProviderId(v.provider, allProviders);
      let startsAt = v.start && v.start.includes("T") ? new Date(v.start) : null;
      if (!startsAt || Number.isNaN(startsAt.getTime()) || localDateStr(startsAt) !== v.date) startsAt = clinicLocalToUtc(v.date, "12:00");
      const endsAt = v.end && v.end.includes("T") ? new Date(v.end) : null;
      const minutes = endsAt && !Number.isNaN(endsAt.getTime()) ? Math.round((endsAt.getTime() - startsAt.getTime()) / 60000) : 0;
      rows.push({
        clinicId: (providerId ? providerClinic.get(providerId) ?? null : null) ?? (v.patientId ? roster.get(v.patientId)?.clinicId ?? null : null),
        patientId: v.patientId,
        patientName: name,
        dateOfBirth: dob ? new Date(`${dob}T12:00:00Z`) : null,
        phoneNumber: normalizePhone(v.phone) ?? known?.phone ?? null,
        providerId,
        providerName: v.provider?.slice(0, 255) ?? null,
        date: v.date,
        startsAt,
        durationMin: minutes >= 5 && minutes <= 180 ? minutes : 20,
        visitType: "Seen (from Practice Fusion chart)",
        status: "completed",
        externalKey: `${CHART_VISIT_KEY_PREFIX}${createHash("sha256").update(v.id).digest("hex").slice(0, 48)}`,
      });
      // Someone only Practice Fusion knew is now on the schedule: move their chart copy to the schedule's key
      // (what the next chart sync would do), so they aren't listed twice in the patient directory.
      const now = subjectKeyFor(v.patientId, name, dob ? new Date(`${dob}T12:00:00Z`) : null);
      if (v.subjectKey.startsWith("f:") && v.patientFhirId && now !== v.subjectKey) rekey.push({ fhirId: v.patientFhirId, from: v.subjectKey, to: now });
    }
    for (let i = 0; i < rows.length; i += 400) await d.insert(appointments).ignore().values(rows.slice(i, i + 400));
    for (const k of rekey) {
      await d.update(fhirPatients).set({ subjectKey: k.to }).where(and(eq(fhirPatients.fhirId, k.fhirId), eq(fhirPatients.subjectKey, k.from)));
      await d.update(fhirResources).set({ subjectKey: k.to }).where(and(eq(fhirResources.subjectKey, k.from), eq(fhirResources.patientFhirId, k.fhirId)));
    }
  }
  if (plan.seen.length || adds.length) clearScheduleCache();

  const state: VisitFillState = { lastRunAt: new Date().toISOString(), forSyncAt: opts.forSyncAt ?? (await getVisitFillState()).forSyncAt, result, error: null };
  await saveState(state);
  console.log(`[pf-visit-fill] ${JSON.stringify(result)}`); // counts only
  return { dryRun: false, ...result };
}

/** After a chart sync finishes (pf-sync tick with nothing else to do): fill in once per finished sync. */
export async function fillVisitsAfterSync(sync: { phase: string; lastSuccessAt: string | null }) {
  if (sync.phase !== "idle" || !sync.lastSuccessAt) return null;
  const s = await getVisitFillState();
  // The very first run is started by hand (IAM job pf-visit-fill, after a dry run); after that it's automatic.
  if (!s.lastRunAt || s.forSyncAt === sync.lastSuccessAt) return null;
  try {
    return await fillVisitsFromChart({ apply: true, forSyncAt: sync.lastSuccessAt });
  } catch (e) {
    // Don't retry every 2 minutes on a persistent problem: wait for the next sync.
    await saveState({ ...s, lastRunAt: new Date().toISOString(), forSyncAt: sync.lastSuccessAt, error: (e as Error).message.slice(0, 300) });
    console.log(`[pf-visit-fill] failed: ${(e as Error).message.slice(0, 200)}`);
    return null;
  }
}

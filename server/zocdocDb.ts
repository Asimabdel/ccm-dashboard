// ZocDoc in Master Billing (owner only, 2026-11-13): saving the bookings from ZocDoc's "Appointment report"
// downloads, matching each booked patient to a MyPCP person by name + date of birth, and the spend-vs-revenue
// report (insurance payments from Master Billing's claims for those patients). Only read and written through
// the Master Billing router (owner only).
//
// An upload goes: importStart (one row per file) → importRows (the bookings the browser read, a chunk at a
// time; the same booking in a later file updates its row) → the report reads everything fresh.
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { billClaims, fhirResources, users, zocdocBookings, zocdocImports } from "../drizzle/schema";
import { SEEN_STATUSES, nameKey } from "../shared/workspace";
import { addDays, localDateStr } from "../shared/workforce";
import { bookingKeySource, zocdocSummary, type ZBooking, type ZClaim, type ZocdocPatientFilter, type ZocdocRow, type ZocdocStatus, type ZOutcome, type ZVisit } from "../shared/zocdoc";
import { findPeople, type PeopleIndex } from "./billPatientMatch";
import { similarSpelling, tok } from "./rosterMatch";
import { audit, loadScheduleSubjects, WorkspaceError, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const MAX_ROWS_PER_CALL = 500;

/** One row per uploaded file. A file seen before is allowed (re-uploads only update), just reported. */
export async function importStart(a: WorkspaceActor, input: { fileName: string; sha256: string; rowCount: number; firstDate: string | null; lastDate: string | null }) {
  const d = await db();
  const [seen] = await d.select({ id: zocdocImports.id, createdAt: zocdocImports.createdAt }).from(zocdocImports).where(eq(zocdocImports.sha256, input.sha256)).orderBy(desc(zocdocImports.id)).limit(1);
  const [res] = await d.insert(zocdocImports).values({
    fileName: input.fileName.slice(0, 255), sha256: input.sha256, rowCount: input.rowCount, firstDate: input.firstDate, lastDate: input.lastDate, uploadedByUserId: a.id,
  });
  const importId = Number((res as { insertId: number }).insertId);
  await audit(a, "import_zocdoc", { entityType: "zocdocImport", entityId: importId, description: `Uploaded a ZocDoc report (${input.rowCount} bookings, ${input.firstDate ?? "?"} to ${input.lastDate ?? "?"})` });
  return { importId, seenBefore: seen ? { id: seen.id, at: seen.createdAt } : null };
}

/** The key a booking is saved under: ZocDoc's appointment ID, else a hash of who / when / which provider. */
export function bookingKeyOf(r: ZocdocRow): string {
  const src = bookingKeySource(r);
  return src.startsWith("id:") ? src.slice(0, 80) : `h:${createHash("sha256").update(src).digest("hex").slice(0, 40)}`;
}

interface Matcher { nameDob: Map<string, { key: string }>; index: PeopleIndex }

/** Name + date of birth → the MyPCP person. Exact name first, then close spellings with the SAME date of birth. */
function matchPerson(m: Matcher, r: Pick<ZocdocRow, "patientFirst" | "patientLast" | "patientDob" | "appointmentDate">): { subjectKey: string | null; matchSource: string | null } {
  if (!r.patientDob || !r.patientLast) return { subjectKey: null, matchSource: null };
  const name = `${r.patientFirst ?? ""} ${r.patientLast}`.trim();
  const exact = m.nameDob.get(`${nameKey(name)}|${r.patientDob}`);
  if (exact) return { subjectKey: exact.key, matchSource: "name_dob" };
  const sameDob = findPeople(m.index, { name, dates: [r.appointmentDate], providerId: null }).filter((c) => c.person.dob === r.patientDob);
  const keys = Array.from(new Set(sameDob.map((c) => c.person.key)));
  if (keys.length === 1) return { subjectKey: keys[0]!, matchSource: "close_dob" };
  return { subjectKey: null, matchSource: null };
}

async function matcher(): Promise<Matcher> {
  const { people } = await import("./masterBillingDb");
  const p = await people();
  return { nameDob: p.nameDob, index: p.index };
}

/** Save a chunk of bookings (same booking again = its row is updated) and match their patients. */
export async function importRows(_a: WorkspaceActor, input: { importId: number; rows: ZocdocRow[] }) {
  if (input.rows.length > MAX_ROWS_PER_CALL) throw new WorkspaceError(`Send at most ${MAX_ROWS_PER_CALL} bookings at a time.`);
  const d = await db();
  const [imp] = await d.select({ id: zocdocImports.id }).from(zocdocImports).where(eq(zocdocImports.id, input.importId)).limit(1);
  if (!imp) throw new WorkspaceError("That upload wasn't found. Start it again.", "NOT_FOUND");
  const m = await matcher();
  let matched = 0;
  const values = input.rows.map((r) => {
    const hit = matchPerson(m, r);
    if (hit.subjectKey) matched++;
    return {
      bookingKey: bookingKeyOf(r), appointmentAt: r.appointmentAt, appointmentDate: r.appointmentDate, bookedAt: r.bookedAt, status: r.status, statusText: r.statusText,
      patientType: r.patientType, costCents: r.costCents, costReason: r.costReason, bookingSource: r.bookingSource, providerName: r.providerName, locationName: r.locationName,
      insuranceCarrier: r.insuranceCarrier, insurancePlan: r.insurancePlan, visitReason: r.visitReason, patientFirst: r.patientFirst, patientLast: r.patientLast,
      patientDob: r.patientDob, subjectKey: hit.subjectKey, matchSource: hit.matchSource, lastImportId: input.importId,
    };
  });
  if (values.length) {
    await d.insert(zocdocBookings).values(values).onDuplicateKeyUpdate({
      set: {
        appointmentAt: sql`VALUES(appointmentAt)`, appointmentDate: sql`VALUES(appointmentDate)`, bookedAt: sql`VALUES(bookedAt)`, status: sql`VALUES(status)`,
        statusText: sql`VALUES(statusText)`, patientType: sql`VALUES(patientType)`, costCents: sql`VALUES(costCents)`, costReason: sql`VALUES(costReason)`,
        bookingSource: sql`VALUES(bookingSource)`, providerName: sql`VALUES(providerName)`, locationName: sql`VALUES(locationName)`, insuranceCarrier: sql`VALUES(insuranceCarrier)`,
        insurancePlan: sql`VALUES(insurancePlan)`, visitReason: sql`VALUES(visitReason)`, patientFirst: sql`VALUES(patientFirst)`, patientLast: sql`VALUES(patientLast)`,
        patientDob: sql`VALUES(patientDob)`, subjectKey: sql`VALUES(subjectKey)`, matchSource: sql`VALUES(matchSource)`, lastImportId: sql`VALUES(lastImportId)`,
      },
    });
  }
  return { saved: values.length, matched };
}

/** Match again everyone not matched yet (after new patients come into MyPCP). */
export async function rematchUnmatched(): Promise<{ checked: number; matched: number }> {
  const d = await db();
  const rows = await d.select({ id: zocdocBookings.id, patientFirst: zocdocBookings.patientFirst, patientLast: zocdocBookings.patientLast, patientDob: zocdocBookings.patientDob, appointmentDate: zocdocBookings.appointmentDate })
    .from(zocdocBookings).where(isNull(zocdocBookings.subjectKey));
  const m = await matcher();
  let matched = 0;
  for (const r of rows) {
    const hit = matchPerson(m, r);
    if (!hit.subjectKey) continue;
    await d.update(zocdocBookings).set({ subjectKey: hit.subjectKey, matchSource: hit.matchSource }).where(eq(zocdocBookings.id, r.id));
    matched++;
  }
  return { checked: rows.length, matched };
}

type BookingRow = {
  id: number; appointmentDate: string; status: string; patientType: string | null; costCents: number; costReason: string | null; providerName: string | null;
  insuranceCarrier: string | null; patientFirst: string | null; patientLast: string | null; patientDob: string | null; subjectKey: string | null; bookingSource: string | null;
};

/** The person a booking belongs to: the MyPCP person when matched, else name + DOB. */
const personOf = (b: Pick<BookingRow, "subjectKey" | "patientFirst" | "patientLast" | "patientDob">, aliasOf: Map<string, string>) =>
  b.subjectKey ? (aliasOf.get(b.subjectKey) ?? b.subjectKey) : `u:${nameKey(`${b.patientFirst ?? ""} ${b.patientLast ?? ""}`)}|${b.patientDob ?? ""}`;

async function load(from: string, to: string) {
  const d = await db();
  const bookings: BookingRow[] = await d.select({
    id: zocdocBookings.id, appointmentDate: zocdocBookings.appointmentDate, status: zocdocBookings.status, patientType: zocdocBookings.patientType, costCents: zocdocBookings.costCents,
    costReason: zocdocBookings.costReason, providerName: zocdocBookings.providerName, insuranceCarrier: zocdocBookings.insuranceCarrier, patientFirst: zocdocBookings.patientFirst,
    patientLast: zocdocBookings.patientLast, patientDob: zocdocBookings.patientDob, subjectKey: zocdocBookings.subjectKey, bookingSource: zocdocBookings.bookingSource,
  }).from(zocdocBookings).where(and(gte(zocdocBookings.appointmentDate, from), lte(zocdocBookings.appointmentDate, to))).orderBy(asc(zocdocBookings.appointmentDate));

  // Every key a matched person goes by (roster / schedule / Practice Fusion), so all their claims count.
  const { people } = await import("./masterBillingDb");
  const { index } = await people();
  const aliasOf = new Map<string, string>();
  const allKeys = new Set<string>();
  for (const k of Array.from(new Set(bookings.map((b) => b.subjectKey).filter((x): x is string => !!x)))) {
    const person = index.byKey.get(k);
    const canonical = person?.key ?? k;
    for (const alias of [k, ...(person?.keys ?? [])]) { aliasOf.set(alias, canonical); allKeys.add(alias); }
  }
  const claimsByPerson = new Map<string, ZClaim[]>();
  const keyList = Array.from(allKeys);
  for (let i = 0; i < keyList.length; i += 1000) {
    const rows = await d.select({ subjectKey: billClaims.subjectKey, date: billClaims.firstServiceDate, paid: billClaims.paidCents, owes: billClaims.patientOwesCents, billed: billClaims.billedCents })
      .from(billClaims).where(and(inArray(billClaims.subjectKey, keyList.slice(i, i + 1000)), isNull(billClaims.supersededBy), isNotNull(billClaims.firstServiceDate)));
    for (const r of rows) {
      const person = aliasOf.get(r.subjectKey!) ?? r.subjectKey!;
      claimsByPerson.set(person, [...(claimsByPerson.get(person) ?? []), { date: r.date!, paidCents: r.paid, owesCents: r.owes, billedCents: r.billed }]);
    }
  }

  // Visits: our schedule (seen / no-show / canceled / booked) and signed Practice Fusion visits, so a patient who was
  // seen but whose insurance hasn't paid isn't counted as "never came".
  const today = localDateStr();
  const visitsByPerson = new Map<string, ZVisit[]>();
  const addVisit = (key: string, v: ZVisit) => { const person = aliasOf.get(key) ?? key; visitsByPerson.set(person, [...(visitsByPerson.get(person) ?? []), v]); };
  if (allKeys.size) {
    const schedule = await loadScheduleSubjects();
    for (const k of keyList) {
      for (const v of schedule.get(k)?.visits ?? []) {
        const date = localDateStr(v.startsAt);
        const kind: ZVisit["kind"] | null = SEEN_STATUSES.includes(v.status) ? "seen" : v.status === "no_show" ? "no_show" : v.status === "cancelled" ? "cancelled" : date >= today ? "upcoming" : null;
        if (kind) addVisit(k, { date, kind, source: "schedule", provider: v.providerName, visitType: v.visitType });
      }
    }
    // Encounters with no visit type ("Unknown") aren't visits (Practice Fusion made ~5,600 of them on 2026-09-28/29).
    // Their title reads "YYYY-MM-DD; <calendar>; <provider>; My PCP Dr; <signed date>".
    for (let i = 0; i < keyList.length; i += 1000) {
      const rows = await d.select({ key: fhirResources.subjectKey, date: fhirResources.date, status: fhirResources.status, title: fhirResources.title }).from(fhirResources)
        .where(and(eq(fhirResources.section, "Encounter"), inArray(fhirResources.subjectKey, keyList.slice(i, i + 1000)), isNotNull(fhirResources.date), isNotNull(fhirResources.title), sql`${fhirResources.title} <> 'Unknown'`));
      for (const r of rows) {
        if (!r.key || !r.date || r.date > today || ["cancelled", "entered-in-error"].includes(r.status ?? "")) continue;
        const parts = (r.title ?? "").split(";").map((x) => x.trim());
        addVisit(r.key, { date: r.date, kind: "seen", source: "chart", provider: parts[2] || null, visitType: parts[1] || null });
      }
    }
  }
  const zb: ZBooking[] = bookings.map((b) => ({
    person: personOf(b, aliasOf), matched: !!b.subjectKey, appointmentDate: b.appointmentDate, status: b.status as ZocdocStatus,
    patientType: (b.patientType as ZBooking["patientType"]) ?? null, costCents: b.costCents, costReason: b.costReason, providerName: b.providerName, insuranceCarrier: b.insuranceCarrier,
  }));
  return { bookings, aliasOf, visitsByPerson, summary: zocdocSummary(zb, claimsByPerson, today, visitsByPerson) };
}

/** The ZocDoc tab: spend vs. what those patients brought in, by month / provider / insurance, and where money leaks. */
export async function zocdocReport(a: WorkspaceActor, input: { from: string; to: string }) {
  const { summary } = await load(input.from, input.to);
  const d = await db();
  const [last] = await d.select({ id: zocdocImports.id, fileName: zocdocImports.fileName, createdAt: zocdocImports.createdAt, firstDate: zocdocImports.firstDate, lastDate: zocdocImports.lastDate })
    .from(zocdocImports).orderBy(desc(zocdocImports.id)).limit(1);
  const [{ n: total } = { n: 0 }] = await d.select({ n: count() }).from(zocdocBookings);
  await audit(a, "view_zocdoc", { entityType: "zocdocReport", description: `Viewed the ZocDoc report ${input.from} to ${input.to}` });
  const { people, ...rest } = summary;
  return { ...rest, lastUpload: last ?? null, bookingsOnFile: Number(total) };
}

export type { ZocdocPatientFilter } from "../shared/zocdoc";
const PAGE = 50;

/** One row per booked patient (owner only), for checking and for disputes with ZocDoc. */
export async function zocdocPatients(a: WorkspaceActor, input: { from: string; to: string; filter: ZocdocPatientFilter; page: number }) {
  const { bookings, aliasOf, summary } = await load(input.from, input.to);
  const named = new Map<string, { name: string; dob: string | null; subjectKey: string | null }>();
  for (const b of bookings) {
    const person = personOf(b, aliasOf);
    if (!named.has(person)) named.set(person, { name: `${b.patientFirst ?? ""} ${b.patientLast ?? ""}`.trim(), dob: b.patientDob, subjectKey: b.subjectKey });
  }
  const want = (p: (typeof summary.people)[number]) => {
    switch (input.filter) {
      case "no_visit": return p.isNew && p.chargedBookings > 0 && !p.cameIn && !p.pending;
      case "practice_canceled": return p.practiceCanceledCharged > 0;
      case "not_matched": return !p.matched;
      case "already_ours": return p.alreadyOurs;
      case "came_in": return p.cameIn;
      case "never": case "came_later": case "seen_no_payment": case "upcoming":
        return p.isNew && p.chargedBookings > 0 && p.outcome === (input.filter as ZOutcome);
      default: return true;
    }
  };
  const list = summary.people.filter(want).sort((x, y) => y.firstDate.localeCompare(x.firstDate));
  const page = Math.max(1, input.page);
  const rows = list.slice((page - 1) * PAGE, page * PAGE).map((p) => ({ ...p, ...named.get(p.person)! }));
  await audit(a, "view_zocdoc", { entityType: "zocdocPatients", description: `Viewed ZocDoc patients (${input.filter}, ${list.length})` });
  return { rows, total: list.length, page, pageSize: PAGE };
}

/** Uploads, newest first. */
export async function zocdocImportsList(limit = 50) {
  const d = await db();
  return d.select({
    id: zocdocImports.id, fileName: zocdocImports.fileName, rowCount: zocdocImports.rowCount, firstDate: zocdocImports.firstDate, lastDate: zocdocImports.lastDate,
    createdAt: zocdocImports.createdAt, uploadedBy: users.name,
  }).from(zocdocImports).leftJoin(users, eq(users.id, zocdocImports.uploadedByUserId)).orderBy(desc(zocdocImports.id)).limit(limit);
}

/** Counts and dollar totals only (no patient details), for the IAM-only "zocdoc-counts" job. */
export async function zocdocCounts(input: { from?: string; to?: string } = {}) {
  const from = input.from ?? `${localDateStr().slice(0, 4)}-01-01`;
  const to = input.to ?? localDateStr();
  const { summary } = await load(from, to);
  const d = await db();
  const bySource = await d.select({ source: zocdocBookings.matchSource, n: count() }).from(zocdocBookings)
    .where(and(gte(zocdocBookings.appointmentDate, from), lte(zocdocBookings.appointmentDate, to))).groupBy(zocdocBookings.matchSource);
  const dollars = (c: number) => Math.round(c / 100);
  const t = summary.totals;
  return {
    from, to, bookings: t.bookings, chargedBookings: t.chargedBookings, spent: dollars(t.spentCents), patients: t.patients, chargedNewPatients: t.chargedPatients,
    matched: t.matchedPatients, matchBySource: Object.fromEntries(bySource.map((r) => [r.source ?? "none", Number(r.n)])),
    cameIn: t.cameIn, judged: t.judged, pending: t.pending, alreadyOurs: t.alreadyOurs,
    insurancePaidFirst45: dollars(t.paidFirstCents), insurancePaidLater: dollars(t.paidLaterCents), patientResponsibility: dollars(t.owesCents),
    leaks: { noVisit: { ...summary.leaks.noVisit, cost: dollars(summary.leaks.noVisit.costCents) }, practiceCanceled: { bookings: summary.leaks.practiceCanceled.bookings, cost: dollars(summary.leaks.practiceCanceled.costCents) }, patientCanceled: { bookings: summary.leaks.patientCanceled.bookings, cost: dollars(summary.leaks.patientCanceled.costCents) } },
    months: summary.months.map((m) => ({ month: m.key, charged: m.chargedBookings, cost: dollars(m.costCents), patients: m.patients, cameIn: m.cameIn, paid: dollars(m.paidCents) })),
    lost: {
      patients: summary.lost.patients, judged: summary.lost.judged, cost: dollars(summary.lost.costCents), notInMyPcp: summary.lost.notInMyPcp, noShowOnSchedule: summary.lost.noShowOnSchedule,
      reasons: Object.fromEntries(summary.lost.reasons.map((r) => [r.key, { patients: r.patients, cost: dollars(r.costCents) }])),
      notLost: Object.fromEntries(Object.entries(summary.lost.notLost).map(([k, v]) => [k, { patients: v.patients, cost: dollars(v.costCents) }])),
      months: summary.lost.months.map((m) => `${m.key} ${m.lost}/${m.judged} $${dollars(m.costCents)}`),
    },
    alreadyOursCost: dollars(summary.leaks.alreadyOurs.costCents),
  };
}

/** A claim's patient name looks like the booked patient's: any word order, one-letter typos, a first name's start. */
export function nameLooksLike(first: string | null, last: string | null, other: string | null): boolean {
  const o = tok(other).words;
  if (!o.length) return false;
  const near = (x: string) => !!x && o.some((w) => w === x || similarSpelling(w, x));
  const f = tok(first).first;
  const firstOk = near(f) || (f.length >= 3 && o.some((w) => w.length >= 3 && (w.startsWith(f.slice(0, 3)) || f.startsWith(w.slice(0, 3)))));
  return tok(last).words.some(near) && firstOk;
}

const tally = (list: (string | null | undefined)[], top = 12) => {
  const m = new Map<string, number>();
  for (const k of list) m.set(k || "(blank)", (m.get(k || "(blank)") ?? 0) + 1);
  return Object.fromEntries(Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, top));
};

/**
 * IAM-only "zocdoc-seen-no-payment" job, counts only: the charged new patients who were seen (our schedule or a signed
 * Practice Fusion visit) but have no insurance claim in Master Billing. Why: a claim for that day under another / no
 * patient match, the same name + birth date on another date, how recent the visit is, who saw them, the insurance.
 */
export async function zocdocSeenNoPaymentCounts(input: { from?: string; to?: string } = {}) {
  const from = input.from ?? `${localDateStr().slice(0, 4)}-01-01`;
  const to = input.to ?? localDateStr();
  const today = localDateStr();
  const { bookings, aliasOf, visitsByPerson, summary } = await load(from, to);
  const d = await db();
  const named = new Map<string, { first: string | null; last: string | null; dob: string | null }>();
  for (const b of bookings) { const p = personOf(b, aliasOf); if (!named.has(p)) named.set(p, { first: b.patientFirst, last: b.patientLast, dob: b.patientDob }); }
  const list = summary.people.filter((p) => p.isNew && p.chargedBookings > 0 && p.outcome === "seen_no_payment");
  const seenOf = (p: (typeof list)[number]) => (visitsByPerson.get(p.person) ?? [])
    .filter((v) => v.kind === "seen" && v.date >= addDays(p.firstDate, -1) && v.date <= today).sort((a, b) => a.date.localeCompare(b.date));

  // Claims on (or 3 days around) each seen day, and claims with the same birth date, whoever they were matched to.
  type C = { date: string | null; name: string | null; dob: string | null; subjectKey: string | null; status: string; paid: number };
  const cols = { date: billClaims.firstServiceDate, name: billClaims.patientName, dob: billClaims.patientDob, subjectKey: billClaims.subjectKey, status: billClaims.status, paid: billClaims.paidCents };
  const dates = new Set<string>();
  for (const p of list) for (const v of seenOf(p)) for (let k = -3; k <= 3; k++) dates.add(addDays(v.date, k));
  const near: C[] = [];
  const dl = Array.from(dates);
  for (let i = 0; i < dl.length; i += 500) near.push(...await d.select(cols).from(billClaims).where(and(inArray(billClaims.firstServiceDate, dl.slice(i, i + 500)), isNull(billClaims.supersededBy))));
  const dobs = Array.from(new Set(list.map((p) => named.get(p.person)?.dob).filter((x): x is string => !!x)));
  const sameDob: C[] = [];
  for (let i = 0; i < dobs.length; i += 500) sameDob.push(...await d.select(cols).from(billClaims).where(and(inArray(billClaims.patientDob, dobs.slice(i, i + 500)), isNull(billClaims.supersededBy))));
  const [{ last: latestPayment } = { last: null }] = await d.select({ last: sql<string | null>`max(${billClaims.lastPaidDate})` }).from(billClaims);

  const evidence: string[] = [], age: string[] = [], month: string[] = [], found: string[] = [], foundStatus: string[] = [];
  const provider: (string | null)[] = [], visitType: (string | null | undefined)[] = [];
  let costCents = 0, twoPlusVisits = 0;
  /** Per ZocDoc insurance: how many have a signed Practice Fusion visit note vs. only "seen" on our schedule. */
  const byInsurance = new Map<string, { patients: number; signedNote: number; scheduleOnly: number }>();
  for (const p of list) {
    const n = named.get(p.person) ?? { first: null, last: null, dob: null };
    const seen = seenOf(p);
    const first = seen[0]!;
    costCents += p.costCents;
    if (seen.length > 1) twoPlusVisits++;
    const chart = seen.some((v) => v.source === "chart"), sched = seen.some((v) => v.source === "schedule");
    evidence.push(chart && sched ? "schedule + signed chart visit" : chart ? "signed chart visit only" : "schedule only");
    const ins = byInsurance.get(p.insurance || "(none / self-pay)") ?? { patients: 0, signedNote: 0, scheduleOnly: 0 };
    ins.patients++;
    if (chart) ins.signedNote++; else ins.scheduleOnly++;
    byInsurance.set(p.insurance || "(none / self-pay)", ins);
    const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${first.date}T12:00:00Z`)) / 86_400_000);
    age.push(days <= 30 ? "0-30 days ago" : days <= 60 ? "31-60 days ago" : days <= 90 ? "61-90 days ago" : "over 90 days ago");
    month.push(first.date.slice(0, 7));
    provider.push(seen.find((v) => v.provider)?.provider ?? p.provider);
    visitType.push(first.visitType);
    const seenDays = seen.map((v) => v.date);
    const close = (date: string | null) => !!date && seenDays.some((s) => Math.abs(Date.parse(`${s}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) <= 3 * 86_400_000);
    const sameDay = near.filter((c) => close(c.date) && nameLooksLike(n.first, n.last, c.name));
    const otherDate = n.dob ? sameDob.filter((c) => c.dob === n.dob && !!c.date && c.date >= addDays(p.firstDate, -1) && nameLooksLike(n.first, n.last, c.name)) : [];
    const hit = sameDay[0] ?? otherDate[0];
    found.push(sameDay.length ? (sameDay.some((c) => !c.subjectKey) ? "claim near the visit day, not matched to any patient" : "claim near the visit day, matched to another patient record")
      : otherDate.length ? "same name + birth date claim on another day" : "no claim found at all");
    if (hit) foundStatus.push(hit.status);
  }
  return {
    from, to, today, latestPaymentInMasterBilling: latestPayment, patients: list.length, zocdocCost: Math.round(costCents / 100),
    whatWeFound: tally(found), statusOfFoundClaims: tally(foundStatus),
    visitEvidence: tally(evidence), seenMoreThanOnce: twoPlusVisits,
    firstVisitAge: tally(age), firstVisitMonth: Object.fromEntries(Object.entries(tally(month, 24)).sort()),
    provider: tally(provider), visitType: tally(visitType, 10),
    zocdocInsurance: tally(list.map((p) => p.insurance)),
    insuranceBySignedNote: Object.fromEntries(Array.from(byInsurance.entries()).sort((a, b) => b[1].patients - a[1].patients)),
    insurersWithPaymentFiles: (await d.selectDistinct({ payer: billClaims.payerName }).from(billClaims)).map((r) => r.payer).filter(Boolean),
    lastZocdocStatus: tally(list.map((p) => p.statuses[p.statuses.length - 1])),
  };
}

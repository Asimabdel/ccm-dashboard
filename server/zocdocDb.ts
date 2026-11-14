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
import { billClaims, users, zocdocBookings, zocdocImports } from "../drizzle/schema";
import { nameKey } from "../shared/workspace";
import { localDateStr } from "../shared/workforce";
import { bookingKeySource, zocdocSummary, type ZBooking, type ZClaim, type ZocdocRow, type ZocdocStatus } from "../shared/zocdoc";
import { findPeople, type PeopleIndex } from "./billPatientMatch";
import { audit, WorkspaceError, type WorkspaceActor } from "./workspaceDb";

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
  const zb: ZBooking[] = bookings.map((b) => ({
    person: personOf(b, aliasOf), matched: !!b.subjectKey, appointmentDate: b.appointmentDate, status: b.status as ZocdocStatus,
    patientType: (b.patientType as ZBooking["patientType"]) ?? null, costCents: b.costCents, costReason: b.costReason, providerName: b.providerName, insuranceCarrier: b.insuranceCarrier,
  }));
  return { bookings, aliasOf, summary: zocdocSummary(zb, claimsByPerson, localDateStr()) };
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

export type ZocdocPatientFilter = "all" | "no_visit" | "practice_canceled" | "not_matched" | "already_ours" | "came_in";
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
    leaks: { noVisit: { ...summary.leaks.noVisit, cost: dollars(summary.leaks.noVisit.costCents) }, practiceCanceled: { bookings: summary.leaks.practiceCanceled.bookings, cost: dollars(summary.leaks.practiceCanceled.costCents) } },
    months: summary.months.map((m) => ({ month: m.key, charged: m.chargedBookings, cost: dollars(m.costCents), patients: m.patients, cameIn: m.cameIn, paid: dollars(m.paidCents) })),
  };
}

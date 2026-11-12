// Master Billing (owner only, built 2026-11-11): saving uploaded bills, joining each claim's files
// into one claim, matching claims to patients / providers / clinics, and the totals behind the page.
//
// An upload goes: startImport (refuses a file already saved, gives an upload link for the original)
// → addEvents (the claims the browser read, a chunk at a time) → finishImport (claims recomputed a
// few hundred at a time, so no request runs long). Removing an upload works the same way backwards.
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, appointments, billClaimEvents, billClaims, billImports, billLines, clinics, coverageOnFile, fhirPatients, fhirResources, patients, providers, users } from "../drizzle/schema";
import {
  altKeyOf, claimRefOf, deductibleOwedCents, groupDeductible, HIGH_DEDUCTIBLE_MIN_VISITS, HIGH_DEDUCTIBLE_WINDOW_DAYS, mergeClaim,
  type BillAdjustment, type BillEventInput, type BillLineInput, type BillSource, type BreakdownDim, type DateBasis, type DeductibleLine,
} from "../shared/masterBilling";
import { BILL_STATUS_LABELS, describeAdjustment, insuranceType, type BillStatus } from "../shared/billCodes";
import { nameKey } from "../shared/workspace";
import { matchProviderId } from "../shared/csvImport";
import { addDays } from "../shared/payments";
import { localDateStr } from "../shared/workforce";
import { audit, buildNameDobIndex, buildNameIndex, loadScheduleSubjects, subjectKeyFor, WorkspaceError, type WorkspaceActor } from "./workspaceDb";
import { addMember, buildPeopleIndex, compareNames, findPeople, personByMember, pickPerson, type PeopleIndex, type PersonInput } from "./billPatientMatch";
import { getBytes, onS3, putBytes, readTarget, uploadTarget } from "./docStore";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}
type Db = Awaited<ReturnType<typeof db>>;

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Claims recomputed per request (each request stays well under the 30-second limit). */
const RECOMPUTE_BATCH = 300;
const MEMBER_LINKS_KEY = "master_billing_member_links";
const SHEET_MAPS_KEY = "master_billing_sheet_maps";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const upperAlnum = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const chunks = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const cut = (s: string | null | undefined, n: number) => (s == null || s === "" ? null : String(s).slice(0, n));
/** "Medicare Part B" and "MEDICARE  PART B" are the same insurance: one spelling, so they group together. */
const payerLabel = (s: string | null | undefined) => cut((s ?? "").trim().replace(/\s+/g, " ").toUpperCase(), 160);

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export interface CheckSummary {
  payerName: string | null;
  checkNumber: string | null;
  paymentDate: string | null;
  amountCents: number;
  method: string | null;
  claims: number;
  balanced: boolean | null;
  balanceDiffCents: number;
  adjustments: { code: string; ref: string | null; cents: number }[];
}

/** Which of these files are already saved (the same file isn't saved twice). */
export async function checkFiles(hashes: string[]) {
  if (!hashes.length) return [];
  const rows = await (await db()).select({ sha256: billImports.sha256, id: billImports.id, fileName: billImports.fileName, createdAt: billImports.createdAt })
    .from(billImports).where(and(inArray(billImports.sha256, hashes), eq(billImports.status, "saved")));
  return rows;
}

const EXT: Record<string, string> = { era835: ".835", pdf: ".pdf", sheet: "" };

export async function startImport(a: WorkspaceActor, input: { kind: BillSource; fileName: string; sha256: string; size: number; contentType: string; checks?: CheckSummary[] | null }) {
  if (input.size > MAX_FILE_BYTES) throw new WorkspaceError("That file is too big (25 MB at most).");
  const d = await db();
  const [dupe] = await d.select({ id: billImports.id, fileName: billImports.fileName, createdAt: billImports.createdAt }).from(billImports)
    .where(and(eq(billImports.sha256, input.sha256), eq(billImports.status, "saved"))).limit(1);
  if (dupe) throw new WorkspaceError(`This file was already uploaded (${dupe.fileName}, ${dupe.createdAt.toISOString().slice(0, 10)}).`);
  // An earlier try of the same file that never finished: clear it first.
  const stale = await d.select({ id: billImports.id }).from(billImports).where(and(eq(billImports.sha256, input.sha256), eq(billImports.status, "saving")));
  for (const s of stale) await dropImportRows(d, s.id, "canceled");

  const res = await d.insert(billImports).values({
    kind: input.kind, fileName: input.fileName.slice(0, 255), sha256: input.sha256, uploadedByUserId: a.id, status: "saving",
    checks: input.checks ?? null,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  const ext = (input.fileName.match(/\.[a-z0-9]{1,5}$/i)?.[0] ?? EXT[input.kind] ?? "").toLowerCase();
  // Under documents/ like every other stored file (the bucket's access is set up for that folder).
  const s3Key = `documents/master-billing/${id}-${input.sha256.slice(0, 12)}${ext}`;
  await d.update(billImports).set({ s3Key }).where(eq(billImports.id, id));
  return { importId: id, upload: await uploadTarget(s3Key, input.contentType || "application/octet-stream") };
}

async function importOr404(id: number) {
  const [imp] = await (await db()).select().from(billImports).where(eq(billImports.id, id)).limit(1);
  if (!imp) throw new WorkspaceError("Upload not found.", "NOT_FOUND");
  return imp;
}

/** Local development only: the original file comes through the API. */
export async function uploadLocal(importId: number, base64: string) {
  if (onS3()) throw new WorkspaceError("Upload the file with the upload link.");
  const imp = await importOr404(importId);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_FILE_BYTES) throw new WorkspaceError("That file is too big.");
  if (imp.s3Key) await putBytes(imp.s3Key, bytes, "application/octet-stream");
  return { ok: true };
}

/** A short-lived link to the original file (or its bytes, locally). */
export async function originalFile(importId: number) {
  const imp = await importOr404(importId);
  if (!imp.s3Key) throw new WorkspaceError("The original file wasn't kept for this upload.");
  const type = imp.kind === "pdf" ? "application/pdf" : "text/plain";
  try {
    return { ...(await readTarget(imp.s3Key, imp.fileName, type)), fileName: imp.fileName, contentType: type };
  } catch {
    throw new WorkspaceError("The original file couldn't be found.");
  }
}

/** The original PDF's bytes (for the AI read). */
export async function importBytes(importId: number): Promise<Buffer> {
  const imp = await importOr404(importId);
  if (!imp.s3Key) throw new WorkspaceError("The file wasn't uploaded.");
  try {
    return await getBytes(imp.s3Key);
  } catch {
    throw new WorkspaceError("The upload didn't arrive. Please try again.");
  }
}

/** What makes two events the same payment (a re-downloaded zip, or a PDF of a payment file already in). */
function eventKeyOf(e: BillEventInput): string {
  return sha256(JSON.stringify([
    e.source, upperAlnum(e.payerName), upperAlnum(e.checkNumber), upperAlnum(e.claimNo), upperAlnum(e.payerClaimNo), e.clpStatus, e.sheetStatus,
    e.billedCents, e.paidCents, e.paidDate, e.source === "sheet" ? [nameKey(e.patientName ?? ""), e.serviceFrom, e.note] : null,
    e.lines.map((l) => [l.code, l.modifiers.join(","), l.serviceDate, l.billedCents, l.paidCents]),
  ]));
}

export async function addEvents(a: WorkspaceActor, importId: number, events: BillEventInput[]) {
  const imp = await importOr404(importId);
  if (imp.status !== "saving" || imp.uploadedByUserId !== a.id) throw new WorkspaceError("This upload can't take more claims.");
  if (!events.length) return { added: 0 };
  const rows = events.map((e) => ({
    importId, claimRef: claimRefOf(e), altKey: altKeyOf(e), eventKey: eventKeyOf(e), source: e.source,
    claimNo: cut(e.claimNo, 60), payerClaimNo: cut(e.payerClaimNo, 60), clpStatus: cut(e.clpStatus, 4), sheetStatus: cut(e.sheetStatus, 20),
    payerName: cut(e.payerName, 160), payerId: cut(e.payerId, 40), filingIndicator: cut(e.filingIndicator, 4),
    patientName: cut(e.patientName, 255), patientDob: cut(e.patientDob, 10), memberId: cut(e.memberId, 60),
    providerName: cut(e.providerName, 255), providerNpi: cut(e.providerNpi, 10),
    serviceFrom: cut(e.serviceFrom, 10), serviceTo: cut(e.serviceTo, 10), paidDate: cut(e.paidDate, 10), checkNumber: cut(e.checkNumber, 60),
    billedCents: e.billedCents, paidCents: e.paidCents, patientRespCents: e.patientRespCents,
    claimAdjustments: e.claimAdjustments, lines: e.lines, note: cut(e.note, 500),
  }));
  const d = await db();
  let added = 0;
  for (const part of chunks(rows, 200)) {
    const r = await d.insert(billClaimEvents).ignore().values(part);
    added += Number((r as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? part.length);
  }
  return { added };
}

/** Recompute this upload's claims, a batch per call. Returns done=false with the next cursor until finished. */
export async function finishImport(a: WorkspaceActor, importId: number, cursor = 0) {
  const imp = await importOr404(importId);
  if (imp.status !== "saving" || imp.uploadedByUserId !== a.id) throw new WorkspaceError("This upload is already finished.");
  const d = await db();
  const refs = (await d.selectDistinct({ ref: billClaimEvents.claimRef }).from(billClaimEvents).where(eq(billClaimEvents.importId, importId)).orderBy(asc(billClaimEvents.claimRef))).map((r) => r.ref);
  const batch = refs.slice(cursor, cursor + RECOMPUTE_BATCH);
  if (batch.length) await recomputeClaims(d, batch, importId);
  const next = cursor + batch.length;
  if (next < refs.length) return { done: false as const, next, total: refs.length };

  // Billed counts new charges only (a take-back repeats an old charge as a negative); paid is the net money.
  const [totals] = await d.select({
    billed: sql<number>`COALESCE(SUM(CASE WHEN ${billClaimEvents.clpStatus} = '22' THEN 0 ELSE ${billClaimEvents.billedCents} END), 0)`,
    paid: sql<number>`COALESCE(SUM(${billClaimEvents.paidCents}), 0)`,
  }).from(billClaimEvents).where(eq(billClaimEvents.importId, importId));
  let matched = 0;
  for (const part of chunks(refs, 1000)) {
    const [m] = await d.select({ n: sql<number>`COUNT(*)` }).from(billClaims).where(and(inArray(billClaims.claimRef, part), isNotNull(billClaims.subjectKey)));
    matched += Number(m?.n ?? 0);
  }
  await d.update(billImports).set({
    status: "saved", claimCount: refs.length, billedCents: Number(totals?.billed ?? 0), paidCents: Number(totals?.paid ?? 0), matchedCount: matched,
  }).where(eq(billImports.id, importId));
  await audit(a, "import_bills", { entityType: "billImport", entityId: importId, description: `Uploaded ${imp.kind} file: ${refs.length} claim${refs.length === 1 ? "" : "s"}` });
  return { done: true as const, claims: refs.length, matched, total: refs.length };
}

/** Abandon an upload that wasn't finished (the owner canceled the review). */
export async function cancelImport(a: WorkspaceActor, importId: number) {
  const imp = await importOr404(importId);
  if (imp.status !== "saving" || imp.uploadedByUserId !== a.id) throw new WorkspaceError("Only an unfinished upload can be canceled.");
  const d = await db();
  await dropImportRows(d, importId, "canceled");
  return { ok: true };
}

/** canceled = never finished (hidden from the list); removed = taken out after it was saved. */
async function dropImportRows(d: Db, importId: number, status: "canceled" | "removed") {
  await d.delete(billClaimEvents).where(eq(billClaimEvents.importId, importId));
  await d.update(billImports).set({ status, removedAt: new Date() }).where(eq(billImports.id, importId));
}

/** Remove a saved upload: its claims are recomputed without it, a batch per call. */
export async function removeImport(a: WorkspaceActor, importId: number, cursor = 0) {
  const imp = await importOr404(importId);
  if (imp.status === "removed" || imp.status === "canceled") return { done: true as const, total: 0 };
  const d = await db();
  if (imp.status === "saved") await d.update(billImports).set({ status: "removing", removedByUserId: a.id }).where(eq(billImports.id, importId));
  else if (imp.status !== "removing") throw new WorkspaceError("This upload isn't finished yet.");
  const refs = (await d.selectDistinct({ ref: billClaimEvents.claimRef }).from(billClaimEvents).where(eq(billClaimEvents.importId, importId)).orderBy(asc(billClaimEvents.claimRef))).map((r) => r.ref);
  const batch = refs.slice(cursor, cursor + RECOMPUTE_BATCH);
  if (batch.length) await recomputeClaims(d, batch, null);
  const next = cursor + batch.length;
  if (next < refs.length) return { done: false as const, next, total: refs.length };
  await dropImportRows(d, importId, "removed");
  await d.update(billImports).set({ removedByUserId: a.id }).where(eq(billImports.id, importId));
  await audit(a, "remove_bill_import", { entityType: "billImport", entityId: importId, description: `Removed upload "${imp.fileName}" (${refs.length} claims recomputed)` });
  return { done: true as const, total: refs.length };
}

// ---------------------------------------------------------------------------
// Recompute claims from their events
// ---------------------------------------------------------------------------

type EventRow = typeof billClaimEvents.$inferSelect;

function toInput(r: EventRow): BillEventInput & { id: number } {
  return {
    id: r.id, source: r.source as BillSource, claimNo: r.claimNo, payerClaimNo: r.payerClaimNo, clpStatus: r.clpStatus, sheetStatus: (r.sheetStatus as BillStatus | null) ?? null,
    payerName: r.payerName, payerId: r.payerId, filingIndicator: r.filingIndicator, patientName: r.patientName, patientDob: r.patientDob, memberId: r.memberId,
    providerName: r.providerName, providerNpi: r.providerNpi, serviceFrom: r.serviceFrom, serviceTo: r.serviceTo, paidDate: r.paidDate, checkNumber: r.checkNumber,
    billedCents: r.billedCents, paidCents: r.paidCents, patientRespCents: r.patientRespCents,
    claimAdjustments: (r.claimAdjustments as BillAdjustment[] | null) ?? [], lines: (r.lines as BillLineInput[] | null) ?? [], note: r.note,
  };
}

type VisitHit = { key: string; patientId: number | null; clinicId: number | null; providerId: number | null };

/** Everything matching needs, loaded once per batch. */
interface MatchContext {
  /** The owner's own picks, by member ID (key "" = "no patient in MyPCP"). */
  memberLinks: Record<string, { key: string }>;
  /** Member ID (every way it's written) → the people it's on: Practice Fusion's insurance list and insurance checks. */
  members: Map<string, Set<string>>;
  nameDob: Map<string, { key: string; patientId: number | null }>;
  names: Map<string, { key: string; patientId: number | null }[]>;
  /** Everyone, for names that aren't spelled exactly alike. */
  index: PeopleIndex;
  visits: Map<string, VisitHit[]>;
  /** "key|date" → that person's visit that day. */
  visitByKeyDate: Map<string, VisitHit>;
  providers: { id: number; name: string; aliases: string[] | null; npi: string | null; clinicId: number | null }[];
}

/** First and last name only ("Jane A Doe" = "Jane Doe"). */
const looseName = (n: string) => {
  const t = nameKey(n).split(" ").filter(Boolean);
  return t.length > 1 ? `${t[0]} ${t[t.length - 1]}` : t.join(" ");
};

// The patient indexes take a moment to build; an upload's batches reuse them for a minute.
let peopleCache: { at: number; nameDob: MatchContext["nameDob"]; names: MatchContext["names"]; index: PeopleIndex; members: MatchContext["members"] } | null = null;

const ymdOf = (dt: Date | null | undefined) => (dt ? dt.toISOString().slice(0, 10) : null);
const MISSED = /cancel|no.?show/i;

async function people() {
  if (peopleCache && Date.now() - peopleCache.at < 60_000) return peopleCache;
  const d = await db();
  const nameDob = new Map<string, { key: string; patientId: number | null }>();
  for (const [k, v] of Array.from((await buildNameDobIndex()).entries())) nameDob.set(k, { key: v.key, patientId: v.patientId });
  const names = new Map<string, { key: string; patientId: number | null }[]>();
  for (const [k, list] of Array.from((await buildNameIndex()).entries())) {
    names.set(k, [...(names.get(k) ?? []), ...list]);
    const loose = looseName(k);
    if (loose !== k) names.set(`~${loose}`, [...(names.get(`~${loose}`) ?? []), ...list]);
  }

  // Everyone (roster, schedule, Practice Fusion), with their providers and visit days, for close names.
  const list: PersonInput[] = [];
  for (const p of await d.select({ id: patients.id, name: patients.name, dob: patients.dateOfBirth, providerId: patients.providerId }).from(patients)) {
    if (/\(merged into #\d+\)/.test(p.name)) continue; // retired duplicate copies
    list.push({ key: `p:${p.id}`, patientId: p.id, name: p.name, dob: ymdOf(p.dob), providerIds: p.providerId ? [p.providerId] : [], visitDays: [] });
  }
  for (const s of Array.from((await loadScheduleSubjects()).values())) {
    const seen = s.visits.filter((v) => !MISSED.test(v.status ?? ""));
    const provIds = seen.map((v) => /^id:(\d+)$/.exec(v.providerKey ?? "")?.[1]).filter((x): x is string => !!x).map(Number);
    list.push({ key: s.key, patientId: s.patientId, name: s.name, dob: ymdOf(s.dob), providerIds: Array.from(new Set([...(s.providerId ? [s.providerId] : []), ...provIds])), visitDays: seen.map((v) => localDateStr(v.startsAt)) });
  }
  for (const f of await d.select({ key: fhirPatients.subjectKey, patientId: fhirPatients.patientId, name: fhirPatients.name, dob: fhirPatients.dob }).from(fhirPatients)) {
    if (f.name) list.push({ key: f.key, patientId: f.patientId, name: f.name, dob: f.dob, providerIds: [], visitDays: [] });
  }
  const index = buildPeopleIndex(list);

  // Member IDs: Practice Fusion's insurance list ("Member ID …") and insurance checks on file.
  const members = new Map<string, Set<string>>();
  for (const c of await d.select({ key: fhirResources.subjectKey, value: fhirResources.value }).from(fhirResources).where(eq(fhirResources.resourceType, "Coverage"))) {
    const m = /Member ID ([^\s·]+)/.exec(c.value ?? "");
    if (m) addMember(members, m[1], c.key);
  }
  for (const c of await d.select({ memberId: coverageOnFile.memberId, key: coverageOnFile.subjectKey }).from(coverageOnFile)) addMember(members, c.memberId, c.key);

  peopleCache = { at: Date.now(), nameDob, names, index, members };
  return peopleCache;
}

async function matchContext(d: Db, dates: string[]): Promise<MatchContext> {
  const [links] = await d.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, MEMBER_LINKS_KEY)).limit(1);
  const { nameDob, names, index, members } = await people();
  const visits = new Map<string, VisitHit[]>();
  const visitByKeyDate = new Map<string, VisitHit>();
  const sorted = dates.filter(Boolean).sort();
  if (sorted.length) {
    const rows = await d.select({ date: appointments.date, patientId: appointments.patientId, patientName: appointments.patientName, dob: appointments.dateOfBirth, clinicId: appointments.clinicId, providerId: appointments.providerId, status: appointments.status })
      .from(appointments).where(and(gte(appointments.date, sorted[0]!), lte(appointments.date, sorted.at(-1)!), ne(appointments.status, "cancelled")));
    for (const r of rows) {
      const v = { key: subjectKeyFor(r.patientId, r.patientName, r.dob), patientId: r.patientId, clinicId: r.clinicId, providerId: r.providerId };
      for (const k of [`${r.date}|${nameKey(r.patientName)}`, `${r.date}|~${looseName(r.patientName)}`]) visits.set(k, [...(visits.get(k) ?? []), v]);
      visitByKeyDate.set(`${v.key}|${r.date}`, v);
    }
  }
  const provs = (await d.select({ id: providers.id, name: providers.name, aliases: providers.aliases, npi: providers.npi, clinicId: providers.clinicId }).from(providers))
    .map((p) => ({ ...p, aliases: (p.aliases as string[] | null) ?? null }));
  return { memberLinks: (links?.value as Record<string, { key: string }> | undefined) ?? {}, members, nameDob, names, index, visits, visitByKeyDate, providers: provs };
}

interface Match { subjectKey: string | null; patientId: number | null; matchSource: string | null; providerId: number | null; clinicId: number | null; learnNpi: { providerId: number; npi: string } | null }

/** What matching reads from a claim (a merged claim, or a saved one when matching again). */
interface MatchInput {
  memberId: string | null; patientName: string | null; patientDob: string | null; firstServiceDate: string | null;
  lines: { serviceDate: string | null }[]; providerNpi: string | null; providerName: string | null;
}

const patientIdOf = (key: string | null) => (key && /^p:\d+$/.test(key) ? Number(key.slice(2)) : null);
const claimDates = (m: MatchInput) => Array.from(new Set([m.firstServiceDate, ...m.lines.map((l) => l.serviceDate)].filter((x): x is string => !!x)));

/**
 * The patient, provider and clinic of a claim. Patient, in order: the owner's own pick for that member
 * ID; the member ID on Practice Fusion's insurance list (first name must fit); name + birthday; that
 * day's visit; a name only one person has; then a name spelled differently (billPatientMatch.ts).
 */
function matchClaim(ctx: MatchContext, m: MatchInput): Match {
  const member = upperAlnum(m.memberId);
  const name = m.patientName ?? "";
  const dates = claimDates(m);

  // Provider first (NPI, else the name on the file): it also helps confirm a name spelled differently.
  const npi = (m.providerNpi ?? "").trim();
  let provider = npi ? ctx.providers.find((p) => p.npi === npi) ?? null : null;
  let learnNpi: Match["learnNpi"] = null;
  if (!provider && m.providerName) {
    const id = matchProviderId(m.providerName, ctx.providers);
    provider = id ? ctx.providers.find((p) => p.id === id) ?? null : null;
    if (provider && npi && !provider.npi && /^\d{10}$/.test(npi)) learnNpi = { providerId: provider.id, npi };
  }

  const visitHits = (k: (date: string) => string) => {
    const hits = dates.flatMap((dt) => ctx.visits.get(k(dt)) ?? []);
    const keys = Array.from(new Set(hits.map((h) => h.key)));
    return keys.length === 1 ? hits.find((h) => h.key === keys[0])! : null;
  };
  const visit = name ? visitHits((dt) => `${dt}|${nameKey(name)}`) ?? visitHits((dt) => `${dt}|~${looseName(name)}`) : null;

  let subjectKey: string | null = null;
  let matchSource: string | null = null;
  const unique = (list?: { key: string }[]) => (list && Array.from(new Set(list.map((x) => x.key))).length === 1 ? list[0]!.key : null);
  const link = member ? ctx.memberLinks[member] : undefined;
  const byMember = !link && member ? personByMember(ctx.index, ctx.members, m.memberId, name) : [];
  if (link) { subjectKey = link.key || null; matchSource = "manual"; }
  else if (byMember.length === 1) { subjectKey = byMember[0]!.key; matchSource = "member"; }
  else if (name && m.patientDob && ctx.nameDob.get(`${nameKey(name)}|${m.patientDob}`)) { subjectKey = ctx.nameDob.get(`${nameKey(name)}|${m.patientDob}`)!.key; matchSource = "name"; }
  else if (visit) { subjectKey = visit.key; matchSource = "visit"; }
  else if (name) {
    const k = unique(ctx.names.get(nameKey(name))) ?? unique(ctx.names.get(`~${looseName(name)}`));
    if (k) { subjectKey = k; matchSource = "name"; }
    else {
      const pick = pickPerson(findPeople(ctx.index, { name, dates, providerId: provider?.id ?? null }));
      if (pick) { subjectKey = pick.person.key; matchSource = "close"; }
    }
  }

  // That day's visit (the exact name, or the matched person's) gives the clinic, and the provider if the file had none.
  let dayVisit: VisitHit | null = visit;
  if (!dayVisit && subjectKey) {
    const keys = ctx.index.byKey.get(subjectKey)?.keys ?? [subjectKey];
    for (const k of keys) for (const dt of dates) dayVisit ??= ctx.visitByKeyDate.get(`${k}|${dt}`) ?? null;
  }
  if (!provider && dayVisit?.providerId) provider = ctx.providers.find((p) => p.id === dayVisit!.providerId) ?? null;
  const clinicId = dayVisit?.clinicId ?? provider?.clinicId ?? null;
  return { subjectKey, patientId: patientIdOf(subjectKey), matchSource, providerId: provider?.id ?? null, clinicId, learnNpi };
}

/**
 * Rebuild these claims from their events (every saved upload, plus `withImport` while it's being
 * saved): the claim row, its lines, the patient / provider / clinic match, and which report rows
 * its payment replaces.
 */
async function recomputeClaims(d: Db, refs: string[], withImport: number | null) {
  const counted = withImport ? or(eq(billImports.status, "saved"), eq(billClaimEvents.importId, withImport))! : eq(billImports.status, "saved");
  const rows = (await d.select({ e: billClaimEvents }).from(billClaimEvents).innerJoin(billImports, eq(billImports.id, billClaimEvents.importId))
    .where(and(inArray(billClaimEvents.claimRef, refs), counted)).orderBy(asc(billClaimEvents.id))).map((r) => r.e);
  const byRef = new Map<string, EventRow[]>();
  const seen = new Set<string>();
  for (const r of rows) {
    // The same payment in two uploads counts once.
    const k = `${r.claimRef}|${r.eventKey}`;
    if (seen.has(k)) continue;
    seen.add(k);
    byRef.set(r.claimRef, [...(byRef.get(r.claimRef) ?? []), r]);
  }
  const existing = await d.select({ id: billClaims.id, claimRef: billClaims.claimRef, subjectKey: billClaims.subjectKey, patientId: billClaims.patientId, matchSource: billClaims.matchSource })
    .from(billClaims).where(inArray(billClaims.claimRef, refs));
  const existingByRef = new Map(existing.map((x) => [x.claimRef, x]));

  // Report rows this batch's claims had replaced: released, then set again below.
  await d.update(billClaims).set({ supersededBy: null }).where(inArray(billClaims.supersededBy, refs));

  // Claims with no events left (their only upload was removed).
  const gone = existing.filter((x) => !byRef.has(x.claimRef)).map((x) => x.id);
  for (const part of chunks(gone, 500)) {
    await d.delete(billLines).where(inArray(billLines.claimId, part));
    await d.delete(billClaims).where(inArray(billClaims.id, part));
  }
  if (!byRef.size) return;

  const merged = Array.from(byRef.entries()).map(([ref, evs]) => ({ ref, m: mergeClaim(evs.map(toInput)) }));
  const ctx = await matchContext(d, merged.flatMap(({ m }) => [m.firstServiceDate, ...m.lines.map((l) => l.serviceDate)].filter((x): x is string => !!x)));
  const learned = new Map<number, string>();
  const claimRows = merged.map(({ ref, m }) => {
    const prev = existingByRef.get(ref);
    const match = matchClaim(ctx, m);
    const keepManual = prev?.matchSource === "manual";
    if (match.learnNpi) learned.set(match.learnNpi.providerId, match.learnNpi.npi);
    return {
      claimRef: ref, altKey: altKeyOf({ patientName: m.patientName, serviceFrom: m.firstServiceDate, billedCents: m.billedCents, lines: [] }), supersededBy: null,
      status: m.status, sourceUsed: m.sourceUsed,
      billedCents: m.billedCents, allowedCents: m.allowedCents, paidCents: m.paidCents, laterPayersPaidCents: m.laterPayersPaidCents,
      patientOwesCents: m.patientOwesCents, writtenOffCents: m.writtenOffCents, deniedCents: m.deniedCents,
      payerName: payerLabel(m.payerName), payerType: insuranceType(m.payerName, m.filingIndicator), filingIndicator: cut(m.filingIndicator, 4),
      otherPayers: Array.from(new Set(m.otherPayers.map(payerLabel).filter((x): x is string => !!x && x !== payerLabel(m.payerName)))),
      claimNo: cut(m.claimNo, 60), payerClaimNo: cut(m.payerClaimNo, 60), patientName: cut(m.patientName, 255), patientDob: cut(m.patientDob, 10), memberId: cut(m.memberId, 60),
      subjectKey: keepManual ? prev!.subjectKey : match.subjectKey, patientId: keepManual ? prev!.patientId : match.patientId, matchSource: keepManual ? "manual" : match.matchSource,
      providerName: cut(m.providerName, 255), providerNpi: cut(m.providerNpi, 10), providerId: match.providerId, clinicId: match.clinicId,
      firstServiceDate: m.firstServiceDate, lastPaidDate: m.lastPaidDate, denialCodes: m.denialCodes, eventCount: byRef.get(ref)!.length,
    };
  });
  const v = (c: { name: string }) => sql.raw(`VALUES(\`${c.name}\`)`);
  const cols = ["altKey", "supersededBy", "status", "sourceUsed", "billedCents", "allowedCents", "paidCents", "laterPayersPaidCents", "patientOwesCents", "writtenOffCents", "deniedCents",
    "payerName", "payerType", "filingIndicator", "otherPayers", "claimNo", "payerClaimNo", "patientName", "patientDob", "memberId", "subjectKey", "patientId", "matchSource",
    "providerName", "providerNpi", "providerId", "clinicId", "firstServiceDate", "lastPaidDate", "denialCodes", "eventCount"] as const;
  const set = Object.fromEntries(cols.map((c) => [c, v({ name: c })])) as Record<(typeof cols)[number], SQL>;
  for (const part of chunks(claimRows, 150)) await d.insert(billClaims).values(part).onDuplicateKeyUpdate({ set });

  const ids = await d.select({ id: billClaims.id, claimRef: billClaims.claimRef }).from(billClaims).where(inArray(billClaims.claimRef, Array.from(byRef.keys())));
  const idOf = new Map(ids.map((x) => [x.claimRef, x.id]));
  for (const part of chunks(ids.map((x) => x.id), 500)) await d.delete(billLines).where(inArray(billLines.claimId, part));
  const lineRows = merged.flatMap(({ ref, m }) => m.lines.map((l, i) => ({
    claimId: idOf.get(ref)!, lineNo: i + 1, code: l.code.slice(0, 16), modifiers: cut(l.modifiers.join(","), 20), units: l.units, serviceDate: l.serviceDate,
    billedCents: l.billedCents, allowedCents: l.allowedCents, paidCents: l.paidCents, patientOwesCents: l.patientOwesCents, writtenOffCents: l.writtenOffCents,
    deniedCents: l.deniedCents, denialCode: cut(l.denialCode, 20), adjustments: l.adjustments, remarks: l.remarks,
  })));
  for (const part of chunks(lineRows, 400)) await d.insert(billLines).values(part);

  // A claim-report row (no payment yet) is replaced by the payment for the same patient, date and amount.
  const paidAlts = claimRows.filter((c) => c.sourceUsed !== "sheet").map((c) => ({ ref: c.claimRef, alt: c.altKey }));
  for (const p of paidAlts) await d.update(billClaims).set({ supersededBy: p.ref }).where(and(eq(billClaims.altKey, p.alt), eq(billClaims.sourceUsed, "sheet"), ne(billClaims.claimRef, p.ref)));
  const sheetRows = claimRows.filter((c) => c.sourceUsed === "sheet");
  if (sheetRows.length) {
    const payers = await d.select({ claimRef: billClaims.claimRef, altKey: billClaims.altKey }).from(billClaims)
      .where(and(inArray(billClaims.altKey, sheetRows.map((s) => s.altKey)), ne(billClaims.sourceUsed, "sheet")));
    for (const s of sheetRows) {
      const by = payers.find((p) => p.altKey === s.altKey && p.claimRef !== s.claimRef);
      if (by) await d.update(billClaims).set({ supersededBy: by.claimRef }).where(eq(billClaims.claimRef, s.claimRef));
    }
  }
  for (const [providerId, npi] of Array.from(learned.entries())) await d.update(providers).set({ npi }).where(and(eq(providers.id, providerId), isNull(providers.npi)));
}

// ---------------------------------------------------------------------------
// Reading: filters, summary, breakdown, claims
// ---------------------------------------------------------------------------

export interface BillFilters {
  from: string;
  to: string;
  basis: DateBasis;
  status?: BillStatus[] | null;
  payer?: string | null;
  payerType?: string | null;
  providerId?: number | null;
  clinicId?: number | null;
  cpt?: string | null;
  reason?: string | null;
  q?: string | null;
  needsPatient?: boolean | null;
  /** Only claims matched by a name spelled differently (to check them). */
  closeMatch?: boolean | null;
  /** One patient's claims (from the high-deductible list). */
  subjectKey?: string | null;
}

function claimWhere(f: BillFilters): SQL {
  const date = f.basis === "paid" ? billClaims.lastPaidDate : billClaims.firstServiceDate;
  const parts: (SQL | undefined)[] = [isNull(billClaims.supersededBy), gte(date, f.from), lte(date, f.to)];
  if (f.status?.length) parts.push(inArray(billClaims.status, f.status));
  if (f.payer) parts.push(eq(billClaims.payerName, f.payer));
  if (f.payerType) parts.push(eq(billClaims.payerType, f.payerType));
  if (f.providerId) parts.push(eq(billClaims.providerId, f.providerId));
  if (f.clinicId) parts.push(eq(billClaims.clinicId, f.clinicId));
  if (f.needsPatient) parts.push(isNull(billClaims.subjectKey));
  if (f.closeMatch) parts.push(eq(billClaims.matchSource, "close"));
  if (f.subjectKey) parts.push(eq(billClaims.subjectKey, f.subjectKey));
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[%_]/g, "")}%`;
    parts.push(or(sql`${billClaims.patientName} LIKE ${like}`, sql`${billClaims.claimNo} LIKE ${like}`, sql`${billClaims.payerClaimNo} LIKE ${like}`, sql`${billClaims.memberId} LIKE ${like}`));
  }
  if (f.cpt) parts.push(sql`EXISTS (SELECT 1 FROM ${billLines} WHERE ${billLines.claimId} = ${billClaims.id} AND ${billLines.code} = ${f.cpt})`);
  if (f.reason) parts.push(sql`EXISTS (SELECT 1 FROM ${billLines} WHERE ${billLines.claimId} = ${billClaims.id} AND ${billLines.denialCode} = ${f.reason})`);
  return and(...parts)!;
}

/** Every line in range (with its claim), for the summary and breakdowns. */
async function loadLines(f: BillFilters) {
  const d = await db();
  const lineParts: SQL[] = [claimWhere(f)];
  if (f.cpt) lineParts.push(eq(billLines.code, f.cpt));
  if (f.reason) lineParts.push(eq(billLines.denialCode, f.reason));
  return d.select({
    claimId: billLines.claimId, code: billLines.code, units: billLines.units, serviceDate: billLines.serviceDate,
    billed: billLines.billedCents, allowed: billLines.allowedCents, paid: billLines.paidCents, patientOwes: billLines.patientOwesCents,
    writtenOff: billLines.writtenOffCents, denied: billLines.deniedCents, denialCode: billLines.denialCode,
    status: billClaims.status, payerName: billClaims.payerName, payerType: billClaims.payerType, subjectKey: billClaims.subjectKey, patientName: billClaims.patientName,
    providerId: billClaims.providerId, providerName: billClaims.providerName, clinicId: billClaims.clinicId,
    firstServiceDate: billClaims.firstServiceDate, lastPaidDate: billClaims.lastPaidDate,
  }).from(billLines).innerJoin(billClaims, eq(billClaims.id, billLines.claimId)).where(and(...lineParts)).limit(MAX_LINES);
}
/** Lines added up per request (years of a clinic's claims); past this the page asks for a shorter range. */
const MAX_LINES = 200_000;
type LineRow = Awaited<ReturnType<typeof loadLines>>[number];

interface Money { claims: number; lines: number; units: number; billed: number; allowed: number; paid: number; patientOwes: number; writtenOff: number; denied: number }
const MONEY_KEYS = ["billed", "allowed", "paid", "patientOwes", "writtenOff", "denied"] as const;

class Tally {
  claims = new Set<number>();
  lines = 0; units = 0; billed = 0; allowed = 0; paid = 0; patientOwes = 0; writtenOff = 0; denied = 0;
  add(r: LineRow) {
    this.claims.add(r.claimId);
    this.lines++;
    this.units += r.units;
    for (const k of MONEY_KEYS) this[k] += r[k];
  }
  out(): Money {
    return { claims: this.claims.size, lines: this.lines, units: this.units, billed: this.billed, allowed: this.allowed, paid: this.paid, patientOwes: this.patientOwes, writtenOff: this.writtenOff, denied: this.denied };
  }
}

const dateOf = (r: LineRow, basis: DateBasis) => (basis === "paid" ? r.lastPaidDate : r.firstServiceDate) ?? "";
/** Monday of the week (YYYY-MM-DD). */
function weekOf(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return addDays(ymd, -((dow + 6) % 7));
}

async function nameMaps() {
  const d = await db();
  const [provs, cls] = await Promise.all([
    d.select({ id: providers.id, name: providers.name }).from(providers),
    d.select({ id: clinics.id, name: clinics.name }).from(clinics),
  ]);
  return { provider: new Map(provs.map((p) => [p.id, p.name])), clinic: new Map(cls.map((c) => [c.id, c.name])) };
}

function dimValue(r: LineRow, dim: BreakdownDim, basis: DateBasis, names: Awaited<ReturnType<typeof nameMaps>>): { key: string; label: string } {
  switch (dim) {
    case "cpt": return { key: r.code, label: r.code };
    case "insurance": return { key: r.payerName ?? "", label: r.payerName ?? "(no insurance listed)" };
    case "insuranceType": return { key: r.payerType ?? "", label: r.payerType ?? "Other" };
    case "patient": {
      const k = r.subjectKey ?? `name:${nameKey(r.patientName ?? "")}`;
      return { key: k, label: r.patientName ?? "(no name)" };
    }
    case "provider":
      if (r.providerId) return { key: `id:${r.providerId}`, label: names.provider.get(r.providerId) ?? r.providerName ?? "Provider" };
      return { key: `name:${(r.providerName ?? "").toLowerCase()}`, label: r.providerName ? `${r.providerName} (not matched)` : "(no provider listed)" };
    case "clinic": return { key: String(r.clinicId ?? ""), label: r.clinicId ? names.clinic.get(r.clinicId) ?? "Clinic" : "Unknown clinic" };
    case "status": return { key: r.status, label: BILL_STATUS_LABELS[r.status as BillStatus] ?? r.status };
    case "reason": {
      if (!r.denialCode) return { key: "", label: "No denial" };
      const [g, c] = r.denialCode.split("-");
      return { key: r.denialCode, label: describeAdjustment(g ?? "", c ?? "") };
    }
    case "month": { const dt = dateOf(r, basis); return { key: dt.slice(0, 7), label: dt.slice(0, 7) || "(no date)" }; }
    case "week": { const w = weekOf(dateOf(r, basis)); return { key: w, label: w ? `Week of ${w}` : "(no date)" }; }
    case "day": { const dt = dateOf(r, basis); return { key: dt, label: dt || "(no date)" }; }
  }
}

export async function summary(a: WorkspaceActor, f: BillFilters) {
  const rows = await loadLines(f);
  const total = new Tally();
  const byStatus = new Map<string, Tally>();
  const byMonth = new Map<string, Tally>();
  const byPayer = new Map<string, Tally>();
  const byCpt = new Map<string, Tally>();
  const needsPatient = new Set<number>();
  const tally = (m: Map<string, Tally>, k: string, r: LineRow) => {
    let t = m.get(k);
    if (!t) m.set(k, (t = new Tally()));
    t.add(r);
  };
  for (const r of rows) {
    total.add(r);
    tally(byStatus, r.status, r);
    tally(byMonth, dateOf(r, f.basis).slice(0, 7), r);
    tally(byPayer, r.payerName ?? "(no insurance listed)", r);
    if (!r.code.startsWith("(")) tally(byCpt, r.code, r);
    if (!r.subjectKey) needsPatient.add(r.claimId);
  }
  const d = await db();
  const [uploads] = await d.select({ n: sql<number>`COUNT(*)`, last: sql<Date | null>`MAX(${billImports.createdAt})` }).from(billImports).where(eq(billImports.status, "saved"));
  await audit(a, "view_master_billing", { entityType: "billClaims", description: `Master Billing summary ${f.from} to ${f.to}` });
  const top = (m: Map<string, Tally>, by: "billed" | "paid", n: number) => Array.from(m.entries()).map(([k, t]) => ({ key: k, ...t.out() })).sort((x, y) => y[by] - x[by]).slice(0, n);
  return {
    totals: total.out(),
    byStatus: Object.fromEntries(Array.from(byStatus.entries()).map(([k, t]) => [k, t.out()])),
    byMonth: Array.from(byMonth.entries()).map(([k, t]) => ({ month: k, ...t.out() })).sort((x, y) => x.month.localeCompare(y.month)),
    topPayers: top(byPayer, "billed", 6),
    topCpt: top(byCpt, "paid", 8),
    needsPatient: needsPatient.size,
    uploads: Number(uploads?.n ?? 0),
    lastUpload: uploads?.last ?? null,
    capped: rows.length >= MAX_LINES,
  };
}

export async function breakdown(a: WorkspaceActor, f: BillFilters, dims: BreakdownDim[]) {
  const [rows, names] = await Promise.all([loadLines(f), nameMaps()]);
  const groups = new Map<string, { keys: { dim: BreakdownDim; key: string; label: string }[]; t: Tally }>();
  const total = new Tally();
  for (const r of rows) {
    const keys = dims.map((dim) => ({ dim, ...dimValue(r, dim, f.basis, names) }));
    const gk = keys.map((k) => k.key).join("\u0001");
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = { keys, t: new Tally() }));
    g.t.add(r);
    total.add(r);
  }
  await audit(a, "view_master_billing", { entityType: "billClaims", description: `Master Billing breakdown by ${dims.join(", ")} ${f.from} to ${f.to}` });
  const dateDims = dims.every((x) => x === "month" || x === "week" || x === "day");
  const out = Array.from(groups.values()).map((g) => ({ keys: g.keys, ...g.t.out() }));
  out.sort((x, y) => (dateDims ? x.keys.map((k) => k.key).join("|").localeCompare(y.keys.map((k) => k.key).join("|")) : y.billed - x.billed || y.paid - x.paid));
  return { rows: out.slice(0, 2000), totals: total.out(), groups: out.length, capped: rows.length >= MAX_LINES };
}

export async function listClaims(a: WorkspaceActor, f: BillFilters, page: number, sort: "date" | "billed" | "paid" | "denied" = "date") {
  const d = await db();
  const where = claimWhere(f);
  const date = f.basis === "paid" ? billClaims.lastPaidDate : billClaims.firstServiceDate;
  const order = sort === "billed" ? desc(billClaims.billedCents) : sort === "paid" ? desc(billClaims.paidCents) : sort === "denied" ? desc(billClaims.deniedCents) : desc(date);
  const PAGE = 50;
  const [rows, [count]] = await Promise.all([
    d.select({
      id: billClaims.id, status: billClaims.status, sourceUsed: billClaims.sourceUsed, firstServiceDate: billClaims.firstServiceDate, lastPaidDate: billClaims.lastPaidDate,
      patientName: billClaims.patientName, subjectKey: billClaims.subjectKey, matchSource: billClaims.matchSource, payerName: billClaims.payerName, payerType: billClaims.payerType,
      providerId: billClaims.providerId, providerName: billClaims.providerName, clinicId: billClaims.clinicId, claimNo: billClaims.claimNo,
      billedCents: billClaims.billedCents, paidCents: billClaims.paidCents, patientOwesCents: billClaims.patientOwesCents, deniedCents: billClaims.deniedCents,
      writtenOffCents: billClaims.writtenOffCents, denialCodes: billClaims.denialCodes,
    }).from(billClaims).where(where).orderBy(order, desc(billClaims.id)).limit(PAGE).offset((page - 1) * PAGE),
    d.select({ n: sql<number>`COUNT(*)` }).from(billClaims).where(where),
  ]);
  const codes = rows.length ? await d.select({ claimId: billLines.claimId, code: billLines.code }).from(billLines).where(inArray(billLines.claimId, rows.map((r) => r.id))).orderBy(asc(billLines.lineNo)) : [];
  const names = await nameMaps();
  await audit(a, "view_master_billing", { entityType: "billClaims", description: `Master Billing claims list ${f.from} to ${f.to} (page ${page})` });
  return {
    rows: rows.map((r) => ({
      ...r, denialCodes: (r.denialCodes as string[] | null) ?? [],
      providerLabel: r.providerId ? names.provider.get(r.providerId) ?? r.providerName : r.providerName,
      clinicName: r.clinicId ? names.clinic.get(r.clinicId) ?? null : null,
      codes: Array.from(new Set(codes.filter((c) => c.claimId === r.id && !c.code.startsWith("(")).map((c) => c.code))),
    })),
    total: Number(count?.n ?? 0), page, pageSize: PAGE,
  };
}

export async function claimDetail(a: WorkspaceActor, id: number) {
  const d = await db();
  const [c] = await d.select().from(billClaims).where(eq(billClaims.id, id)).limit(1);
  if (!c) throw new WorkspaceError("Claim not found.", "NOT_FOUND");
  const [lines, events, names] = await Promise.all([
    d.select().from(billLines).where(eq(billLines.claimId, id)).orderBy(asc(billLines.lineNo)),
    d.select({ e: billClaimEvents, fileName: billImports.fileName, uploadedAt: billImports.createdAt, importStatus: billImports.status })
      .from(billClaimEvents).innerJoin(billImports, eq(billImports.id, billClaimEvents.importId))
      .where(and(eq(billClaimEvents.claimRef, c.claimRef), eq(billImports.status, "saved"))).orderBy(asc(billClaimEvents.paidDate), asc(billClaimEvents.id)),
    nameMaps(),
  ]);
  // Report rows this claim's payment replaced.
  const replaced = await d.select({ claimRef: billClaims.claimRef }).from(billClaims).where(eq(billClaims.supersededBy, c.claimRef));
  const patient = await patientHelp(c, lines.map((l) => l.serviceDate));
  await audit(a, "view_master_billing", { entityType: "billClaim", entityId: id, description: "Opened a claim" });
  return {
    claim: { ...c, otherPayers: (c.otherPayers as string[] | null) ?? [], denialCodes: (c.denialCodes as string[] | null) ?? [],
      providerLabel: c.providerId ? names.provider.get(c.providerId) ?? c.providerName : c.providerName, clinicName: c.clinicId ? names.clinic.get(c.clinicId) ?? null : null },
    patient,
    lines: lines.map((l) => ({ ...l, adjustments: ((l.adjustments as BillAdjustment[] | null) ?? []).map((x) => ({ ...x, text: describeAdjustment(x.group, x.code) })), remarks: (l.remarks as string[] | null) ?? [] })),
    events: events.map(({ e, fileName, uploadedAt }) => ({
      id: e.id, importId: e.importId, fileName, uploadedAt, source: e.source, clpStatus: e.clpStatus, sheetStatus: e.sheetStatus, payerName: e.payerName,
      checkNumber: e.checkNumber, paidDate: e.paidDate, billedCents: e.billedCents, paidCents: e.paidCents, patientRespCents: e.patientRespCents, note: e.note,
      payerClaimNo: e.payerClaimNo,
      claimAdjustments: ((e.claimAdjustments as BillAdjustment[] | null) ?? []).map((x) => ({ ...x, text: describeAdjustment(x.group, x.code) })),
    })),
    replacedReports: replaced.length,
  };
}

// ---------------------------------------------------------------------------
// High-deductible patients
// ---------------------------------------------------------------------------

/** Lines where insurance applied a deductible the patient still owes (claims not taken back). */
async function deductibleLines(d: Db, where: SQL): Promise<DeductibleLine[]> {
  const rows = await d.select({
    claimId: billClaims.id, subjectKey: billClaims.subjectKey, patientName: billClaims.patientName, serviceDate: billLines.serviceDate, firstServiceDate: billClaims.firstServiceDate,
    payerName: billClaims.payerName, providerId: billClaims.providerId, clinicId: billClaims.clinicId, adjustments: billLines.adjustments, patientOwesCents: billLines.patientOwesCents,
  }).from(billLines).innerJoin(billClaims, eq(billClaims.id, billLines.claimId))
    .where(and(where, ne(billClaims.status, "taken_back"), gt(billLines.patientOwesCents, 0), sql`JSON_CONTAINS(${billLines.adjustments}, JSON_OBJECT('group', 'PR', 'code', '1'))`));
  return rows.map((r) => ({
    claimId: r.claimId, personKey: r.subjectKey ?? `n:${nameKey(r.patientName ?? "")}`, date: r.serviceDate ?? r.firstServiceDate,
    deductibleCents: deductibleOwedCents(r.adjustments as BillAdjustment[] | null, r.patientOwesCents), payerName: r.payerName, providerId: r.providerId, clinicId: r.clinicId,
  }));
}

/**
 * The owner's High deductible list: patients whose deductible was applied on at least `minVisits`
 * separate visits in the range, with what they owe in all (deductible, coinsurance, copays), what
 * insurance paid, and their next visit on the schedule.
 */
export async function highDeductible(a: WorkspaceActor, f: BillFilters, minVisits: number) {
  const d = await db();
  const range = { ...f, status: null };
  const patientsFound = groupDeductible(await deductibleLines(d, claimWhere(range)), minVisits);
  const keys = patientsFound.map((p) => p.personKey).filter((k) => !k.startsWith("n:"));
  const names = patientsFound.filter((p) => p.personKey.startsWith("n:"));

  // Everything these patients owe / were paid in the range, every reason.
  const totals = new Map<string, { owes: number; paid: number; billed: number; claims: number }>();
  for (const part of chunks(keys, 500)) {
    const rows = await d.select({ key: billClaims.subjectKey, owes: sql<number>`SUM(${billClaims.patientOwesCents})`, paid: sql<number>`SUM(${billClaims.paidCents})`, billed: sql<number>`SUM(${billClaims.billedCents})`, n: sql<number>`COUNT(*)` })
      .from(billClaims).where(and(claimWhere(range), inArray(billClaims.subjectKey, part))).groupBy(billClaims.subjectKey);
    for (const r of rows) totals.set(r.key!, { owes: Number(r.owes ?? 0), paid: Number(r.paid ?? 0), billed: Number(r.billed ?? 0), claims: Number(r.n ?? 0) });
  }
  if (names.length) {
    const rows = await d.select({ name: billClaims.patientName, owes: billClaims.patientOwesCents, paid: billClaims.paidCents, billed: billClaims.billedCents }).from(billClaims).where(and(claimWhere(range), isNull(billClaims.subjectKey)));
    for (const r of rows) {
      const k = `n:${nameKey(r.name ?? "")}`;
      if (!names.some((p) => p.personKey === k)) continue;
      const t = totals.get(k) ?? { owes: 0, paid: 0, billed: 0, claims: 0 };
      t.owes += r.owes; t.paid += r.paid; t.billed += r.billed; t.claims += 1;
      totals.set(k, t);
    }
  }

  // Names as MyPCP has them, and each patient's next visit.
  const { index } = await people();
  const today = localDateStr();
  const next = new Map<string, string>();
  const upcoming = await d.select({ date: appointments.date, patientId: appointments.patientId, patientName: appointments.patientName, dob: appointments.dateOfBirth, status: appointments.status })
    .from(appointments).where(and(gte(appointments.date, today), ne(appointments.status, "cancelled")));
  for (const r of upcoming) {
    if (MISSED.test(r.status ?? "")) continue;
    const k = subjectKeyFor(r.patientId, r.patientName, r.dob);
    const main = index.byKey.get(k)?.key ?? k;
    if (!next.has(main) || r.date < next.get(main)!) next.set(main, r.date);
  }
  const billName = new Map<string, string | null>();
  if (names.length || keys.some((k) => !index.byKey.get(k))) {
    const ids = patientsFound.flatMap((p) => p.claimIds.slice(0, 1));
    for (const part of chunks(ids, 500)) {
      for (const r of await d.select({ id: billClaims.id, key: billClaims.subjectKey, name: billClaims.patientName }).from(billClaims).where(inArray(billClaims.id, part))) billName.set(r.key ?? `n:${nameKey(r.name ?? "")}`, r.name);
    }
  }
  const nm = await nameMaps();
  await audit(a, "view_master_billing", { entityType: "billClaims", description: `Master Billing high-deductible list ${f.from} to ${f.to}` });
  return {
    rows: patientsFound.map((p) => {
      const person = p.personKey.startsWith("n:") ? null : index.byKey.get(p.personKey) ?? null;
      const t = totals.get(p.personKey);
      return {
        key: p.personKey, matched: !p.personKey.startsWith("n:"), name: person?.name ?? billName.get(p.personKey) ?? null, dob: person?.dob ?? null,
        visits: p.visits.length, deductibleCents: p.deductibleCents, patientOwesCents: t?.owes ?? p.deductibleCents, paidCents: t?.paid ?? 0, billedCents: t?.billed ?? 0, claims: t?.claims ?? p.claimIds.length,
        lastDate: p.lastDate, payerName: p.payerName, provider: p.providerId ? nm.provider.get(p.providerId) ?? null : null, clinic: p.clinicId ? nm.clinic.get(p.clinicId) ?? null : null,
        nextVisit: person ? next.get(person.key) ?? null : null,
      };
    }),
  };
}

// Staff see a "High deductible" note; the list is worked out at most every 10 minutes per server.
let hdCache: { at: number; keys: Map<string, { visits: number; lastDate: string | null }> } | null = null;

/**
 * Everyone (under each of their keys: roster, schedule, Practice Fusion) whose deductible was applied
 * on HIGH_DEDUCTIBLE_MIN_VISITS+ visits in the last year. Only a yes / no and a visit count leave
 * this function for staff: no dollar amounts.
 */
export async function highDeductibleKeys(): Promise<Map<string, { visits: number; lastDate: string | null }>> {
  if (hdCache && Date.now() - hdCache.at < 10 * 60_000) return hdCache.keys;
  const d = await db();
  const since = addDays(localDateStr(), -HIGH_DEDUCTIBLE_WINDOW_DAYS);
  const found = groupDeductible(await deductibleLines(d, and(isNull(billClaims.supersededBy), isNotNull(billClaims.subjectKey), gte(billClaims.firstServiceDate, since))!), HIGH_DEDUCTIBLE_MIN_VISITS);
  const keys = new Map<string, { visits: number; lastDate: string | null }>();
  if (found.length) {
    const { index } = await people();
    for (const p of found) for (const k of index.byKey.get(p.personKey)?.keys ?? [p.personKey]) keys.set(k, { visits: p.visits.length, lastDate: p.lastDate });
  }
  hdCache = { at: Date.now(), keys };
  return keys;
}

/** Staff: who on that day's schedule (in clinics they can see) has a high deductible. Subject key → visit count. */
export async function highDeductibleForDay(actor: WorkspaceActor, date: string): Promise<Record<string, { visits: number }>> {
  const flagged = await highDeductibleKeys();
  if (!flagged.size) return {};
  const d = await db();
  const rows = await d.select({ patientId: appointments.patientId, patientName: appointments.patientName, dob: appointments.dateOfBirth, clinicId: appointments.clinicId })
    .from(appointments).where(eq(appointments.date, date));
  const out: Record<string, { visits: number }> = {};
  for (const r of rows) {
    if (actor.clinicIds && (r.clinicId == null || !actor.clinicIds.includes(r.clinicId))) continue;
    const key = subjectKeyFor(r.patientId, r.patientName, r.dob);
    const hit = flagged.get(key);
    if (hit) out[key] = { visits: hit.visits };
  }
  return out;
}

/**
 * For the claim's Patient row: the matched person's name as MyPCP has it and, for a name spelled
 * differently, why it was matched; with no patient yet, the likely people to pick from (best first).
 */
async function patientHelp(c: typeof billClaims.$inferSelect, lineDates: (string | null)[]) {
  const { index, members } = await people();
  const matched = c.subjectKey ? index.byKey.get(c.subjectKey) ?? null : null;
  const why = matched && c.matchSource === "close" ? compareNames(c.patientName, matched.name)?.why ?? null : null;
  const suggestions: { key: string; name: string; dob: string | null; why: string; support: string | null }[] = [];
  if (!c.subjectKey && c.patientName) {
    const dates = Array.from(new Set([c.firstServiceDate, ...lineDates].filter((x): x is string => !!x)));
    // The member ID's people whose first name didn't fit (a spouse or child sharing the ID, or a new name).
    for (const p of personByMember(index, members, c.memberId, c.patientName, false)) suggestions.push({ key: p.key, name: p.name, dob: p.dob, why: "same member ID on their insurance", support: null });
    for (const x of findPeople(index, { name: c.patientName, dates, providerId: c.providerId }, true)) {
      if (!suggestions.some((s) => s.key === x.person.key)) suggestions.push({ key: x.person.key, name: x.person.name, dob: x.person.dob, why: x.why, support: x.supportWhy });
    }
  }
  return { name: matched?.name ?? null, dob: matched?.dob ?? null, why, suggestions: suggestions.slice(0, 6) };
}

export async function listImports(limit = 100) {
  const d = await db();
  return d.select({
    id: billImports.id, kind: billImports.kind, fileName: billImports.fileName, status: billImports.status, checks: billImports.checks, claimCount: billImports.claimCount,
    billedCents: billImports.billedCents, paidCents: billImports.paidCents, matchedCount: billImports.matchedCount, createdAt: billImports.createdAt, removedAt: billImports.removedAt,
    hasFile: sql<boolean>`${billImports.s3Key} IS NOT NULL`, uploadedBy: users.name,
  }).from(billImports).leftJoin(users, eq(users.id, billImports.uploadedByUserId))
    .where(inArray(billImports.status, ["saved", "removing", "removed"])).orderBy(desc(billImports.createdAt), desc(billImports.id)).limit(limit);
}

/** Insurances / providers / clinics / CPT codes / reasons seen, for the filter pickers. */
export async function filterOptions() {
  const d = await db();
  const live = isNull(billClaims.supersededBy);
  const [payers, types, provs, cls, codes, reasons] = await Promise.all([
    d.selectDistinct({ v: billClaims.payerName }).from(billClaims).where(and(live, isNotNull(billClaims.payerName))).orderBy(asc(billClaims.payerName)).limit(500),
    d.selectDistinct({ v: billClaims.payerType }).from(billClaims).where(and(live, isNotNull(billClaims.payerType))),
    d.selectDistinct({ id: providers.id, name: providers.name }).from(billClaims).innerJoin(providers, eq(providers.id, billClaims.providerId)).where(live),
    d.selectDistinct({ id: clinics.id, name: clinics.name }).from(billClaims).innerJoin(clinics, eq(clinics.id, billClaims.clinicId)).where(live),
    d.selectDistinct({ v: billLines.code }).from(billLines).orderBy(asc(billLines.code)).limit(500),
    d.selectDistinct({ v: billLines.denialCode }).from(billLines).where(isNotNull(billLines.denialCode)).limit(300),
  ]);
  return {
    payers: payers.map((p) => p.v!).filter(Boolean),
    payerTypes: types.map((t) => t.v!).filter(Boolean).sort(),
    providers: provs.sort((x, y) => x.name.localeCompare(y.name)),
    clinics: cls.sort((x, y) => x.name.localeCompare(y.name)),
    codes: codes.map((c) => c.v).filter((c) => c && !c.startsWith("(")),
    reasons: reasons.map((r) => r.v!).filter(Boolean).sort().map((code) => { const [g, c] = code.split("-"); return { code, text: describeAdjustment(g ?? "", c ?? "") }; }),
  };
}

/**
 * Link a claim to the right patient (null = let matching decide again; `none` = "not this patient", the
 * patient isn't in MyPCP, so matching leaves it alone). Remembered for that member ID.
 */
export async function linkPatient(a: WorkspaceActor, claimId: number, subjectKey: string | null, none = false) {
  const d = await db();
  const [c] = await d.select({ id: billClaims.id, claimRef: billClaims.claimRef, memberId: billClaims.memberId }).from(billClaims).where(eq(billClaims.id, claimId)).limit(1);
  if (!c) throw new WorkspaceError("Claim not found.", "NOT_FOUND");
  const member = upperAlnum(c.memberId);
  const [row] = await d.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, MEMBER_LINKS_KEY)).limit(1);
  const links = { ...((row?.value as Record<string, { key: string }> | undefined) ?? {}) };
  if (member) {
    if (subjectKey) links[member] = { key: subjectKey };
    else if (none) links[member] = { key: "" };
    else delete links[member];
    await d.insert(appSettings).values({ key: MEMBER_LINKS_KEY, value: links }).onDuplicateKeyUpdate({ set: { value: links } });
  }
  if (!subjectKey && none) {
    const target = member ? or(eq(billClaims.id, claimId), and(eq(billClaims.memberId, c.memberId!), or(isNull(billClaims.matchSource), ne(billClaims.matchSource, "manual"))))! : eq(billClaims.id, claimId);
    await d.update(billClaims).set({ subjectKey: null, patientId: null, matchSource: "manual" }).where(target);
    await audit(a, "link_bill_patient", { entityType: "billClaim", entityId: claimId, description: "Marked a claim's patient as not in MyPCP" });
    return { ok: true };
  }
  if (subjectKey) {
    const target = member ? or(eq(billClaims.id, claimId), and(eq(billClaims.memberId, c.memberId!), ne(billClaims.matchSource, "manual")))! : eq(billClaims.id, claimId);
    await d.update(billClaims).set({ subjectKey, patientId: patientIdOf(subjectKey), matchSource: "manual" }).where(target);
    // Also claims with that member ID that had no match yet.
    if (member) await d.update(billClaims).set({ subjectKey, patientId: patientIdOf(subjectKey), matchSource: "manual" }).where(and(eq(billClaims.memberId, c.memberId!), isNull(billClaims.matchSource)));
  } else {
    await d.update(billClaims).set({ matchSource: null }).where(eq(billClaims.id, claimId));
    await recomputeClaims(d, [c.claimRef], null);
  }
  await audit(a, "link_bill_patient", { entityType: "billClaim", entityId: claimId, description: subjectKey ? "Linked a claim to a patient" : "Cleared a claim's patient link" });
  return { ok: true };
}

/** The owner's saved column choices for a spreadsheet layout. */
export async function sheetMapping(signature: string): Promise<Record<string, number> | null> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, SHEET_MAPS_KEY)).limit(1);
  return ((row?.value as Record<string, Record<string, number>> | undefined) ?? {})[signature] ?? null;
}

export async function saveSheetMapping(signature: string, mapping: Record<string, number>) {
  const d = await db();
  const [row] = await d.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, SHEET_MAPS_KEY)).limit(1);
  const all = { ...((row?.value as Record<string, Record<string, number>> | undefined) ?? {}) };
  all[signature] = mapping;
  // Keep the 40 most recent layouts.
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete all[k];
  await d.insert(appSettings).values({ key: SHEET_MAPS_KEY, value: all }).onDuplicateKeyUpdate({ set: { value: all } });
  return { ok: true };
}

/**
 * IAM-only "master-billing-rematch" job: match again the saved claims that have no patient, or were
 * matched by member ID or a close name (after matching improves). The owner's own picks stay. Counts
 * only, no patient details. Dry run unless `apply`; re-run until `left` is 0 if time runs out.
 */
export async function rematchClaims(opts: { apply: boolean; deadline: number }) {
  const d = await db();
  peopleCache = null;
  const rows = await d.select({
    id: billClaims.id, patientName: billClaims.patientName, patientDob: billClaims.patientDob, memberId: billClaims.memberId, providerNpi: billClaims.providerNpi,
    providerName: billClaims.providerName, firstServiceDate: billClaims.firstServiceDate, subjectKey: billClaims.subjectKey, matchSource: billClaims.matchSource, clinicId: billClaims.clinicId,
  }).from(billClaims).where(or(isNull(billClaims.matchSource), inArray(billClaims.matchSource, ["member", "close"])));
  const lineDates = new Map<number, string[]>();
  for (const part of chunks(rows.map((r) => r.id), 1000)) {
    for (const l of await d.select({ claimId: billLines.claimId, serviceDate: billLines.serviceDate }).from(billLines).where(inArray(billLines.claimId, part))) {
      if (l.serviceDate) lineDates.set(l.claimId, [...(lineDates.get(l.claimId) ?? []), l.serviceDate]);
    }
  }
  const inputs = rows.map((r) => ({ r, m: { ...r, lines: (lineDates.get(r.id) ?? []).map((serviceDate) => ({ serviceDate })) } as MatchInput }));
  const ctx = await matchContext(d, inputs.flatMap(({ m }) => claimDates(m)));
  const count = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
  const before: Record<string, number> = {}, after: Record<string, number> = {};
  const why: Record<string, number> = {};
  let memberOtherFirstName = 0;
  const changes: { id: number; subjectKey: string | null; patientId: number | null; matchSource: string | null; clinicId: number | null }[] = [];
  for (const { r, m } of inputs) {
    count(before, r.matchSource ?? "none");
    const x = matchClaim(ctx, m);
    count(after, x.matchSource ?? "none");
    const clinicId = x.clinicId ?? r.clinicId;
    if (x.subjectKey !== r.subjectKey || x.matchSource !== r.matchSource || clinicId !== r.clinicId) changes.push({ id: r.id, subjectKey: x.subjectKey, patientId: x.patientId, matchSource: x.matchSource, clinicId });
    if (x.subjectKey) continue;
    // Why the rest still have no patient (counts only).
    const name = r.patientName ?? "";
    if (!name.trim()) { count(why, "no name on the bill"); continue; }
    if (personByMember(ctx.index, ctx.members, r.memberId, name, false).length) memberOtherFirstName++;
    const cands = findPeople(ctx.index, { name, dates: claimDates(m), providerId: null }, true);
    if (!cands.length) count(why, "no one with a similar name");
    else if (cands.every((c) => c.level === "weak")) count(why, "only loosely similar names (shown as suggestions)");
    else if (cands.filter((c) => c.level !== "weak").length === 1) count(why, "one similar name, nothing else confirming it (shown as a suggestion)");
    else count(why, "several people with that name (shown as suggestions)");
  }
  let applied = 0;
  if (opts.apply) {
    for (const part of chunks(changes, 10)) {
      if (Date.now() > opts.deadline) break;
      await Promise.all(part.map((c) => d.update(billClaims).set({ subjectKey: c.subjectKey, patientId: c.patientId, matchSource: c.matchSource, clinicId: c.clinicId }).where(eq(billClaims.id, c.id))));
      applied += part.length;
    }
  }
  return { checked: rows.length, before, after, changes: changes.length, applied, left: opts.apply ? changes.length - applied : null, stillNoPatient: why, memberOtherFirstName, people: ctx.index.people.length, memberIds: ctx.members.size };
}

/** IAM-only "master-billing-counts" job: counts and totals only, no patient details. */
export async function masterBillingCounts() {
  const d = await db();
  const imports = await d.select({ kind: billImports.kind, status: billImports.status, n: sql<number>`COUNT(*)`, claims: sql<number>`SUM(${billImports.claimCount})` })
    .from(billImports).groupBy(billImports.kind, billImports.status);
  const [events] = await d.select({ n: sql<number>`COUNT(*)` }).from(billClaimEvents);
  const byStatus = await d.select({ status: billClaims.status, n: sql<number>`COUNT(*)`, billed: sql<number>`SUM(${billClaims.billedCents})`, paid: sql<number>`SUM(${billClaims.paidCents})` })
    .from(billClaims).where(isNull(billClaims.supersededBy)).groupBy(billClaims.status);
  const [m] = await d.select({
    claims: sql<number>`COUNT(*)`, matched: sql<number>`SUM(${billClaims.subjectKey} IS NOT NULL)`, withProvider: sql<number>`SUM(${billClaims.providerId} IS NOT NULL)`,
    withClinic: sql<number>`SUM(${billClaims.clinicId} IS NOT NULL)`, superseded: sql<number>`SUM(${billClaims.supersededBy} IS NOT NULL)`,
  }).from(billClaims);
  const [lines] = await d.select({ n: sql<number>`COUNT(*)` }).from(billLines);
  const bySource = await d.select({ matchSource: billClaims.matchSource, n: sql<number>`COUNT(*)` }).from(billClaims).groupBy(billClaims.matchSource);
  // High-deductible patients in the last year (what staff see flagged), by visits with a deductible.
  const dedLines = await deductibleLines(d, and(isNull(billClaims.supersededBy), gte(billClaims.firstServiceDate, addDays(localDateStr(), -HIGH_DEDUCTIBLE_WINDOW_DAYS)))!);
  const dedPeople = groupDeductible(dedLines, 1);
  const num = (x: unknown) => Number(x ?? 0);
  return {
    imports: imports.map((i) => ({ kind: i.kind, status: i.status, files: num(i.n), claims: num(i.claims) })),
    events: num(events?.n), lines: num(lines?.n),
    claims: { total: num(m?.claims), matchedToPatient: num(m?.matched), withProvider: num(m?.withProvider), withClinic: num(m?.withClinic), replacedReportRows: num(m?.superseded) },
    matchedBy: Object.fromEntries(bySource.map((s) => [s.matchSource ?? "none", num(s.n)])),
    highDeductibleLast12Months: {
      deductibleOn1Visit: dedPeople.filter((p) => p.visits.length === 1).length,
      on2Visits: dedPeople.filter((p) => p.visits.length === 2).length,
      on3to4Visits: dedPeople.filter((p) => p.visits.length >= 3 && p.visits.length <= 4).length,
      on5PlusVisits: dedPeople.filter((p) => p.visits.length >= 5).length,
      flaggedForStaff: dedPeople.filter((p) => p.visits.length >= HIGH_DEDUCTIBLE_MIN_VISITS).length,
      flaggedWithoutPatientMatch: dedPeople.filter((p) => p.visits.length >= HIGH_DEDUCTIBLE_MIN_VISITS && p.personKey.startsWith("n:")).length,
      deductibleDollarsFlagged: Math.round(dedPeople.filter((p) => p.visits.length >= HIGH_DEDUCTIBLE_MIN_VISITS).reduce((a, p) => a + p.deductibleCents, 0) / 100),
    },
    byStatus: byStatus.map((s) => ({ status: s.status, claims: num(s.n), billedDollars: Math.round(num(s.billed) / 100), paidDollars: Math.round(num(s.paid) / 100) })),
  };
}

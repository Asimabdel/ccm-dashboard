// What a patient will likely owe at check-in (2026-11-17), from the payment files in Master Billing:
// their own past copays and deductibles, and for someone with no visits yet, what other patients on
// the same plan paid. Worked out for everyone at once, at most every 15 minutes per server, then
// looked up per patient. Rules: shared/visitCost.ts. Estimates only; nothing here changes a claim.
import { gunzipSync } from "node:zlib";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appointments, appSettings, billClaims, billLines, clinics, coverageOnFile, fhirResources, patients, planCopays } from "../drizzle/schema";
import type { BillAdjustment } from "../shared/masterBilling";
import {
  coverageInfo, EXPECTED_CODES, medianCents, payerFamily, personCost, personNote, planCopay, planDeductibleLikely, planKeys, planNote, planStat, sameMemberId, shortDay, usd, visitsOf,
  type CollectNote, type CostLine, type PersonCost, type PlanMember, type PlanStat, type PlanTier,
} from "../shared/visitCost";
import { visitAnswer, type CardInput, type OwnerPlanInput } from "../shared/visitCostAnswer";
import { cardReadingAvailable, cardStatus, latestCardReads, type CardRead } from "./insuranceCardDb";
import { addDays } from "../shared/payments";
import { localDateStr } from "../shared/workforce";
import { audit, subjectCare, subjectKeyFor, WorkspaceError, type WorkspaceActor } from "./workspaceDb";
import { people } from "./masterBillingDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

// ---- Who sees the notes ----
// Admins first, so the owner can check the notes against patients he knows. Then everyone with the usual
// access, switched on by the IAM-only "visit-cost-audience" job (a saved switch: no deploy needed).
const AUDIENCE_KEY = "visit_cost_audience";
let audience: { at: number; everyone: boolean } | null = null;

async function everyoneSees(): Promise<boolean> {
  if (audience && Date.now() - audience.at < 60_000) return audience.everyone;
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, AUDIENCE_KEY)).limit(1);
  audience = { at: Date.now(), everyone: (row?.value as { everyone?: boolean } | undefined)?.everyone === true };
  return audience.everyone;
}
const maySee = async (actor: WorkspaceActor) => actor.role === "admin" || (await everyoneSees());
/** For the side menu: does this role get the Copays & deductibles tab right now? */
export const visitCostAllowed = async (role: string) => role === "admin" || (await everyoneSees());

/** IAM-only "visit-cost-audience" job: who sees the notes. { everyone: true | false } changes it; without it, it only reports. */
export async function visitCostAudienceJob(input: { everyone?: boolean }) {
  if (typeof input.everyone === "boolean") {
    const value = { everyone: input.everyone };
    await (await db()).insert(appSettings).values({ key: AUDIENCE_KEY, value, updatedByUserId: null }).onDuplicateKeyUpdate({ set: { value, updatedByUserId: null } });
    audience = null;
  }
  return { everyone: await everyoneSees(), meaning: "false = admins only; true = everyone with Patient Flow / Insurance access" };
}

/** A patient's insurance as Practice Fusion (or an insurance check) has it. */
interface OnFile { payer: string | null; payerKey: string; memberId: string | null; group: string | null; plan: string | null; active: boolean; start: string | null; order: number | null; fromCard?: boolean }
/** A plan's display name: insurer, plan name, group number. */
interface PlanLabel { payer: string | null; plan: string | null; group: string | null }
interface Median { cents: number; n: number }

interface Built {
  at: number;
  today: string;
  /** Any of a person's keys (roster, schedule, Practice Fusion) → their one main key. */
  main: (key: string) => string;
  persons: Map<string, PersonCost>;
  /** Each person's latest wellness visit in the payment files, and what insurance left to them. */
  wellness: Map<string, { date: string; owesCents: number }>;
  coverage: Map<string, OnFile[]>;
  plans: Map<string, PlanStat>;
  /** Each person's newest card reading (as of the build). */
  cards: Map<string, CardRead>;
  /** Plan key → how to show it, and what the cards on that plan print. */
  labels: Map<string, PlanLabel>;
  cardStats: Map<string, { cards: number; copays: number[]; highDeductible: number }>;
  /** Insurance → office visit code → what it usually allows. */
  allowed: Map<string, Map<string, Median>>;
  /** The latest payment date in the uploaded files. */
  through: string | null;
  lines: number;
  coverageRecords: number;
}

const TTL_MS = 15 * 60_000;
/** A code's usual price needs at least this many paid visits behind it. */
const MIN_PRICED = 5;
let cache: Built | null = null;
let building: Promise<Built> | null = null;

const unpack = (raw: string | null): unknown => {
  if (!raw) return null;
  try { return JSON.parse(gunzipSync(Buffer.from(raw, "base64")).toString("utf8")) as unknown; } catch { return null; }
};

/** The insurance record to go by: the one the latest claim was paid under; with no claims, the active primary one. */
function pickCoverage(list: OnFile[] | undefined, pc: PersonCost | null): OnFile | null {
  if (!list?.length) return null;
  // A card the AI read beats Practice Fusion's list (whose group field is different for nearly everyone).
  const ordered = [...list.filter((c) => c.fromCard), ...list.filter((c) => !c.fromCard)];
  if (pc) return ordered.find((c) => sameMemberId(c.memberId, pc.memberId)) ?? ordered.find((c) => !!c.payerKey && c.payerKey === pc.payerKey) ?? null;
  if (ordered[0]?.fromCard) return ordered[0];
  const active = list.filter((c) => c.active);
  const pool = active.length ? active : list;
  return pool.slice().sort((a, b) => (a.order ?? 9) - (b.order ?? 9) || (b.start ?? "").localeCompare(a.start ?? ""))[0] ?? null;
}

async function build(): Promise<Built> {
  const d = await db();
  const today = localDateStr();
  const since = `${Number(today.slice(0, 4)) - 1}-01-01`;
  const { index } = await people();
  const main = (key: string) => index.byKey.get(key)?.key ?? key;

  // Paid claims only: a denied or waiting claim says nothing about what the patient owes.
  const rows = await d.select({
    claimId: billClaims.id, subjectKey: billClaims.subjectKey, payerName: billClaims.payerName, filingIndicator: billClaims.filingIndicator, memberId: billClaims.memberId,
    firstServiceDate: billClaims.firstServiceDate, serviceDate: billLines.serviceDate, code: billLines.code, allowedCents: billLines.allowedCents, paidCents: billLines.paidCents,
    patientOwesCents: billLines.patientOwesCents, adjustments: billLines.adjustments,
  }).from(billLines).innerJoin(billClaims, eq(billClaims.id, billLines.claimId))
    .where(and(isNull(billClaims.supersededBy), inArray(billClaims.status, ["paid", "partly_paid", "patient_owes"]), gte(billClaims.firstServiceDate, since)));

  const byPerson = new Map<string, CostLine[]>();
  const prices = new Map<string, Map<string, number[]>>();
  const priced = new Set<string>([...EXPECTED_CODES.established, ...EXPECTED_CODES.newPatient]);
  const yearAgo = addDays(today, -365);
  for (const r of rows) {
    const line: CostLine = {
      claimId: r.claimId, date: r.serviceDate ?? r.firstServiceDate, code: r.code, payerName: r.payerName, filingIndicator: r.filingIndicator, memberId: r.memberId,
      allowedCents: r.allowedCents, paidCents: r.paidCents, patientOwesCents: r.patientOwesCents, adjustments: (r.adjustments as BillAdjustment[] | null) ?? null,
    };
    // A claim not matched to a patient still tells what the insurance pays for a visit.
    if (r.subjectKey) {
      const key = main(r.subjectKey);
      const list = byPerson.get(key);
      if (list) list.push(line); else byPerson.set(key, [line]);
    }
    if (priced.has(line.code) && line.allowedCents > 0 && line.date && line.date >= yearAgo) {
      const payer = payerFamily(line.payerName, line.filingIndicator);
      if (!payer) continue;
      let codes = prices.get(payer);
      if (!codes) prices.set(payer, (codes = new Map()));
      const xs = codes.get(line.code);
      if (xs) xs.push(line.allowedCents); else codes.set(line.code, [line.allowedCents]);
    }
  }
  const persons = new Map<string, PersonCost>();
  const wellness = new Map<string, { date: string; owesCents: number }>();
  for (const [key, lines] of Array.from(byPerson.entries())) {
    const visits = visitsOf(lines);
    const pc = personCost(visits, today);
    if (pc) persons.set(key, pc);
    const w = visits.find((v) => v.kind === "wellness" && v.date <= today);
    if (w) wellness.set(key, { date: w.date, owesCents: w.dayOwesCents });
  }
  const allowed = new Map<string, Map<string, Median>>();
  for (const [payer, codes] of Array.from(prices.entries())) {
    const m = new Map<string, Median>();
    for (const [code, xs] of Array.from(codes.entries())) if (xs.length >= MIN_PRICED) m.set(code, { cents: medianCents(xs), n: xs.length });
    if (m.size) allowed.set(payer, m);
  }

  // Everyone's insurance on file: Practice Fusion's insurance list (group number and plan name live in the full record) and insurance checks.
  const coverage = new Map<string, OnFile[]>();
  const add = (key: string | null, c: OnFile) => {
    if (!key) return;
    const k = main(key);
    const list = coverage.get(k);
    if (list) list.push(c); else coverage.set(k, [c]);
  };
  const covRows = await d.select({ key: fhirResources.subjectKey, raw: fhirResources.raw, title: fhirResources.title, value: fhirResources.value, status: fhirResources.status, date: fhirResources.date })
    .from(fhirResources).where(and(eq(fhirResources.resourceType, "Coverage"), isNotNull(fhirResources.subjectKey)));
  for (const c of covRows) {
    const json = unpack(c.raw);
    const info = json
      ? coverageInfo(json, today)
      : { payer: c.title, memberId: /Member ID ([^\s·]+)/.exec(c.value ?? "")?.[1] ?? null, group: null, plan: null, active: !/cancel|inactive|entered/i.test(c.status ?? ""), start: c.date, order: null };
    add(c.key, { ...info, payer: info.payer ?? c.title, payerKey: payerFamily(info.payer ?? c.title) });
  }
  for (const c of await d.select().from(coverageOnFile)) {
    add(c.subjectKey, { payer: c.payerName, payerKey: payerFamily(c.payerName), memberId: c.memberId, group: c.groupNumber, plan: null, active: true, start: null, order: null });
  }
  // Insurance cards the AI read: the most exact plan (group number and plan name as printed).
  const cards = new Map<string, CardRead>();
  const labels = new Map<string, PlanLabel>();
  const cardStats = new Map<string, { cards: number; copays: number[]; highDeductible: number }>();
  for (const r of await latestCardReads()) {
    const k = main(r.subjectKey);
    if (cards.has(k)) continue;
    cards.set(k, r);
    const payerKey = payerFamily(r.payer);
    add(r.subjectKey, { payer: r.payer, payerKey, memberId: r.memberId, group: r.groupNumber, plan: r.planName, active: true, start: r.photoAt ? r.photoAt.toISOString().slice(0, 10) : null, order: 0, fromCard: true });
    for (const pk of planKeys(payerKey, r.groupNumber, r.planName)) {
      if (!labels.has(pk.key)) labels.set(pk.key, { payer: r.payer, plan: pk.tier === "payer" ? null : r.planName, group: pk.tier === "group" ? r.groupNumber : null });
      const s = cardStats.get(pk.key) ?? { cards: 0, copays: [], highDeductible: 0 };
      s.cards++;
      if (r.pcpCopayCents != null) s.copays.push(r.pcpCopayCents);
      if (r.highDeductible) s.highDeductible++;
      cardStats.set(pk.key, s);
    }
  }

  // What each plan's patients paid: same group number, same plan name, same insurance.
  const members = new Map<string, { tier: PlanTier; list: PlanMember[] }>();
  for (const [key, pc] of Array.from(persons.entries())) {
    const cov = pickCoverage(coverage.get(key), pc);
    const d2 = pc.deductible;
    const member: PlanMember = { copayCents: pc.copay?.cents ?? null, nothingOwed: pc.nothingOwed, deductible: d2.state === "applies" || d2.visitsThisYear >= 2 || d2.visitsLastYear >= 2 };
    for (const k of planKeys(pc.payerKey, cov?.group, cov?.plan)) {
      const m = members.get(k.key);
      if (m) m.list.push(member); else members.set(k.key, { tier: k.tier, list: [member] });
      if (!labels.has(k.key)) labels.set(k.key, { payer: cov?.payer ?? pc.payer, plan: k.tier === "payer" ? null : cov?.plan ?? null, group: k.tier === "group" ? cov?.group ?? null : null });
    }
  }
  const plans = new Map<string, PlanStat>();
  for (const [key, m] of Array.from(members.entries())) plans.set(key, planStat(m.tier, m.list));

  const [last] = await d.select({ through: sql<string | null>`MAX(${billClaims.lastPaidDate})` }).from(billClaims).where(isNull(billClaims.supersededBy));
  const through = last?.through ? (last.through > today ? today : last.through) : null;
  return { at: Date.now(), today, main, persons, wellness, coverage, plans, cards, labels, cardStats, allowed, through, lines: rows.length, coverageRecords: covRows.length };
}

/** After a card is read or the owner changes the table: work everything out again on the next look. */
export function invalidateVisitCost() {
  cache = null;
  ownerCache = null;
}

// ---- The owner's plan copay table ----
type OwnerRow = typeof planCopays.$inferSelect;
let ownerCache: { at: number; rows: Map<string, OwnerRow> } | null = null;
async function ownerRows(): Promise<Map<string, OwnerRow>> {
  if (ownerCache && Date.now() - ownerCache.at < 30_000) return ownerCache.rows;
  const rows = new Map((await (await db()).select().from(planCopays)).map((r) => [r.planKey, r]));
  ownerCache = { at: Date.now(), rows };
  return rows;
}
const labelText = (l: PlanLabel | null | undefined, key: string) => {
  if (!l) return key.split("|").slice(1).join(" ");
  const name = [l.plan, l.group ? `group ${l.group}` : null].filter(Boolean).join(", ");
  return name ? `${name} (${l.payer ?? "insurance"})` : `${l.payer ?? "this insurance"}, any plan`;
};
/** The owner's row for this plan, most exact first (group number, plan name, insurance). */
function ownerFor(rows: Map<string, OwnerRow>, keys: { key: string }[]): OwnerPlanInput | null {
  for (const k of keys) {
    const r = rows.get(k.key);
    if (r) return { answer: r.answer as OwnerPlanInput["answer"], copayCents: r.copayCents, coinsurancePct: r.coinsurancePct, label: labelText({ payer: r.payerName, plan: r.planName, group: r.groupNumber }, r.planKey) };
  }
  return null;
}
const cardInput = (r: CardRead | null | undefined): CardInput | null => (r && r.status === "read" ? {
  payer: r.payer, planName: r.planName, planType: r.planType, pcpCopayCents: r.pcpCopayCents, highDeductible: r.highDeductible, photoDate: r.photoAt ? r.photoAt.toISOString().slice(0, 10) : null,
} : null);
/** The plan keys to look a patient up by: their card first, then the insurance on file. */
function keysFor(card: CardRead | null | undefined, pc: PersonCost | null, cov: OnFile | null) {
  const fromCard = card && card.status === "read" ? planKeys(payerFamily(card.payer), card.groupNumber, card.planName) : [];
  const payerKey = pc?.payerKey ?? cov?.payerKey ?? "";
  const seen = new Set(fromCard.map((k) => k.key));
  return [...fromCard, ...planKeys(payerKey, cov?.group, cov?.plan).filter((k) => !seen.has(k.key))];
}

async function built(): Promise<Built> {
  if (cache && Date.now() - cache.at < TTL_MS && cache.today === localDateStr()) return cache;
  // One build at a time, however many screens ask at once.
  building ??= build().then((b) => (cache = b)).finally(() => { building = null; });
  return building;
}

/** The plan a patient is on, as exactly as other patients' payments can tell: the first of group number, plan name, insurance that says something. */
function planFor(b: Built, payerKey: string, group: string | null | undefined, plan: string | null | undefined): PlanStat | null {
  let loosest: PlanStat | null = null;
  for (const k of planKeys(payerKey, group, plan)) {
    const stat = b.plans.get(k.key);
    if (!stat) continue;
    if (planCopay(stat) || planDeductibleLikely(stat)) return stat;
    loosest = stat;
  }
  return loosest;
}

/** What this insurance usually allows for an office visit (the code billed most of the pair). */
function expected(b: Built, payerKey: string, kind: keyof typeof EXPECTED_CODES): (Median & { code: string }) | null {
  const codes = b.allowed.get(payerKey);
  if (!codes) return null;
  return EXPECTED_CODES[kind].map((code) => ({ code, ...(codes.get(code) ?? { cents: 0, n: 0 }) })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n)[0] ?? null;
}

function noteFor(b: Built, key: string, owners?: Map<string, OwnerRow>): CollectNote | null {
  const m = b.main(key);
  const pc = b.persons.get(m);
  if (pc) return personNote(pc);
  // No paid visits on file: their card, then the owner's plan table, then other patients on the same plan.
  const card = b.cards.get(m);
  const cov = pickCoverage(b.coverage.get(m), null);
  if (!cov?.payerKey) return null;
  const price = expected(b, cov.payerKey, "newPatient") ?? expected(b, cov.payerKey, "established");
  const when = card?.photoAt ? ` (photo from ${shortDay(card.photoAt.toISOString().slice(0, 10))})` : "";
  if (card?.highDeductible) return { kind: "deductible", basis: "card", cents: price?.cents ?? null, label: `Deductible plan (card)${price ? `: about ${usd(price.cents)}` : ""}`, detail: `Their insurance card${when} shows an HSA / high-deductible plan: they pay the full visit until the deductible is met.` };
  if (card && card.pcpCopayCents != null) return card.pcpCopayCents
    ? { kind: "copay", basis: "card", cents: card.pcpCopayCents, label: `Copay ${usd(card.pcpCopayCents)} (card)`, detail: `Printed on their insurance card${when}: ${usd(card.pcpCopayCents)} office visit copay.` }
    : { kind: "nothing", basis: "card", cents: 0, label: "No copay (card)", detail: `Their insurance card${when} shows a $0 office visit copay.` };
  const owner = owners ? ownerFor(owners, keysFor(card, null, cov)) : null;
  if (owner?.answer === "copay" && owner.copayCents != null) return { kind: owner.copayCents ? "copay" : "nothing", basis: "table", cents: owner.copayCents, label: owner.copayCents ? `Copay ${usd(owner.copayCents)} (plan table)` : "No copay (plan table)", detail: `Your plan copay table: ${owner.label}.` };
  if (owner?.answer === "nothing") return { kind: "nothing", basis: "table", cents: 0, label: "No copay (plan table)", detail: `Your plan copay table: ${owner.label}.` };
  if (owner?.answer === "deductible") return { kind: "deductible", basis: "table", cents: price?.cents ?? null, label: `Deductible plan (plan table)${price ? `: about ${usd(price.cents)}` : ""}`, detail: `Your plan copay table: ${owner.label}: the deductible comes first.` };
  return planNote(planFor(b, cov.payerKey, cov.group, cov.plan), price?.cents ?? null);
}

/** Patient Flow / Insurance schedule: the collect note for everyone on that day's schedule (in clinics the person can see). */
export async function visitCostForDay(actor: WorkspaceActor, date: string): Promise<Record<string, CollectNote>> {
  if (!(await maySee(actor))) return {};
  const d = await db();
  const rows = await d.select({ patientId: appointments.patientId, patientName: appointments.patientName, dob: appointments.dateOfBirth, clinicId: appointments.clinicId })
    .from(appointments).where(eq(appointments.date, date));
  if (!rows.length) return {};
  const [b, owners] = await Promise.all([built(), ownerRows()]);
  const out: Record<string, CollectNote> = {};
  for (const r of rows) {
    if (actor.clinicIds && (r.clinicId == null || !actor.clinicIds.includes(r.clinicId))) continue;
    const key = subjectKeyFor(r.patientId, r.patientName, r.dob);
    if (out[key]) continue;
    const note = noteFor(b, key, owners);
    if (note) out[key] = note;
  }
  return out;
}

/** The Insurance tab's "From past visits" card: the note, the visits behind it, the plan's other patients, and what a visit usually costs. */
export async function visitCostForPatient(actor: WorkspaceActor, key: string) {
  if (!(await maySee(actor))) return { note: null, through: null, insurance: null, own: null, plan: null, prices: [] };
  if (actor.clinicIds) {
    const care = await subjectCare(key);
    if (!care?.clinicId || !actor.clinicIds.includes(care.clinicId)) throw new WorkspaceError("That patient isn't at your office.", "FORBIDDEN");
  }
  const b = await built();
  const m = b.main(key);
  const pc = b.persons.get(m) ?? null;
  const cov = pickCoverage(b.coverage.get(m), pc);
  const payerKey = pc?.payerKey ?? cov?.payerKey ?? "";
  const stat = payerKey ? planFor(b, payerKey, cov?.group, cov?.plan) : null;
  const copay = stat ? planCopay(stat) : null;
  const prices = payerKey
    ? [...EXPECTED_CODES.established, ...EXPECTED_CODES.newPatient].map((code) => ({ code, ...(b.allowed.get(payerKey)?.get(code) ?? { cents: 0, n: 0 }) })).filter((x) => x.n > 0)
    : [];
  return {
    note: noteFor(b, key, await ownerRows()),
    through: b.through,
    insurance: pc || cov ? { payer: pc?.payer ?? cov?.payer ?? null, group: cov?.group ?? null, plan: cov?.plan ?? null } : null,
    own: pc,
    plan: stat ? { tier: stat.tier, patients: stat.patients, copays: stat.copays.slice(0, 4), deductiblePatients: stat.deductiblePatients, copay, deductibleLikely: planDeductibleLikely(stat) } : null,
    prices,
  };
}

/** IAM-only "visit-cost-counts" job: how much the estimates cover. Counts only, no patient details. */
export async function visitCostCounts() {
  cache = null;
  const b = await built();
  const d = await db();
  const tally = (xs: string[]) => {
    const out: Record<string, number> = {};
    for (const x of xs) out[x] = (out[x] ?? 0) + 1;
    return out;
  };
  const list = Array.from(b.persons.values());
  const notes = list.map((pc) => personNote(pc));
  const copayAmounts = Object.entries(tally(list.filter((pc) => pc.copay).map((pc) => String(pc.copay!.cents / 100)))).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([dollars, patients]) => ({ dollars: Number(dollars), patients }));
  const cov = Array.from(b.coverage.values());
  const tiers = (tier: PlanTier) => {
    const stats = Array.from(b.plans.values()).filter((s) => s.tier === tier);
    return { plans: stats.length, with2PlusPatients: stats.filter((s) => s.patients >= 2).length, sayACopay: stats.filter((s) => planCopay(s)).length, likelyDeductible: stats.filter((s) => planDeductibleLikely(s)).length };
  };

  // The next day with a schedule: how many of its patients get a note, and from where.
  const [next] = await d.select({ date: appointments.date }).from(appointments).where(gt(appointments.date, b.today)).orderBy(asc(appointments.date)).limit(1);
  let nextDay: Record<string, unknown> | null = null;
  if (next) {
    const rows = await d.select({ patientId: appointments.patientId, patientName: appointments.patientName, dob: appointments.dateOfBirth }).from(appointments).where(eq(appointments.date, next.date));
    const keys = Array.from(new Set(rows.map((r) => subjectKeyFor(r.patientId, r.patientName, r.dob))));
    const found = keys.map((k) => ({ own: b.persons.has(b.main(k)), covered: (b.coverage.get(b.main(k))?.length ?? 0) > 0, note: noteFor(b, k) }));
    nextDay = {
      date: next.date, patients: keys.length,
      withANote: found.filter((f) => f.note).length, fromOwnVisits: found.filter((f) => f.note?.basis === "own").length, fromSamePlan: found.filter((f) => f.note?.basis === "plan").length,
      noPaidVisitsOnFile: found.filter((f) => !f.own).length, noPaidVisitsButInsuranceOnFile: found.filter((f) => !f.own && f.covered).length,
      kinds: tally(found.filter((f) => f.note).map((f) => f.note!.kind)),
    };
  }
  return {
    paymentsThrough: b.through, linesRead: b.lines,
    patientsWithPaidOfficeVisits: list.length,
    notes: { ...tally(notes.map((n) => n?.kind ?? "none")), total: list.length },
    copay: { patientsWithACopay: list.filter((pc) => pc.copay).length, fromLastYearOnly: list.filter((pc) => pc.copay?.fromLastYear).length, changedLately: list.filter((pc) => pc.copay && pc.copay.latestCents !== pc.copay.cents).length, amounts: copayAmounts },
    deductible: tally(list.map((pc) => pc.deductible.state)),
    coinsurancePatients: list.filter((pc) => pc.coinsurancePct).length,
    insuranceOnFile: {
      records: b.coverageRecords, patients: cov.length,
      patientsWithGroupNumber: cov.filter((l) => l.some((c) => c.group)).length, patientsWithPlanName: cov.filter((l) => l.some((c) => c.plan)).length,
      patientsWithVisitsAndAGroupNumber: Array.from(b.persons.entries()).filter(([k, pc]) => pickCoverage(b.coverage.get(k), pc)?.group).length,
    },
    plans: { byGroupNumber: tiers("group"), byPlanName: tiers("plan"), byInsurance: tiers("payer") },
    insurancesWithAUsualVisitPrice: b.allowed.size,
    nextDay,
  };
}

// ---------------------------------------------------------------------------
// The Copays & deductibles search: one patient, one answer for today's visit
// ---------------------------------------------------------------------------

/**
 * What the picked patient will likely pay for today's visit (or their next booked one), with what to
 * say to them. Like the Patients directory, anyone who may use the page can look up any patient.
 */
export async function visitCostAnswer(actor: WorkspaceActor, key: string) {
  if (!(await maySee(actor))) throw new WorkspaceError("Copays & deductibles isn't switched on for your role yet.", "FORBIDDEN");
  const d = await db();
  const b = await built();
  const { index } = await people();
  const person = index.byKey.get(key) ?? null;
  const keys = new Set(person?.keys ?? [key]);
  const m = b.main(key);
  const pc = b.persons.get(m) ?? null;
  // Their newest card photo, read fresh (it may have just been snapped or read).
  const cardNow = await cardStatus(key);
  const card = cardNow.read && cardNow.read.status === "read" ? cardNow.read : null;
  const cardAsCoverage: OnFile | null = card ? { payer: card.payer, payerKey: payerFamily(card.payer), memberId: card.memberId, group: card.groupNumber, plan: card.planName, active: true, start: null, order: 0, fromCard: true } : null;
  const cov = pickCoverage([...(cardAsCoverage ? [cardAsCoverage] : []), ...(b.coverage.get(m) ?? []).filter((c) => !c.fromCard)], pc);
  const cardIn = cardInput(card);
  const cardNewer = !!cardIn && (!pc || !cardIn.photoDate || cardIn.photoDate > pc.lastVisit);

  // Their visit today, else the next one booked (cancelled visits don't count).
  const upcoming = await d.select({
    date: appointments.date, startsAt: appointments.startsAt, patientId: appointments.patientId, patientName: appointments.patientName, dob: appointments.dateOfBirth,
    visitType: appointments.visitType, reason: appointments.reason, status: appointments.status, providerName: appointments.providerName, clinicId: appointments.clinicId,
  }).from(appointments).where(and(gte(appointments.date, b.today))).orderBy(asc(appointments.startsAt));
  const visit = upcoming.find((a) => a.status !== "cancelled" && keys.has(subjectKeyFor(a.patientId, a.patientName, a.dob))) ?? null;
  const clinicName = visit?.clinicId ? (await d.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, visit.clinicId)).limit(1))[0]?.name ?? null : null;

  // The insurance we go by: their latest paid claim, else Practice Fusion's insurance list, else the roster.
  let insurance: string | null = cardNewer && card?.payer ? card.payer : pc?.payer ?? null;
  let insuranceFrom: "card" | "claim" | "chart" | "roster" | null = insurance ? (cardNewer && card?.payer ? "card" : "claim") : null;
  if (!insurance && cov?.payer) { insurance = cov.payer; insuranceFrom = "chart"; }
  const patientId = person?.patientId ?? (/^p:(\d+)$/.exec(key) ? Number(key.slice(2)) : null);
  if (!insurance && patientId) {
    const [row] = await d.select({ insurance: patients.insurance }).from(patients).where(eq(patients.id, patientId)).limit(1);
    if (row?.insurance?.trim()) { insurance = row.insurance.trim(); insuranceFrom = "roster"; }
  }

  const payerKey = (cardNewer && cardAsCoverage?.payerKey) || pc?.payerKey || cov?.payerKey || "";
  const seenBefore = !!pc || Array.from(person?.visitDays ?? []).some((day) => day < b.today);
  const planKeysNow = keysFor(card, pc, cov);
  const owner = ownerFor(await ownerRows(), planKeysNow);
  // What other patients on the same plan paid (their card's group number / plan name first).
  const newPrice = payerKey ? expected(b, payerKey, "newPatient")?.cents ?? null : null;
  const followPrice = payerKey ? expected(b, payerKey, "established")?.cents ?? null : null;
  const stat = planKeysNow.map((k) => b.plans.get(k.key)).find((s) => s && (planCopay(s) || planDeductibleLikely(s))) ?? null;
  const answer = visitAnswer({
    today: b.today, pc, planNote: planNote(stat, newPrice ?? followPrice), insurance, insuranceFrom,
    visit: visit ? { date: visit.date, type: visit.visitType, reason: visit.reason } : null,
    seenBefore, newVisitCents: newPrice, followUpVisitCents: followPrice, lastWellness: b.wellness.get(m) ?? null, card: cardIn, ownerPlan: owner,
  });
  await audit(actor, "view_patient", { entityType: "visitCost", description: "Copays & deductibles: looked up what a patient pays today" });
  return {
    answer,
    patient: { key, patientId, name: person?.name ?? null, dob: person?.dob ?? null },
    visit: visit ? { date: visit.date, startsAt: visit.startsAt, today: visit.date === b.today, type: visit.visitType, provider: visit.providerName, clinic: clinicName } : null,
    insurance,
    through: b.through,
    card: {
      state: !cardNow.photo ? "none" : !cardNow.read ? "unread" : cardNow.read.status,
      canRead: cardReadingAvailable(),
      photoDate: cardNow.photo?.at ? cardNow.photo.at.toISOString().slice(0, 10) : null,
      read: card ? { payer: card.payer, planName: card.planName, groupNumber: card.groupNumber, pcpCopayCents: card.pcpCopayCents, specialistCopayCents: card.specialistCopayCents, highDeductible: card.highDeductible } : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Master Billing → Plan copays: the owner teaches what each plan charges
// ---------------------------------------------------------------------------

export const PLAN_ANSWERS = ["copay", "deductible", "nothing", "coinsurance"] as const;
export type PlanAnswer = (typeof PLAN_ANSWERS)[number];

/** Every plan worth an answer: seen on 2+ patients' payments, on a card the AI read, or already answered. */
export async function planCopayTable(actor: WorkspaceActor) {
  const [b, owners] = await Promise.all([built(), ownerRows()]);
  const keys = new Set<string>([...Array.from(b.plans.entries()).filter(([, s]) => s.patients >= 2).map(([k]) => k), ...Array.from(b.cardStats.keys()), ...Array.from(owners.keys())]);
  const tierOf = (k: string) => (k.startsWith("g|") ? "group" : k.startsWith("n|") ? "plan" : "payer") as PlanTier;
  const counts = (xs: number[]) => {
    const m = new Map<number, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return Array.from(m.entries()).map(([cents, n]) => ({ cents, patients: n })).sort((x, y) => y.patients - x.patients);
  };
  const rows = Array.from(keys).map((key) => {
    const stat = b.plans.get(key) ?? null;
    const cs = b.cardStats.get(key) ?? null;
    const o = owners.get(key) ?? null;
    const label = b.labels.get(key) ?? (o ? { payer: o.payerName, plan: o.planName, group: o.groupNumber } : null);
    const suggestion = stat ? planCopay(stat) : null;
    return {
      key, tier: tierOf(key), payer: label?.payer ?? null, plan: label?.plan ?? null, group: label?.group ?? null,
      patients: stat?.patients ?? 0, claimCopays: stat?.copays.slice(0, 4) ?? [], deductiblePatients: stat?.deductiblePatients ?? 0,
      suggestion: suggestion ? { kind: suggestion.cents ? "copay" : "nothing", cents: suggestion.cents } : stat && planDeductibleLikely(stat) ? { kind: "deductible", cents: null } : null,
      cards: cs?.cards ?? 0, cardCopays: counts(cs?.copays ?? []).slice(0, 4), cardHighDeductible: cs?.highDeductible ?? 0,
      answer: o ? { answer: o.answer as PlanAnswer, copayCents: o.copayCents, coinsurancePct: o.coinsurancePct, note: o.note, updatedAt: o.updatedAt } : null,
    };
  }).sort((x, y) => Number(!!x.answer) - Number(!!y.answer) || (y.patients + y.cards) - (x.patients + x.cards) || (x.payer ?? "").localeCompare(y.payer ?? ""));
  const { waitingCardCount } = await import("./insuranceCardDb");
  await audit(actor, "view_master_billing", { entityType: "planCopays", description: `Plan copays (${rows.length} plans)` });
  return { rows: rows.slice(0, 400), total: rows.length, answered: rows.filter((r) => r.answer).length, cardsWaiting: await waitingCardCount(), canRead: cardReadingAvailable() };
}

const KEY_RE = /^(g|n|p)\|.{1,190}$/;

/** Save the owner's answer for a plan (an existing key, or a new plan typed in by name). */
export async function savePlanCopay(actor: WorkspaceActor, input: { key?: string | null; payerName?: string | null; planName?: string | null; groupNumber?: string | null; answer: PlanAnswer; copayCents?: number | null; coinsurancePct?: number | null; note?: string | null }) {
  let key = input.key?.trim() || null;
  if (key && !KEY_RE.test(key)) throw new WorkspaceError("That plan isn't recognized.");
  if (!key) {
    const payerKey = payerFamily(input.payerName);
    if (!payerKey) throw new WorkspaceError("Type the insurance name.");
    key = planKeys(payerKey, input.groupNumber, input.planName)[0]!.key;
  }
  if (input.answer === "copay" && (input.copayCents == null || input.copayCents < 0 || input.copayCents > 50_000)) throw new WorkspaceError("Type the copay amount.");
  if (input.answer === "coinsurance" && (!input.coinsurancePct || input.coinsurancePct < 1 || input.coinsurancePct > 99)) throw new WorkspaceError("Type the coinsurance percent (1 to 99).");
  const b = await built();
  const label = b.labels.get(key);
  const values = {
    planKey: key, payerName: (input.payerName?.trim() || label?.payer || null)?.slice(0, 160) ?? null, planName: (input.planName?.trim() || label?.plan || null)?.slice(0, 160) ?? null,
    groupNumber: (input.groupNumber?.trim() || label?.group || null)?.slice(0, 60) ?? null, answer: input.answer,
    copayCents: input.answer === "copay" ? input.copayCents ?? null : null, coinsurancePct: input.answer === "coinsurance" ? input.coinsurancePct ?? null : null,
    note: input.note?.trim().slice(0, 255) || null, updatedByUserId: actor.id,
  };
  const { planKey: _k, ...set } = values;
  await (await db()).insert(planCopays).values(values).onDuplicateKeyUpdate({ set });
  invalidateVisitCost();
  await audit(actor, "set_plan_copay", { entityType: "planCopays", description: `Plan copays: set ${input.answer}${values.copayCents != null ? ` ${usd(values.copayCents)}` : ""} for ${labelText({ payer: values.payerName, plan: values.planName, group: values.groupNumber }, key)}` });
  return { key };
}

export async function removePlanCopay(actor: WorkspaceActor, key: string) {
  if (!KEY_RE.test(key)) throw new WorkspaceError("That plan isn't recognized.");
  await (await db()).delete(planCopays).where(eq(planCopays.planKey, key));
  invalidateVisitCost();
  await audit(actor, "set_plan_copay", { entityType: "planCopays", description: "Plan copays: removed an answer" });
  return { ok: true };
}

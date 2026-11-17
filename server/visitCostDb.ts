// What a patient will likely owe at check-in (2026-11-17), from the payment files in Master Billing:
// their own past copays and deductibles, and for someone with no visits yet, what other patients on
// the same plan paid. Worked out for everyone at once, at most every 15 minutes per server, then
// looked up per patient. Rules: shared/visitCost.ts. Estimates only; nothing here changes a claim.
import { gunzipSync } from "node:zlib";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appointments, appSettings, billClaims, billLines, clinics, coverageOnFile, fhirResources } from "../drizzle/schema";
import type { BillAdjustment } from "../shared/masterBilling";
import {
  coverageInfo, EXPECTED_CODES, medianCents, payerFamily, personCost, personNote, planCopay, planDeductibleLikely, planKeys, planNote, planStat, sameMemberId, visitsOf,
  type CollectKind, type CollectNote, type CostLine, type PersonCost, type PlanMember, type PlanStat, type PlanTier,
} from "../shared/visitCost";
import { addDays } from "../shared/payments";
import { localDateStr } from "../shared/workforce";
import { nameKey } from "../shared/workspace";
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
interface OnFile { payer: string | null; payerKey: string; memberId: string | null; group: string | null; plan: string | null; active: boolean; start: string | null; order: number | null }
interface Median { cents: number; n: number }

interface Built {
  at: number;
  today: string;
  /** Any of a person's keys (roster, schedule, Practice Fusion) → their one main key. */
  main: (key: string) => string;
  persons: Map<string, PersonCost>;
  coverage: Map<string, OnFile[]>;
  plans: Map<string, PlanStat>;
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
  if (pc) return list.find((c) => sameMemberId(c.memberId, pc.memberId)) ?? list.find((c) => !!c.payerKey && c.payerKey === pc.payerKey) ?? null;
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
  for (const [key, lines] of Array.from(byPerson.entries())) {
    const pc = personCost(visitsOf(lines), today);
    if (pc) persons.set(key, pc);
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

  // What each plan's patients paid: same group number, same plan name, same insurance.
  const members = new Map<string, { tier: PlanTier; list: PlanMember[] }>();
  for (const [key, pc] of Array.from(persons.entries())) {
    const cov = pickCoverage(coverage.get(key), pc);
    const d2 = pc.deductible;
    const member: PlanMember = { copayCents: pc.copay?.cents ?? null, nothingOwed: pc.nothingOwed, deductible: d2.state === "applies" || d2.visitsThisYear >= 2 || d2.visitsLastYear >= 2 };
    for (const k of planKeys(pc.payerKey, cov?.group, cov?.plan)) {
      const m = members.get(k.key);
      if (m) m.list.push(member); else members.set(k.key, { tier: k.tier, list: [member] });
    }
  }
  const plans = new Map<string, PlanStat>();
  for (const [key, m] of Array.from(members.entries())) plans.set(key, planStat(m.tier, m.list));

  const [last] = await d.select({ through: sql<string | null>`MAX(${billClaims.lastPaidDate})` }).from(billClaims).where(isNull(billClaims.supersededBy));
  const through = last?.through ? (last.through > today ? today : last.through) : null;
  return { at: Date.now(), today, main, persons, coverage, plans, allowed, through, lines: rows.length, coverageRecords: covRows.length };
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

function noteFor(b: Built, key: string): CollectNote | null {
  const m = b.main(key);
  const pc = b.persons.get(m);
  if (pc) return personNote(pc);
  // No paid visits on file: go by other patients on the same plan.
  const cov = pickCoverage(b.coverage.get(m), null);
  if (!cov?.payerKey) return null;
  const price = expected(b, cov.payerKey, "newPatient") ?? expected(b, cov.payerKey, "established");
  return planNote(planFor(b, cov.payerKey, cov.group, cov.plan), price?.cents ?? null);
}

/** Patient Flow / Insurance schedule: the collect note for everyone on that day's schedule (in clinics the person can see). */
export async function visitCostForDay(actor: WorkspaceActor, date: string): Promise<Record<string, CollectNote>> {
  if (!(await maySee(actor))) return {};
  const d = await db();
  const rows = await d.select({ patientId: appointments.patientId, patientName: appointments.patientName, dob: appointments.dateOfBirth, clinicId: appointments.clinicId })
    .from(appointments).where(eq(appointments.date, date));
  if (!rows.length) return {};
  const b = await built();
  const out: Record<string, CollectNote> = {};
  for (const r of rows) {
    if (actor.clinicIds && (r.clinicId == null || !actor.clinicIds.includes(r.clinicId))) continue;
    const key = subjectKeyFor(r.patientId, r.patientName, r.dob);
    if (out[key]) continue;
    const note = noteFor(b, key);
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
    note: noteFor(b, key),
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
// The "Copays & deductibles" tab: a day's schedule, or everyone with paid visits
// ---------------------------------------------------------------------------

/** One patient's line: the note, and the copay / deductible / coinsurance behind it. */
function costRow(b: Built, key: string) {
  const m = b.main(key);
  const pc = b.persons.get(m) ?? null;
  const cov = pc ? null : pickCoverage(b.coverage.get(m), null);
  const d = pc?.deductible ?? null;
  return {
    note: noteFor(b, key),
    payer: pc?.payer ?? cov?.payer ?? null,
    copay: pc?.copay ? { cents: pc.copay.cents, seenOn: pc.copay.seenOn, outOf: pc.copay.outOf, fromLastYear: pc.copay.fromLastYear } : null,
    nothingOwed: pc?.nothingOwed ?? false,
    deductible: d && d.state !== "none"
      ? { state: d.state, year: d.year, visits: d.state === "reset" ? d.visitsLastYear : d.visitsThisYear, cents: d.state === "reset" ? d.centsLastYear : d.centsThisYear, lastOwedCents: d.lastOwedCents }
      : null,
    coinsurancePct: pc?.coinsurancePct ?? null,
    coinsuranceCents: pc?.coinsuranceCents ?? null,
    lastVisit: pc?.lastVisit ?? null,
    /** Paid office visits the numbers come from (0 = none on file). */
    visits: pc?.lookedAt ?? 0,
  };
}

const NOT_YET = "Copays & deductibles isn't switched on for your role yet.";

/** A day's schedule (in clinics the person can see), each patient with what to expect at check-in. Cancelled visits are left out. */
export async function visitCostSchedule(actor: WorkspaceActor, date: string) {
  if (!(await maySee(actor))) throw new WorkspaceError(NOT_YET, "FORBIDDEN");
  const d = await db();
  const [appts, clinicRows, b] = await Promise.all([
    d.select({
      id: appointments.id, patientId: appointments.patientId, patientName: appointments.patientName, dob: appointments.dateOfBirth, clinicId: appointments.clinicId,
      providerName: appointments.providerName, startsAt: appointments.startsAt, visitType: appointments.visitType, status: appointments.status,
    }).from(appointments).where(eq(appointments.date, date)).orderBy(asc(appointments.startsAt)),
    d.select({ id: clinics.id, name: clinics.name }).from(clinics),
    built(),
  ]);
  const clinicName = new Map(clinicRows.map((c) => [c.id, c.name]));
  const rows = appts
    .filter((a) => a.status !== "cancelled" && (!actor.clinicIds || (a.clinicId != null && actor.clinicIds.includes(a.clinicId))))
    .map((a) => {
      const key = subjectKeyFor(a.patientId, a.patientName, a.dob);
      return {
        appointmentId: a.id, startsAt: a.startsAt, subjectKey: key, patientId: a.patientId, name: a.patientName, provider: a.providerName,
        clinic: a.clinicId != null ? clinicName.get(a.clinicId) ?? null : null, visitType: a.visitType, status: a.status, ...costRow(b, key),
      };
    });
  await audit(actor, "view_schedule", { entityType: "visitCost", description: `Copays & deductibles for ${date} (${rows.length} visits)` });
  return { date, today: b.today, through: b.through, everyone: actor.clinicIds === null, rows };
}

export const COST_LIST_KINDS = ["all", "copay", "deductible", "coinsurance", "nothing", "info", "none"] as const;
export type CostListKind = (typeof COST_LIST_KINDS)[number];
const LIST_PAGE = 50;

/**
 * Everyone with paid office visits on file, by name, 50 a page: for people who work across every
 * office (the schedule view is the one limited by clinic).
 */
export async function visitCostList(actor: WorkspaceActor, input: { q: string; kind: CostListKind; page: number }) {
  if (!(await maySee(actor))) throw new WorkspaceError(NOT_YET, "FORBIDDEN");
  if (actor.clinicIds !== null) throw new WorkspaceError("The all-patients list is for people who work across every office. Use the schedule view.", "FORBIDDEN");
  const b = await built();
  const { index } = await people();
  const all = Array.from(b.persons.keys()).map((key) => {
    const person = index.byKey.get(key);
    return { subjectKey: key, patientId: person?.patientId ?? null, name: person?.name ?? "(name not on file)", dob: person?.dob ?? null, ...costRow(b, key) };
  });
  const kindOf = (r: { note: CollectNote | null }): CollectKind | "none" => r.note?.kind ?? "none";
  const counts: Record<string, number> = { all: all.length };
  for (const r of all) counts[kindOf(r)] = (counts[kindOf(r)] ?? 0) + 1;
  const words = nameKey(input.q).split(" ").filter(Boolean);
  const found = all
    .filter((r) => (input.kind === "all" || kindOf(r) === input.kind) && (!words.length || words.every((w) => nameKey(r.name).includes(w))))
    .sort((x, y) => x.name.localeCompare(y.name));
  const page = Math.max(1, Math.min(input.page, Math.max(1, Math.ceil(found.length / LIST_PAGE))));
  await audit(actor, "view_patient", { entityType: "visitCost", description: `Copays & deductibles: all patients, page ${page}${words.length ? " (searched by name)" : ""}` });
  return { total: found.length, page, pageSize: LIST_PAGE, counts, through: b.through, rows: found.slice((page - 1) * LIST_PAGE, page * LIST_PAGE) };
}

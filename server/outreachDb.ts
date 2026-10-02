// Call-list tracking for the Opportunity Finder: where each patient stands (to call, waiting, booked,
// unreachable, closed), logging a call made outside the RingCentral phone, the "being called" hold,
// a patient's call history, and results by caller and list. Rules are in shared/outreach.ts.
import { and, desc, eq, gte, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { getDb } from "./db";
import { appointments, clinics, opportunityActions, outreachLocks, phoneCalls, staffProfiles, users } from "../drizzle/schema";
import { WorkspaceError, audit, subjectKeyFor, type WorkspaceActor } from "./workspaceDb";
import { CLOSING_OUTCOMES, normalizePhone, type CallOutcome } from "../shared/phone";
import { LOCK_MINUTES, OUTREACH_STATUS_LIST, OUTREACH_WINDOW_DAYS, outreachState, type ListSort, type OutreachCall, type OutreachState, type OutreachStatus, type SortDir } from "../shared/outreach";
import { OPPORTUNITY_CATEGORY_LIST, OPPORTUNITY_INFO, type OpportunityCategory } from "../shared/workspace";
import { isValidDateStr, localDateStr } from "../shared/workforce";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export const FILL_SOURCE = "schedule_fill";
const listCategories = new Set<string>([...OPPORTUNITY_CATEGORY_LIST, FILL_SOURCE]);

interface CallRow extends OutreachCall { id: number; by: string | null; userId: number | null; source: string | null; manual: boolean }

/** Outbound calls in the window, per patient (newest first), plus who is calling whom right now. */
export async function loadOutreach() {
  const d = await db();
  const since = new Date(Date.now() - OUTREACH_WINDOW_DAYS * 86_400_000);
  const rows = await d.select({
    id: phoneCalls.id, subjectKey: phoneCalls.subjectKey, startedAt: phoneCalls.startedAt, outcome: phoneCalls.outcome, callBackOn: phoneCalls.callBackOn,
    userId: phoneCalls.userId, userName: users.name, ext: phoneCalls.rcExtensionName, source: phoneCalls.source, result: phoneCalls.result,
  }).from(phoneCalls).leftJoin(users, eq(users.id, phoneCalls.userId))
    .where(and(eq(phoneCalls.direction, "outbound"), isNotNull(phoneCalls.subjectKey), gte(phoneCalls.startedAt, since)))
    .orderBy(desc(phoneCalls.startedAt));
  const calls = new Map<string, CallRow[]>();
  for (const r of rows) {
    const list = calls.get(r.subjectKey!) ?? [];
    list.push({ id: r.id, at: r.startedAt.getTime(), day: localDateStr(r.startedAt), outcome: r.outcome, callBackOn: r.callBackOn, by: r.userName ?? r.ext ?? null, userId: r.userId, source: r.source, manual: r.result === "Logged by hand" });
    calls.set(r.subjectKey!, list);
  }
  const now = new Date();
  const lockRows = await d.select({ subjectKey: outreachLocks.subjectKey, userId: outreachLocks.userId, name: users.name }).from(outreachLocks)
    .innerJoin(users, eq(users.id, outreachLocks.userId)).where(gte(outreachLocks.lockedUntil, now));
  const locks = new Map(lockRows.map((l) => [l.subjectKey, { userId: l.userId, name: l.name }]));
  const today = localDateStr();
  return {
    /** Where a patient stands on a list, what to show for it, and whether someone else is calling them. */
    stateFor(key: string, action: { action: string; createdAt: Date } | null, me: number) {
      const list = calls.get(key) ?? [];
      const state: OutreachState = outreachState(list, action ? { action: action.action, at: action.createdAt.getTime() } : null, today);
      const last = list[0];
      const lock = locks.get(key);
      return {
        ...state,
        calls: list.length,
        last: last ? { at: new Date(last.at), outcome: last.outcome, by: last.by, manual: last.manual } : null,
        lockedBy: lock && lock.userId !== me ? lock.name ?? "Someone" : null,
      };
    },
  };
}

export type RowOutreach = ReturnType<Awaited<ReturnType<typeof loadOutreach>>["stateFor"]>;

type Sortable = { outreach: RowOutreach; score: number; name: string; clinicName: string | null };
const lastCallAt = (r: Sortable) => r.outreach.last ? new Date(r.outreach.last.at).getTime() : 0;

/**
 * Count per status, keep one status, and sort it. The suggested order for "To call": call-backs that
 * are due (the patient asked for that day), then people nobody has called yet (highest priority first),
 * then retries — fewest tries first, longest since the last call first — so patients who were just
 * called move down and everyone else gets a turn. Column sorts (name, clinic, last visit…) override it.
 */
export function filterByStatus<T extends Sortable>(rows: T[], status: OutreachStatus, sort: { by: ListSort; dir: SortDir } = { by: "suggested", dir: "asc" }, lastVisitOf: (r: T) => Date | null = () => null) {
  const counts = Object.fromEntries(OUTREACH_STATUS_LIST.map((s) => [s, 0])) as Record<OutreachStatus, number>;
  for (const r of rows) counts[r.outreach.status]++;
  const kept = rows.filter((r) => r.outreach.status === status);
  if (sort.by === "suggested") {
    const rank = (r: T) => (r.outreach.label.startsWith("Call back") ? 0 : r.outreach.tries === 0 ? 1 : 2);
    if (status === "to_call") kept.sort((a, b) => rank(a) - rank(b) || a.outreach.tries - b.outreach.tries || (rank(a) === 2 ? lastCallAt(a) - lastCallAt(b) : 0) || b.score - a.score);
    else if (status === "waiting") kept.sort((a, b) => (a.outreach.next ?? "").localeCompare(b.outreach.next ?? "") || b.score - a.score);
    else kept.sort((a, b) => lastCallAt(b) - lastCallAt(a));
    return { counts, rows: kept };
  }
  // A column sort. Missing values (no visit, never called) always go last.
  const sign = sort.dir === "desc" ? -1 : 1;
  const nameOf = (r: T) => r.name.toLowerCase();
  const cmp: (a: T, b: T) => number =
    sort.by === "name" ? (a, b) => sign * nameOf(a).localeCompare(nameOf(b))
    : sort.by === "priority" ? (a, b) => sign * (b.score - a.score)
    : sort.by === "clinic" ? (a, b) => sign * (a.clinicName ?? "~").localeCompare(b.clinicName ?? "~")
    : sort.by === "lastVisit" ? (a, b) => {
        const x = lastVisitOf(a)?.getTime() ?? null, y = lastVisitOf(b)?.getTime() ?? null;
        return x === null ? (y === null ? 0 : 1) : y === null ? -1 : sign * (x - y);
      }
    : (a, b) => {
        const x = lastCallAt(a) || null, y = lastCallAt(b) || null;
        return x === null ? (y === null ? 0 : 1) : y === null ? -1 : sign * (x - y);
      };
  kept.sort((a, b) => cmp(a, b) || b.score - a.score || nameOf(a).localeCompare(nameOf(b)));
  return { counts, rows: kept };
}

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

/** Hold a patient for me while I call them (15 minutes). Someone else holding them: say who. */
export async function claim(actor: WorkspaceActor, subjectKey: string) {
  const d = await db();
  const now = new Date();
  const [cur] = await d.select({ userId: outreachLocks.userId, until: outreachLocks.lockedUntil, name: users.name }).from(outreachLocks)
    .innerJoin(users, eq(users.id, outreachLocks.userId)).where(eq(outreachLocks.subjectKey, subjectKey)).limit(1);
  if (cur && cur.userId !== actor.id && cur.until > now) return { ok: false as const, by: cur.name ?? "Someone" };
  const until = new Date(now.getTime() + LOCK_MINUTES * 60_000);
  await d.insert(outreachLocks).values({ subjectKey, userId: actor.id, lockedUntil: until }).onDuplicateKeyUpdate({ set: { userId: actor.id, lockedUntil: until } });
  return { ok: true as const, until };
}

export async function release(actor: WorkspaceActor, subjectKey: string) {
  await (await db()).delete(outreachLocks).where(and(eq(outreachLocks.subjectKey, subjectKey), eq(outreachLocks.userId, actor.id)));
  return { ok: true };
}

/** Closing outcomes take the patient off the list they were called from. */
async function closeOnList(actor: WorkspaceActor, call: { patientId: number | null; subjectKey: string; source: string | null }, outcome: CallOutcome) {
  if (!CLOSING_OUTCOMES.includes(outcome)) return false;
  const category = call.source && listCategories.has(call.source) ? call.source : FILL_SOURCE;
  await (await db()).insert(opportunityActions).values({
    patientId: call.patientId, subjectKey: call.subjectKey, category, action: outcome === "booked" ? "reviewed" : "dismissed", userId: actor.id,
  });
  return true;
}

/**
 * The result of a call to a patient. Goes on the call just made through the RingCentral phone (or a
 * given call, e.g. a desk-phone call from the RingCentral log); otherwise it's logged as a call made by hand.
 */
export async function recordCall(actor: WorkspaceActor, input: {
  subjectKey: string; category?: string | null; outcome: CallOutcome; note?: string | null; callBackOn?: string | null; callId?: number | null;
}) {
  const d = await db();
  const category = input.category && listCategories.has(input.category) ? input.category : null;
  const callBackOn = input.outcome === "call_back" && input.callBackOn && isValidDateStr(input.callBackOn) ? input.callBackOn : null;
  const note = input.note?.trim().slice(0, 1000) || null;
  let call: typeof phoneCalls.$inferSelect | undefined;
  if (input.callId) {
    [call] = await d.select().from(phoneCalls).where(eq(phoneCalls.id, input.callId)).limit(1);
    if (!call || call.subjectKey !== input.subjectKey || (call.userId && call.userId !== actor.id && actor.role !== "admin")) throw new WorkspaceError("Call not found.", "NOT_FOUND");
  } else {
    [call] = await d.select().from(phoneCalls).where(and(
      eq(phoneCalls.subjectKey, input.subjectKey), eq(phoneCalls.direction, "outbound"), isNull(phoneCalls.outcome),
      or(eq(phoneCalls.userId, actor.id), isNull(phoneCalls.userId)), gte(phoneCalls.startedAt, new Date(Date.now() - 30 * 60_000)),
    )).orderBy(desc(phoneCalls.startedAt)).limit(1);
  }
  let callId: number;
  if (call) {
    await d.update(phoneCalls).set({ outcome: input.outcome, callBackOn, note: note ?? call.note, userId: call.userId ?? actor.id, ...(category && !call.source ? { source: category } : {}) }).where(eq(phoneCalls.id, call.id));
    callId = call.id;
  } else {
    // Made outside MyPCP's phone (a cell phone, another line): log it by hand.
    const { directoryEntry } = await import("./directoryDb");
    const who = await directoryEntry(input.subjectKey);
    if (!who) throw new WorkspaceError("That patient wasn't found.");
    const res = await d.insert(phoneCalls).values({
      userId: actor.id, direction: "outbound", phoneNumber: normalizePhone(who.phone) ?? "", patientId: who.patientId, subjectKey: input.subjectKey, contactName: who.name,
      startedAt: new Date(), durationSec: 0, result: "Logged by hand", outcome: input.outcome, callBackOn, note, source: category,
    });
    callId = Number((res as unknown as [{ insertId: number }])[0]?.insertId);
  }
  const closed = await closeOnList(actor, { patientId: call?.patientId ?? (input.subjectKey.startsWith("p:") ? Number(input.subjectKey.slice(2)) : null), subjectKey: input.subjectKey, source: category ?? call?.source ?? null }, input.outcome);
  await release(actor, input.subjectKey);
  await audit(actor, "opportunity_action", { entityType: "call", entityId: callId, description: `Call result: ${input.outcome}${category ? ` (${category})` : ""}` });
  return { callId, closed, logged: !call };
}

/** A patient's calls (both directions, last 90 days), for the calling screen. */
export async function callHistory(subjectKey: string) {
  const d = await db();
  return d.select({
    id: phoneCalls.id, direction: phoneCalls.direction, at: phoneCalls.startedAt, durationSec: phoneCalls.durationSec, outcome: phoneCalls.outcome,
    callBackOn: phoneCalls.callBackOn, note: phoneCalls.note, result: phoneCalls.result, by: users.name, ext: phoneCalls.rcExtensionName,
  }).from(phoneCalls).leftJoin(users, eq(users.id, phoneCalls.userId))
    .where(and(eq(phoneCalls.subjectKey, subjectKey), gte(phoneCalls.startedAt, new Date(Date.now() - 90 * 86_400_000))))
    .orderBy(desc(phoneCalls.startedAt)).limit(30);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const REACHED = new Set(["booked", "call_back", "declined"]);
const listLabel = (source: string | null) =>
  source && (OPPORTUNITY_CATEGORY_LIST as string[]).includes(source) ? OPPORTUNITY_INFO[source as OpportunityCategory].label
    : source === FILL_SOURCE ? "Fill a schedule"
    : source === "ringcentral" ? "Desk phone (RingCentral log)"
    : source === "patient" ? "Patient page"
    : source === "reach_out" ? "Reach Out"
    : "Other";

/**
 * Calls, people reached, booked, and booked visits that showed up on the imported schedule — by caller and
 * by list. Admins see everyone; office managers their office's staff; everyone else their own calls.
 */
export async function callResults(actor: WorkspaceActor, input: { days: number }) {
  const d = await db();
  const since = new Date(Date.now() - input.days * 86_400_000);
  let who: number[] | null = null;
  if (actor.role === "office_manager") {
    who = (await d.select({ id: staffProfiles.userId }).from(staffProfiles).where(inArray(staffProfiles.homeClinicId, actor.clinicIds?.length ? actor.clinicIds : [0]))).map((r) => r.id);
    who.push(actor.id);
  } else if (actor.role !== "admin") who = [actor.id];
  const rows = await d.select({
    id: phoneCalls.id, userId: phoneCalls.userId, by: users.name, ext: phoneCalls.rcExtensionName, subjectKey: phoneCalls.subjectKey, patientId: phoneCalls.patientId,
    at: phoneCalls.startedAt, outcome: phoneCalls.outcome, source: phoneCalls.source,
  }).from(phoneCalls).leftJoin(users, eq(users.id, phoneCalls.userId))
    .where(and(eq(phoneCalls.direction, "outbound"), isNotNull(phoneCalls.subjectKey), gte(phoneCalls.startedAt, since), ...(who ? [inArray(phoneCalls.userId, who.length ? who : [0])] : [])));

  // Booked calls whose visit appears on the imported schedule afterwards (not cancelled).
  const booked = rows.filter((r) => r.outcome === "booked");
  const onSchedule = new Set<number>();
  if (booked.length) {
    const first = new Date(Math.min(...booked.map((b) => b.at.getTime())));
    const appts = await d.select({ patientId: appointments.patientId, patientName: appointments.patientName, dob: appointments.dateOfBirth, date: appointments.date, createdAt: appointments.createdAt, status: appointments.status })
      .from(appointments).where(and(gte(appointments.date, localDateStr(first)), gte(appointments.createdAt, new Date(first.getTime() - 3_600_000))));
    const byKey = new Map<string, { date: string; createdAt: Date; status: string }[]>();
    for (const a of appts) {
      if (a.status === "cancelled") continue;
      const k = subjectKeyFor(a.patientId, a.patientName, a.dob);
      byKey.set(k, [...(byKey.get(k) ?? []), { date: a.date, createdAt: a.createdAt, status: a.status }]);
    }
    for (const b of booked) {
      const day = localDateStr(b.at);
      if ((byKey.get(b.subjectKey!) ?? []).some((a) => a.date >= day && a.createdAt.getTime() >= b.at.getTime() - 3_600_000)) onSchedule.add(b.id);
    }
  }

  type Totals = { key: string; label: string; calls: number; patients: Set<string>; reached: number; booked: number; onSchedule: number; notRecorded: number };
  const add = (m: Map<string, Totals>, key: string, label: string, r: (typeof rows)[number]) => {
    const t = m.get(key) ?? { key, label, calls: 0, patients: new Set<string>(), reached: 0, booked: 0, onSchedule: 0, notRecorded: 0 };
    t.calls++;
    t.patients.add(r.subjectKey!);
    if (r.outcome && REACHED.has(r.outcome)) t.reached++;
    if (r.outcome === "booked") t.booked++;
    if (onSchedule.has(r.id)) t.onSchedule++;
    if (!r.outcome) t.notRecorded++;
    m.set(key, t);
  };
  const byCaller = new Map<string, Totals>();
  const byList = new Map<string, Totals>();
  const all = new Map<string, Totals>();
  for (const r of rows) {
    add(byCaller, r.userId ? `u${r.userId}` : `x${r.ext ?? "?"}`, r.by ?? r.ext ?? "Unknown extension", r);
    add(byList, r.source ?? "other", listLabel(r.source), r);
    add(all, "all", "Everyone", r);
  }
  const out = (m: Map<string, Totals>) => Array.from(m.values()).map((t) => ({ ...t, patients: t.patients.size })).sort((a, b) => b.booked - a.booked || b.calls - a.calls);
  return { days: input.days, onlyMine: who !== null && actor.role !== "office_manager", byCaller: out(byCaller), byList: out(byList), total: out(all)[0] ?? null };
}

/** Clinic phone numbers, for the voicemail script. */
export async function clinicPhones() {
  return (await (await db()).select({ id: clinics.id, name: clinics.name, phone: clinics.phone }).from(clinics));
}


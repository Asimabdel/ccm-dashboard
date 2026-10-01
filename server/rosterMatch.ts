// Link CCM-roster patients to their Practice Fusion records when the import couldn't tell they're the
// same person (no date of birth on the roster, a middle name, a double surname, a shifted birthday).
// Unlinked, the same person shows twice: the roster record (enrolled) and a Practice Fusion-only copy
// that looks "not enrolled" to Program approvals.
//
// Confident matches link automatically (the practice chose, 2026-10-01, to also link roster records
// that hold only a name when exactly one Practice Fusion patient has that name and it's unique on the
// roster too). Close names (nickname / initial) and reversed names wait on the Record matching page for
// an admin. Linking moves the Practice Fusion copy's chart, visits and other records onto the roster
// record, and fills a missing roster date of birth (and phone) from Practice Fusion.
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, clinics, fhirPatients, patients, users } from "../drizzle/schema";
import { isEmptyQuery, parseDirectoryQuery } from "../shared/directory";
import { nameKey } from "../shared/workspace";
import { normalizePhone } from "../shared/phone";
import { addDays } from "../shared/workforce";
import { clearDirectoryCache, loadDirectory } from "./directoryDb";
import { moveToRosterKey } from "./programsDb";
import { WorkspaceError, audit, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const ymd = (dt: Date | null | undefined) => (dt ? dt.toISOString().slice(0, 10) : null);
const tok = (name: string | null | undefined) => {
  const w = nameKey(name ?? "").split(" ").filter(Boolean);
  return { first: w[0] ?? "", last: w[w.length - 1] ?? "", words: w };
};
/** "Abdul" vs "Abdulrahman", or an initial: same start (3+ letters), or one is the other's initial. */
export const firstClose = (a: string, b: string) => !!a && !!b && a !== b && ((a.length >= 3 && b.startsWith(a)) || (b.length >= 3 && a.startsWith(b)) || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b)));

export type Bucket =
  | "linked_dob_name" | "linked_dob_first_variant" | "linked_dob_double_surname" | "linked_dob_phone" | "linked_dob_off_by_one"
  | "linked_no_dob_name_phone" | "linked_no_dob_name_only"
  | "review_close_name" | "review_reversed_name" | "review_duplicate_roster_name" | "review_dob_differs_same_name"
  | "ambiguous" | "no_match_no_dob" | "no_match";
export const AUTO_LINK: Bucket[] = ["linked_dob_name", "linked_dob_first_variant", "linked_dob_double_surname", "linked_dob_phone", "linked_dob_off_by_one", "linked_no_dob_name_phone", "linked_no_dob_name_only"];
const REVIEW: Bucket[] = ["review_close_name", "review_reversed_name", "review_duplicate_roster_name"];
export const REVIEW_LABELS: Partial<Record<Bucket, string>> = {
  review_close_name: "Same last name; first name is a nickname or initial",
  review_reversed_name: "First and last name swapped",
  review_duplicate_roster_name: "Same name, but this name is on the CCM roster more than once: link the right record",
};

interface Pf { fhirId: string; key: string; name: string; dob: string | null; phone: string | null; t: ReturnType<typeof tok> }
type RosterRow = { id: number; name: string; dob: Date | null; phone: string; ccm: string | null; clinicId: number | null; staffId: number | null; lastCcm: Date | null };

const NOT_SAME_KEY = "roster_pf_not_same";
async function notSamePairs(): Promise<Set<string>> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, NOT_SAME_KEY)).limit(1);
  const pairs = (row?.value as { pairs?: unknown } | undefined)?.pairs;
  return new Set(Array.isArray(pairs) ? pairs.map(String) : []);
}

/** Everyone unlinked on the roster, the free Practice Fusion records, and how each roster patient matches. */
async function loadMatching() {
  const d = await db();
  const roster = (await d.select({ id: patients.id, name: patients.name, dob: patients.dateOfBirth, phone: patients.phoneNumber, ccm: patients.ccmEnrollmentStatus, clinicId: patients.clinicId, staffId: patients.assignedStaffId, lastCcm: patients.lastCCMDate }).from(patients)) as RosterRow[];
  const pfRows = await d.select({ fhirId: fhirPatients.fhirId, key: fhirPatients.subjectKey, patientId: fhirPatients.patientId, name: fhirPatients.name, dob: fhirPatients.dob, phone: fhirPatients.phone }).from(fhirPatients);
  const linkedRoster = new Set<number>();
  for (const p of pfRows) {
    if (p.patientId) linkedRoster.add(p.patientId);
    const m = /^p:(\d+)$/.exec(p.key);
    if (m) linkedRoster.add(Number(m[1]));
  }
  // Practice Fusion records not yet on any roster record: the candidates.
  const free: Pf[] = pfRows.filter((p) => !/^p:\d+$/.test(p.key) && p.name).map((p) => ({ fhirId: p.fhirId, key: p.key, name: p.name!, dob: p.dob, phone: normalizePhone(p.phone), t: tok(p.name) }));
  const byDob = new Map<string, Pf[]>();
  const byName = new Map<string, Pf[]>();
  const byLast = new Map<string, Pf[]>();
  const push = (m: Map<string, Pf[]>, k: string, p: Pf) => { const l = m.get(k); if (l) l.push(p); else m.set(k, [p]); };
  for (const p of free) {
    if (p.dob) push(byDob, p.dob, p);
    push(byName, `${p.t.first}|${p.t.last}`, p);
    push(byLast, p.t.last, p);
  }
  // A roster name that appears more than once (duplicate records) is never linked by name alone.
  const rosterNameCount = new Map<string, number>();
  for (const r of roster) { const t = tok(r.name); rosterNameCount.set(`${t.first}|${t.last}`, (rosterNameCount.get(`${t.first}|${t.last}`) ?? 0) + 1); }
  const notSame = await notSamePairs();

  const one = (list: Pf[]) => (list.length === 1 ? list[0]! : null);
  const decide = (r: RosterRow): { bucket: Bucket; pf: Pf | null } => {
    const t = tok(r.name);
    const dob = ymd(r.dob);
    const phone = normalizePhone(r.phone);
    const ok = (c: Pf) => !notSame.has(`${r.id}|${c.fhirId}`);
    const sameName = (c: Pf) => c.t.first === t.first && c.t.last === t.last && ok(c);
    if (dob) {
      const cands = (byDob.get(dob) ?? []).filter(ok);
      const exact = cands.filter(sameName);
      if (exact.length === 1) return { bucket: "linked_dob_name", pf: exact[0]! };
      if (exact.length > 1) return { bucket: "ambiguous", pf: null };
      const variant = one(cands.filter((c) => c.t.last === t.last && firstClose(c.t.first, t.first)));
      if (variant) return { bucket: "linked_dob_first_variant", pf: variant };
      const surname = one(cands.filter((c) => c.t.first === t.first && (c.t.words.includes(t.last) || t.words.includes(c.t.last))));
      if (surname) return { bucket: "linked_dob_double_surname", pf: surname };
      const byPhone = one(cands.filter((c) => phone && c.phone === phone && (c.t.last === t.last || c.t.first === t.first)));
      if (byPhone) return { bucket: "linked_dob_phone", pf: byPhone };
      // A date of birth shifted by a day (time-zone) with exactly the same name.
      const shifted = one([...(byDob.get(addDays(dob, -1)) ?? []), ...(byDob.get(addDays(dob, 1)) ?? [])].filter(sameName));
      if (shifted) return { bucket: "linked_dob_off_by_one", pf: shifted };
      const named = (byName.get(`${t.first}|${t.last}`) ?? []).filter(ok);
      if (named.length) return { bucket: "review_dob_differs_same_name", pf: named.length === 1 ? named[0]! : null };
      return { bucket: "no_match", pf: null };
    }
    const named = (byName.get(`${t.first}|${t.last}`) ?? []).filter(ok);
    if (named.length === 1 && (rosterNameCount.get(`${t.first}|${t.last}`) ?? 0) === 1) {
      if (phone && named[0]!.phone === phone) return { bucket: "linked_no_dob_name_phone", pf: named[0]! };
      return { bucket: "linked_no_dob_name_only", pf: named[0]! };
    }
    if (named.length === 1) return { bucket: "review_duplicate_roster_name", pf: named[0]! };
    if (named.length > 1) return { bucket: "ambiguous", pf: null };
    const swapped = one((byName.get(`${t.last}|${t.first}`) ?? []).filter(ok));
    if (swapped) return { bucket: "review_reversed_name", pf: swapped };
    const close = one((byLast.get(t.last) ?? []).filter((c) => ok(c) && firstClose(c.t.first, t.first)));
    if (close) return { bucket: "review_close_name", pf: close };
    return { bucket: "no_match_no_dob", pf: null };
  };
  /** Several Practice Fusion records fit equally well (same name, and the same birthday when there is one). */
  const candidates = (r: RosterRow): Pf[] => {
    const t = tok(r.name);
    const dob = ymd(r.dob);
    const same = (c: Pf) => c.t.first === t.first && c.t.last === t.last && !notSame.has(`${r.id}|${c.fhirId}`);
    return dob ? (byDob.get(dob) ?? []).filter(same) : (byName.get(`${t.first}|${t.last}`) ?? []).filter(same);
  };
  const unlinked = roster.filter((r) => !linkedRoster.has(r.id));
  return { roster, pfRows, linkedRoster, unlinked, decide, candidates, free };
}

/** Link one roster patient to one Practice Fusion record (fills a missing / day-shifted birthday and a missing phone). */
async function link(rosterId: number, pf: { fhirId: string; key: string; dob: string | null; phone: string | null }, opts: { fixDob: boolean }) {
  const d = await db();
  const [r] = await d.select({ dob: patients.dateOfBirth, phone: patients.phoneNumber }).from(patients).where(eq(patients.id, rosterId)).limit(1);
  if (!r) throw new WorkspaceError("Roster patient not found.", "NOT_FOUND");
  const patch: Record<string, unknown> = {};
  if (pf.dob && (!r.dob || opts.fixDob)) patch.dateOfBirth = new Date(`${pf.dob}T00:00:00Z`);
  if (pf.phone && !normalizePhone(r.phone)) patch.phoneNumber = pf.phone.slice(0, 20);
  if (Object.keys(patch).length) await d.update(patients).set(patch).where(eq(patients.id, rosterId));
  await d.update(fhirPatients).set({ subjectKey: `p:${rosterId}`, patientId: rosterId }).where(eq(fhirPatients.fhirId, pf.fhirId));
  const dir = await loadDirectory();
  await moveToRosterKey(pf.key, rosterId, dir.get(pf.key));
}

/**
 * Match every roster patient that has no Practice Fusion record linked. apply=false only reports.
 * `name` (optional) also reports, for roster patients whose name contains those words, which bucket
 * they fall in (no names or dates come back).
 */
export async function matchRosterToPf(opts: { apply: boolean; name?: string | null; deadline: number }) {
  const { roster, pfRows, linkedRoster, unlinked, decide } = await loadMatching();
  const counts: Record<string, number> = {};
  const ccmActiveCounts: Record<string, number> = {};
  const plan: { rosterId: number; pf: Pf; bucket: Bucket }[] = [];
  const claimed = new Set<string>();
  for (const r of unlinked) {
    const { bucket, pf } = decide(r);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    if (r.ccm === "active") ccmActiveCounts[bucket] = (ccmActiveCounts[bucket] ?? 0) + 1;
    // One Practice Fusion record goes to one roster record only.
    if (pf && AUTO_LINK.includes(bucket) && !claimed.has(pf.fhirId)) { claimed.add(pf.fhirId); plan.push({ rosterId: r.id, pf, bucket }); }
  }
  let lookup: { rosterMatches: number; results: { alreadyLinked: boolean; ccm: string | null; hasDob: boolean; bucket: string | null; pfRecordsWithSameName: number }[] } | null = null;
  if (opts.name) {
    const words = nameKey(opts.name).split(" ").filter(Boolean);
    const hits = roster.filter((r) => words.every((w) => nameKey(r.name).includes(w)));
    lookup = {
      rosterMatches: hits.length,
      results: hits.map((r) => {
        const t = tok(r.name);
        return {
          alreadyLinked: linkedRoster.has(r.id), ccm: r.ccm, hasDob: !!r.dob, bucket: linkedRoster.has(r.id) ? null : decide(r).bucket,
          pfRecordsWithSameName: pfRows.filter((p) => { const pt = tok(p.name); return pt.first === t.first && pt.last === t.last; }).length,
        };
      }),
    };
  }
  let linked = 0;
  let done = true;
  if (opts.apply) {
    for (const m of plan) {
      if (Date.now() > opts.deadline) { done = false; break; }
      await link(m.rosterId, m.pf, { fixDob: m.bucket === "linked_dob_off_by_one" });
      linked++;
    }
    clearDirectoryCache();
  }
  return {
    roster: roster.length, alreadyLinked: roster.length - unlinked.length, unlinked: unlinked.length,
    byBucket: counts, ccmActiveUnlinkedByBucket: ccmActiveCounts, toLink: plan.length,
    linked: opts.apply ? linked : null, done: opts.apply ? done : null, lookup,
  };
}

// ---------------------------------------------------------------------------
// Record matching page (admins): the pairs that need a person to confirm
// ---------------------------------------------------------------------------

/**
 * The Record matching page: pairs to confirm, roster patients with several equally good Practice Fusion
 * records (pick one), and roster patients with no Practice Fusion match at all (search by hand).
 */
export async function matchingOverview() {
  const { unlinked, decide, candidates } = await loadMatching();
  const d = await db();
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));
  const staffName = new Map((await d.select({ id: users.id, name: users.name }).from(users)).map((u) => [u.id, u.name]));
  const dir = await loadDirectory();
  const pfInfo = (pf: Pf) => {
    const e = dir.get(pf.key);
    return {
      pfId: pf.fhirId, pfName: pf.name, pfDob: pf.dob, pfPhoneLast4: pf.phone ? pf.phone.slice(-4) : null,
      pfClinic: e?.clinicId ? clinicName.get(e.clinicId) ?? null : null, pfProvider: e?.providerName ?? null, pfLastVisit: e?.lastVisit ?? null,
    };
  };
  const rosterInfo = (r: RosterRow) => ({
    rosterId: r.id, rosterName: r.name, rosterDob: ymd(r.dob), rosterCcm: r.ccm, rosterClinic: r.clinicId ? clinicName.get(r.clinicId) ?? null : null,
    rosterCoordinator: r.staffId ? staffName.get(r.staffId) ?? null : null, rosterLastCcm: ymd(r.lastCcm),
  });
  const confirm = [], several = [], none = [];
  for (const r of unlinked) {
    const { bucket, pf } = decide(r);
    if (pf && REVIEW.includes(bucket)) confirm.push({ ...rosterInfo(r), ...pfInfo(pf), reason: REVIEW_LABELS[bucket] ?? bucket });
    else if (bucket === "ambiguous") several.push({ ...rosterInfo(r), candidates: candidates(r).map(pfInfo) });
    else if (bucket === "no_match" || bucket === "no_match_no_dob") none.push(rosterInfo(r));
  }
  const byName = <T extends { rosterName: string }>(a: T, b: T) => a.rosterName.localeCompare(b.rosterName);
  return { confirm: confirm.sort(byName), several: several.sort(byName), none: none.sort(byName) };
}

/** Search the Practice Fusion records not linked to any roster patient (name in any order, birthday, phone). */
export async function searchUnlinkedPf(q: string) {
  const query = parseDirectoryQuery(q);
  if (isEmptyQuery(query)) return [];
  const { free } = await loadMatching();
  const dir = await loadDirectory();
  const d = await db();
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));
  return free
    .filter((p) => (!query.dob || p.dob === query.dob) && (!query.digits || (p.phone ?? "").includes(query.digits)) && query.words.every((w) => p.t.words.some((x) => x.startsWith(w))))
    .slice(0, 15)
    .map((p) => {
      const e = dir.get(p.key);
      return { pfId: p.fhirId, pfName: p.name, pfDob: p.dob, pfPhoneLast4: p.phone ? p.phone.slice(-4) : null, pfClinic: e?.clinicId ? clinicName.get(e.clinicId) ?? null : null, pfProvider: e?.providerName ?? null, pfLastVisit: e?.lastVisit ?? null };
    });
}

/** An admin confirms a pair: link it (only if both are still unlinked). */
export async function confirmPair(actor: WorkspaceActor, rosterId: number, pfId: string) {
  const d = await db();
  const [pf] = await d.select({ fhirId: fhirPatients.fhirId, key: fhirPatients.subjectKey, dob: fhirPatients.dob, phone: fhirPatients.phone }).from(fhirPatients).where(eq(fhirPatients.fhirId, pfId)).limit(1);
  if (!pf) throw new WorkspaceError("That Practice Fusion record wasn't found.", "NOT_FOUND");
  if (/^p:\d+$/.test(pf.key)) throw new WorkspaceError("That Practice Fusion record is already linked to a roster patient.");
  const { linkedRoster } = await loadMatching();
  if (linkedRoster.has(rosterId)) throw new WorkspaceError("That roster patient is already linked.");
  await link(rosterId, { fhirId: pf.fhirId, key: pf.key, dob: pf.dob, phone: normalizePhone(pf.phone) }, { fixDob: false });
  clearDirectoryCache();
  await audit(actor, "update_patient", { entityType: "patient", entityId: rosterId, description: "Linked to their Practice Fusion record (confirmed on Record matching)" });
  return { ok: true };
}

/** An admin says they're different people: the pair is never suggested again. */
export async function rejectPair(actor: WorkspaceActor, rosterId: number, pfId: string) {
  const d = await db();
  const pairs = Array.from(await notSamePairs());
  pairs.push(`${rosterId}|${pfId}`);
  const value = { pairs: Array.from(new Set(pairs)) };
  await d.insert(appSettings).values({ key: NOT_SAME_KEY, value, updatedByUserId: actor.id }).onDuplicateKeyUpdate({ set: { value, updatedByUserId: actor.id } });
  await audit(actor, "update_patient", { entityType: "patient", entityId: rosterId, description: "Marked not the same person as a Practice Fusion record (Record matching)" });
  return { ok: true };
}

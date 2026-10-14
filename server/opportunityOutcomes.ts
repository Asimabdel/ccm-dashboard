// IAM-only check (2026-10-14): did patients on the Opportunity Finder's scheduling lists get scheduled — whether or
// not the caller logged it? Rebuilds who was on each list on a past date (the same rules, using only appointments
// that had been imported by then), then looks at what's on the schedule now: a new appointment added since (not
// cancelled), whether they came in, and whether anyone called them first (any call MyPCP has for that patient,
// including desk-phone calls matched by number). Counts only: list names and numbers, no patients.
import { and, gte, isNotNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appointments, patients, phoneCalls } from "../drizzle/schema";
import { subjectKeyFor } from "./workspaceDb";
import { OPPORTUNITY_INFO, SEEN_STATUSES, evaluateOpportunities, evaluateScheduleOpportunities, type OpportunityCategory, type ScheduleVisit } from "../shared/workspace";

/** The lists that are about getting the patient on the schedule (not program enrollment). */
const SCHEDULING: OpportunityCategory[] = ["missed_appointment", "cancelled_not_rebooked", "new_patient_no_return", "lapsed_follow_up", "overdue_follow_up", "diabetes_follow_up", "hypertension_follow_up"];

type Appt = { startsAt: Date; status: string; visitType: string | null; createdAt: Date };

export async function opportunityOutcomes(input: { asOf: string }) {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  // The list as it stood at the end of that day (clinic time ≈ UTC−5).
  const asOf = new Date(`${input.asOf}T23:59:00-05:00`);
  const [appts, roster, calls] = await Promise.all([
    d.select({ patientId: appointments.patientId, name: appointments.patientName, dob: appointments.dateOfBirth, startsAt: appointments.startsAt, status: appointments.status, visitType: appointments.visitType, createdAt: appointments.createdAt }).from(appointments),
    d.select({ id: patients.id, chronicConditions: patients.chronicConditions, bhiConditions: patients.bhiConditions, ccmEnrollmentStatus: patients.ccmEnrollmentStatus, bhiEnrollmentStatus: patients.bhiEnrollmentStatus, rpmStatus: patients.rpmStatus, rpmEnrolled: patients.rpmEnrolled, lastOfficeVisit: patients.lastOfficeVisit })
      .from(patients).where(sql`${patients.name} NOT LIKE '%(merged into #%'`),
    d.select({ subjectKey: phoneCalls.subjectKey, patientId: phoneCalls.patientId, at: phoneCalls.startedAt, outcome: phoneCalls.outcome, direction: phoneCalls.direction, source: phoneCalls.source })
      .from(phoneCalls).where(and(isNotNull(phoneCalls.subjectKey), gte(phoneCalls.startedAt, new Date(asOf.getTime() - 86_400_000)))),
  ]);

  const byKey = new Map<string, Appt[]>();
  for (const a of appts) {
    const k = subjectKeyFor(a.patientId, a.name, a.dob);
    byKey.set(k, [...(byKey.get(k) ?? []), { startsAt: a.startsAt, status: a.status, visitType: a.visitType, createdAt: a.createdAt }]);
  }
  /** The visits as they stood then: past ones as they turned out; future ones only if already imported (and not cancelled). */
  const visitsThen = (list: Appt[]): ScheduleVisit[] => list
    .filter((v) => v.startsAt <= asOf || (v.createdAt <= asOf && v.status !== "cancelled"))
    .map((v) => ({ startsAt: v.startsAt, status: v.startsAt > asOf ? "scheduled" : v.status, visitType: v.visitType }));

  // Who was on which scheduling list that day.
  const onList = new Map<string, OpportunityCategory[]>();
  const rosterIds = new Set<number>();
  for (const p of roster) {
    const key = `p:${p.id}`;
    rosterIds.add(p.id);
    const visits = visitsThen(byKey.get(key) ?? []);
    let lastSeen: Date | null = null, nextBooked: Date | null = null;
    for (const v of visits) {
      if (v.startsAt <= asOf && SEEN_STATUSES.includes(v.status) && (!lastSeen || v.startsAt > lastSeen)) lastSeen = v.startsAt;
      if (v.startsAt > asOf && (!nextBooked || v.startsAt < nextBooked)) nextBooked = v.startsAt;
    }
    // The roster's last visit only counts if it was before that day (a later one wasn't known yet).
    const rosterLast = p.lastOfficeVisit && p.lastOfficeVisit <= asOf ? p.lastOfficeVisit : null;
    const lastVisit = lastSeen && (!rosterLast || lastSeen > rosterLast) ? lastSeen : rosterLast;
    const cats = [
      ...evaluateScheduleOpportunities(visits, asOf),
      ...evaluateOpportunities({ chronicConditions: p.chronicConditions ?? [], bhiConditions: p.bhiConditions ?? [], ccmEnrollmentStatus: p.ccmEnrollmentStatus, bhiEnrollmentStatus: p.bhiEnrollmentStatus, rpmStatus: p.rpmStatus, rpmEnrolled: p.rpmEnrolled, lastOfficeVisit: lastVisit, nextVisit: nextBooked }, asOf),
    ].map((m) => m.category).filter((c) => SCHEDULING.includes(c));
    if (cats.length) onList.set(key, Array.from(new Set(cats)));
  }
  for (const [key, list] of Array.from(byKey.entries())) {
    if (key.startsWith("p:")) continue;
    const cats = evaluateScheduleOpportunities(visitsThen(list), asOf).map((m) => m.category).filter((c) => SCHEDULING.includes(c));
    if (cats.length) onList.set(key, Array.from(new Set(cats)));
  }

  // What happened since: a new appointment added after that day (not cancelled), and did they come in?
  const callsBy = new Map<string, { at: Date; outcome: string | null; fromList: boolean }[]>();
  const listSources = new Set<string>([...SCHEDULING, "schedule_fill", "testing_due", ...Object.keys(OPPORTUNITY_INFO)]);
  for (const c of calls) {
    const k = c.subjectKey ?? (c.patientId ? `p:${c.patientId}` : null);
    if (!k) continue;
    callsBy.set(k, [...(callsBy.get(k) ?? []), { at: c.at, outcome: c.outcome, fromList: !!c.source && listSources.has(c.source) }]);
  }
  const now = new Date();
  type Tally = { onList: number; scheduled: number; cameIn: number; upcoming: number; called: number; calledScheduled: number; notCalled: number; notCalledScheduled: number; scheduledAfterCall: number; loggedBooked: number };
  const blank = (): Tally => ({ onList: 0, scheduled: 0, cameIn: 0, upcoming: 0, called: 0, calledScheduled: 0, notCalled: 0, notCalledScheduled: 0, scheduledAfterCall: 0, loggedBooked: 0 });
  const total = blank();
  const byList = new Map<OpportunityCategory, Tally>();
  const bump = (t: Tally, x: { scheduled: boolean; cameIn: boolean; upcoming: boolean; called: boolean; afterCall: boolean; logged: boolean }) => {
    t.onList++;
    if (x.scheduled) t.scheduled++;
    if (x.cameIn) t.cameIn++;
    if (x.upcoming) t.upcoming++;
    if (x.called) { t.called++; if (x.scheduled) t.calledScheduled++; } else { t.notCalled++; if (x.scheduled) t.notCalledScheduled++; }
    if (x.afterCall) t.scheduledAfterCall++;
    if (x.logged) t.loggedBooked++;
  };
  for (const [key, cats] of Array.from(onList.entries())) {
    const newVisits = (byKey.get(key) ?? []).filter((v) => v.createdAt > asOf && v.startsAt > asOf && v.status !== "cancelled");
    const scheduled = newVisits.length > 0;
    const cameIn = newVisits.some((v) => v.startsAt <= now && SEEN_STATUSES.includes(v.status));
    const upcoming = !cameIn && newVisits.some((v) => v.startsAt > now);
    const myCalls = (callsBy.get(key) ?? []).filter((c) => c.at > new Date(asOf.getTime() - 86_400_000));
    const called = myCalls.length > 0;
    const firstNew = scheduled ? new Date(Math.min(...newVisits.map((v) => v.createdAt.getTime()))) : null;
    const afterCall = !!firstNew && myCalls.some((c) => c.at <= firstNew);
    const logged = myCalls.some((c) => c.outcome === "booked");
    const x = { scheduled, cameIn, upcoming, called, afterCall, logged };
    bump(total, x);
    for (const c of cats) { const t = byList.get(c) ?? blank(); bump(t, x); byList.set(c, t); }
  }
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    asOf: input.asOf,
    total: { ...total, scheduledRate: rate(total.scheduled, total.onList), calledRate: rate(total.calledScheduled, total.called), notCalledRate: rate(total.notCalledScheduled, total.notCalled) },
    byList: Array.from(byList.entries()).map(([c, t]) => ({ list: OPPORTUNITY_INFO[c].label, ...t, scheduledRate: rate(t.scheduled, t.onList) })).sort((a, b) => b.onList - a.onList),
  };
}

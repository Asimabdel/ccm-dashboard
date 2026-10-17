// Seen visits from the Practice Fusion chart copy (2026-10-17). Practice Fusion's API has no appointments,
// but every signed visit comes through the nightly chart sync as a FHIR Encounter. These pure helpers say
// which day and provider a visit belongs to and how a visit is matched to an imported appointment, so the
// nightly fill-in (server/pfVisitFill.ts) and the schedule import (which takes those rows over) agree.
import { nameKey } from "./workspace";

/**
 * Practice Fusion's visit type text: "2026-10-16; Dr Sudad's Schedule; Dr Sudad Al Hadad; My PCP Dr; 10/17/2026"
 * (the visit's date, the calendar, the provider, the practice, then the date it was signed).
 */
export function parseVisitTitle(title: string | null | undefined): { date: string | null; calendar: string | null; provider: string | null } {
  const parts = (title ?? "").split(";").map((s) => s.trim());
  const date = /^\d{4}-\d{2}-\d{2}$/.test(parts[0] ?? "") ? parts[0]! : null;
  return { date, calendar: date ? parts[1] || null : null, provider: date ? parts[2] || null : null };
}

const firstLast = (key: string) => {
  const w = key.split(" ").filter(Boolean);
  return w.length >= 2 ? `${w[0]} ${w[w.length - 1]}` : key;
};

/**
 * The ways one person is recognized: their CCM-roster link, name + DOB, first + last name + DOB (middle names
 * differ between systems), and, for a schedule row without a DOB, the name alone.
 */
export function personKeys(p: { patientId: number | null; names: (string | null | undefined)[]; dob: string | null }, side: "visit" | "appointment"): string[] {
  const out = new Set<string>();
  if (p.patientId) out.add(`p:${p.patientId}`);
  for (const n of p.names) {
    const k = n ? nameKey(n) : "";
    if (!k) continue;
    if (p.dob) {
      out.add(`n:${k}|${p.dob}`);
      out.add(`fl:${firstLast(k)}|${p.dob}`);
    }
    // A visit (Practice Fusion always has the DOB) may match a schedule row that has none, by name.
    if (side === "visit" || !p.dob) out.add(`nm:${k}`);
  }
  return Array.from(out);
}

export const IN_PROGRESS_STATUSES = ["arrived", "checked_in", "roomed", "with_provider", "checkout"];
const NOT_SEEN = ["no_show", "cancelled"];

export interface FillVisit { id: string; date: string; keys: string[] }
export interface FillAppointment { id: number; date: string; status: string; keys: string[] }
export interface FillPlan {
  /** Appointments to mark Seen (they were still Scheduled, or left part-way on the flow board). */
  seen: { id: number; from: string }[];
  /** Visits with no appointment that day: added to the schedule as Seen. */
  add: FillVisit[];
  alreadySeen: number;
  /** The schedule says no-show or cancelled: left as the schedule says. */
  notSeen: number;
  /** A second visit record for the same person and day. */
  duplicates: number;
}

const rank = (status: string) => (status === "completed" ? 0 : IN_PROGRESS_STATUSES.includes(status) ? 1 : status === "scheduled" ? 2 : 3);

/** Match each signed visit to that person's appointment on the same day. Each appointment is used once. */
export function planVisitFill(visits: FillVisit[], appts: FillAppointment[]): FillPlan {
  const byDay = new Map<string, FillAppointment[]>();
  for (const a of appts) (byDay.get(a.date) ?? byDay.set(a.date, []).get(a.date)!).push(a);
  const plan: FillPlan = { seen: [], add: [], alreadySeen: 0, notSeen: 0, duplicates: 0 };
  const claimed = new Set<number>();
  const added = new Set<string>();
  for (const v of visits) {
    const same = (byDay.get(v.date) ?? []).filter((a) => a.keys.some((k) => v.keys.includes(k)));
    const best = same.filter((a) => !claimed.has(a.id)).sort((a, b) => rank(a.status) - rank(b.status) || a.id - b.id)[0];
    if (!best) {
      // Their appointment that day was already matched to another visit record, or this person was just added.
      if (same.length || v.keys.some((k) => added.has(`${v.date}|${k}`))) { plan.duplicates++; continue; }
      v.keys.forEach((k) => added.add(`${v.date}|${k}`));
      plan.add.push(v);
      continue;
    }
    claimed.add(best.id);
    if (best.status === "completed") plan.alreadySeen++;
    else if (NOT_SEEN.includes(best.status)) plan.notSeen++;
    else plan.seen.push({ id: best.id, from: best.status });
  }
  return plan;
}

/**
 * Schedule import: which new rows from the file are a visit the nightly fill-in already added (same person,
 * same day). The file's row takes that appointment over, so it isn't listed twice. A no-show or cancelled row
 * in the file is a different appointment and never takes over a seen visit.
 */
export function matchImportToChartVisits(incoming: { idx: number; date: string; status: string; keys: string[] }[], chartRows: { id: number; date: string; keys: string[] }[]): Map<number, number> {
  const out = new Map<number, number>();
  const taken = new Set<number>();
  const usable = incoming.filter((r) => !NOT_SEEN.includes(r.status)).sort((a, b) => rank(a.status) - rank(b.status) || a.idx - b.idx);
  for (const r of usable) {
    const hit = chartRows.find((c) => !taken.has(c.id) && c.date === r.date && c.keys.some((k) => r.keys.includes(k)));
    if (!hit) continue;
    taken.add(hit.id);
    out.set(r.idx, hit.id);
  }
  return out;
}

/** Appointments the nightly fill-in added carry this key prefix (the schedule import's keys are plain hashes). */
export const CHART_VISIT_KEY_PREFIX = "pf:";

// The clinic's patient list (Patients tab): everyone MyPCP knows about, one row per person, from
// the CCM roster, the imported schedule and Practice Fusion. These are the rules the server and
// the page share: who counts as active or new, and how a search box entry is matched.
import { nameKey } from "./workspace";
import { addDays } from "./workforce";

/** Seen within this many years, or booked = an active patient. */
export const ACTIVE_YEARS = 3;
/** First visit within this many days (or booked but never seen) = a new patient. */
export const NEW_PATIENT_DAYS = 90;

export const DIRECTORY_STATUSES = ["active", "new", "inactive", "all"] as const;
export type DirectoryStatus = (typeof DIRECTORY_STATUSES)[number];
export const DIRECTORY_STATUS_LABELS: Record<DirectoryStatus, string> = {
  active: "Active",
  new: "New",
  inactive: "Inactive",
  all: "Everyone",
};
export const DIRECTORY_STATUS_HINTS: Record<DirectoryStatus, string> = {
  active: `Seen in the last ${ACTIVE_YEARS} years or has an appointment booked`,
  new: `First visit in the last ${NEW_PATIENT_DAYS} days, or booked and not seen yet`,
  inactive: `Not seen in ${ACTIVE_YEARS} years and nothing booked`,
  all: "Every patient MyPCP knows about",
};

export const DIRECTORY_PROGRAMS = ["ccm", "bhi", "apcm", "rpm"] as const;
export type DirectoryProgram = (typeof DIRECTORY_PROGRAMS)[number];
export const DIRECTORY_PROGRAM_LABELS: Record<DirectoryProgram, string> = { ccm: "CCM", bhi: "BHI", apcm: "APCM", rpm: "RPM" };

export const DIRECTORY_SORTS = ["name", "lastVisit", "nextVisit"] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

export const DIRECTORY_PAGE_SIZE = 50;

/** Visit dates are "YYYY-MM-DD"; the next appointment is a full timestamp (ISO). */
export interface VisitFacts {
  lastVisit: string | null;
  firstVisit: string | null;
  nextVisit: string | null;
  /** Known to be an established patient (e.g. on the CCM roster): never "new". */
  established?: boolean;
}

export function directoryStatus(f: VisitFacts, today: string): { active: boolean; isNew: boolean } {
  const booked = !!f.nextVisit;
  const active = booked || (!!f.lastVisit && f.lastVisit >= addDays(today, -365 * ACTIVE_YEARS));
  const isNew = !f.established && ((!!f.firstVisit && f.firstVisit >= addDays(today, -NEW_PATIENT_DAYS)) || (!f.lastVisit && booked));
  return { active, isNew };
}

export function inStatus(status: DirectoryStatus, s: { active: boolean; isNew: boolean }): boolean {
  if (status === "all") return true;
  if (status === "new") return s.isNew;
  return status === "active" ? s.active : !s.active;
}

/** What someone typed: name words, a date of birth, and/or digits (phone or MRN). */
export interface ParsedQuery {
  words: string[];
  dob: string | null;
  digits: string | null;
}

export function parseDirectoryQuery(raw: string): ParsedQuery {
  let q = raw.trim();
  let dob: string | null = null;
  const us = q.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b/);
  const iso = q.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    dob = `${iso[1]}-${iso[2]!.padStart(2, "0")}-${iso[3]!.padStart(2, "0")}`;
    q = q.replace(iso[0], " ");
  } else if (us) {
    const yy = us[3]!;
    // Two-digit years: a birth year, so never in the future.
    const year = yy.length === 4 ? yy : Number(yy) > Number(String(new Date().getFullYear()).slice(2)) ? `19${yy}` : `20${yy}`;
    dob = `${year}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
    q = q.replace(us[0], " ");
  }
  const digitRun = q.replace(/[\s().-]/g, "").match(/\d{4,}/);
  const digits = digitRun ? digitRun[0] : null;
  if (digits) q = q.replace(/[\d().-]+/g, " ");
  return { words: nameKey(q).split(" ").filter(Boolean), dob, digits };
}

/** Every name word must appear in the name; a date must be the date of birth; digits must be in the phone or MRN. */
export function matchesQuery(p: { nameKey: string; dob: string | null; phoneDigits: string; mrn: string | null }, q: ParsedQuery): boolean {
  if (q.dob && p.dob !== q.dob) return false;
  if (q.digits && !p.phoneDigits.includes(q.digits) && !(p.mrn ?? "").replace(/\D/g, "").includes(q.digits)) return false;
  return q.words.every((w) => p.nameKey.includes(w));
}

export const isEmptyQuery = (q: ParsedQuery) => !q.words.length && !q.dob && !q.digits;

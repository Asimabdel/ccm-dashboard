// Call-list tracking for the Opportunity Finder (the practice's choices, 2026-10-02): every call to a
// patient counts, wherever it was made (the list, the RingCentral phone, a desk phone synced from
// RingCentral, or logged by hand). No answer / voicemail: try again 2 business days later; after 3
// tries the patient is Unreachable for now. "Call back" waits for the date the patient asked for.
// A person being called is held for that caller for 15 minutes so two people don't call them.
import { addDays, weekdayIndex } from "./workforce";
import { isClinicHoliday } from "./schedulePattern";
import { CALL_OUTCOMES, type CallOutcome } from "./phone";

export const MAX_TRIES = 3;
export const RETRY_BUSINESS_DAYS = 2;
/** Calls older than this no longer count (an Unreachable patient comes back to the list after it). */
export const OUTREACH_WINDOW_DAYS = 60;
export const LOCK_MINUTES = 15;

export type OutreachStatus = "to_call" | "waiting" | "booked" | "unreachable" | "closed";
export const OUTREACH_TABS: { key: OutreachStatus; label: string; hint: string }[] = [
  { key: "to_call", label: "To call", hint: "Not called yet, a retry that's due, or a call-back due today" },
  { key: "waiting", label: "Waiting", hint: "Try again in a couple of days, or call back on the date they asked for" },
  { key: "booked", label: "Booked", hint: "Booked an appointment on the call" },
  { key: "unreachable", label: "Unreachable", hint: `No answer after ${MAX_TRIES} tries` },
  { key: "closed", label: "Closed", hint: "Declined, wrong number, reviewed, dismissed or made into a task" },
];
export const OUTREACH_STATUS_LIST = OUTREACH_TABS.map((t) => t.key);

/** Outcomes where nobody was reached (they count as a try). Unrecorded ones (null) count too. */
const NO_CONTACT = new Set<string>(["no_answer", "voicemail", "other"]);

/** Business days after a date (skips weekends and the clinic holidays). */
export function addBusinessDays(date: string, n: number): string {
  let d = date;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (weekdayIndex(d) < 5 && !isClinicHoliday(d)) left--;
  }
  return d;
}

export interface OutreachCall {
  /** When (ms) and the clinic-local day of the call (YYYY-MM-DD). */
  at: number;
  day: string;
  outcome: string | null;
  callBackOn: string | null;
}

export interface OutreachState {
  status: OutreachStatus;
  /** Tries since the patient was last reached. */
  tries: number;
  /** When to call next (YYYY-MM-DD): a retry or the call-back date. */
  next: string | null;
  /** A short line for the list: "Try #2", "Call back Oct 6", "Booked". */
  label: string;
}

const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

/**
 * Where a patient stands on a call list.
 * @param calls outbound calls in the window, newest first
 * @param action the list's own "reviewed / dismissed / task made" in the last 30 days, if any. Whichever
 *   is newer wins: a call after it puts the patient back in the call flow.
 */
export function outreachState(calls: OutreachCall[], action: { action: string; at: number } | null, today: string): OutreachState {
  const latest = calls[0];
  if (latest?.outcome === "booked") return { status: "booked", tries: 0, next: null, label: "Booked" };
  if (latest?.outcome === "declined") return { status: "closed", tries: 0, next: null, label: "Declined" };
  if (latest?.outcome === "wrong_number") return { status: "closed", tries: 0, next: null, label: "Wrong number" };
  if (action && (!latest || action.at >= latest.at)) {
    return { status: "closed", tries: 0, next: null, label: action.action === "task_created" ? "Task made" : action.action === "dismissed" ? "Dismissed" : "Reviewed" };
  }
  if (latest?.outcome === "call_back") {
    const on = latest.callBackOn ?? addBusinessDays(latest.day, 1);
    return on > today ? { status: "waiting", tries: 0, next: on, label: `Call back ${shortDay(on)}` } : { status: "to_call", tries: 0, next: on, label: on === today ? "Call back today" : `Call back (was due ${shortDay(on)})` };
  }
  // Tries since they were last reached: one per day with no contact.
  const days = new Set<string>();
  for (const c of calls) {
    if (c.outcome && !NO_CONTACT.has(c.outcome)) break;
    days.add(c.day);
  }
  const tries = days.size;
  if (!tries) return { status: "to_call", tries: 0, next: null, label: "Not called yet" };
  if (tries >= MAX_TRIES) return { status: "unreachable", tries, next: null, label: `No answer after ${tries} tries` };
  const next = addBusinessDays(latest!.day, RETRY_BUSINESS_DAYS);
  return next > today ? { status: "waiting", tries, next, label: `Try again ${shortDay(next)}` } : { status: "to_call", tries, next, label: `Try #${tries + 1}` };
}

export const outcomeLabel = (o: string | null | undefined) => (o ? CALL_OUTCOMES[o as CallOutcome] ?? o : "Result not recorded");

// ---------------------------------------------------------------------------
// What to say (a short script per list; no health details in voicemails)
// ---------------------------------------------------------------------------

export interface ScriptFill { me: string; clinic: string; clinicPhone: string; provider: string; patient: string }

const GOAL: Record<string, { en: string; es: string }> = {
  missed_appointment: { en: "we missed you at your last appointment and would like to get you rescheduled", es: "no pudimos verle en su última cita y queremos darle una nueva" },
  cancelled_not_rebooked: { en: "your last visit was cancelled and we'd like to find a new time for you", es: "su última cita se canceló y queremos darle una nueva fecha" },
  new_patient_no_return: { en: "{provider} would like to see you for a follow-up after your first visit", es: "{provider} quiere verle para un seguimiento después de su primera visita" },
  lapsed_follow_up: { en: "it's been a few months since your last visit and {provider} would like to see you for a follow-up", es: "han pasado unos meses desde su última visita y {provider} quiere verle para un seguimiento" },
  overdue_follow_up: { en: "{provider} would like to see you for your regular check-up", es: "{provider} quiere verle para su chequeo regular" },
  diabetes_follow_up: { en: "you're due for your regular diabetes check-up with {provider}", es: "le toca su chequeo regular de diabetes con {provider}" },
  hypertension_follow_up: { en: "you're due for your regular blood-pressure check-up with {provider}", es: "le toca su chequeo regular de presión con {provider}" },
  schedule_fill: { en: "{provider} has openings coming up and we'd like to get you scheduled for a visit", es: "{provider} tiene citas disponibles y queremos programarle una visita" },
};

export function callScript(category: string, lang: "en" | "es", f: ScriptFill): { call: string; voicemail: string } | null {
  const goal = GOAL[category];
  if (!goal) return null;
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: keyof ScriptFill) => f[k] || "");
  return lang === "es"
    ? {
        call: fill(`Hola, ¿hablo con {patient}? Le habla {me} de {clinic}. Le llamo porque ${goal.es}. ¿Qué día y hora le queda mejor?`),
        voicemail: fill("Hola, este mensaje es para {patient}. Le habla {me} de {clinic}. Por favor llámenos al {clinicPhone}. Gracias."),
      }
    : {
        call: fill(`Hi, may I speak with {patient}? This is {me} from {clinic}. I'm calling because ${goal.en}. What day and time works best for you?`),
        voicemail: fill("Hi, this message is for {patient}. This is {me} from {clinic}. Please call us back at {clinicPhone}. Thank you."),
      };
}

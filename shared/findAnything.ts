// Find anything (Ctrl K): the things it can do, and how a typed line is read.
// "note maria" → Excuse note + the patients named Maria; "forms 0142" → Send forms + phone ending 0142.
// Pure: shared by the search window and the tests.

export const FIND_ACTIONS = ["excuse", "forms", "task", "call", "text", "fax", "insurance"] as const;
export type FindAction = (typeof FIND_ACTIONS)[number];

export interface FindActionInfo {
  /** "Excuse note" */
  label: string;
  /** "Excuse note for" (+ the patient's name) */
  lead: string;
  /** Words that pick this action (a typed word matches when it is one of these, or the start of one, 3+ letters). */
  words: string[];
  /** A patient is needed (otherwise it can also be done without one). */
  needsPatient: boolean;
  hint: string;
}

export const FIND_ACTION_INFO: Record<FindAction, FindActionInfo> = {
  excuse: { label: "Excuse note", lead: "Excuse note for", words: ["excuse", "note", "work", "school"], needsPatient: false, hint: "On the provider's letterhead, filled in from the record" },
  forms: { label: "Send forms", lead: "Send forms to", words: ["forms", "form", "consent", "intake", "phq", "gad", "screening"], needsPatient: true, hint: "By text or email, in the patient's language" },
  task: { label: "New task", lead: "New task for", words: ["task", "todo", "remind", "reminder", "follow"], needsPatient: false, hint: "For you or a teammate" },
  call: { label: "Call", lead: "Call", words: ["call", "phone", "dial"], needsPatient: true, hint: "From your RingCentral phone" },
  text: { label: "Text", lead: "Text", words: ["text", "sms"], needsPatient: true, hint: "Opens a text to the patient" },
  fax: { label: "Send a fax", lead: "Fax records for", words: ["fax"], needsPatient: false, hint: "Pick pages from the patient's folder" },
  insurance: { label: "Check insurance", lead: "Check insurance for", words: ["insurance", "eligibility", "coverage", "benefits"], needsPatient: true, hint: "Ask the insurance company now" },
};

/** The action a single typed word asks for, if any. */
export function actionForWord(word: string): FindAction | null {
  const w = word.toLowerCase();
  if (w.length < 3 || /\d/.test(w)) return null;
  for (const a of FIND_ACTIONS) if (FIND_ACTION_INFO[a].words.some((k) => k === w || k.startsWith(w))) return a;
  return null;
}

/**
 * Read a typed line: the first word that names an action is the action; every other word is
 * what to look for (a patient's name, date of birth or phone). With an action already picked
 * (the chip in the search box), every word is what to look for.
 */
export function parseFindQuery(query: string, picked: FindAction | null = null): { action: FindAction | null; rest: string } {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (picked) return { action: picked, rest: words.join(" ") };
  let action: FindAction | null = null;
  const rest: string[] = [];
  for (const w of words) {
    const a: FindAction | null = action ? null : actionForWord(w);
    if (a) action = a;
    else rest.push(w);
  }
  // "send a note to maria", "follow up with dan": the little words aren't part of a name.
  const kept = action ? rest.filter((w) => !FILLER.has(w.toLowerCase())) : rest;
  return { action, rest: kept.join(" ") };
}
const FILLER = new Set(["a", "an", "the", "to", "for", "up", "with", "on", "about", "send", "make", "new", "start", "check", "of"]);

/** Patient 360 opens with this action ready (`?do=`), so the search window hands over to the patient's page. */
export const isFindAction = (v: string | null | undefined): v is FindAction => !!v && (FIND_ACTIONS as readonly string[]).includes(v);

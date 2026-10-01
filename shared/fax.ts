// Fax inbox: faxes that arrive by email are matched to a patient and become a "file this in
// Practice Fusion" task. Practice Fusion has no API for adding documents to a chart, so staff do
// the upload; MyPCP finds the patient, routes the work and tracks what's still unfiled.
import { nameKey } from "./workspace";

export const FAX_DOC_TYPES = {
  lab_result: "Lab results",
  imaging: "Imaging report",
  consult: "Specialist / consult note",
  hospital: "Hospital / ER records",
  referral: "Referral",
  records_request: "Records request",
  prior_auth: "Prior authorization",
  pharmacy: "Pharmacy / refill request",
  insurance: "Insurance / billing",
  medical_records: "Medical records",
  other: "Other",
} as const;
export type FaxDocType = keyof typeof FAX_DOC_TYPES;
export const FAX_DOC_TYPE_KEYS = Object.keys(FAX_DOC_TYPES) as FaxDocType[];

export type FaxStatus = "new" | "needs_patient" | "to_file" | "filed" | "not_patient";

export type FaxRouting = "front_desk" | "care_team" | "user";
export interface FaxSettings {
  /** Extra sender addresses or domains whose emails are faxes (the practice mailbox). */
  senders: string[];
  /** Who gets "file this in Practice Fusion" tasks. */
  routing: FaxRouting;
  routeUserId: number | null;
  /** Read each fax with the practice's AI (AWS Bedrock, under the AWS BAA) to suggest the patient. */
  ai: boolean;
}
export const DEFAULT_FAX_SETTINGS: FaxSettings = { senders: [], routing: "front_desk", routeUserId: null, ai: true };

/** Fax-to-email services. Emails from these (with a PDF/TIFF attached) are treated as faxes. */
export const KNOWN_FAX_SENDERS = [
  "ringcentral.com", "efax.com", "j2.com", "myfax.com", "metrofax.com", "srfax.com", "faxage.com", "hellofax.com",
  "fax.plus", "mfax.io", "humblefax.com", "sfax.com", "scrypt.com", "documo.com", "updox.com", "faxburner.com",
  "nextiva.com", "vonage.com", "8x8.com", "dialpad.com", "goto.com", "ooma.com", "kareo.com", "concordfax.com",
];

export interface FaxAttachment { attachmentId: string; filename: string; mimeType: string; size: number }

export const isFaxFile = (a: { filename: string; mimeType: string }) =>
  /pdf|tiff?/i.test(a.mimeType) || /\.(pdf|tiff?)$/i.test(a.filename);

const senderMatches = (from: string, list: string[]) => {
  const email = from.toLowerCase();
  const domain = email.split("@")[1] ?? "";
  return list.some((s) => {
    const x = s.trim().toLowerCase().replace(/^@/, "");
    if (!x) return false;
    return x.includes("@") ? email === x : domain === x || domain.endsWith(`.${x}`);
  });
};

/** Is this email a fax? It needs a PDF/TIFF attached, and a fax sender or "fax" in the subject. */
export function isFaxEmail(msg: { fromEmail: string | null; subject: string; attachments: { filename: string; mimeType: string }[] }, extraSenders: string[] = []): boolean {
  if (!msg.attachments.some(isFaxFile)) return false;
  if (msg.fromEmail && senderMatches(msg.fromEmail, [...KNOWN_FAX_SENDERS, ...extraSenders])) return true;
  return /\b(e-?)?fax(ed)?\b/i.test(msg.subject);
}

/** The sending fax number and page count, when the email says them (e.g. "New fax from (713) 555-0199, 3 pages"). */
export function parseFaxMeta(subject: string, body: string): { fromNumber: string | null; pages: number | null } {
  const text = `${subject}\n${body}`.slice(0, 4000);
  const num = text.match(/(?:from|sender|caller|fax)[^\d+]{0,30}(\+?1?[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4})/i) ?? text.match(/(\+?1?[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4})/);
  const digits = num?.[1]?.replace(/\D/g, "").slice(-10) ?? null;
  const pages = text.match(/(\d{1,3})\s*(?:pages?|pgs?)\b/i) ?? text.match(/\bpages?\s*[:=]?\s*(\d{1,3})\b/i);
  return { fromNumber: digits && digits.length === 10 ? digits : null, pages: pages ? Number(pages[1]) : null };
}

export interface FaxReading { patientName: string | null; dob: string | null; documentType: FaxDocType; sender: string | null; summary: string | null }

/** Pull the JSON the AI returned (tolerates code fences / chatter) and keep only valid values. */
export function parseFaxReading(text: string): FaxReading | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() && !/^(null|unknown|n\/a|none)$/i.test(v.trim()) ? v.trim().slice(0, max) : null);
  const dob = str(raw.dob, 10);
  const type = str(raw.documentType, 40);
  return {
    patientName: str(raw.patientName, 120),
    dob: dob && /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : null,
    documentType: type && type in FAX_DOC_TYPES ? (type as FaxDocType) : "other",
    sender: str(raw.sender, 120),
    summary: str(raw.summary, 160),
  };
}

export const FAX_AI_PROMPT = `You index incoming faxes for a primary-care clinic's front desk so each one can be filed in the right patient's chart.
Return ONLY a JSON object with these keys:
- "patientName": the patient the fax is about, as written (null if there isn't one, e.g. marketing or a fax about many patients)
- "dob": the patient's date of birth as YYYY-MM-DD (null if not shown)
- "documentType": one of ${FAX_DOC_TYPE_KEYS.map((k) => `"${k}"`).join(", ")}
- "sender": the organization or office that sent it (null if unclear)
- "summary": a short title of at most 12 words, e.g. "Lab report from Quest, collected 9/22/2026". Do not include test results, values, diagnoses or any medical interpretation.
Do not give medical advice or interpret the contents.`;

export interface PersonRef { key: string; patientId: number | null; name: string; dob: string | null }

const tokens = (name: string) => { const t = nameKey(name).split(" ").filter(Boolean); return { first: t[0] ?? "", last: t[t.length - 1] ?? "" }; };

/**
 * Find the patient a fax is about. Same date of birth + same first and last name = a sure match.
 * A unique name without a date of birth is only a suggestion for staff to confirm.
 */
export function matchFaxPatient(name: string | null, dob: string | null, people: PersonRef[]): { person: PersonRef; sure: boolean } | null {
  return makePersonMatcher(people)(name, dob);
}

/**
 * The same matching as matchFaxPatient, with everyone's names worked out once up front. For matching
 * many people against the same list (the Practice Fusion import): each lookup is then instant, instead
 * of re-reading every name on the list each time.
 */
export function makePersonMatcher(people: PersonRef[]): (name: string | null, dob: string | null) => { person: PersonRef; sure: boolean } | null {
  const byDobName = new Map<string, PersonRef[]>();
  const byDobLast = new Map<string, PersonRef[]>();
  const byName = new Map<string, PersonRef[]>();
  const add = (m: Map<string, PersonRef[]>, k: string, p: PersonRef) => { const l = m.get(k); if (l) l.push(p); else m.set(k, [p]); };
  for (const p of people) {
    const t = tokens(p.name);
    add(byName, `${t.first}|${t.last}`, p);
    if (p.dob) {
      add(byDobName, `${p.dob}|${t.first}|${t.last}`, p);
      add(byDobLast, `${p.dob}|${t.last}`, p);
    }
  }
  return (name, dob) => {
    if (!name) return null;
    const n = tokens(name);
    if (!n.first || !n.last) return null;
    if (dob) {
      const hits = byDobName.get(`${dob}|${n.first}|${n.last}`) ?? [];
      if (hits.length === 1) return { person: hits[0]!, sure: true };
      // First name as an initial or a nickname: same DOB + same last name, only one such person.
      const lastOnly = byDobLast.get(`${dob}|${n.last}`) ?? [];
      if (lastOnly.length === 1) return { person: lastOnly[0]!, sure: false };
      if (hits.length > 1) return null;
    }
    const unique = Array.from(new Map((byName.get(`${n.first}|${n.last}`) ?? []).map((p) => [p.key, p])).values());
    return unique.length === 1 ? { person: unique[0]!, sure: false } : null;
  };
}

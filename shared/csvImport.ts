/**
 * Flexible CSV parser + validator for bulk patient import.
 * Shared between server (import procedure) and tests.
 *
 * Supports two real-world templates (auto-detected by header) plus a generic
 * fallback. Names may be "Last, First" or "First Last". Dates may be M/D,
 * M/D/YY, or MM/DD/YYYY. Phone is optional (missing info is fine — staff fill
 * it in manually later).
 *
 * Template A — "Dr.Mai CCMs":
 *   Name, Provider, Wellness Call, Date Completed, Next Appointment, Notes
 * Template B — "Chart Notes Report":
 *   PATIENT NAME, CHART NOTE TYPE, SERVICE DATE, PROVIDER, SIGNED, SIGNED BY, SIGNED ON
 * Generic — name + any of phoneNumber/dob/clinic/provider/etc.
 */

export type ImportTemplate = "drmai" | "chartnotes" | "generic" | "ccmlist" | "unknown";

export type ParsedPatientRow = {
  rowNumber: number;
  name: string; // normalized to "First Last"
  dateOfBirth?: string;
  phoneNumber?: string;
  clinic?: string;
  provider?: string;
  preferredLanguage?: string;
  chronicConditions?: string[];
  insurance?: string;
  consentStatus?: string;
  rpmEnrolled?: boolean;
  rpmDeviceType?: string;
  // CCM operational fields captured from the two real templates
  lastCalled?: string; // raw date string (Date Completed / Service Date)
  nextAppointment?: string; // raw date string
  wellnessCallStatus?: string; // raw status text from Template A
  completed?: boolean; // whether this row represents a completed CCM
  enrollmentStatus?: "active" | "inactive"; // from an Active/Inactive column
  notes?: string;
  errors: string[];
};

/** Split a single CSV line into fields, honoring double-quote quoting. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_-]/g, "");
}

function parseBool(v?: string): boolean | undefined {
  if (v == null || v === "") return undefined;
  const s = v.toLowerCase().trim();
  if (["yes", "y", "true", "1", "enrolled"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return undefined;
}

/** Convert "Last, First" → "First Last"; leave "First Last" untouched. */
export function normalizePersonName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return "";
  if (name.includes(",")) {
    const [last, first] = name.split(",").map((s) => s.trim());
    if (first) return `${first} ${last}`;
    return last;
  }
  return name;
}

/**
 * Parse a flexible date string into ISO YYYY-MM-DD.
 * Supports M/D, M/D/YY, M/D/YYYY, YYYY-MM-DD. Assumes a default year for M/D.
 * Returns undefined if unparseable.
 */
export function parseFlexibleDate(raw: string | undefined, defaultYear?: number): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  // already ISO
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (mdy) {
    let [, m, d, y] = mdy;
    let year: number;
    if (y == null) {
      year = defaultYear ?? new Date().getFullYear();
    } else if (y.length === 2) {
      year = 2000 + parseInt(y, 10);
    } else {
      year = parseInt(y, 10);
    }
    const mm = parseInt(m, 10);
    const dd = parseInt(d, 10);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return undefined;
    return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  // fallback to Date parsing
  const t = new Date(s);
  if (!isNaN(t.getTime())) {
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  }
  return undefined;
}

// Header aliases (already normalized: lowercased, spaces/underscores/hyphens removed).
// Different practices label the same columns differently, so accept the common ones.
const NAME_KEYS = ["name", "patientname", "patient"];
const STATUS_KEYS = ["wellnesscall", "completionstatus", "status", "callstatus"];
const COMPLETED_DATE_KEYS = ["datecompleted", "dateccmcompleted", "completiondate", "ccmdate"];

/** Detect which template a header row represents. */
export function detectTemplate(headers: string[]): ImportTemplate {
  const h = headers.map(normalizeHeader);
  const has = (k: string) => h.includes(k);
  const hasAny = (keys: string[]) => keys.some((k) => h.includes(k));
  if (has("patientname") && (has("chartnotetype") || has("servicedate") || has("signed"))) {
    return "chartnotes";
  }
  // A name column plus a call/completion-status column = a CCM call sheet
  // (the "Dr.Mai" shape and look-alikes: Patient/Provider/Completion Status/...).
  if (hasAny(NAME_KEYS) && hasAny(STATUS_KEYS)) {
    return "drmai";
  }
  if (hasAny(NAME_KEYS)) {
    return "generic";
  }
  return "unknown";
}

/** Map a wellness-call / completion status to a completion flag. */
function isCompletedStatus(status: string): boolean {
  const s = status.toLowerCase();
  if (
    s.includes("not complet") || s.includes("uncomplet") || s.includes("incomplet") ||
    s.includes("to be complet") || s.includes("to complete") || s.includes("needs complet")
  ) return false; // e.g. "Not Completed", "Needs to be completed" — still to do
  return s.includes("complet");
}

export function parsePatientCsv(
  text: string,
  opts?: { defaultYear?: number },
): { rows: ParsedPatientRow[]; template: ImportTemplate; headerError?: string } {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) return { rows: [], template: "unknown", headerError: "File is empty." };

  const rawHeaders = splitCsvLine(lines[0]);
  const headers = rawHeaders.map(normalizeHeader);
  let template = detectTemplate(rawHeaders);

  // Header-less "CCM call list" working sheets (e.g. Salma's): no header row, the
  // 4th column is consistently "Completed"/"Not Completed". Detect by content.
  let headerless = false;
  if (template === "unknown") {
    const isStatusRow = (l: string) => /^(completed|not\s*completed)$/i.test((splitCsvLine(l)[3] ?? "").trim());
    const statusRows = lines.filter(isStatusRow).length;
    if (statusRows >= Math.max(2, Math.ceil(lines.length * 0.4))) {
      template = "ccmlist";
      headerless = true;
    }
  }

  if (template === "unknown") {
    return {
      rows: [],
      template,
      headerError:
        'Could not recognize this file. Expected one of: the "Dr.Mai CCMs" export (Name, Provider, Wellness Call, ...), the "Chart Notes Report" export (PATIENT NAME, SERVICE DATE, PROVIDER, ...), a header-less CCM call list (Name, Provider, Active/Inactive, Completed/Not Completed, ...), or a generic sheet with a "name" column.',
    };
  }

  const idx = (key: string) => headers.indexOf(normalizeHeader(key));
  const get = (cols: string[], key: string) => {
    const i = idx(key);
    return i >= 0 ? (cols[i] ?? "").trim() : "";
  };
  /** First non-empty value among several possible header names. */
  const getAny = (cols: string[], keys: string[]) => {
    for (const k of keys) {
      const v = get(cols, k);
      if (v) return v;
    }
    return "";
  };

  // Build a row for the header-less CCM call-list format (positional columns).
  const ccmRow = (rowNumber: number, rawName: string, rawProvider: string, enrollment: string, status: string, dateOrNote: string, extraNote: string): ParsedPatientRow => {
    const errors: string[] = [];
    const row: ParsedPatientRow = { rowNumber, name: normalizePersonName(rawName), errors };
    row.provider = rawProvider.trim() || undefined;
    row.enrollmentStatus = /inactive/i.test(enrollment) ? "inactive" : "active";
    row.wellnessCallStatus = status.trim() || undefined;
    row.completed = status.trim() ? isCompletedStatus(status) : undefined;
    const d = parseFlexibleDate(dateOrNote, opts?.defaultYear);
    row.lastCalled = d;
    const note = [d ? "" : dateOrNote, extraNote].map((s) => s.trim()).filter(Boolean).join(" ");
    row.notes = note || undefined;
    if (!row.name) errors.push("Patient name is required");
    return row;
  };

  const rows: ParsedPatientRow[] = [];
  const startLine = headerless ? 0 : 1;
  for (let i = startLine; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    // Skip blank filler rows (these exports often have hundreds of empty ",,,,," lines).
    if (cols.every((c) => c.trim() === "")) continue;

    if (template === "ccmlist") {
      const c0 = (cols[0] ?? "").trim();
      const c1 = (cols[1] ?? "").trim();
      // Decide whether col 1 is the provider or the last half of a "First,Last" name.
      let name = c0;
      let provider = "";
      if (/^dr\.?\s/i.test(c1) || c0.includes(" ") || c0.includes(",")) {
        name = c0; provider = c1; // c0 is already a full name; c1 is the provider
      } else if (c1) {
        name = `${c0} ${c1}`.trim(); // single first name + last name split across two columns
      }
      rows.push(ccmRow(i + 1, name, provider, cols[2] ?? "", cols[3] ?? "", cols[4] ?? "", cols[5] ?? ""));
      // Some rows carry a second patient in a side-by-side block
      // (cols 8-11: name, Active/Inactive, status, date — no provider).
      const c8 = (cols[8] ?? "").trim();
      if (c8 && /^(completed|not\s*completed)$/i.test((cols[10] ?? "").trim())) {
        rows.push(ccmRow(i + 1, c8, "", cols[9] ?? "", cols[10] ?? "", cols[11] ?? "", ""));
      }
      continue;
    }

    const errors: string[] = [];
    const row: ParsedPatientRow = { rowNumber: i + 1, name: "", errors };

    if (template === "chartnotes") {
      row.name = normalizePersonName(get(cols, "patientname"));
      row.provider = get(cols, "provider") || undefined;
      row.lastCalled = parseFlexibleDate(get(cols, "servicedate"), opts?.defaultYear);
      // A signed CCM chart note represents a completed CCM for that service date.
      row.completed = true;
      row.wellnessCallStatus = "Completed";
    } else if (template === "drmai") {
      row.name = normalizePersonName(getAny(cols, NAME_KEYS));
      row.provider = get(cols, "provider") || undefined;
      const status = getAny(cols, STATUS_KEYS);
      row.wellnessCallStatus = status || undefined;
      row.completed = isCompletedStatus(status);
      row.lastCalled = parseFlexibleDate(getAny(cols, COMPLETED_DATE_KEYS), opts?.defaultYear);
      row.nextAppointment = parseFlexibleDate(get(cols, "nextappointment"), opts?.defaultYear);
      row.notes = get(cols, "notes") || undefined;
    } else {
      // generic
      row.name = normalizePersonName(getAny(cols, NAME_KEYS));
      row.phoneNumber = get(cols, "phonenumber") || undefined;
      row.dateOfBirth = parseFlexibleDate(get(cols, "dateofbirth"), opts?.defaultYear);
      row.clinic = get(cols, "clinic") || undefined;
      row.provider = get(cols, "provider") || undefined;
      row.preferredLanguage = get(cols, "preferredlanguage") || undefined;
      const conditionsRaw = get(cols, "chronicconditions");
      row.chronicConditions = conditionsRaw
        ? conditionsRaw.split(/[;|]/).map((c) => c.trim()).filter(Boolean)
        : undefined;
      row.insurance = get(cols, "insurance") || undefined;
      const consentRaw = get(cols, "consentstatus").toLowerCase();
      row.consentStatus = ["consented", "pending", "declined"].includes(consentRaw) ? consentRaw : undefined;
      row.rpmEnrolled = parseBool(get(cols, "rpmenrolled"));
      row.rpmDeviceType = get(cols, "rpmdevicetype") || undefined;
      row.nextAppointment = parseFlexibleDate(get(cols, "nextappointment"), opts?.defaultYear);
      const statusRaw = get(cols, "status") || get(cols, "wellnesscall");
      row.wellnessCallStatus = statusRaw || undefined;
      row.completed = statusRaw ? isCompletedStatus(statusRaw) : undefined;
    }

    // Only the patient name is required — all other info is optional and can be
    // completed manually after import.
    if (!row.name) errors.push("Patient name is required");

    rows.push(row);
  }

  return { rows, template };
}

// Titles/credentials that should be ignored when matching a provider name, so
// "Dr. Sudad", "Dr Sudad", "Sudad Al Hadad, MD" all reduce to the same tokens.
const PROVIDER_STOPWORDS = new Set([
  "dr", "doctor", "md", "do", "np", "pa", "pac", "pa-c", "rn", "arnp", "fnp",
  "crnp", "mr", "mrs", "ms", "prof", "professor",
]);

/**
 * Normalize a provider name for fuzzy matching: lowercase, drop punctuation and
 * title/credential words, collapse whitespace. e.g. "Dr. Sudad" -> "sudad",
 * "Sudad Al Hadad, MD" -> "sudad al hadad".
 */
export function normalizeProviderName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !PROVIDER_STOPWORDS.has(t))
    .join(" ")
    .trim();
}

/**
 * Resolve a free-text provider string from an import to one of the providers
 * already in the system, consolidating name variations onto a single canonical
 * provider. Returns the matched provider id, or null if nothing matches well
 * enough (caller can then fall back to a default or leave it unset).
 *
 * Matching rules (after stripping titles/credentials):
 *   - exact normalized equality wins outright;
 *   - otherwise accept when one name's tokens are fully contained in the other's
 *     ("Sudad" ⊆ "Sudad Al Hadad") or they share at least two tokens.
 * The best-scoring candidate is returned; a lone shared first name is not enough.
 */
export function matchProviderId(
  raw: string | undefined | null,
  providers: { id: number; name: string; aliases?: string[] | null }[],
): number | null {
  const n = normalizeProviderName(raw || "");
  if (!n) return null;
  const tokensN = Array.from(new Set(n.split(" ").filter(Boolean)));
  if (tokensN.length === 0) return null;

  let best: number | null = null;
  let bestScore = 0;
  for (const p of providers) {
    // Compare against the provider's name and any configured aliases.
    const candidates = [p.name, ...(p.aliases ?? [])];
    for (const cand of candidates) {
      const np = normalizeProviderName(cand);
      if (!np) continue;
      if (np === n) return p.id; // exact name/alias match wins immediately
      const tokensP = Array.from(new Set(np.split(" ").filter(Boolean)));
      let inter = 0;
      for (const t of tokensN) if (tokensP.includes(t)) inter++;
      if (inter === 0) continue;
      const subset = inter === tokensN.length || inter === tokensP.length;
      if (!subset && inter < 2) continue; // avoid matching on a single shared name
      const score = inter * 10 + (subset ? 5 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = p.id;
      }
    }
  }
  return best;
}

/**
 * Map a free-text status from an import file onto the closest CCM worklist status
 * (the same set offered in the app's status dropdown). Returns a canonical status
 * key, or null if nothing fits (caller falls back to the default not_started/assigned).
 *
 * Handles the real values seen in exports — "Completed", "Not Answer try again",
 * "Wellness Call", "Left VM", etc. — via exact-label match first, then keywords.
 */
export function matchWorklistStatus(raw?: string | null): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/[_\-/]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;

  // Exact canonical labels / common phrasings.
  const exact: Record<string, string> = {
    "not started": "not_started", "assigned": "assigned",
    "called no answer": "called_no_answer", "no answer": "called_no_answer",
    "voicemail left": "voicemail_left", "left voicemail": "voicemail_left",
    "wrong number": "wrong_number", "needs callback": "needs_callback",
    "in progress": "in_progress", "completed": "completed", "complete": "completed",
    "needs provider review": "needs_provider_review", "needs appointment": "needs_appointment",
    "documentation incomplete": "documentation_incomplete", "ready for billing": "ready_for_billing",
    "billed": "billed", "cancelled": "cancelled", "canceled": "cancelled",
    "unable to reach": "unable_to_reach", "declined ccm": "declined_ccm",
    "declined": "declined_ccm", "inactive": "inactive",
  };
  if (exact[s]) return exact[s];

  const has = (...ks: string[]) => ks.some((k) => s.includes(k));
  // Order matters: most specific / outcome-bearing first.
  // "Not Completed" / "incomplete" must be caught before the generic "complet".
  // "Needs to be completed" / "to be completed" still need doing — catch these
  // before the generic "complet" check so they don't read as Completed.
  if (has("not complet", "uncomplet", "to be complet", "to complete", "needs complet", "need to complet")) return "not_started";
  if (has("complet")) return "completed";
  if (has("voicemail", "left vm", "vm left", "left message", "left msg", "left a message")) return "voicemail_left";
  if (has("wrong number", "wrong #", "wrong num")) return "wrong_number";
  if (has("unable to reach", "unreachable", "cant reach", "can't reach", "no contact")) return "unable_to_reach";
  if (has("no answer", "not answer", "no ans", "no response", "no resp", "noresponse", "didnt answer", "didn't answer", "did not answer", "unanswered")) return "called_no_answer";
  if (has("provider review", "md review", "needs review", "review needed")) return "needs_provider_review";
  if (has("appointment", "appt")) return "needs_appointment";
  if (has("callback", "call back", "try again", "follow up", "followup", "reattempt", "retry")) return "needs_callback";
  if (has("ready for billing", "bill ready", "billable")) return "ready_for_billing";
  if (has("billed", "invoiced")) return "billed";
  if (has("document", "charting", "incomplete doc", "note incomplete")) return "documentation_incomplete";
  if (has("cancel")) return "cancelled";
  if (has("declin", "refus", "deny", "opt out", "opted out")) return "declined_ccm";
  // Administrative drop-offs (insurance lapsed, PCP changed, etc.) → mark inactive.
  if (has("inactive", "discharg", "deceased", "moved", "pcp chang", "provider chang", "insurance chang", "insurance inactive", "pcp change")) return "inactive";
  if (has("in progress", "started", "ongoing", "working")) return "in_progress";
  if (has("assigned")) return "assigned";
  // Pending wellness call / new / to-be-called → not yet started.
  if (has("wellness", "not started", "pending", "new", "to call")) return "not_started";
  return null;
}

/** Find duplicate names *within* the parsed batch (case-insensitive). */
export function findInBatchDuplicates(rows: ParsedPatientRow[]): Set<number> {
  const seen = new Map<string, number>();
  const dupRowNumbers = new Set<number>();
  for (const r of rows) {
    const key = r.name.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key) continue;
    if (seen.has(key)) {
      dupRowNumbers.add(r.rowNumber);
      dupRowNumbers.add(seen.get(key)!);
    } else {
      seen.set(key, r.rowNumber);
    }
  }
  return dupRowNumbers;
}

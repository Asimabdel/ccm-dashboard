/**
 * Lightweight CSV parser + validator for bulk patient import.
 * Shared between server (import procedure) and tests.
 * Supports quoted fields, embedded commas, and CRLF/LF line endings.
 */

export type ParsedPatientRow = {
  rowNumber: number;
  name: string;
  dateOfBirth?: string; // raw string from CSV (YYYY-MM-DD preferred)
  phoneNumber: string;
  clinic?: string; // clinic name (resolved to id server-side)
  provider?: string; // provider name (resolved to id server-side)
  preferredLanguage?: string;
  chronicConditions?: string[];
  insurance?: string;
  riskLevel?: string;
  consentStatus?: string;
  rpmEnrolled?: boolean;
  rpmDeviceType?: string;
  errors: string[];
};

const REQUIRED_HEADERS = ["name", "phonenumber"];

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

/**
 * Parse CSV text into rows with per-row validation errors.
 * Header row is required.
 */
export function parsePatientCsv(text: string): {
  rows: ParsedPatientRow[];
  headerError?: string;
} {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) return { rows: [], headerError: "File is empty." };

  const headers = splitCsvLine(lines[0]).map(normalizeHeader);
  for (const req of REQUIRED_HEADERS) {
    if (!headers.includes(req)) {
      return {
        rows: [],
        headerError: `Missing required column "${req}". Required columns: name, phoneNumber. Optional: dateOfBirth, clinic, provider, preferredLanguage, chronicConditions, insurance, riskLevel, consentStatus, rpmEnrolled, rpmDeviceType.`,
      };
    }
  }

  const idx = (key: string) => headers.indexOf(key);
  const get = (cols: string[], key: string) => {
    const i = idx(key);
    return i >= 0 ? (cols[i] ?? "").trim() : "";
  };

  const rows: ParsedPatientRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const errors: string[] = [];

    const name = get(cols, "name");
    const phoneNumber = get(cols, "phonenumber");
    if (!name) errors.push("Name is required");
    if (!phoneNumber) errors.push("Phone number is required");

    const riskRaw = get(cols, "risklevel").toLowerCase();
    const riskLevel = ["high", "medium", "low"].includes(riskRaw) ? riskRaw : undefined;
    if (riskRaw && !riskLevel) errors.push(`Invalid riskLevel "${riskRaw}"`);

    const consentRaw = get(cols, "consentstatus").toLowerCase();
    const consentStatus = ["consented", "pending", "declined"].includes(consentRaw) ? consentRaw : undefined;
    if (consentRaw && !consentStatus) errors.push(`Invalid consentStatus "${consentRaw}"`);

    const dob = get(cols, "dateofbirth");
    if (dob && isNaN(new Date(dob).getTime())) errors.push(`Invalid dateOfBirth "${dob}"`);

    const conditionsRaw = get(cols, "chronicconditions");
    const chronicConditions = conditionsRaw
      ? conditionsRaw.split(/[;|]/).map((c) => c.trim()).filter(Boolean)
      : undefined;

    rows.push({
      rowNumber: i + 1,
      name,
      dateOfBirth: dob || undefined,
      phoneNumber,
      clinic: get(cols, "clinic") || undefined,
      provider: get(cols, "provider") || undefined,
      preferredLanguage: get(cols, "preferredlanguage") || undefined,
      chronicConditions,
      insurance: get(cols, "insurance") || undefined,
      riskLevel,
      consentStatus,
      rpmEnrolled: parseBool(get(cols, "rpmenrolled")),
      rpmDeviceType: get(cols, "rpmdevicetype") || undefined,
      errors,
    });
  }

  return { rows };
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

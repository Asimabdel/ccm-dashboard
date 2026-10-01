// Patient folders: one place per patient that collects everything MyPCP has about them.
// Pure definitions shared by the server and the folder page.

export const FOLDER_SECTIONS = {
  chart: "Chart",
  visits: "Visits",
  tasks: "Tasks",
  comms: "Calls & emails",
  forms: "Forms & consents",
  files: "Documents & files",
  faxes: "Faxes",
  payments: "Payments",
  care: "Care programs",
  insurance: "Insurance",
} as const;
export type FolderSection = keyof typeof FOLDER_SECTIONS;
export const FOLDER_SECTION_LIST = Object.keys(FOLDER_SECTIONS) as FolderSection[];

/** What a file staff put in the folder is. */
export const PATIENT_FILE_TYPES = {
  outside_records: "Outside records",
  insurance_card: "Insurance card",
  id_card: "ID / driver's license",
  lab_report: "Lab report",
  imaging_report: "Imaging report",
  referral: "Referral",
  letter: "Letter",
  other: "Other",
} as const;
export type PatientFileType = keyof typeof PATIENT_FILE_TYPES;
export const PATIENT_FILE_TYPE_LIST = Object.keys(PATIENT_FILE_TYPES) as PatientFileType[];

/** PDFs and photos (phones send JPEG; HEIC is turned into JPEG by the browser on upload). */
export const PATIENT_FILE_MIME = ["application/pdf", "image/jpeg", "image/png"] as const;
export type PatientFileMime = (typeof PATIENT_FILE_MIME)[number];
export const MAX_PATIENT_FILE_BYTES = 25 * 1024 * 1024;

export const isPatientKey = (key: string) => /^(p:\d+|s:.{1,110}|f:.{1,120})$/.test(key);

/** Patient 360 for anyone: roster patients by their number, everyone else by their patient key. */
export const patientHref = (key: string, tab?: string | null, extra?: string) => {
  const q = [tab ? `tab=${tab}` : "", extra ?? ""].filter(Boolean).join("&");
  return `/patients/${/^p:\d+$/.test(key) ? key.slice(2) : encodeURIComponent(key)}${q ? `?${q}` : ""}`;
};

/** Where a patient's folder is: the Folder tab of their Patient 360. */
export const folderHref = (key: string, section?: FolderSection | null) => patientHref(key, "folder", section ? `s=${section}` : "");

/** How an item in the folder opens. */
export type FolderOpen =
  | { type: "task"; id: number }
  | { type: "file"; id: number }
  | { type: "fax"; id: number }
  | { type: "document"; id: number; ready: boolean }
  | { type: "form"; id: number }
  | { type: "payment"; id: string }
  | { type: "note"; id: number }
  | { type: "link"; url: string }
  | { type: "none" };

export interface FolderItem {
  /** Unique across the folder, e.g. "fax:12". */
  key: string;
  section: FolderSection;
  kind: string;
  title: string;
  detail: string | null;
  /** ISO timestamp (or YYYY-MM-DD) for sorting, newest first. */
  date: string | null;
  status: string | null;
  open: FolderOpen;
  /** Search only: the words around the match. */
  snippet?: string | null;
}

/** Newest first; undated last. */
export function sortItems<T extends { date: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/** The text around the first match of `needle` (case-insensitive), or null. */
export function snippetAround(text: string | null | undefined, needle: string, width = 70): string | null {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  const n = needle.trim().toLowerCase();
  if (!t || !n) return null;
  const i = t.toLowerCase().indexOf(n);
  if (i < 0) return null;
  const start = Math.max(0, i - width);
  const end = Math.min(t.length, i + n.length + width);
  return `${start > 0 ? "…" : ""}${t.slice(start, end)}${end < t.length ? "…" : ""}`;
}

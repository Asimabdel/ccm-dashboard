// Providers' daily reports (the practice's format, 2026-10-02):
//   Date: 07/31/26
//   Provider’s Name - Dr. Sudad
//   Seen: 21
//   Testing: Sang Woan Park (PFT), Saisha Terrell (PFT & RMR)
//   New CCMs: 4
//   New RPMs: 0
//   Injections: Esraa Naser (WL #11), Fatima Gendra (WL #8)
// Seen = that provider's visits marked arrived…seen/checked out (schedule import / Patient Flow).
// Testing = in-office tests marked done that day. New CCMs / RPMs = NEW patients (that day was their first
// visit with the practice) who qualify for the program (Program approvals, from their diagnoses) or signed
// its consent that day.
// Injections = logged by staff in MyPCP.

export const INJECTION_KINDS = {
  wl: { label: "Weight loss", short: "WL" },
  b12: { label: "B12", short: "B12" },
  testosterone: { label: "Testosterone", short: "Testosterone" },
  toradol: { label: "Toradol", short: "Toradol" },
  other: { label: "Other", short: "" },
} as const;
export type InjectionKind = keyof typeof INJECTION_KINDS;
export const INJECTION_KIND_LIST = Object.keys(INJECTION_KINDS) as InjectionKind[];

/** "WL #11", "B12 #3", or the typed name for "other". */
export function injectionTag(kind: string, label: string | null | undefined, n: number | null | undefined): string {
  const base = kind === "other" ? (label?.trim() || "Injection") : INJECTION_KINDS[kind as InjectionKind]?.short || kind;
  return n ? `${base} #${n}` : base;
}

/** 2026-07-31 → 07/31/26 */
export function reportDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${m}/${d}/${y!.slice(2)}`;
}

export interface ProviderDay {
  date: string;
  provider: string;
  seen: number;
  testing: { name: string; tests: string[] }[];
  newCcm: number;
  newRpm: number;
  injections: { name: string; tag: string }[];
}

/** The report exactly as the practice writes it. */
export function formatProviderReport(r: ProviderDay): string {
  const list = (items: string[]) => (items.length ? items.join(", ") : "None");
  return [
    `Date: ${reportDate(r.date)}`,
    `Provider’s Name - ${r.provider}`,
    `Seen: ${r.seen}`,
    `Testing: ${list(r.testing.map((t) => `${t.name} (${t.tests.join(" & ")})`))}`,
    `New CCMs: ${r.newCcm}`,
    `New RPMs: ${r.newRpm}`,
    `Injections: ${list(r.injections.map((i) => `${i.name} (${i.tag})`))}`,
  ].join("\n");
}

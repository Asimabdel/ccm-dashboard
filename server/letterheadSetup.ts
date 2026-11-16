// One-time setup for letterheads and excuse notes (2026-11-16, approved by Asim): each provider's name as it
// prints on letters, and the offices' full addresses. IAM-only job `letterhead-setup`: a dry run lists what it
// would change; {"apply": true} makes the changes. Staff and office details only (no patient data).
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { clinics, providers, users } from "../drizzle/schema";

/** Provider (matched by their name, alias or login name) → how the name prints on letters. */
export const LETTER_NAMES: { match: RegExp; letterName: string }[] = [
  { match: /al[\s-]?hadad|sudad/i, letterName: "Sudad Al Hadad, MD" },
  { match: /mansour/i, letterName: "Mohamed Mansour, MD" },
  { match: /narang/i, letterName: "Nisha Narang, MD" },
  { match: /yilian|almaguer/i, letterName: "Yilian Almaguer Simon, FNP" },
  { match: /maggie|magdalene|inyang/i, letterName: "Magdalene Inyang, FNP" },
];

/** Office (matched by the street number in today's address) → its full address. */
export const OFFICE_ADDRESSES: { street: RegExp; address: string }[] = [
  { street: /^\s*21398\s+provincial/i, address: "21398 Provincial Blvd, Katy, TX 77450" },
  { street: /^\s*7050\s+lakeview\s+haven/i, address: "7050 Lakeview Haven Dr, Ste 100, Houston, TX 77095" },
  { street: /^\s*12121\s+richmond/i, address: "12121 Richmond Ave, Ste 216, Houston, TX 77082" },
  { street: /^\s*22214\s+highland\s+knolls/i, address: "22214 Highland Knolls Dr, Ste A, Katy, TX 77450" },
];

/** Which rule a provider matches: exactly one, or none (several matches = ambiguous, left alone). */
export function letterNameFor(p: { name: string; aliases?: string[] | null; userName?: string | null }) {
  const text = [p.name, ...(p.aliases ?? []), p.userName ?? ""].join(" | ");
  const hits = LETTER_NAMES.filter((r) => r.match.test(text));
  return hits.length === 1 ? hits[0]!.letterName : null;
}

export async function letterheadSetup(apply: boolean) {
  const d = await getDb();
  if (!d) return { problem: "no database" };
  const provs = await d.select({ id: providers.id, name: providers.name, title: providers.title, aliases: providers.aliases, letterName: providers.letterName, clinicId: providers.clinicId, userName: users.name })
    .from(providers).leftJoin(users, eq(users.id, providers.userId));
  const offices = await d.select({ id: clinics.id, name: clinics.name, address: clinics.address }).from(clinics);
  const providerChanges = provs.map((p) => ({ id: p.id, name: p.name, title: p.title, clinicId: p.clinicId, now: p.letterName, to: letterNameFor(p) }));
  // The same letter name for two provider records would be a duplicate: report it, change neither.
  const twice = new Set(providerChanges.map((c) => c.to).filter((t, i, all) => t && all.indexOf(t) !== i));
  const officeChanges = offices.map((o) => {
    const hit = OFFICE_ADDRESSES.find((x) => x.street.test(o.address ?? ""));
    return { id: o.id, name: o.name, now: o.address, to: hit?.address ?? null };
  });
  const applied: string[] = [];
  if (apply) {
    for (const c of providerChanges) {
      if (!c.to || twice.has(c.to) || c.now === c.to) continue;
      await d.update(providers).set({ letterName: c.to }).where(eq(providers.id, c.id));
      applied.push(`provider #${c.id} ${c.name} → ${c.to}`);
    }
    for (const c of officeChanges) {
      if (!c.to || c.now === c.to) continue;
      await d.update(clinics).set({ address: c.to }).where(eq(clinics.id, c.id));
      applied.push(`office #${c.id} ${c.name} → ${c.to}`);
    }
  }
  return { apply, providers: providerChanges, duplicates: Array.from(twice), offices: officeChanges, applied };
}

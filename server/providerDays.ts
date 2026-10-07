// IAM-only check (2026-10-07): which days each provider worked in a date range, from two sources so they can
// be checked against each other: the imported clinic schedule (patients seen = arrived … completed) and the
// Practice Fusion chart copy (real visits, by the visit's provider). Counts only: provider names, dates, numbers.
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appointments, fhirResources, providers, scheduleImports } from "../drizzle/schema";
import { SEEN_STATUSES } from "../shared/workspace";

const weekday = (date: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

export async function providerDays(input: { from: string; to: string }) {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  const { from, to } = input;
  const [provs, appts, encs, imports] = await Promise.all([
    d.select({ id: providers.id, name: providers.name, aliases: providers.aliases }).from(providers),
    d.select({ providerId: appointments.providerId, providerName: appointments.providerName, date: appointments.date, status: appointments.status, n: sql<number>`COUNT(*)` })
      .from(appointments).where(and(gte(appointments.date, from), lte(appointments.date, to)))
      .groupBy(appointments.providerId, appointments.providerName, appointments.date, appointments.status),
    d.select({ key: fhirResources.subjectKey, date: fhirResources.date, raw: fhirResources.raw, value: fhirResources.value, status: fhirResources.status, title: fhirResources.title })
      .from(fhirResources).where(and(eq(fhirResources.section, "Encounter"), gte(fhirResources.date, from), lte(fhirResources.date, to))),
    d.select({ lastDate: scheduleImports.lastDate, firstDate: scheduleImports.firstDate, at: scheduleImports.createdAt, rows: scheduleImports.rowCount }).from(scheduleImports),
  ]);

  // Who a Practice Fusion visit belongs to: match the visit's provider to our provider names / aliases.
  const words = provs.map((p) => ({ id: p.id, name: p.name, keys: [p.name, ...((p.aliases as string[] | null) ?? [])].map((x) => x.toLowerCase().replace(/^dr\.?\s*/, "").trim()).filter((x) => x.length >= 3) }));
  const pfName = (raw: string | null, value: string | null) => {
    try {
      const r = raw ? JSON.parse(raw) as { participant?: { individual?: { display?: string } }[] } : null;
      const who = (r?.participant ?? []).map((p) => p.individual?.display).find(Boolean);
      if (who) return who;
    } catch { /* fall back to the stored value */ }
    return value?.split(" · ").at(-1) ?? null;
  };
  const matchProvider = (display: string | null) => {
    if (!display) return null;
    const s = display.toLowerCase();
    const hits = words.filter((w) => w.keys.some((k) => s.includes(k)));
    return hits.length === 1 ? hits[0]!.name : null;
  };

  type Day = { booked: number; seen: number; noShow: number; cancelled: number; stillScheduled: number; pfVisits: number; pfUntyped: number };
  const table = new Map<string, Map<string, Day>>();
  const cell = (prov: string, date: string) => {
    if (!table.has(prov)) table.set(prov, new Map());
    const m = table.get(prov)!;
    if (!m.has(date)) m.set(date, { booked: 0, seen: 0, noShow: 0, cancelled: 0, stillScheduled: 0, pfVisits: 0, pfUntyped: 0 });
    return m.get(date)!;
  };
  const provName = new Map(provs.map((p) => [p.id, p.name]));
  for (const a of appts) {
    const prov = (a.providerId ? provName.get(a.providerId) : null) ?? matchProvider(a.providerName) ?? `(schedule) ${a.providerName ?? "no provider"}`;
    const c = cell(prov, a.date);
    const n = Number(a.n);
    if (a.status === "cancelled") c.cancelled += n;
    else {
      c.booked += n;
      if (SEEN_STATUSES.includes(a.status)) c.seen += n;
      else if (a.status === "no_show") c.noShow += n;
      else if (a.status === "scheduled") c.stillScheduled += n;
    }
  }
  const pfSeen = new Map<string, Set<string>>(); // prov|date -> patients (real visits)
  const pfUntyped = new Map<string, Set<string>>(); // prov|date -> patients ("Unknown" visit type)
  const unmatched: Record<string, number> = {};
  for (const e of encs) {
    if (e.status && ["cancelled", "entered-in-error"].includes(e.status)) continue;
    const display = pfName(e.raw, e.value);
    const prov = matchProvider(display);
    if (!prov) { const k = display ?? "(no provider on the visit)"; unmatched[k] = (unmatched[k] ?? 0) + 1; continue; }
    const k = `${prov}|${e.date}`;
    const into = !e.title || e.title === "Unknown" ? pfUntyped : pfSeen;
    if (!into.has(k)) into.set(k, new Set());
    into.get(k)!.add(e.key ?? `x${into.get(k)!.size}`);
  }
  for (const [k, set] of Array.from(pfSeen.entries())) {
    const [prov, date] = k.split("|") as [string, string];
    cell(prov, date).pfVisits = set.size;
  }
  for (const [k, set] of Array.from(pfUntyped.entries())) {
    const [prov, date] = k.split("|") as [string, string];
    cell(prov, date).pfUntyped = set.size;
  }
  const [pfLatest] = await d.select({ lastVisitDate: sql<string | null>`MAX(${fhirResources.date})`, lastSynced: sql<string | null>`MAX(${fhirResources.syncedAt})` })
    .from(fhirResources).where(and(eq(fhirResources.section, "Encounter"), lte(fhirResources.date, to)));

  const byProvider = Array.from(table.entries()).map(([provider, days]) => ({
    provider,
    days: Array.from(days.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, c]) => ({ date, day: weekday(date), ...c })),
  })).sort((a, b) => a.provider.localeCompare(b.provider));
  const lastImport = imports.sort((a, b) => +b.at - +a.at)[0] ?? null;
  return { from, to, practiceFusionCopy: pfLatest ?? null, scheduleImportedThrough: lastImport ? { lastDate: lastImport.lastDate, importedAt: lastImport.at } : null, byProvider, pfVisitsWithUnmatchedProvider: unmatched };
}

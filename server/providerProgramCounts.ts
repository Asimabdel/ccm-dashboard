// IAM-only check (2026-10-06): how many patients each provider has in each program — CCM, BHI and APCM
// active — so questions like "how many active CCM patients are Yilian's?" get a number. Counts only:
// provider names and numbers, no patient names or ids. Retired duplicate copies ("(merged into #N)") don't count.
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { patients, providers } from "../drizzle/schema";

export async function providerProgramCounts() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  const active = (col: typeof patients.ccmEnrollmentStatus | typeof patients.bhiEnrollmentStatus | typeof patients.apcmEnrollmentStatus) =>
    sql<number>`SUM(CASE WHEN ${col} = 'active' THEN 1 ELSE 0 END)`;
  const rows = await d.select({
    providerId: patients.providerId, providerName: providers.name,
    ccm: active(patients.ccmEnrollmentStatus), bhi: active(patients.bhiEnrollmentStatus), apcm: active(patients.apcmEnrollmentStatus),
  }).from(patients).leftJoin(providers, eq(providers.id, patients.providerId))
    .where(sql`${patients.name} NOT LIKE '%(merged into #%'`)
    .groupBy(patients.providerId, providers.name);
  const list = rows.map((r) => ({ provider: r.providerName ?? "(no provider)", ccm: Number(r.ccm ?? 0), bhi: Number(r.bhi ?? 0), apcm: Number(r.apcm ?? 0) }))
    .filter((r) => r.ccm || r.bhi || r.apcm)
    .sort((a, b) => b.ccm - a.ccm);
  return { byProvider: list, totals: list.reduce((t, r) => ({ ccm: t.ccm + r.ccm, bhi: t.bhi + r.bhi, apcm: t.apcm + r.apcm }), { ccm: 0, bhi: 0, apcm: 0 }) };
}

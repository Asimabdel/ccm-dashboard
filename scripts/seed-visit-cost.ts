/**
 * LOCAL-ONLY made-up payments for the copay / deductible estimates (fictional people, never real PHI).
 *
 *   DATABASE_URL=mysql://dev:devpass@127.0.0.1:3307/ccm node_modules/.bin/tsx scripts/seed-visit-cost.ts
 *
 * Run scripts/seed-local.ts first. Puts the first ten roster patients on today's schedule and gives
 * them paid claims that show each kind of note: a steady copay, a deductible that still applies, one
 * that is met, coinsurance, nothing owed, and two patients with no claims who share a group number
 * with others. Safe to run again: it replaces its own rows. Refuses anything but a local database.
 */
import { gzipSync } from "node:zlib";
import { asc, eq, inArray, like } from "drizzle-orm";
import { getDb } from "../server/db";
import { appointments, billClaims, billLines, fhirResources, patients, providers } from "../drizzle/schema";
import { addDays, localDateStr } from "../shared/workforce";

const url = process.env.DATABASE_URL ?? "";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error("✗ Refusing to seed: DATABASE_URL must point at a local database (127.0.0.1 / localhost).");
  process.exit(1);
}

type Adj = { group: string; code: string; cents: number };
interface Visit { daysAgo: number; code?: string; allowed: number; paid: number; pr?: [string, number][]; owes?: number }
interface Person { payer: string; filing: string; memberId: string; group?: string; plan?: string; visits: Visit[]; visitType?: string }

const BCBS = "BCBS OF TEXAS";
const copay25 = (daysAgo: number, code = "99214"): Visit => ({ daysAgo, code, allowed: code === "99204" ? 16500 : 12800, paid: (code === "99204" ? 16500 : 12800) - 2500, pr: [["3", 2500]] });
const deductible = (daysAgo: number, code = "99214"): Visit => ({ daysAgo, code, allowed: code === "99204" ? 16500 : 12800, paid: 0, pr: [["1", code === "99204" ? 16500 : 12800]] });

/** In roster order: what each of the first ten patients' insurance did. */
const PEOPLE: Person[] = [
  { payer: BCBS, filing: "BL", memberId: "ZGP800100200", group: "174589", plan: "Blue Choice PPO", visits: [copay25(20), copay25(110), copay25(200, "99213")] },
  { payer: BCBS, filing: "BL", memberId: "HDX800100201", group: "HD9000", plan: "Blue Saver HSA", visits: [deductible(15), deductible(95)] },
  { payer: "NOVITAS SOLUTIONS", filing: "MB", memberId: "1EG4TE5MK73", visits: [{ daysAgo: 30, allowed: 13000, paid: 10400, pr: [["2", 2600]] }, { daysAgo: 250, allowed: 13000, paid: 0, pr: [["1", 13000]] }] },
  { payer: "AETNA MEDICARE", filing: "16", memberId: "MEBP4400781", visits: [{ daysAgo: 25, allowed: 12000, paid: 12000 }, { daysAgo: 120, allowed: 12000, paid: 12000 }] },
  { payer: BCBS, filing: "BL", memberId: "ZGP800100205", group: "174589", plan: "Blue Choice PPO", visits: [copay25(40, "99204"), copay25(10)] },
  { payer: BCBS, filing: "BL", memberId: "ZGP800100206", group: "174589", plan: "Blue Choice PPO", visits: [copay25(60, "99204")] },
  // No claims: the same group number as the three patients above.
  { payer: "Blue Cross Blue Shield of Texas", filing: "BL", memberId: "ZGP800100207", group: "174589", plan: "Blue Choice PPO", visits: [] },
  // No claims: the same group number as the deductible patients.
  { payer: "Blue Cross Blue Shield of Texas", filing: "BL", memberId: "HDX800100208", group: "HD9000", plan: "Blue Saver HSA", visits: [] },
  { payer: BCBS, filing: "BL", memberId: "HDX800100209", group: "HD9000", plan: "Blue Saver HSA", visits: [deductible(50, "99204"), deductible(12)] },
  { payer: BCBS, filing: "BL", memberId: "HDX800100210", group: "HD9000", plan: "Blue Saver HSA", visits: [deductible(70, "99204"), deductible(33), { daysAgo: 5, allowed: 12800, paid: 6240, pr: [["1", 5000], ["2", 1560]] }] },
  // A plan the practice no longer takes: the answer is the self-pay price.
  { payer: "HUMANA GOLD PLUS", filing: "16", memberId: "H55500111", visits: [{ daysAgo: 45, allowed: 11000, paid: 11000 }, { daysAgo: 150, allowed: 11000, paid: 11000 }] },
  // Booked for an annual wellness visit, with a $25 copay on office visits.
  { payer: BCBS, filing: "BL", memberId: "ZGP800100212", visits: [copay25(30), copay25(120)], visitType: "Annual Wellness" },
];
/** Extra new-patient visits (no patient attached) so the insurance has a usual new-visit price. */
const EXTRA_NEW = 3;

async function main() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const today = localDateStr();
  const roster = await db.select().from(patients).orderBy(asc(patients.id)).limit(PEOPLE.length);
  if (roster.length < PEOPLE.length) throw new Error("Run scripts/seed-local.ts first (not enough patients).");
  const provs = new Map((await db.select({ id: providers.id, name: providers.name }).from(providers)).map((p) => [p.id, p.name]));

  // Replace this script's own rows.
  const old = await db.select({ id: billClaims.id }).from(billClaims).where(like(billClaims.claimRef, "vcseed-%"));
  if (old.length) {
    await db.delete(billLines).where(inArray(billLines.claimId, old.map((c) => c.id)));
    await db.delete(billClaims).where(like(billClaims.claimRef, "vcseed-%"));
  }
  await db.delete(fhirResources).where(like(fhirResources.fhirId, "vcseed-%"));
  await db.delete(appointments).where(like(appointments.externalKey, "vcseed-%"));

  let claims = 0;
  const addClaim = async (ref: string, who: { key: string | null; id: number | null; name: string }, p: Person, v: Visit) => {
    const date = addDays(today, -v.daysAgo);
    const adj: Adj[] = [{ group: "CO", code: "45", cents: 5000 }, ...(v.pr ?? []).map(([code, cents]) => ({ group: "PR", code, cents }))];
    const owes = v.owes ?? (v.pr ?? []).reduce((s, [, c]) => s + c, 0);
    const [res] = await db.insert(billClaims).values({
      claimRef: ref, altKey: ref, status: v.paid > 0 ? "paid" : "patient_owes", sourceUsed: "era835", billedCents: v.allowed + 5000, allowedCents: v.allowed, paidCents: v.paid,
      patientOwesCents: owes, writtenOffCents: 5000, payerName: p.payer, filingIndicator: p.filing, patientName: who.name, memberId: p.memberId, subjectKey: who.key, patientId: who.id,
      matchSource: who.key ? "name" : null, firstServiceDate: date, lastPaidDate: addDays(date, 14) > today ? today : addDays(date, 14), eventCount: 1,
    });
    await db.insert(billLines).values({
      claimId: res.insertId, lineNo: 1, code: v.code ?? "99214", units: 1, serviceDate: date, billedCents: v.allowed + 5000, allowedCents: v.allowed, paidCents: v.paid,
      patientOwesCents: owes, writtenOffCents: 5000, adjustments: adj, remarks: [],
    });
    claims++;
  };

  for (let i = 0; i < PEOPLE.length; i++) {
    const pt = roster[i]!;
    const p = PEOPLE[i]!;
    const key = `p:${pt.id}`;
    for (let n = 0; n < p.visits.length; n++) await addClaim(`vcseed-${pt.id}-${n}`, { key, id: pt.id, name: pt.name }, p, p.visits[n]!);
    // Their insurance as Practice Fusion would list it (group number and plan name in the full record).
    if (p.group) {
      const record = {
        resourceType: "Coverage", id: `vcseed-cov-${pt.id}`, status: "active", subscriberId: p.memberId, order: 1, payor: [{ display: p.payer }], period: { start: `${today.slice(0, 4)}-01-01` },
        class: [{ type: { coding: [{ code: "group" }] }, value: p.group }, { type: { coding: [{ code: "plan" }] }, name: p.plan }],
      };
      await db.insert(fhirResources).values({
        resourceType: "Coverage", section: "Coverage", fhirId: `vcseed-cov-${pt.id}`, subjectKey: key, title: p.payer, value: `Member ID ${p.memberId} · ${p.plan}`, status: "active",
        date: `${today.slice(0, 4)}-01-01`, raw: gzipSync(Buffer.from(JSON.stringify(record))).toString("base64"), syncedAt: new Date(),
      });
    }
    // On today's schedule, twenty minutes apart from 9:00.
    const startsAt = new Date(`${today}T09:00:00`);
    startsAt.setMinutes(startsAt.getMinutes() + i * 20);
    await db.insert(appointments).values({
      clinicId: pt.clinicId, patientId: pt.id, patientName: pt.name, dateOfBirth: pt.dateOfBirth, providerId: pt.providerId, providerName: pt.providerId ? provs.get(pt.providerId) ?? null : null,
      date: today, startsAt, visitType: p.visitType ?? (p.visits.length ? "Follow Up" : "New Patient"), reason: "Made-up visit for the copay estimates", externalKey: `vcseed-${pt.id}-${today}`,
    });
  }
  const bcbs = PEOPLE[0]!;
  for (let n = 0; n < EXTRA_NEW; n++) await addClaim(`vcseed-extra-${n}`, { key: null, id: null, name: `Made Up ${n}` }, bcbs, copay25(80 + n, "99204"));

  console.log(`✓ ${claims} made-up paid claims, ${PEOPLE.filter((p) => p.group).length} insurance records, ${PEOPLE.length} patients on today's schedule (${today}).`);
  for (let i = 0; i < PEOPLE.length; i++) console.log(`  ${roster[i]!.name}: ${PEOPLE[i]!.visits.length ? `${PEOPLE[i]!.visits.length} paid visits, ${PEOPLE[i]!.payer}` : `no claims, group ${PEOPLE[i]!.group}`}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

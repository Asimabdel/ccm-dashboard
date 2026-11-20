/**
 * LOCAL-ONLY made-up ad campaigns, spend and leads for the Ads tab (fictional people, never real PHI).
 *
 *   DATABASE_URL=mysql://dev:devpass@127.0.0.1:3307/ccm node_modules/.bin/tsx scripts/seed-ads.ts
 *
 * Run scripts/seed-local.ts first. Builds four campaigns (one that works, one with slow follow-up, one with
 * clicks and no leads, a free one), about three months of daily spend, and leads in every state: called fast
 * and came in, never called, no answer, no-show, booked for next week, waiting right now, a repeat, an existing
 * patient, a missed call and a test. Safe to run again: it replaces its own rows. Refuses anything but a local database.
 */
import { asc, eq, inArray, like } from "drizzle-orm";
import { getDb } from "../server/db";
import { adCalls, adCampaigns, adLeads, adSpend, appointments, billClaims, billLines, bookingRequests, clinics, patients } from "../drizzle/schema";
import { normalizePhone } from "../shared/phone";
import { addDays, localDateStr } from "../shared/workforce";

const url = process.env.DATABASE_URL ?? "";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error("✗ Refusing to seed: DATABASE_URL must point at a local database (127.0.0.1 / localhost).");
  process.exit(1);
}

/** What became of a made-up website lead. */
type Fate = "came_in" | "came_in_slow" | "no_answer" | "not_called" | "didnt_book" | "no_show" | "upcoming" | "waiting" | "recent_booked" | "spam" | "existing";
interface WebLead { campaign: string; daysAgo: number; fate: Fate; keyword?: string; spanish?: boolean }

const CAMPAIGNS = [
  { code: "g-maple-en", name: "Google Search - Maple", channel: "google_search", language: "en", budget: 60_000, perDay: 2000, clicksPerDay: 5 },
  { code: "g-oak-en", name: "Google Search - Oak", channel: "google_search", language: "en", budget: 50_000, perDay: 1650, clicksPerDay: 4 },
  { code: "fb-familias-es", name: "Facebook - Familias", channel: "facebook", language: "es", budget: 30_000, perDay: 1000, clicksPerDay: 9 },
  { code: "gbp-maple", name: "Google clinic page - Maple", channel: "google_profile", language: "en", budget: null, perDay: 0, clicksPerDay: 0 },
] as const;

const WEB: WebLead[] = [
  // Google Maple: fast calls, most come in.
  ...[80, 74, 70, 66, 61, 55, 50, 47, 44, 40, 36].map((daysAgo, i): WebLead => ({ campaign: "g-maple-en", daysAgo, fate: "came_in", keyword: i % 2 ? "primary care doctor near me" : "doctors that take ambetter" })),
  { campaign: "g-maple-en", daysAgo: 58, fate: "no_show", keyword: "family doctor near me" },
  { campaign: "g-maple-en", daysAgo: 52, fate: "didnt_book", keyword: "primary care doctor near me" },
  { campaign: "g-maple-en", daysAgo: 12, fate: "upcoming", keyword: "annual physical near me" },
  { campaign: "g-maple-en", daysAgo: 6, fate: "recent_booked", keyword: "primary care doctor near me" },
  { campaign: "g-maple-en", daysAgo: 0, fate: "waiting", keyword: "doctors accepting new patients near me" },
  { campaign: "g-maple-en", daysAgo: 30, fate: "spam" },
  { campaign: "g-maple-en", daysAgo: 20, fate: "existing", keyword: "maple clinic phone number" },
  // Google Oak: slow follow-up, so few come in.
  ...[78, 72, 65, 60, 57, 51, 46, 42].map((daysAgo, i): WebLead => ({ campaign: "g-oak-en", daysAgo, fate: i % 2 ? "not_called" : "no_answer", keyword: "family doctor near me" })),
  { campaign: "g-oak-en", daysAgo: 69, fate: "came_in_slow", keyword: "blue cross blue shield doctors near me" },
  { campaign: "g-oak-en", daysAgo: 48, fate: "came_in_slow", keyword: "primary care doctor near me" },
  { campaign: "g-oak-en", daysAgo: 0, fate: "waiting", keyword: "pcp near me" },
  // Free clinic page.
  { campaign: "gbp-maple", daysAgo: 45, fate: "came_in" },
  { campaign: "gbp-maple", daysAgo: 38, fate: "came_in" },
  { campaign: "gbp-maple", daysAgo: 9, fate: "recent_booked" },
];

async function main() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const today = localDateStr();
  const clinicRows = await db.select({ id: clinics.id, name: clinics.name }).from(clinics).orderBy(asc(clinics.id));
  if (!clinicRows.length) throw new Error("Run scripts/seed-local.ts first (no clinics).");
  const roster = await db.select().from(patients).orderBy(asc(patients.id));
  if (roster.length < 42) throw new Error("Run scripts/seed-local.ts first (not enough patients).");

  // Replace this script's own rows.
  const mine = await db.select({ id: adCampaigns.id }).from(adCampaigns).where(inArray(adCampaigns.code, CAMPAIGNS.map((c) => c.code)));
  if (mine.length) {
    const ids = mine.map((c) => c.id);
    const leads = await db.select({ id: adLeads.id }).from(adLeads).where(inArray(adLeads.campaignId, ids));
    if (leads.length) await db.delete(adCalls).where(inArray(adCalls.leadId, leads.map((l) => l.id)));
    await db.delete(adLeads).where(inArray(adLeads.campaignId, ids));
    await db.delete(adSpend).where(inArray(adSpend.campaignId, ids));
    await db.delete(adCampaigns).where(inArray(adCampaigns.id, ids));
  }
  await db.delete(bookingRequests).where(like(bookingRequests.note, "adseed%"));
  const oldClaims = await db.select({ id: billClaims.id }).from(billClaims).where(like(billClaims.claimRef, "adseed-%"));
  if (oldClaims.length) {
    await db.delete(billLines).where(inArray(billLines.claimId, oldClaims.map((c) => c.id)));
    await db.delete(billClaims).where(like(billClaims.claimRef, "adseed-%"));
  }
  await db.delete(appointments).where(like(appointments.externalKey, "adseed-%"));

  // Campaigns: the first clinic for "Maple", the second for "Oak".
  const idOf = new Map<string, number>();
  for (const [i, c] of CAMPAIGNS.entries()) {
    const clinicId = c.code.includes("oak") ? (clinicRows[1] ?? clinicRows[0]!).id : c.code.startsWith("fb") ? null : clinicRows[0]!.id;
    const [res] = await db.insert(adCampaigns).values({
      name: c.name, channel: c.channel, code: c.code, clinicId, language: c.language, monthlyBudgetCents: c.budget, status: "active",
      trackingPhone: i === 0 ? "3465550100" : null, note: "Made-up campaign for local testing",
    });
    idOf.set(c.code, res.insertId);
  }

  // About three months of daily spend, with a little wobble.
  const spend: (typeof adSpend.$inferInsert)[] = [];
  for (const c of CAMPAIGNS) {
    if (!c.perDay) continue;
    for (let n = 85; n >= 1; n--) {
      const wobble = ((n * 7) % 5) - 2;
      spend.push({ campaignId: idOf.get(c.code)!, day: addDays(today, -n), costCents: c.perDay + wobble * 110, clicks: Math.max(0, c.clicksPerDay + (wobble > 0 ? 1 : 0)), impressions: c.clicksPerDay * 60 + wobble * 20, source: "upload" });
    }
  }
  for (let i = 0; i < spend.length; i += 500) await db.insert(adSpend).values(spend.slice(i, i + 500));

  // Leads: patients 13 on from the made-up roster (the first twelve have the copay seed's claims).
  let next = 12, claims = 0;
  const at = (daysAgo: number, hour: number, min = 0) => new Date(`${addDays(today, -daysAgo)}T${String(hour + 6).padStart(2, "0")}:${String(min).padStart(2, "0")}:00Z`); // ≈ Houston morning
  const addClaim = async (ref: string, pt: (typeof roster)[number], date: string, paid: number) => {
    const [res] = await db.insert(billClaims).values({
      claimRef: ref, altKey: ref, status: "paid", sourceUsed: "era835", billedCents: paid + 6000, allowedCents: paid + 2500, paidCents: paid, patientOwesCents: 2500, writtenOffCents: 3500,
      payerName: "BCBS OF TEXAS", filingIndicator: "BL", patientName: pt.name, subjectKey: `p:${pt.id}`, patientId: pt.id, matchSource: "name", firstServiceDate: date,
      lastPaidDate: addDays(date, 14) > today ? today : addDays(date, 14), eventCount: 1,
    });
    await db.insert(billLines).values({ claimId: res.insertId, lineNo: 1, code: "99204", units: 1, serviceDate: date, billedCents: paid + 6000, allowedCents: paid + 2500, paidCents: paid, patientOwesCents: 2500, writtenOffCents: 3500, adjustments: [{ group: "PR", code: "3", cents: 2500 }], remarks: [] });
    claims++;
  };
  const addVisit = async (pt: (typeof roster)[number], date: string, status: string) => {
    await db.insert(appointments).values({
      clinicId: pt.clinicId, patientId: pt.id, patientName: pt.name, dateOfBirth: pt.dateOfBirth, providerId: pt.providerId, date, startsAt: new Date(`${date}T16:00:00Z`), visitType: "New Patient",
      status: status as never, reason: "Made-up visit for the ads report", externalKey: `adseed-${pt.id}-${date}`,
    });
  };
  for (const [i, w] of WEB.entries()) {
    const pt = roster[next++ % roster.length]!;
    const known = w.fate !== "not_called" && w.fate !== "no_answer" && w.fate !== "spam" && w.fate !== "waiting" && w.fate !== "didnt_book";
    const phone = known ? pt.phoneNumber ?? `34655${String(50000 + i)}` : `34655${String(60000 + i)}`;
    const receivedAt = w.fate === "waiting" ? new Date(Date.now() - (40 + i) * 60_000) : at(w.daysAgo, 10, (i * 7) % 50);
    const fast = new Date(receivedAt.getTime() + (4 + (i % 9)) * 60_000), slow = new Date(receivedAt.getTime() + (26 + i) * 3600_000);
    const status = w.fate === "spam" ? "spam" : w.fate === "not_called" || w.fate === "waiting" ? "new" : w.fate === "no_answer" ? "no_answer" : w.fate === "didnt_book" ? "not_booked" : "scheduled";
    const firstContactAt = status === "new" || status === "spam" ? null : w.fate === "came_in_slow" || w.fate === "no_answer" ? slow : fast;
    const name = known ? pt.name : w.fate === "spam" ? "TEST please ignore" : `Made Up Lead ${i + 1}`;
    const [b] = await db.insert(bookingRequests).values({
      receivedAt, source: "website", name, phone, phoneKey: normalizePhone(phone), location: "Maple", clinicId: pt.clinicId, visitType: "New patient · Annual physical", preferred: "First available",
      spanish: !!w.spanish, status: status as never, attempts: status === "no_answer" ? 2 : 0, subjectKey: known ? `p:${pt.id}` : null, patientId: known ? pt.id : null, patientName: known ? pt.name : null,
      firstContactAt, note: "adseed",
    });
    await db.insert(adLeads).values({
      campaignId: idOf.get(w.campaign)!, kind: "web", at: receivedAt, name, phoneKey: normalizePhone(phone), bookingRequestId: b.insertId, subjectKey: known ? `p:${pt.id}` : null,
      keyword: w.keyword ?? null, adName: w.keyword ? "ad-1" : null, device: i % 3 ? "phone" : "computer", landing: "/",
    });
    const visitDay = addDays(today, -Math.max(0, w.daysAgo - 5));
    if (w.fate === "came_in" || w.fate === "came_in_slow") { await addVisit(pt, visitDay, "completed"); await addClaim(`adseed-${pt.id}-1`, pt, visitDay, 13_500 + (i % 4) * 1500); if (w.daysAgo > 60) await addClaim(`adseed-${pt.id}-2`, pt, addDays(visitDay, 30), 9_800); }
    if (w.fate === "no_show") await addVisit(pt, visitDay, "no_show");
    if (w.fate === "upcoming") await addVisit(pt, addDays(today, 4), "scheduled");
    if (w.fate === "existing") { await addClaim(`adseed-${pt.id}-0`, pt, addDays(today, -200), 11_000); await addVisit(pt, visitDay, "completed"); }
  }

  // Phone leads on the campaign with its own number: one answered and came in, one missed and called back, one missed and never returned.
  const calls: { daysAgo: number; answered: boolean; back?: number; cameIn?: boolean }[] = [{ daysAgo: 63, answered: true, cameIn: true }, { daysAgo: 41, answered: false, back: 25 }, { daysAgo: 37, answered: false }];
  for (const [i, c] of calls.entries()) {
    const pt = roster[next++ % roster.length]!;
    const startedAt = at(c.daysAgo, 11, i * 9);
    const phoneKey = c.cameIn ? normalizePhone(pt.phoneNumber) ?? `34655${70000 + i}` : `34655${70000 + i}`;
    const [l] = await db.insert(adLeads).values({
      campaignId: idOf.get("g-maple-en")!, kind: "call", at: startedAt, name: c.cameIn ? pt.name : null, phoneKey, subjectKey: c.cameIn ? `p:${pt.id}` : null,
      calledBackAt: c.back ? new Date(startedAt.getTime() + c.back * 60_000) : null, outcome: c.cameIn ? "scheduled" : null,
    });
    await db.insert(adCalls).values({ leadId: l.insertId, rcId: `adseed-call-${i}`, startedAt, durationSec: c.answered ? 240 : 0, answered: c.answered, result: c.answered ? "Accepted" : "Missed" });
    if (c.cameIn) { const day = addDays(today, -(c.daysAgo - 6)); await addVisit(pt, day, "completed"); await addClaim(`adseed-${pt.id}-1`, pt, day, 14_200); }
  }
  // The same person twice: the first Maple lead also clicked the Facebook ad two weeks later.
  const [first] = await db.select().from(adLeads).where(eq(adLeads.campaignId, idOf.get("g-maple-en")!)).orderBy(asc(adLeads.at)).limit(1);
  if (first) await db.insert(adLeads).values({ campaignId: idOf.get("fb-familias-es")!, kind: "manual", at: new Date(first.at.getTime() + 14 * 86_400_000), name: first.name, phoneKey: first.phoneKey, subjectKey: first.subjectKey, note: "Said they also saw the Facebook ad" });

  console.log(`✓ ${CAMPAIGNS.length} made-up campaigns, ${spend.length} days of spend, ${WEB.length} website leads, ${calls.length} phone leads, ${claims} paid claims (${today}).`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

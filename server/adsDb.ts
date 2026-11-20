// Ads in Master Billing (owner only, 2026-11-20): campaigns, what they cost, and every lead they bring in,
// followed to "came in" and "insurance paid" with the same rules as the ZocDoc tab.
//
// Leads arrive three ways, none of them through the owner's screen:
//   - a website booking that carries a campaign's code (bookingsDb.ingestBooking → leadFromBooking),
//   - a call to a campaign's own phone number (the RingCentral call-log sync → noteAdCall),
//   - one added by hand on the Ads tab.
// The money side (spend, insurance paid) is only read through the Master Billing router (owner guard). Staff
// only ever see that a booking "came from an ad" so they call it first.
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { getDb } from "./db";
import { adCalls, adCampaigns, adLeads, adSpend, bookingRequests, clinics, users, workTaskActivities, workTasks } from "../drizzle/schema";
import {
  AD_CHANNEL_KEYS, AD_LANGUAGE_KEYS, AD_LEAD_OUTCOMES, AD_REPEAT_DAYS, AD_STATUSES, adChannel, adCode, adsSummary, budgetPace, channelForSource, isAdCode, spreadSpend,
  trackingSuffix, trackingUrl, type ACampaign, type ALead, type ALeadResult, type AdChannel, type AdLeadKind, type AdLeadOutcome, type AdStatus, type AdTouch,
} from "../shared/ads";
import type { BookingStatus } from "../shared/booking";
import { formatPhone, normalizePhone } from "../shared/phone";
import { addDays, isValidDateStr, localDateStr } from "../shared/workforce";
import { audit, buildPhoneIndex, createTask, frontDeskFor, WorkspaceError, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}
const insertId = (res: unknown) => Number((res as [{ insertId?: number }])[0]?.insertId ?? (res as { insertId?: number }).insertId ?? 0);

/** Jobs (website bookings, the call sync) act as the practice, not as a person. */
async function systemActor(): Promise<WorkspaceActor> {
  const [u] = await (await db()).select({ id: users.id }).from(users).where(eq(users.role, "admin")).orderBy(asc(users.id)).limit(1);
  if (!u) throw new Error("No admin user to file ad leads under.");
  return { id: u.id, name: "Ads", role: "admin", clinicIds: null };
}

// ── Campaigns ────────────────────────────────────────────────────────────────

const campaignCols = {
  id: adCampaigns.id, name: adCampaigns.name, channel: adCampaigns.channel, code: adCampaigns.code, clinicId: adCampaigns.clinicId, clinicName: clinics.name,
  language: adCampaigns.language, trackingPhone: adCampaigns.trackingPhone, monthlyBudgetCents: adCampaigns.monthlyBudgetCents, status: adCampaigns.status,
  landingUrl: adCampaigns.landingUrl, outsideName: adCampaigns.outsideName, note: adCampaigns.note, createdAt: adCampaigns.createdAt,
};
export async function listCampaigns() {
  const rows = await (await db()).select(campaignCols).from(adCampaigns).leftJoin(clinics, eq(clinics.id, adCampaigns.clinicId)).orderBy(asc(adCampaigns.status), asc(adCampaigns.name));
  return rows.map((c) => ({ ...c, channel: c.channel as AdChannel, status: c.status as AdStatus, link: { suffix: trackingSuffix(c), url: trackingUrl(c) } }));
}

export interface CampaignInput {
  id?: number | null;
  name: string;
  channel: AdChannel;
  code?: string | null;
  clinicId: number | null;
  language: string;
  trackingPhone?: string | null;
  monthlyBudgetCents?: number | null;
  status: AdStatus;
  landingUrl?: string | null;
  outsideName?: string | null;
  note?: string | null;
}

/** Add a campaign, or change one (id). The code can't change once leads or spend exist under it. */
export async function saveCampaign(actor: WorkspaceActor, input: CampaignInput) {
  const d = await db();
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new WorkspaceError("Give the campaign a name, e.g. Google Search - Katy.");
  if (!AD_CHANNEL_KEYS.includes(input.channel)) throw new WorkspaceError("Pick where the ad runs.");
  if (!(AD_LANGUAGE_KEYS as string[]).includes(input.language)) throw new WorkspaceError("Pick the ad's language.");
  if (!(AD_STATUSES as readonly string[]).includes(input.status)) throw new WorkspaceError("Pick a status.");
  const code = input.code?.trim() ? input.code.trim().toLowerCase() : adCode(name);
  if (!isAdCode(code)) throw new WorkspaceError("The tracking code needs 3 to 40 lowercase letters, numbers or dashes, e.g. g-katy-en.");
  const phone = input.trackingPhone?.trim() ? normalizePhone(input.trackingPhone) : null;
  if (input.trackingPhone?.trim() && !phone) throw new WorkspaceError("The phone number needs 10 digits.");
  const budget = input.monthlyBudgetCents ?? null;
  if (budget != null && (budget < 0 || budget > 50_000_000)) throw new WorkspaceError("That monthly budget doesn't look right.");
  const landingUrl = input.landingUrl?.trim() || null;
  if (landingUrl && !/^https:\/\/[^\s]+$/.test(landingUrl)) throw new WorkspaceError("The page address should start with https://");
  if (input.clinicId) {
    const [c] = await d.select({ id: clinics.id }).from(clinics).where(eq(clinics.id, input.clinicId)).limit(1);
    if (!c) throw new WorkspaceError("That clinic wasn't found.", "NOT_FOUND");
  }
  const id = input.id ?? null;
  const others = await d.select({ id: adCampaigns.id, code: adCampaigns.code, trackingPhone: adCampaigns.trackingPhone, status: adCampaigns.status, name: adCampaigns.name }).from(adCampaigns);
  if (others.some((o) => o.id !== id && o.code === code)) throw new WorkspaceError(`Another campaign already uses the code "${code}".`);
  const clash = phone ? others.find((o) => o.id !== id && o.trackingPhone === phone && o.status !== "ended") : null;
  if (clash) throw new WorkspaceError(`${formatPhone(phone)} is already the number for "${clash.name}". Each campaign needs its own number.`);
  const values = {
    name, channel: input.channel, code, clinicId: input.clinicId ?? null, language: input.language, trackingPhone: phone, monthlyBudgetCents: budget, status: input.status,
    landingUrl: landingUrl?.slice(0, 255) ?? null, outsideName: input.outsideName?.trim().slice(0, 160) || null, note: input.note?.trim().slice(0, 255) || null,
  };
  if (id) {
    const old = others.find((o) => o.id === id);
    if (!old) throw new WorkspaceError("That campaign wasn't found.", "NOT_FOUND");
    if (old.code !== code) {
      const [[lead], [spend]] = await Promise.all([
        d.select({ id: adLeads.id }).from(adLeads).where(eq(adLeads.campaignId, id)).limit(1),
        d.select({ id: adSpend.id }).from(adSpend).where(eq(adSpend.campaignId, id)).limit(1),
      ]);
      if (lead || spend) throw new WorkspaceError("This campaign already has leads or spend under its code, so the code stays. (Changing it would break the links already in the ads.)");
    }
    await d.update(adCampaigns).set(values).where(eq(adCampaigns.id, id));
    await audit(actor, "manage_ads", { entityType: "adCampaign", entityId: id, description: `Changed the ad campaign "${name}"` });
    return { ok: true, id };
  }
  const newId = insertId(await d.insert(adCampaigns).values({ ...values, createdByUserId: actor.id }));
  await audit(actor, "manage_ads", { entityType: "adCampaign", entityId: newId, description: `Added the ad campaign "${name}" (${adChannel(input.channel).label})` });
  return { ok: true, id: newId };
}

/** Remove a campaign that has nothing under it. One with leads or spend is ended instead (its numbers stay). */
export async function removeCampaign(actor: WorkspaceActor, id: number) {
  const d = await db();
  const [c] = await d.select({ id: adCampaigns.id, name: adCampaigns.name }).from(adCampaigns).where(eq(adCampaigns.id, id)).limit(1);
  if (!c) throw new WorkspaceError("That campaign wasn't found.", "NOT_FOUND");
  const [[lead], [spend]] = await Promise.all([
    d.select({ id: adLeads.id }).from(adLeads).where(eq(adLeads.campaignId, id)).limit(1),
    d.select({ id: adSpend.id }).from(adSpend).where(eq(adSpend.campaignId, id)).limit(1),
  ]);
  if (lead || spend) {
    await d.update(adCampaigns).set({ status: "ended" }).where(eq(adCampaigns.id, id));
    await audit(actor, "manage_ads", { entityType: "adCampaign", entityId: id, description: `Ended the ad campaign "${c.name}" (it has leads or spend, so it stays in the numbers)` });
    return { ok: true, ended: true };
  }
  await d.delete(adCampaigns).where(eq(adCampaigns.id, id));
  await audit(actor, "manage_ads", { entityType: "adCampaign", entityId: id, description: `Removed the ad campaign "${c.name}"` });
  return { ok: true, ended: false };
}

// ── Spend ────────────────────────────────────────────────────────────────────

const MAX_SPEND_ROWS = 2000;
type SpendRow = { campaignId: number; day: string; costCents: number; clicks: number; impressions: number };

async function upsertSpend(actor: WorkspaceActor, rows: SpendRow[], source: "manual" | "upload") {
  const d = await db();
  // The same campaign + day twice in one batch (a report split by device or network) is one day's total.
  const merged = new Map<string, SpendRow>();
  for (const r of rows) {
    const k = `${r.campaignId}|${r.day}`;
    const m = merged.get(k);
    if (m) { m.costCents += r.costCents; m.clicks += r.clicks; m.impressions += r.impressions; } else merged.set(k, { ...r });
  }
  const values = Array.from(merged.values()).map((r) => ({ ...r, source, createdByUserId: actor.id }));
  for (let i = 0; i < values.length; i += 500) {
    await d.insert(adSpend).values(values.slice(i, i + 500)).onDuplicateKeyUpdate({
      set: { costCents: sql`VALUES(costCents)`, clicks: sql`VALUES(clicks)`, impressions: sql`VALUES(impressions)`, source: sql`VALUES(source)` },
    });
  }
  return values.length;
}

/** One amount for a stretch of days (a month's invoice, a flyer run): spread evenly over the days. Replaces what was there. */
export async function saveSpend(actor: WorkspaceActor, input: { campaignId: number; from: string; to: string; costCents: number; clicks?: number | null; impressions?: number | null }) {
  const d = await db();
  if (!isValidDateStr(input.from) || !isValidDateStr(input.to) || input.to < input.from) throw new WorkspaceError("Pick the first and last day the amount covers.");
  if (input.costCents < 0 || input.costCents > 100_000_000) throw new WorkspaceError("That amount doesn't look right.");
  const [c] = await d.select({ id: adCampaigns.id, name: adCampaigns.name }).from(adCampaigns).where(eq(adCampaigns.id, input.campaignId)).limit(1);
  if (!c) throw new WorkspaceError("That campaign wasn't found.", "NOT_FOUND");
  const days = spreadSpend(input.from, input.to, input.costCents);
  if (!days.length) throw new WorkspaceError("That's too long a stretch for one amount (a year at most).");
  const clicks = spreadSpend(input.from, input.to, Math.max(0, input.clicks ?? 0)), impressions = spreadSpend(input.from, input.to, Math.max(0, input.impressions ?? 0));
  await upsertSpend(actor, days.map((x, i) => ({ campaignId: c.id, day: x.day, costCents: x.costCents, clicks: clicks[i]?.costCents ?? 0, impressions: impressions[i]?.costCents ?? 0 })), "manual");
  await audit(actor, "manage_ads", { entityType: "adCampaign", entityId: c.id, description: `Entered ad spend for "${c.name}", ${input.from} to ${input.to}` });
  return { ok: true, days: days.length };
}

/** Rows read from an uploaded Google / Facebook report (the browser matched each to a campaign). The same day again replaces it. */
export async function importSpend(actor: WorkspaceActor, input: { fileName: string; rows: SpendRow[] }) {
  if (input.rows.length > MAX_SPEND_ROWS) throw new WorkspaceError(`Send at most ${MAX_SPEND_ROWS} rows at a time.`);
  const d = await db();
  const ids = new Set((await d.select({ id: adCampaigns.id }).from(adCampaigns)).map((c) => c.id));
  const rows = input.rows.filter((r) => ids.has(r.campaignId) && isValidDateStr(r.day) && r.costCents >= 0);
  const saved = await upsertSpend(actor, rows, "upload");
  const total = rows.reduce((s, r) => s + r.costCents, 0);
  await audit(actor, "manage_ads", { entityType: "adSpend", description: `Uploaded an ad spend report (${saved} campaign-days, $${(total / 100).toFixed(2)})` });
  return { saved, skipped: input.rows.length - rows.length, totalCents: total };
}

/** A campaign's spend by month (its side panel). */
export async function campaignSpend(campaignId: number) {
  const d = await db();
  const rows = await d.select({
    month: sql<string>`LEFT(${adSpend.day}, 7)`, costCents: sql<number>`SUM(${adSpend.costCents})`, clicks: sql<number>`SUM(${adSpend.clicks})`, impressions: sql<number>`SUM(${adSpend.impressions})`,
    days: sql<number>`COUNT(*)`, first: sql<string>`MIN(${adSpend.day})`, last: sql<string>`MAX(${adSpend.day})`,
  }).from(adSpend).where(eq(adSpend.campaignId, campaignId)).groupBy(sql`LEFT(${adSpend.day}, 7)`).orderBy(desc(sql`LEFT(${adSpend.day}, 7)`)).limit(36);
  return rows.map((r) => ({ month: r.month, costCents: Number(r.costCents), clicks: Number(r.clicks), impressions: Number(r.impressions), days: Number(r.days), first: r.first, last: r.last }));
}

// ── Leads coming in ──────────────────────────────────────────────────────────

/** The campaign a tracking link's code belongs to. A code MyPCP hasn't seen is added, so no lead is ever dropped. */
async function campaignForCode(touch: AdTouch): Promise<{ id: number; name: string; clinicId: number | null }> {
  const d = await db();
  const find = async () => (await d.select({ id: adCampaigns.id, name: adCampaigns.name, clinicId: adCampaigns.clinicId }).from(adCampaigns).where(eq(adCampaigns.code, touch.campaign)).limit(1))[0];
  const hit = await find();
  if (hit) return hit;
  try {
    const id = insertId(await d.insert(adCampaigns).values({
      name: touch.campaign, channel: channelForSource(touch.source, touch.medium), code: touch.campaign, language: "en", status: "active",
      note: "Added by itself: a booking arrived with this tracking code. Fill in the details.",
    }));
    return { id, name: touch.campaign, clinicId: null };
  } catch {
    const again = await find(); // two bookings at once
    if (again) return again;
    throw new Error("Could not add the campaign for a new tracking code.");
  }
}

/**
 * A website booking that arrived with a campaign's tracking code. The same phone already a lead for that campaign
 * in the last 90 days (they called first, then booked online) stays one lead.
 */
export async function leadFromBooking(input: { bookingRequestId: number; touch: AdTouch; name: string; phoneKey: string | null; at: Date; subjectKey: string | null }) {
  const d = await db();
  const c = await campaignForCode(input.touch);
  const since = new Date(input.at.getTime() - AD_REPEAT_DAYS * 86_400_000);
  const [same] = input.phoneKey ? await d.select({ id: adLeads.id }).from(adLeads)
    .where(and(eq(adLeads.campaignId, c.id), eq(adLeads.phoneKey, input.phoneKey), isNull(adLeads.bookingRequestId), gte(adLeads.at, since))).orderBy(asc(adLeads.at)).limit(1) : [];
  const details = { keyword: input.touch.keyword, adName: input.touch.adName, clickId: input.touch.clickId, device: input.touch.device, landing: input.touch.landing };
  if (same) {
    await d.update(adLeads).set({ bookingRequestId: input.bookingRequestId, name: input.name.slice(0, 120), subjectKey: input.subjectKey, ...details }).where(eq(adLeads.id, same.id));
    return { leadId: same.id, campaignName: c.name };
  }
  const leadId = insertId(await d.insert(adLeads).values({
    campaignId: c.id, kind: "web", at: input.at, name: input.name.slice(0, 120), phoneKey: input.phoneKey, bookingRequestId: input.bookingRequestId, subjectKey: input.subjectKey, ...details,
  }));
  return { leadId, campaignName: c.name };
}

/** Which bookings came from an ad (for the front desk's list: no money, just "call this one first"). */
export async function adNamesForBookings(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await (await db()).select({ id: adLeads.bookingRequestId, name: adCampaigns.name, channel: adCampaigns.channel }).from(adLeads)
    .innerJoin(adCampaigns, eq(adCampaigns.id, adLeads.campaignId)).where(inArray(adLeads.bookingRequestId, ids));
  return new Map(rows.filter((r) => r.id != null).map((r) => [r.id!, adChannel(r.channel).label]));
}

/** The phone numbers that belong to campaigns (last 10 digits → campaign), for the call sync. */
export async function trackingNumbers(): Promise<Map<string, { id: number; name: string; clinicId: number | null }>> {
  const rows = await (await db()).select({ id: adCampaigns.id, name: adCampaigns.name, clinicId: adCampaigns.clinicId, phone: adCampaigns.trackingPhone, status: adCampaigns.status })
    .from(adCampaigns).where(ne(adCampaigns.status, "ended"));
  return new Map(rows.filter((r) => r.phone).map((r) => [r.phone!, { id: r.id, name: r.name, clinicId: r.clinicId }]));
}

export interface AdCallInput {
  rcId: string;
  direction: "inbound" | "outbound";
  /** The outside number. */
  otherNumber: string;
  /** Our number on the call: the one they dialed, or the one we called from. */
  ownNumber: string | null;
  startedAt: Date;
  durationSec: number;
  answered: boolean;
  missed: boolean;
  result: string | null;
}

/**
 * From the call sync, for every call: a call TO a campaign's number is that campaign's lead (whoever is calling),
 * and a call FROM us to someone whose ad call we missed counts as the call back. Safe to see the same call twice.
 */
export async function noteAdCall(call: AdCallInput, numbers: Map<string, { id: number; name: string; clinicId: number | null }>, who?: { key: string; name: string } | null) {
  const d = await db();
  if (call.direction === "outbound") {
    // Our call to someone with a missed ad call that nobody has returned yet.
    const open = await d.select({ id: adLeads.id, at: adLeads.at }).from(adLeads)
      .where(and(eq(adLeads.phoneKey, call.otherNumber), eq(adLeads.kind, "call"), isNull(adLeads.calledBackAt), lte(adLeads.at, call.startedAt), gte(adLeads.at, new Date(call.startedAt.getTime() - 30 * 86_400_000))));
    for (const l of open) {
      const [picked] = await d.select({ id: adCalls.id }).from(adCalls).where(and(eq(adCalls.leadId, l.id), eq(adCalls.answered, true))).limit(1);
      if (!picked) await d.update(adLeads).set({ calledBackAt: call.startedAt }).where(eq(adLeads.id, l.id));
    }
    return { lead: false };
  }
  const campaign = call.ownNumber ? numbers.get(call.ownNumber) : undefined;
  if (!campaign) return { lead: false };
  const [seen] = await d.select({ id: adCalls.id, leadId: adCalls.leadId }).from(adCalls).where(eq(adCalls.rcId, call.rcId.slice(0, 120))).limit(1);
  let leadId = seen?.leadId ?? 0;
  if (seen) {
    // RingCentral fills in the result late: keep the newest.
    await d.update(adCalls).set({ durationSec: Math.min(call.durationSec, 86_400), answered: call.answered, result: call.result?.slice(0, 60) ?? null }).where(eq(adCalls.id, seen.id));
  } else {
    const since = new Date(call.startedAt.getTime() - AD_REPEAT_DAYS * 86_400_000);
    const [lead] = await d.select({ id: adLeads.id }).from(adLeads)
      .where(and(eq(adLeads.campaignId, campaign.id), eq(adLeads.phoneKey, call.otherNumber), gte(adLeads.at, since), lte(adLeads.at, new Date(call.startedAt.getTime() + 60_000)))).orderBy(desc(adLeads.at)).limit(1);
    leadId = lead?.id ?? insertId(await d.insert(adLeads).values({
      campaignId: campaign.id, kind: "call", at: call.startedAt, name: who?.name?.slice(0, 120) ?? null, phoneKey: call.otherNumber, subjectKey: who?.key ?? null,
    }));
    try {
      await d.insert(adCalls).values({ leadId, rcId: call.rcId.slice(0, 120), startedAt: call.startedAt, durationSec: Math.min(call.durationSec, 86_400), answered: call.answered, result: call.result?.slice(0, 60) ?? null });
    } catch (e) {
      if (!String((e as Error).message).includes("Duplicate")) throw e;
    }
  }
  // A missed call from an ad costs the same as an answered one: someone gets a task to call back, once, while it's fresh.
  const [l] = await d.select({ id: adLeads.id, taskId: adLeads.taskId, calledBackAt: adLeads.calledBackAt }).from(adLeads).where(eq(adLeads.id, leadId)).limit(1);
  if (!l) return { lead: true };
  if (call.answered) {
    if (l.taskId) await closeCallBackTask(l.taskId, "They called again and we picked up");
    return { lead: true };
  }
  const fresh = Date.now() - call.startedAt.getTime() < 24 * 3600_000;
  if (call.missed && fresh && !l.taskId && !l.calledBackAt) {
    const [picked] = await d.select({ id: adCalls.id }).from(adCalls).where(and(eq(adCalls.leadId, leadId), eq(adCalls.answered, true))).limit(1);
    if (!picked) {
      const desk = await frontDeskFor(campaign.clinicId);
      const task = await createTask(await systemActor(), {
        title: `Call back: missed call from an ad${who ? ` (${who.name})` : ""}`.slice(0, 250),
        description: [
          `Someone called the number in our ad (${campaign.name}) and nobody picked up.`,
          `Phone: ${formatPhone(call.otherNumber)}`,
          who ? `Looks like our patient: ${who.name}` : "Not in MyPCP yet: most likely a new patient.",
          "",
          "Call back as soon as you can. We paid for this call; a new patient who waits books somewhere else.",
        ].join("\n"),
        clinicId: campaign.clinicId, assignedUserId: desk.assignedUserId, assignedRole: desk.assignedRole,
        priority: "high", category: "patient_call", dueDate: localDateStr(), sourceType: "ad_call", sourceRef: String(leadId),
      });
      await d.update(adLeads).set({ taskId: task.id }).where(and(eq(adLeads.id, leadId), isNull(adLeads.taskId)));
    }
  }
  return { lead: true };
}

async function closeCallBackTask(taskId: number, reason: string) {
  const d = await db();
  const [t] = await d.select({ status: workTasks.status }).from(workTasks).where(eq(workTasks.id, taskId)).limit(1);
  if (!t || t.status === "completed" || t.status === "cancelled") return;
  const actor = await systemActor();
  await d.update(workTasks).set({ status: "completed", completedAt: new Date() }).where(eq(workTasks.id, taskId));
  await d.insert(workTaskActivities).values({ taskId, userId: actor.id, type: "status_changed", meta: { from: t.status, to: "completed", reason } });
}

/** A lead the owner adds by hand (a patient who said "I saw your flyer"). */
export async function addManualLead(actor: WorkspaceActor, input: { campaignId: number; name: string; phone?: string | null; day?: string | null; note?: string | null }) {
  const d = await db();
  const [c] = await d.select({ id: adCampaigns.id, name: adCampaigns.name }).from(adCampaigns).where(eq(adCampaigns.id, input.campaignId)).limit(1);
  if (!c) throw new WorkspaceError("That campaign wasn't found.", "NOT_FOUND");
  const name = input.name.trim().slice(0, 120);
  const phoneKey = input.phone?.trim() ? normalizePhone(input.phone) : null;
  if (!name && !phoneKey) throw new WorkspaceError("Enter the person's name or phone number.");
  if (input.phone?.trim() && !phoneKey) throw new WorkspaceError("The phone number needs 10 digits.");
  if (input.day && (!isValidDateStr(input.day) || input.day > localDateStr())) throw new WorkspaceError("Pick today or an earlier day.");
  const at = input.day && input.day !== localDateStr() ? new Date(`${input.day}T18:00:00Z`) : new Date();
  const who = phoneKey ? (await buildPhoneIndex()).get(phoneKey) ?? null : null;
  const id = insertId(await d.insert(adLeads).values({
    campaignId: c.id, kind: "manual", at, name: name || who?.name?.slice(0, 120) || null, phoneKey, subjectKey: who?.key ?? null, note: input.note?.trim().slice(0, 255) || null, createdByUserId: actor.id,
  }));
  await audit(actor, "manage_ads", { entityType: "adLead", entityId: id, description: `Added a lead by hand to "${c.name}"` });
  return { ok: true, id };
}

/** How a phone or hand-added lead went (website bookings are marked on the Website bookings page). */
export async function setLeadOutcome(actor: WorkspaceActor, input: { id: number; outcome: AdLeadOutcome | null; note?: string | null }) {
  const d = await db();
  const [l] = await d.select({ id: adLeads.id, kind: adLeads.kind, bookingRequestId: adLeads.bookingRequestId }).from(adLeads).where(eq(adLeads.id, input.id)).limit(1);
  if (!l) throw new WorkspaceError("That lead wasn't found.", "NOT_FOUND");
  if (l.bookingRequestId) throw new WorkspaceError("This one is a website booking: mark it on the Website bookings page.");
  if (input.outcome && !(AD_LEAD_OUTCOMES as readonly string[]).includes(input.outcome)) throw new WorkspaceError("Pick how it went.");
  await d.update(adLeads).set({ outcome: input.outcome, ...(input.note !== undefined ? { note: input.note?.trim().slice(0, 255) || null } : {}) }).where(eq(adLeads.id, l.id));
  await audit(actor, "manage_ads", { entityType: "adLead", entityId: l.id, description: `Marked an ad lead: ${input.outcome ?? "cleared"}` });
  return { ok: true };
}

// ── The report ───────────────────────────────────────────────────────────────

interface Loaded {
  campaigns: ACampaign[];
  leads: ALead[];
  /** Name and phone per lead (never leaves the owner's routes). */
  who: Map<number, { name: string | null; phoneKey: string | null; subjectKey: string | null; note: string | null; device: string | null; adName: string | null; at: Date; bookingRequestId: number | null; outcome: string | null }>;
  claimsByPerson: Awaited<ReturnType<typeof import("./zocdocDb").claimsAndVisits>>["claimsByPerson"];
  visitsByPerson: Awaited<ReturnType<typeof import("./zocdocDb").claimsAndVisits>>["visitsByPerson"];
}

async function load(from: string, to: string): Promise<Loaded> {
  const d = await db();
  const campaigns: ACampaign[] = (await d.select(campaignCols).from(adCampaigns).leftJoin(clinics, eq(clinics.id, adCampaigns.clinicId)))
    .map((c) => ({ id: c.id, name: c.name, channel: c.channel as AdChannel, code: c.code, clinicId: c.clinicId, clinicName: c.clinicName, language: c.language, monthlyBudgetCents: c.monthlyBudgetCents, status: c.status as AdStatus }));
  // Earlier leads too, so the same person again is recognised; a day of slack each side for the time zone.
  const lo = new Date(`${addDays(from, -AD_REPEAT_DAYS - 1)}T00:00:00Z`), hi = new Date(`${addDays(to, 2)}T00:00:00Z`);
  const rows = await d.select({ l: adLeads, bStatus: bookingRequests.status, bFirst: bookingRequests.firstContactAt, bName: bookingRequests.name, bPhone: bookingRequests.phoneKey, bSubject: bookingRequests.subjectKey })
    .from(adLeads).leftJoin(bookingRequests, eq(bookingRequests.id, adLeads.bookingRequestId)).where(and(gte(adLeads.at, lo), lte(adLeads.at, hi)));
  const ids = rows.map((r) => r.l.id);
  const calls = new Map<number, { n: number; answered: boolean }>();
  for (let i = 0; i < ids.length; i += 1000) {
    const agg = await d.select({ leadId: adCalls.leadId, n: sql<number>`COUNT(*)`, answered: sql<number>`MAX(${adCalls.answered})` }).from(adCalls).where(inArray(adCalls.leadId, ids.slice(i, i + 1000))).groupBy(adCalls.leadId);
    for (const a of agg) calls.set(a.leadId, { n: Number(a.n), answered: Number(a.answered) > 0 });
  }
  // People who weren't in MyPCP when they first got in touch usually are once they've been booked: look again by phone.
  const unmatched = rows.filter((r) => !(r.l.subjectKey ?? r.bSubject) && (r.l.phoneKey ?? r.bPhone));
  if (unmatched.length) {
    const phones = await buildPhoneIndex();
    for (const r of unmatched) {
      const hit = phones.get((r.l.phoneKey ?? r.bPhone)!);
      if (!hit) continue;
      r.l.subjectKey = hit.key;
      await d.update(adLeads).set({ subjectKey: hit.key }).where(eq(adLeads.id, r.l.id));
    }
  }
  const { claimsAndVisits } = await import("./zocdocDb");
  const { aliasOf, claimsByPerson, visitsByPerson } = await claimsAndVisits(rows.map((r) => r.l.subjectKey ?? r.bSubject));
  const who: Loaded["who"] = new Map();
  const leads: ALead[] = rows.map(({ l, bStatus, bFirst, bName, bPhone, bSubject }) => {
    const subjectKey = l.subjectKey ?? bSubject ?? null, phoneKey = l.phoneKey ?? bPhone ?? null;
    who.set(l.id, { name: l.name ?? bName ?? null, phoneKey, subjectKey, note: l.note, device: l.device, adName: l.adName, at: l.at, bookingRequestId: l.bookingRequestId, outcome: l.outcome });
    const c = calls.get(l.id);
    return {
      id: l.id, campaignId: l.campaignId, kind: l.kind as AdLeadKind, at: l.at, day: localDateStr(l.at),
      person: subjectKey ? aliasOf.get(subjectKey) ?? subjectKey : phoneKey ? `ph:${phoneKey}` : `l:${l.id}`, matched: !!subjectKey,
      booking: l.bookingRequestId && bStatus ? { status: bStatus as BookingStatus, firstContactAt: bFirst ?? null } : null,
      calls: c?.n ?? 0, answered: c?.answered ?? false, calledBackAt: l.calledBackAt, outcome: (l.outcome as AdLeadOutcome | null) ?? null, keyword: l.keyword, adName: l.adName,
    };
  });
  return { campaigns, leads, who, claimsByPerson, visitsByPerson };
}

async function summarize(from: string, to: string) {
  const d = await db();
  const loaded = await load(from, to);
  const spend = await d.select({ campaignId: adSpend.campaignId, day: adSpend.day, costCents: adSpend.costCents, clicks: adSpend.clicks, impressions: adSpend.impressions })
    .from(adSpend).where(and(gte(adSpend.day, from), lte(adSpend.day, to)));
  const today = localDateStr();
  const summary = adsSummary({ campaigns: loaded.campaigns, spend, leads: loaded.leads, from, to, claimsByPerson: loaded.claimsByPerson, visitsByPerson: loaded.visitsByPerson, now: new Date(), today });
  return { loaded, summary, today };
}

/** The Ads tab: spend vs. leads vs. patients vs. insurance paid, by campaign / channel / clinic / language / month. */
export async function adsReport(actor: WorkspaceActor, input: { from: string; to: string }) {
  const d = await db();
  const { summary, today } = await summarize(input.from, input.to);
  const campaigns = await listCampaigns();
  // This month's spend against each budget, whatever dates are on screen.
  const month = today.slice(0, 7);
  const mtd = new Map((await d.select({ campaignId: adSpend.campaignId, cents: sql<number>`SUM(${adSpend.costCents})` }).from(adSpend)
    .where(and(gte(adSpend.day, `${month}-01`), lte(adSpend.day, today))).groupBy(adSpend.campaignId)).map((r) => [r.campaignId, Number(r.cents)]));
  const [edge] = await d.select({ last: sql<string | null>`MAX(${adSpend.day})`, first: sql<string | null>`MIN(${adSpend.day})` }).from(adSpend);
  const [{ n: leadsEver } = { n: 0 }] = await d.select({ n: sql<number>`COUNT(*)` }).from(adLeads);
  await audit(actor, "view_ads", { entityType: "adsReport", description: `Viewed the Ads report ${input.from} to ${input.to}` });
  const { results: _results, ...rest } = summary;
  return {
    ...rest, today,
    campaignList: campaigns.map((c) => {
      const spentThisMonthCents = mtd.get(c.id) ?? 0;
      return { ...c, paid: adChannel(c.channel).paid, spentThisMonthCents, pace: budgetPace(spentThisMonthCents, c.monthlyBudgetCents, today) };
    }),
    spendThrough: edge?.last ?? null, spendFrom: edge?.first ?? null, leadsEver: Number(leadsEver),
    clinicList: await d.select({ id: clinics.id, name: clinics.name, address: clinics.address }).from(clinics).orderBy(asc(clinics.name)),
  };
}

export const AD_LEAD_FILTERS = ["all", "waiting", "not_called", "booked", "came_in", "upcoming", "pending", "lost", "repeat", "existing", "spam"] as const;
export type AdLeadFilter = (typeof AD_LEAD_FILTERS)[number];
const PAGE = 50;

/** One row per lead with who they are and what became of them (owner only). */
export async function adsLeads(actor: WorkspaceActor, input: { from: string; to: string; filter: AdLeadFilter; campaignId?: number | null; page: number }) {
  const { loaded, summary } = await summarize(input.from, input.to);
  const want = (r: ALeadResult) => {
    if (input.campaignId && r.campaignId !== input.campaignId) return false;
    switch (input.filter) {
      case "waiting": return r.waiting;
      case "not_called": return !r.spam && !r.called;
      case "booked": return r.counted && r.booked;
      case "came_in": return r.counted && r.cameIn;
      case "upcoming": return r.counted && r.outcome === "upcoming";
      case "pending": return r.counted && r.outcome === "pending";
      case "lost": return r.counted && r.outcome === "never";
      case "repeat": return r.repeat;
      case "existing": return r.existing;
      case "spam": return r.spam;
      default: return !r.spam;
    }
  };
  const list = summary.results.filter(want).sort((a, b) => (loaded.who.get(b.id)?.at.getTime() ?? 0) - (loaded.who.get(a.id)?.at.getTime() ?? 0));
  const page = Math.max(1, input.page);
  const names = new Map(loaded.campaigns.map((c) => [c.id, c.name]));
  const rows = list.slice((page - 1) * PAGE, page * PAGE).map((r) => {
    const w = loaded.who.get(r.id)!;
    return {
      id: r.id, at: w.at, campaignId: r.campaignId, campaignName: names.get(r.campaignId) ?? "(removed)", kind: r.kind, name: w.name, phone: w.phoneKey ? formatPhone(w.phoneKey) : null,
      subjectKey: w.subjectKey, bookingRequestId: w.bookingRequestId, keyword: r.keyword, adName: w.adName, device: w.device, note: w.note, markedOutcome: w.outcome,
      spam: r.spam, repeat: r.repeat, existing: r.existing, called: r.called, answered: r.answered, minutesToCall: r.minutesToCall, waiting: r.waiting, booked: r.booked, cameIn: r.cameIn,
      firstVisit: r.firstVisit, outcome: r.outcome, lostReason: r.lostReason, paidCents: r.paidFirstCents + r.paidLaterCents, owesCents: r.owesCents,
    };
  });
  await audit(actor, "view_ads", { entityType: "adLeads", description: `Viewed ad leads (${input.filter}, ${list.length})` });
  return { rows, total: list.length, page, pageSize: PAGE };
}

// ── The number to beat ───────────────────────────────────────────────────────

let benchmarkCache: { at: number; value: Awaited<ReturnType<typeof computeBenchmark>> } | null = null;
async function computeBenchmark() {
  const { zocdocBenchmark } = await import("./zocdocDb");
  const z = await zocdocBenchmark();
  // No ZocDoc report loaded (or nobody judged yet): a round number so the page still has something to compare with.
  if (!z.cameIn || !z.spentCents) return { source: "default" as const, costPerPatientCents: 10_000, perDollar: null, from: z.from, to: z.to, cameIn: 0 };
  return { source: "zocdoc" as const, costPerPatientCents: Math.round(z.spentCents / z.cameIn), perDollar: z.paidCents / z.spentCents, from: z.from, to: z.to, cameIn: z.cameIn };
}
/** What a patient who came in costs through ZocDoc (last 12 months): the number an ad has to beat. Kept 30 minutes. */
export async function adsBenchmark() {
  if (benchmarkCache && Date.now() - benchmarkCache.at < 30 * 60_000) return benchmarkCache.value;
  const value = await computeBenchmark();
  benchmarkCache = { at: Date.now(), value };
  return value;
}

/** Counts and dollar totals only (no patient details), for the IAM-only "ads-counts" job. */
export async function adsCounts(input: { from?: string; to?: string } = {}) {
  const to = input.to ?? localDateStr();
  const from = input.from ?? addDays(to, -90);
  const { summary, loaded } = await summarize(from, to);
  const dollars = (c: number) => Math.round(c / 100);
  const t = summary.totals;
  const shape = (r: typeof t) => ({ spent: dollars(r.spendCents), clicks: r.clicks, leads: r.leads, web: r.webLeads, calls: r.callLeads, newPatientLeads: r.counted, called: r.called, calledWithin15: r.calledFast, booked: r.booked, cameIn: r.cameIn, judged: r.judged, lost: r.lost, insurancePaid: dollars(r.paidCents) });
  return {
    from, to, campaigns: loaded.campaigns.length, withTrackingNumber: (await trackingNumbers()).size, totals: shape(t),
    byChannel: Object.fromEntries(summary.channels.map((r) => [r.label, shape(r)])),
    speed: summary.speed, lostReasons: Object.fromEntries(summary.lost.reasons.map((r) => [r.key, r.leads])), spam: summary.spam, clicksNoLeads: { ...summary.clicksNoLeads, spendCents: undefined, spent: dollars(summary.clicksNoLeads.spendCents) },
  };
}

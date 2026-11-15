// Website bookings that wait too long for their first call, and the end-of-day count (2026-11-14, the
// owner's choice: "alert the front desk and me when a website request has waited more than 15 minutes
// during office hours, plus a simple daily count of requests, calls and bookings").
//
// Runs with the 5-minute workforce-alerts schedule. Only office time counts (Mon–Fri, 9–5 Houston), so a
// request sent on Saturday is flagged at 9:15 on Monday, not over the weekend. Each request is flagged once.
// The alert goes to the front-desk person it was assigned to (else that clinic's front desk), that
// clinic's office manager, and the admins; the count goes to the admins after 5 PM on weekdays.
// Everyone can switch these off in the bell ("Website bookings").
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, bookingRequests, clinics, notifications, staffProfiles, users } from "../drizzle/schema";
import { BOOKING_NOTICE_PREFIX, OFFICE_CLOSE_MIN, WAIT_ALERT_MIN, officeMinutesBetween } from "../shared/booking";
import { localDateStr, localMinutes } from "../shared/workforce";

const COUNT_KEY = "booking_daily_count";
const LOOK_BACK_DAYS = 14;

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

async function send(userIds: number[], title: string, content: string): Promise<number> {
  const { deliverableTo } = await import("./notificationsDb");
  const ids = await deliverableTo(userIds, "task", title);
  if (ids.length) await (await db()).insert(notifications).values(ids.map((userId) => ({ userId, type: "task" as const, title: title.slice(0, 250), content })));
  return ids.length;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const waitText = (n: number) => (n < 60 ? `${n} minutes` : `${Math.floor(n / 60)} h ${String(n % 60).padStart(2, "0")} min`);

/** What the end-of-day notification says (pure, so it can be tested). */
export function dailyCountText(c: { received: number; called: number; scheduled: number; notCalled: number; olderWaiting: number; medianWaitMin: number | null }): { title: string; content: string } | null {
  if (!c.received && !c.olderWaiting) return null;
  const title = `${BOOKING_NOTICE_PREFIX}s today: ${plural(c.received, "request")}`;
  const parts: string[] = [];
  if (c.received) {
    parts.push(`${c.called} called, ${c.scheduled} scheduled${c.notCalled ? `, ${c.notCalled} not called yet` : ""}.`);
    if (c.medianWaitMin != null) parts.push(`Typical wait for the first call: ${waitText(c.medianWaitMin)} of office time.`);
  } else parts.push("No new requests came in today.");
  if (c.olderWaiting) parts.push(`${plural(c.olderWaiting, "earlier request")} ${c.olderWaiting === 1 ? "is" : "are"} still waiting for a call.`);
  return { title, content: parts.join(" ") };
}

export async function runBookingAlerts(now: Date = new Date()) {
  const d = await db();
  const out = { flagged: 0, notified: 0, dailyCount: false };
  const people = await d.select({ id: users.id, role: users.role, clinicId: staffProfiles.homeClinicId, active: staffProfiles.active })
    .from(users).leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .where(inArray(users.role, ["admin", "office_manager", "front_desk"]));
  const admins = people.filter((p) => p.role === "admin").map((p) => p.id);
  const working = people.filter((p) => p.active !== false);

  // 1) Requests nobody has called after 15 minutes of office time.
  const since = new Date(now.getTime() - LOOK_BACK_DAYS * 86_400_000);
  const waiting = await d.select({
    id: bookingRequests.id, name: bookingRequests.name, phone: bookingRequests.phone, receivedAt: bookingRequests.receivedAt, visitType: bookingRequests.visitType,
    clinicId: bookingRequests.clinicId, location: bookingRequests.location, assignedUserId: bookingRequests.assignedUserId, clinicName: clinics.name,
  }).from(bookingRequests).leftJoin(clinics, eq(clinics.id, bookingRequests.clinicId))
    .where(and(eq(bookingRequests.status, "new"), eq(bookingRequests.source, "website"), isNull(bookingRequests.waitAlertAt), isNull(bookingRequests.firstContactAt), gte(bookingRequests.receivedAt, since)));
  for (const b of waiting) {
    const waited = officeMinutesBetween(b.receivedAt, now);
    if (waited < WAIT_ALERT_MIN) continue;
    // Claim it (an overlapping run won't send it twice).
    const res = await d.update(bookingRequests).set({ waitAlertAt: now }).where(and(eq(bookingRequests.id, b.id), isNull(bookingRequests.waitAlertAt)));
    if (!Number((res as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0)) continue;
    out.flagged++;
    const desk = b.assignedUserId ? [b.assignedUserId]
      : working.filter((p) => p.role === "front_desk" && (!b.clinicId || p.clinicId === b.clinicId)).map((p) => p.id);
    const managers = working.filter((p) => p.role === "office_manager" && b.clinicId && p.clinicId === b.clinicId).map((p) => p.id);
    const where = b.clinicName ?? b.location;
    out.notified += await send(
      [...desk, ...managers, ...admins],
      `${BOOKING_NOTICE_PREFIX} waiting ${WAIT_ALERT_MIN}+ min: ${b.name}`,
      `${b.name} asked for an appointment${where ? ` at ${where}` : ""}${b.visitType ? ` (${b.visitType})` : ""} and has waited ${waitText(waited)} of office time for a call. `
        + `Call ${b.phone}, then mark how it went on the Website bookings page.`,
    );
  }

  // 2) After closing on weekdays, once: today's count for the admins.
  const today = localDateStr(now);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const mins = localMinutes(now);
  if (dow !== 0 && dow !== 6 && mins >= OFFICE_CLOSE_MIN && mins < OFFICE_CLOSE_MIN + 120 && admins.length) {
    const [row] = await d.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, COUNT_KEY)).limit(1);
    if ((row?.value as { date?: string } | undefined)?.date !== today) {
      await d.insert(appSettings).values({ key: COUNT_KEY, value: { date: today }, updatedByUserId: null }).onDuplicateKeyUpdate({ set: { value: { date: today }, updatedByUserId: null } });
      const rows = await d.select({ status: bookingRequests.status, receivedAt: bookingRequests.receivedAt, firstContactAt: bookingRequests.firstContactAt })
        .from(bookingRequests).where(and(eq(bookingRequests.source, "website"), gte(bookingRequests.receivedAt, since)));
      const real = rows.filter((r) => r.status !== "spam");
      const todays = real.filter((r) => localDateStr(r.receivedAt) === today);
      const waits = todays.filter((r) => r.firstContactAt).map((r) => officeMinutesBetween(r.receivedAt, r.firstContactAt!)).sort((a, b) => a - b);
      const text = dailyCountText({
        received: todays.length,
        called: todays.filter((r) => r.firstContactAt).length,
        scheduled: todays.filter((r) => r.status === "scheduled").length,
        notCalled: todays.filter((r) => r.status === "new" && !r.firstContactAt).length,
        olderWaiting: real.filter((r) => r.status === "new" && !r.firstContactAt && localDateStr(r.receivedAt) !== today).length,
        medianWaitMin: waits.length ? waits[Math.floor(waits.length / 2)]! : null,
      });
      if (text) { out.notified += await send(admins, text.title, text.content); out.dailyCount = true; }
    }
  }
  return out;
}

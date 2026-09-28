// Website bookings: requests from the mypcpdr.com booking wizard land here (the clinic-booking-mailer
// Lambda hands each one to MyPCP, and still emails Care@ as a backup). Each becomes a "call to confirm"
// task for the front desk at the chosen clinic; staff mark how it went, and the page tracks the rest.
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { bookingRequests, clinics, users, workTaskActivities, workTasks } from "../drizzle/schema";
import { BOOKING_STATUS_LABELS, OPEN_BOOKING, clinicForLocation, parseBookingEmail, parsePreferred, type BookingStatus } from "../shared/booking";
import { normalizePhone } from "../shared/phone";
import { nameKey } from "../shared/workspace";
import { localDateStr } from "../shared/workforce";
import { WorkspaceError, audit, buildNameIndex, createTask, findSubjectByPhone, frontDeskFor, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export interface IncomingBooking { name: string; phone: string; location?: string | null; provider?: string | null; visitType?: string | null; preferred?: string | null }
const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\r\n<>]/g, " ").trim().slice(0, max) : "") || null;

/** Who the person is, if MyPCP already knows them: by phone first, then an exact, unique name. */
async function matchPerson(name: string, phoneKey: string | null) {
  if (phoneKey) {
    const byPhone = await findSubjectByPhone(phoneKey);
    if (byPhone) return byPhone;
  }
  const hits = (await buildNameIndex()).get(nameKey(name)) ?? [];
  return hits.length === 1 ? hits[0]! : null;
}

async function actorFor(userId: number | null): Promise<WorkspaceActor> {
  const d = await db();
  const [u] = userId ? await d.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, userId)).limit(1)
    : await d.select({ id: users.id, name: users.name }).from(users).where(eq(users.role, "admin")).limit(1);
  if (!u) throw new Error("No admin user to file website bookings under.");
  return { id: u.id, name: "Website booking", role: "admin", clinicIds: null };
}

/** A new request from the website (called by the Lambda job; never from a browser). */
export async function ingestBooking(b: IncomingBooking) {
  const name = clean(b.name, 120);
  const phone = clean(b.phone, 30);
  if (!name || !phone || phone.replace(/\D/g, "").length < 10) return { ok: false as const, reason: "name and phone required" };
  const d = await db();
  const receivedAt = new Date();
  const location = clean(b.location, 60);
  const preferred = clean(b.preferred, 100);
  const pref = parsePreferred(preferred, receivedAt);
  const clinicRows = await d.select({ id: clinics.id, name: clinics.name }).from(clinics);
  const clinicId = clinicForLocation(location, clinicRows);
  const phoneKey = normalizePhone(phone);
  const who = await matchPerson(name, phoneKey);
  const desk = await frontDeskFor(clinicId);
  const res = await d.insert(bookingRequests).values({
    receivedAt, source: "website", name, phone, phoneKey, location, clinicId, provider: clean(b.provider, 80), visitType: clean(b.visitType, 80),
    preferred, preferredDate: pref.date, spanish: pref.spanish, status: "new", subjectKey: who?.key ?? null, patientId: who?.patientId ?? null,
    patientName: who?.name?.slice(0, 255) ?? null, assignedUserId: desk.assignedUserId,
  });
  const id = (res as unknown as [{ insertId: number }])[0].insertId;
  const clinicName = clinicRows.find((c) => c.id === clinicId)?.name ?? location ?? "any location";
  const task = await createTask(await actorFor(null), {
    title: `Call to confirm website booking: ${name}${pref.spanish ? " (Spanish)" : ""}`.slice(0, 250),
    description: [
      `${who ? `Existing patient: ${who.name}` : "New patient (not found in MyPCP)"}`,
      `Phone: ${phone}`,
      `Location: ${clinicName}`,
      b.provider ? `Provider: ${b.provider}` : null,
      b.visitType ? `Visit: ${b.visitType}` : null,
      `Preferred: ${preferred ?? "no preference"}`,
      pref.spanish ? "Booked on the Spanish site: call in Spanish." : null,
      "",
      `Call to confirm, book it in Practice Fusion, then mark it on the Website bookings page (/bookings?b=${id}).`,
    ].filter((x) => x !== null).join("\n"),
    patientId: who?.patientId ?? null, clinicId, assignedUserId: desk.assignedUserId, assignedRole: desk.assignedRole,
    priority: "high", category: "patient_call", dueDate: localDateStr(), sourceType: "website_booking", sourceRef: String(id),
  });
  await d.update(bookingRequests).set({ taskId: task.id }).where(eq(bookingRequests.id, id));
  console.log(`[website-booking] ${JSON.stringify({ id, matched: !!who, clinic: !!clinicId })}`); // no patient details in logs
  return { ok: true as const, id };
}

export type BookingFilter = "open" | "scheduled" | "closed" | "earlier" | "all";

export async function listBookings(filter: BookingFilter) {
  const d = await db();
  const since = new Date(Date.now() - 120 * 86_400_000);
  const conds = [gte(bookingRequests.receivedAt, since)];
  if (filter === "open") conds.push(inArray(bookingRequests.status, OPEN_BOOKING));
  else if (filter === "scheduled") conds.push(eq(bookingRequests.status, "scheduled"));
  else if (filter === "closed") conds.push(inArray(bookingRequests.status, ["not_booked", "spam"]));
  else if (filter === "earlier") conds.push(eq(bookingRequests.status, "earlier"));
  const rows = await d.select({ b: bookingRequests, clinicName: clinics.name, assignee: users.name }).from(bookingRequests)
    .leftJoin(clinics, eq(clinics.id, bookingRequests.clinicId)).leftJoin(users, eq(users.id, bookingRequests.assignedUserId))
    .where(and(...conds)).orderBy(desc(bookingRequests.receivedAt)).limit(500);
  return rows.map(({ b, clinicName, assignee }) => ({ ...b, clinicName, assignee }));
}

/** Header numbers: waiting now, and how fast the first call happens (last 30 days). */
export async function bookingStats() {
  const d = await db();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await d.select({ status: bookingRequests.status, receivedAt: bookingRequests.receivedAt, firstContactAt: bookingRequests.firstContactAt, source: bookingRequests.source })
    .from(bookingRequests).where(gte(bookingRequests.receivedAt, since));
  const web = rows.filter((r) => r.source === "website");
  const mins = web.filter((r) => r.firstContactAt).map((r) => (r.firstContactAt!.getTime() - r.receivedAt.getTime()) / 60000).sort((a, b) => a - b);
  return {
    waiting: web.filter((r) => OPEN_BOOKING.includes(r.status as BookingStatus)).length,
    received30: web.length,
    scheduled30: web.filter((r) => r.status === "scheduled").length,
    medianFirstCallMin: mins.length ? Math.round(mins[Math.floor(mins.length / 2)]!) : null,
  };
}

/** Staff record how the call went. Scheduled / didn't book / spam close the task; no answer keeps it open. */
export async function setBookingStatus(actor: WorkspaceActor, input: { id: number; status: Exclude<BookingStatus, "new" | "earlier">; note?: string | null }) {
  const d = await db();
  const [b] = await d.select().from(bookingRequests).where(eq(bookingRequests.id, input.id)).limit(1);
  if (!b) throw new WorkspaceError("Booking not found.", "NOT_FOUND");
  if (b.status === "earlier") throw new WorkspaceError("That's an earlier booking loaded from email; it was handled back then.");
  const now = new Date();
  const note = input.note?.trim() ? `${b.note ? `${b.note}\n` : ""}${now.toLocaleDateString("en-US", { timeZone: "America/Chicago" })} ${actor.name}: ${input.note.trim()}`.slice(0, 4000) : b.note;
  await d.update(bookingRequests).set({
    status: input.status, attempts: input.status === "no_answer" ? b.attempts + 1 : b.attempts, firstContactAt: b.firstContactAt ?? now,
    handledByUserId: actor.id, handledAt: now, note,
  }).where(eq(bookingRequests.id, b.id));
  if (b.taskId) {
    const [t] = await d.select({ status: workTasks.status }).from(workTasks).where(eq(workTasks.id, b.taskId)).limit(1);
    if (t && t.status !== "completed" && t.status !== "cancelled") {
      if (input.status === "no_answer") {
        await d.insert(workTaskActivities).values({ taskId: b.taskId, userId: actor.id, type: "comment", body: `Called, no answer (attempt ${b.attempts + 1}).${input.note?.trim() ? ` ${input.note.trim()}` : ""}` });
      } else {
        const to = input.status === "spam" ? "cancelled" : "completed";
        await d.update(workTasks).set({ status: to, completedAt: to === "completed" ? now : null }).where(eq(workTasks.id, b.taskId));
        await d.insert(workTaskActivities).values({ taskId: b.taskId, userId: actor.id, type: "status_changed", meta: { from: t.status, to, reason: BOOKING_STATUS_LABELS[input.status] } });
      }
    }
  }
  await audit(actor, "update_task", { entityType: "bookingRequest", entityId: b.id, description: `Website booking: ${input.status}` });
  return { ok: true };
}

/**
 * Load earlier website bookings from the booking emails in the practice mailbox (last 120 days), as
 * history. Runs a slice at a time; the page calls it again while `remaining` is true.
 */
export async function importEarlierBookings(actor: WorkspaceActor, input: { pageToken?: string | null }) {
  const { gmailSearch, gmailMessageText } = await import("./gmailSync");
  const d = await db();
  const started = Date.now();
  const q = 'subject:"Appointment request" newer_than:120d (from:care@mypcpdr.com OR from:no-reply@sns.amazonaws.com)';
  let pageToken = input.pageToken ?? null;
  let added = 0, seen = 0;
  const clinicRows = await d.select({ id: clinics.id, name: clinics.name }).from(clinics);
  do {
    const page = await gmailSearch(q, pageToken);
    const have = page.ids.length ? new Set((await d.select({ g: bookingRequests.gmailId }).from(bookingRequests).where(inArray(bookingRequests.gmailId, page.ids))).map((r) => r.g)) : new Set();
    for (const id of page.ids) {
      if (Date.now() - started > 18_000) return { added, seen, pageToken, remaining: true };
      seen++;
      if (have.has(id)) continue;
      const m = await gmailMessageText(id);
      const b = parseBookingEmail(m.text);
      if (!b) continue;
      const pref = parsePreferred(b.preferred, m.receivedAt);
      const phoneKey = normalizePhone(b.phone);
      const who = await matchPerson(b.name, phoneKey);
      await d.insert(bookingRequests).ignore().values({
        receivedAt: m.receivedAt, source: "email", name: b.name, phone: b.phone, phoneKey, location: b.location?.slice(0, 60) ?? null,
        clinicId: clinicForLocation(b.location, clinicRows), provider: b.provider?.slice(0, 80) ?? null, visitType: b.visitType?.slice(0, 80) ?? null,
        preferred: b.preferred?.slice(0, 100) ?? null, preferredDate: pref.date, spanish: pref.spanish, status: "earlier",
        subjectKey: who?.key ?? null, patientId: who?.patientId ?? null, patientName: who?.name?.slice(0, 255) ?? null, gmailId: id,
      });
      added++;
    }
    pageToken = page.next;
  } while (pageToken);
  await audit(actor, "import_schedule", { entityType: "bookingRequest", description: `Loaded earlier website bookings from email: ${added}` });
  return { added, seen, pageToken: null, remaining: false };
}

// Call-outs and shift swaps (2026-10-04, the practice's choices):
//   • "I can't make it": the shift is marked called out, their manager gets a "coverage needed" task (with who
//     could cover), and the shift goes up for grabs for coworkers;
//   • "Offer this shift": it goes up for grabs, still theirs until someone takes it and the manager approves.
// Coworkers with the same job who could work it (their clinic, or they float; free that day, not on time off)
// see it on My Schedule and get a notification. Taking it sends an Approve / Deny task to the manager of the
// person who offered it (office manager → time-off approver → admins); approving moves the shift (swap) or
// adds a coverage shift for them (call-out); denying puts it back up for grabs.
import { and, asc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { getDb } from "./db";
import { clinics, shiftOffers, shifts, staffProfiles, timeOffRequests, users, workTaskActivities, workTasks } from "../drizzle/schema";
import { REMOTE_LABEL, assignCoverage, coverageCandidates, markCalledOut, notify } from "./workforceDb";
import { approverFor } from "./scheduleRequestsDb";
import { fmtDay, fmtTime, localDateStr, localMinutes, timeToMinutes } from "../shared/workforce";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export class ShiftOfferError extends Error {}
type Shift = typeof shifts.$inferSelect;
type Offer = typeof shiftOffers.$inferSelect;
type Who = { id: number; name: string | null; role: string };

async function placeOf(s: Shift) {
  if (!s.clinicId) return REMOTE_LABEL;
  const [c] = await (await db()).select({ name: clinics.name }).from(clinics).where(eq(clinics.id, s.clinicId)).limit(1);
  return c?.name ?? "the clinic";
}
const when = (s: Shift) => `${fmtDay(s.date)}, ${fmtTime(s.startTime)}–${fmtTime(s.endTime)}`;

/** One of my own shifts that hasn't ended yet. */
async function myUpcomingShift(userId: number, shiftId: number) {
  const [s] = await (await db()).select().from(shifts).where(and(eq(shifts.id, shiftId), eq(shifts.userId, userId))).limit(1);
  if (!s) throw new ShiftOfferError("That shift wasn't found.");
  const today = localDateStr();
  if (s.date < today || (s.date === today && timeToMinutes(s.endTime) <= localMinutes())) throw new ShiftOfferError("That shift is already over.");
  return s;
}

/** Coworkers who could take a shift: same job, their clinic or they float, free those hours, not on time off. */
async function eligibleFor(s: Shift, excludeUserId: number) {
  const d = await db();
  const [holder] = await d.select().from(staffProfiles).where(eq(staffProfiles.userId, s.userId)).limit(1);
  if (!holder?.jobRoleId) return [];
  const people = await d.select({ userId: staffProfiles.userId, name: users.name, homeClinicId: staffProfiles.homeClinicId, canFloat: staffProfiles.canFloat })
    .from(staffProfiles).innerJoin(users, eq(users.id, staffProfiles.userId))
    .where(and(eq(staffProfiles.active, true), eq(staffProfiles.jobRoleId, holder.jobRoleId), ne(staffProfiles.userId, excludeUserId), ne(staffProfiles.userId, s.userId)));
  if (!people.length) return [];
  const ids = people.map((p) => p.userId);
  const [busy, off] = await Promise.all([
    d.select({ userId: shifts.userId, startTime: shifts.startTime, endTime: shifts.endTime }).from(shifts).where(and(inArray(shifts.userId, ids), eq(shifts.date, s.date), eq(shifts.status, "scheduled"))),
    d.select({ userId: timeOffRequests.userId }).from(timeOffRequests).where(and(inArray(timeOffRequests.userId, ids), eq(timeOffRequests.status, "approved"), lte(timeOffRequests.startDate, s.date), gte(timeOffRequests.endDate, s.date))),
  ]);
  const a = timeToMinutes(s.startTime), b = timeToMinutes(s.endTime);
  return people.filter((p) =>
    (p.homeClinicId === s.clinicId || p.canFloat) &&
    !busy.some((x) => x.userId === p.userId && timeToMinutes(x.startTime) < b && a < timeToMinutes(x.endTime)) &&
    !off.some((o) => o.userId === p.userId));
}

async function taskFor(offer: Offer, title: string, description: string) {
  const approver = await approverFor(offer.offeredByUserId);
  const d = await db();
  const [u] = await d.select({ name: users.name, role: users.role }).from(users).where(eq(users.id, offer.offeredByUserId)).limit(1);
  const { createTask } = await import("./workspaceDb");
  await createTask({ id: offer.offeredByUserId, name: u?.name ?? null, role: u?.role ?? "staff", clinicIds: null }, {
    title, description, assignedUserId: approver.assignedUserId, assignedRole: approver.assignedUserId ? null : "admin",
    priority: offer.kind === "callout" ? "high" : "normal", category: "administrative", dueDate: localDateStr(),
    sourceType: "shift_offer", sourceRef: String(offer.id),
  });
  return approver;
}

async function closeTasks(offerId: number, how: "completed" | "cancelled", byUserId: number, note: string) {
  const d = await db();
  const open = await d.select({ id: workTasks.id }).from(workTasks)
    .where(and(eq(workTasks.sourceType, "shift_offer"), eq(workTasks.sourceRef, String(offerId)), inArray(workTasks.status, ["open", "in_progress", "waiting"])));
  for (const t of open) {
    await d.update(workTasks).set({ status: how, completedAt: how === "completed" ? new Date() : null }).where(eq(workTasks.id, t.id));
    await d.insert(workTaskActivities).values([{ taskId: t.id, userId: byUserId, type: "status_changed" as const, meta: { to: how } }, { taskId: t.id, userId: byUserId, type: "comment" as const, body: note }]);
  }
}

async function announce(s: Shift, offeredBy: number) {
  const people = await eligibleFor(s, offeredBy);
  if (people.length) await notify(people.slice(0, 20).map((p) => p.userId), "A shift is up for grabs", `${when(s)} at ${await placeOf(s)}. Take it on My Schedule.`);
  return people.length;
}

/** "I can't make it": called out, the manager is told (with who could cover), and the shift is up for grabs. */
export async function callOut(user: Who, shiftId: number, reason: string | null) {
  const s = await myUpcomingShift(user.id, shiftId);
  if (s.status === "called_out") throw new ShiftOfferError("You already called out for that shift.");
  const note = `Called out by ${user.name ?? "them"}${reason?.trim() ? `: ${reason.trim().slice(0, 200)}` : ""}`;
  await markCalledOut(s.id, note, user.name);
  const d = await db();
  const res = await d.insert(shiftOffers).values({ shiftId: s.id, kind: "callout", offeredByUserId: user.id, note: reason?.trim().slice(0, 300) || null });
  const [offer] = await d.select().from(shiftOffers).where(eq(shiftOffers.id, Number((res as unknown as [{ insertId: number }])[0].insertId))).limit(1);
  const cands = await coverageCandidates(s.id);
  const place = await placeOf(s);
  const approver = await taskFor(offer!, `Coverage needed: ${user.name ?? "Employee"} called out (${when(s)}, ${place})`, [
    `${user.name ?? "An employee"} can't work ${when(s)} at ${place}.${reason?.trim() ? ` Reason: ${reason.trim().slice(0, 200)}` : ""}`,
    "", cands.length ? `Could cover: ${cands.slice(0, 6).map((c) => `${c.name}${c.sameClinic ? "" : c.canFloat ? " (floats)" : ` (${c.homeClinicName ?? "other clinic"})`}`).join(", ")}.` : "Nobody with the same job is free those hours.",
    "", "The shift is posted for coworkers to take; you'll approve whoever takes it. Or assign coverage yourself on Workforce → Schedule.",
  ].join("\n"));
  await notify(approver.userIds, `Call-out: ${user.name ?? "Employee"}`, `${when(s)} at ${place} needs coverage.`);
  const told = await announce(s, user.id);
  return { offerId: offer!.id, coworkersTold: told };
}

/** "Offer this shift": it stays mine until someone takes it and the manager approves. */
export async function offerShift(user: Who, shiftId: number, note: string | null) {
  const s = await myUpcomingShift(user.id, shiftId);
  if (s.status !== "scheduled") throw new ShiftOfferError("That shift was called out already.");
  const d = await db();
  const open = await d.select({ id: shiftOffers.id }).from(shiftOffers).where(and(eq(shiftOffers.shiftId, s.id), inArray(shiftOffers.status, ["open", "claimed"]))).limit(1);
  if (open.length) throw new ShiftOfferError("That shift is already up for grabs.");
  const res = await d.insert(shiftOffers).values({ shiftId: s.id, kind: "swap", offeredByUserId: user.id, note: note?.trim().slice(0, 300) || null });
  const told = await announce(s, user.id);
  return { offerId: Number((res as unknown as [{ insertId: number }])[0].insertId), coworkersTold: told };
}

export async function cancelOffer(userId: number, offerId: number) {
  const d = await db();
  const [o] = await d.select().from(shiftOffers).where(and(eq(shiftOffers.id, offerId), eq(shiftOffers.offeredByUserId, userId))).limit(1);
  if (!o || !["open", "claimed"].includes(o.status)) throw new ShiftOfferError("That offer isn't open anymore.");
  if (o.kind === "callout") throw new ShiftOfferError("A call-out can only be undone by your manager.");
  await d.update(shiftOffers).set({ status: "cancelled" }).where(eq(shiftOffers.id, o.id));
  await closeTasks(o.id, "cancelled", userId, "The employee took the shift back.");
  if (o.claimedByUserId) await notify([o.claimedByUserId], "Shift no longer available", "The coworker kept their shift.");
}

/** Shifts I could take (My Schedule → Up for grabs). */
export async function openShiftsFor(userId: number) {
  const d = await db();
  const today = localDateStr();
  const rows = await d.select({ o: shiftOffers, s: shifts, by: users.name }).from(shiftOffers).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId)).innerJoin(users, eq(users.id, shiftOffers.offeredByUserId))
    .where(and(eq(shiftOffers.status, "open"), gte(shifts.date, today), ne(shiftOffers.offeredByUserId, userId))).orderBy(asc(shifts.date), asc(shifts.startTime)).limit(50);
  const out = [];
  for (const r of rows) {
    if (!(await eligibleFor(r.s, -1)).some((p) => p.userId === userId)) continue;
    out.push({ offerId: r.o.id, kind: r.o.kind, date: r.s.date, startTime: r.s.startTime, endTime: r.s.endTime, place: await placeOf(r.s), offeredBy: r.by, note: r.o.kind === "swap" ? r.o.note : null });
  }
  return out;
}

/** My offers and the shifts I've asked to take (status for My Schedule). */
export async function myOffers(userId: number) {
  const d = await db();
  const today = localDateStr();
  const rows = await d.select({ o: shiftOffers, s: shifts }).from(shiftOffers).innerJoin(shifts, eq(shifts.id, shiftOffers.shiftId))
    .where(and(gte(shifts.date, today), inArray(shiftOffers.status, ["open", "claimed", "approved", "denied"]))).orderBy(asc(shifts.date)).limit(200);
  const mine = rows.filter((r) => r.o.offeredByUserId === userId || r.o.claimedByUserId === userId);
  const names = new Map((await d.select({ id: users.id, name: users.name }).from(users)).map((u) => [u.id, u.name]));
  return mine.map((r) => ({
    offerId: r.o.id, shiftId: r.s.id, kind: r.o.kind, status: r.o.status, mine: r.o.offeredByUserId === userId,
    date: r.s.date, startTime: r.s.startTime, endTime: r.s.endTime,
    takenBy: r.o.claimedByUserId ? names.get(r.o.claimedByUserId) ?? null : null, offeredBy: names.get(r.o.offeredByUserId) ?? null, managerNote: r.o.managerNote,
  }));
}

/** "I'll take it": goes to the manager to approve. */
export async function claimShift(user: Who, offerId: number) {
  const d = await db();
  const [o] = await d.select().from(shiftOffers).where(eq(shiftOffers.id, offerId)).limit(1);
  if (!o || o.status !== "open") throw new ShiftOfferError("Someone already took that shift.");
  const [s] = await d.select().from(shifts).where(eq(shifts.id, o.shiftId)).limit(1);
  if (!s || s.date < localDateStr()) throw new ShiftOfferError("That shift is over.");
  if (!(await eligibleFor(s, -1)).some((p) => p.userId === user.id)) throw new ShiftOfferError("You can't take that shift (a different job, another clinic, or you're already working then).");
  const res = await d.update(shiftOffers).set({ status: "claimed", claimedByUserId: user.id, claimedAt: new Date() }).where(and(eq(shiftOffers.id, o.id), eq(shiftOffers.status, "open")));
  if (!Number((res as unknown as [{ affectedRows: number }])[0]?.affectedRows)) throw new ShiftOfferError("Someone already took that shift.");
  const [holder] = await d.select({ name: users.name }).from(users).where(eq(users.id, o.offeredByUserId)).limit(1);
  const place = await placeOf(s);
  // A call-out already has a "coverage needed" task: the decision goes on it; a swap gets its own.
  const hasTask = (await d.select({ id: workTasks.id }).from(workTasks).where(and(eq(workTasks.sourceType, "shift_offer"), eq(workTasks.sourceRef, String(o.id)), inArray(workTasks.status, ["open", "in_progress", "waiting"]))).limit(1)).length > 0;
  if (hasTask) {
    const approver = await approverFor(o.offeredByUserId);
    await notify(approver.userIds, `${user.name ?? "Someone"} can cover ${holder?.name ?? "the call-out"}`, `${when(s)} at ${place}. Approve it on the coverage task.`);
  } else {
    await taskFor(o, `Shift swap: ${user.name ?? "Employee"} takes ${holder?.name ?? "a coworker"}'s shift (${when(s)}, ${place})`,
      `${holder?.name ?? "A coworker"} offered ${when(s)} at ${place}${o.note ? ` ("${o.note}")` : ""}, and ${user.name ?? "a coworker"} wants to take it.\n\nApprove or deny it here.`);
  }
  await notify([o.offeredByUserId], "Someone is taking your shift", `${user.name ?? "A coworker"} asked to take ${when(s)}. It's yours until your manager approves.`);
  return { ok: true };
}

/** For the Approve / Deny box on the task. */
export async function getOffer(offerId: number) {
  const d = await db();
  const [o] = await d.select().from(shiftOffers).where(eq(shiftOffers.id, offerId)).limit(1);
  if (!o) return null;
  const [s] = await d.select().from(shifts).where(eq(shifts.id, o.shiftId)).limit(1);
  const names = new Map((await d.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [o.offeredByUserId, o.claimedByUserId ?? 0]))).map((u) => [u.id, u.name]));
  return {
    id: o.id, kind: o.kind, status: o.status, offeredByUserId: o.offeredByUserId, offeredBy: names.get(o.offeredByUserId) ?? null,
    takenBy: o.claimedByUserId ? names.get(o.claimedByUserId) ?? null : null, when: s ? when(s) : "", place: s ? await placeOf(s) : "", note: o.note,
  };
}

/** The manager approves (swap: the shift becomes theirs; call-out: they get a coverage shift) or denies (open again). */
export async function decideOffer(input: { offerId: number; approve: boolean; managerNote?: string | null; decidedBy: { id: number; name: string | null } }) {
  const d = await db();
  const [o] = await d.select().from(shiftOffers).where(eq(shiftOffers.id, input.offerId)).limit(1);
  if (!o) throw new ShiftOfferError("Not found.");
  if (o.status !== "claimed" || !o.claimedByUserId) throw new ShiftOfferError(o.status === "open" ? "Nobody has taken this shift yet." : `This was already ${o.status}.`);
  const [s] = await d.select().from(shifts).where(eq(shifts.id, o.shiftId)).limit(1);
  if (!s) throw new ShiftOfferError("That shift was deleted.");
  const note = input.managerNote?.trim().slice(0, 300) || null;
  const taker = o.claimedByUserId;
  if (input.approve) {
    if (o.kind === "swap") {
      const clash = await d.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.userId, taker), eq(shifts.date, s.date), eq(shifts.status, "scheduled")));
      const a = timeToMinutes(s.startTime), b = timeToMinutes(s.endTime);
      const overlapping = (await d.select().from(shifts).where(inArray(shifts.id, clash.map((c) => c.id).concat(0)))).some((x) => timeToMinutes(x.startTime) < b && a < timeToMinutes(x.endTime));
      if (overlapping) throw new ShiftOfferError("They're now working those hours already.");
      await d.update(shifts).set({ userId: taker, note: `Swapped from ${(await getOffer(o.id))?.offeredBy ?? "a coworker"}` }).where(eq(shifts.id, s.id));
    } else {
      const r = await assignCoverage(s.id, taker, input.decidedBy.id);
      if ("error" in r) throw new ShiftOfferError(r.error);
    }
    await d.update(shiftOffers).set({ status: "approved", decidedByUserId: input.decidedBy.id, decidedAt: new Date(), managerNote: note }).where(eq(shiftOffers.id, o.id));
    await notify([taker], "Shift approved: it's yours", `${when(s)} at ${await placeOf(s)}.${note ? ` ${note}` : ""}`);
    if (o.kind === "swap") await notify([o.offeredByUserId], "Your shift swap was approved", `${when(s)} is no longer on your schedule.`);
    await closeTasks(o.id, "completed", input.decidedBy.id, `Approved by ${input.decidedBy.name ?? "a manager"}${note ? `: ${note}` : ""}.`);
  } else {
    await d.update(shiftOffers).set({ status: "open", claimedByUserId: null, claimedAt: null, managerNote: note }).where(eq(shiftOffers.id, o.id));
    await notify([taker], "Shift pickup not approved", `${when(s)}.${note ? ` ${input.decidedBy.name ?? "Your manager"}: ${note}` : ""}`);
    // A swap's task closes (it's open for someone else to take, which makes a new one); a call-out's stays open.
    if (o.kind === "swap") await closeTasks(o.id, "completed", input.decidedBy.id, `Denied by ${input.decidedBy.name ?? "a manager"}${note ? `: ${note}` : ""}. Back up for grabs.`);
  }
  return { approved: input.approve };
}

/** When a manager assigns coverage themselves or undoes a call-out, an open call-out offer for it closes. */
export async function closeOffersForShift(shiftId: number, byUserId: number, why: string) {
  const d = await db();
  const open = await d.select().from(shiftOffers).where(and(eq(shiftOffers.shiftId, shiftId), inArray(shiftOffers.status, ["open", "claimed"])));
  for (const o of open) {
    await d.update(shiftOffers).set({ status: "cancelled" }).where(eq(shiftOffers.id, o.id));
    await closeTasks(o.id, "completed", byUserId, why);
    if (o.claimedByUserId) await notify([o.claimedByUserId], "Shift no longer available", why);
  }
}

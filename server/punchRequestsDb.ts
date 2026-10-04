// "Fix my punch" (2026-10-04, the practice's choice): an employee asks to correct a punch (a forgotten
// clock-out, a wrong time, or a day they forgot to clock in at all) instead of an admin editing the
// timesheet. It becomes a task with Approve / Deny for their office manager (else the time-off approver,
// else the admins), the same people who approve schedule changes; approving changes the punch.
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { punchRequests, timePunches, users, workTaskActivities, workTasks } from "../drizzle/schema";
import { addDays, fmtDay, localDateStr } from "../shared/workforce";
import { clinicHhmm, clinicInstant, punchFixProblem } from "../shared/attendance";
import { addPunch, editPunch, notify } from "./workforceDb";
import { approverFor } from "./scheduleRequestsDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export class PunchRequestError extends Error {}

const fmt = (d: Date | null | undefined) => (d ? new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) : "—");

/** My punches on a day (to pick the one to fix), and my recent requests. */
export async function myPunchDay(userId: number, workDate: string) {
  const d = await db();
  const punches = await d.select().from(timePunches).where(and(eq(timePunches.userId, userId), eq(timePunches.workDate, workDate))).orderBy(asc(timePunches.clockInAt));
  return punches.map((p) => ({ id: p.id, clockIn: clinicHhmm(p.clockInAt), clockOut: p.clockOutAt ? clinicHhmm(p.clockOutAt) : null, lunch: p.outReason === "lunch" }));
}

export async function myPunchRequests(userId: number) {
  const d = await db();
  const rows = await d.select().from(punchRequests).where(and(eq(punchRequests.userId, userId), gte(punchRequests.workDate, addDays(localDateStr(), -60)))).orderBy(desc(punchRequests.createdAt)).limit(20);
  return rows.map((r) => ({ id: r.id, workDate: r.workDate, status: r.status, clockIn: r.clockInAt ? clinicHhmm(r.clockInAt) : null, clockOut: r.clockOutAt ? clinicHhmm(r.clockOutAt) : null, reason: r.reason, managerNote: r.managerNote, createdAt: r.createdAt }));
}

async function closeTask(requestId: number, how: "completed" | "cancelled", byUserId: number, note: string) {
  const d = await db();
  const open = await d.select({ id: workTasks.id }).from(workTasks)
    .where(and(eq(workTasks.sourceType, "punch_fix"), eq(workTasks.sourceRef, String(requestId)), inArray(workTasks.status, ["open", "in_progress", "waiting"])));
  for (const t of open) {
    await d.update(workTasks).set({ status: how, completedAt: how === "completed" ? new Date() : null }).where(eq(workTasks.id, t.id));
    await d.insert(workTaskActivities).values([
      { taskId: t.id, userId: byUserId, type: "status_changed" as const, meta: { to: how } },
      { taskId: t.id, userId: byUserId, type: "comment" as const, body: note },
    ]);
  }
}

/** Ask to fix a punch (or add a day I forgot to clock in). A newer request for the same punch replaces a waiting one. */
export async function requestPunchFix(user: { id: number; name: string | null; role: string }, input: { workDate: string; punchId?: number | null; clockIn?: string | null; clockOut?: string | null; reason: string }) {
  const d = await db();
  const today = localDateStr();
  if (input.workDate < addDays(today, -31)) throw new PunchRequestError("Only the last 31 days can be fixed this way. Ask your manager.");
  const { assertOpenDate } = await import("./payPeriodsDb");
  await assertOpenDate(input.workDate).catch((e: Error) => { throw new PunchRequestError(e.message); });
  let punch: typeof timePunches.$inferSelect | undefined;
  if (input.punchId) {
    [punch] = await d.select().from(timePunches).where(and(eq(timePunches.id, input.punchId), eq(timePunches.userId, user.id))).limit(1);
    if (!punch || punch.workDate !== input.workDate) throw new PunchRequestError("That punch wasn't found.");
  }
  const problem = punchFixProblem({ workDate: input.workDate, today, clockIn: input.clockIn ?? null, clockOut: input.clockOut ?? null, hasPunch: !!punch, reason: input.reason });
  if (problem) throw new PunchRequestError(problem);
  const inAt = input.clockIn ? clinicInstant(input.workDate, input.clockIn) : null;
  const outAt = input.clockOut ? clinicInstant(input.workDate, input.clockOut) : null;
  // The times the punch would have after the fix must make sense.
  const finalIn = inAt ?? punch?.clockInAt ?? null;
  const finalOut = outAt ?? punch?.clockOutAt ?? null;
  if (finalIn && finalOut && +finalOut <= +finalIn) throw new PunchRequestError("Clock-out must be after clock-in.");
  if ((finalOut && +finalOut > Date.now()) || (finalIn && +finalIn > Date.now())) throw new PunchRequestError("Times can't be in the future.");
  if (input.punchId) {
    const waiting = await d.select({ id: punchRequests.id }).from(punchRequests).where(and(eq(punchRequests.punchId, input.punchId), eq(punchRequests.status, "pending")));
    for (const w of waiting) {
      await d.update(punchRequests).set({ status: "cancelled" }).where(eq(punchRequests.id, w.id));
      await closeTask(w.id, "cancelled", user.id, "Replaced by a newer request.");
    }
  }
  const approver = await approverFor(user.id);
  const reason = input.reason.trim().slice(0, 500);
  const res = await d.insert(punchRequests).values({ userId: user.id, workDate: input.workDate, punchId: punch?.id ?? null, clockInAt: inAt, clockOutAt: outAt, reason, approverUserId: approver.assignedUserId });
  const id = Number((res as unknown as [{ insertId: number }])[0]?.insertId);
  const { createTask } = await import("./workspaceDb");
  const what = !punch ? `add ${fmt(inAt)} – ${fmt(outAt)} (didn't clock in)` : [inAt ? `clock-in ${fmt(punch.clockInAt)} → ${fmt(inAt)}` : null, outAt ? `clock-out ${punch.clockOutAt ? fmt(punch.clockOutAt) : "missing"} → ${fmt(outAt)}` : null].filter(Boolean).join(", ");
  await createTask({ id: user.id, name: user.name, role: user.role, clinicIds: null }, {
    title: `Fix punch: ${user.name ?? "Employee"}, ${fmtDay(input.workDate)}`,
    description: [`${user.name ?? "An employee"} asks to ${what}.`, `Reason: ${reason}`, "", "Approve or deny it here."].join("\n"),
    assignedUserId: approver.assignedUserId,
    assignedRole: approver.assignedUserId ? null : "admin",
    priority: "normal",
    category: "administrative",
    dueDate: today,
    sourceType: "punch_fix",
    sourceRef: String(id),
  });
  return { id };
}

export async function cancelPunchRequest(userId: number, id: number) {
  const d = await db();
  const [r] = await d.select().from(punchRequests).where(and(eq(punchRequests.id, id), eq(punchRequests.userId, userId))).limit(1);
  if (!r || r.status !== "pending") throw new PunchRequestError("That request isn't waiting anymore.");
  await d.update(punchRequests).set({ status: "cancelled" }).where(eq(punchRequests.id, id));
  await closeTask(id, "cancelled", userId, "The employee cancelled this request.");
}

/** One request, for the Approve / Deny box on its task. */
export async function getPunchRequest(id: number) {
  const d = await db();
  const [r] = await d.select().from(punchRequests).where(eq(punchRequests.id, id)).limit(1);
  if (!r) return null;
  const [u] = await d.select({ name: users.name }).from(users).where(eq(users.id, r.userId)).limit(1);
  const [p] = r.punchId ? await d.select().from(timePunches).where(eq(timePunches.id, r.punchId)).limit(1) : [];
  return {
    id: r.id, userId: r.userId, userName: u?.name ?? null, status: r.status, workDate: r.workDate, reason: r.reason,
    current: p ? { clockIn: fmt(p.clockInAt), clockOut: p.clockOutAt ? fmt(p.clockOutAt) : "not clocked out" } : null,
    requested: { clockIn: r.clockInAt ? fmt(r.clockInAt) : null, clockOut: r.clockOutAt ? fmt(r.clockOutAt) : null },
  };
}

/** The manager approves (the punch changes now) or denies. */
export async function decidePunchRequest(input: { id: number; approve: boolean; managerNote?: string | null; decidedBy: { id: number; name: string | null } }) {
  const d = await db();
  const [r] = await d.select().from(punchRequests).where(eq(punchRequests.id, input.id)).limit(1);
  if (!r) throw new PunchRequestError("Request not found.");
  if (r.status !== "pending") throw new PunchRequestError(`This request was already ${r.status}.`);
  if (r.userId === input.decidedBy.id) throw new PunchRequestError("You can't approve your own punch.");
  const note = input.managerNote?.trim().slice(0, 500) || null;
  if (input.approve) {
    const { assertOpenDate } = await import("./payPeriodsDb");
    await assertOpenDate(r.workDate).catch((e: Error) => { throw new PunchRequestError(e.message); });
    const stamp = `Fixed on request: ${r.reason}`.slice(0, 500);
    if (r.punchId) {
      const [p] = await d.select().from(timePunches).where(eq(timePunches.id, r.punchId)).limit(1);
      if (!p) throw new PunchRequestError("That punch was deleted, so there's nothing to fix.");
      const res = await editPunch({ id: p.id, clockInAt: r.clockInAt ?? p.clockInAt, clockOutAt: r.clockOutAt ?? p.clockOutAt, note: stamp, editedByUserId: input.decidedBy.id });
      if ("error" in res) throw new PunchRequestError(res.error);
    } else {
      const res = await addPunch({ userId: r.userId, clockInAt: r.clockInAt!, clockOutAt: r.clockOutAt, note: stamp, editedByUserId: input.decidedBy.id });
      if ("error" in res) throw new PunchRequestError(res.error);
    }
  }
  await d.update(punchRequests).set({ status: input.approve ? "approved" : "denied", managerNote: note, decidedByUserId: input.decidedBy.id, decidedAt: new Date() }).where(eq(punchRequests.id, r.id));
  await notify([r.userId], `Punch fix ${input.approve ? "approved" : "denied"}`, `${fmtDay(r.workDate)}: ${input.approve ? "your timesheet is updated." : "your punch stays as it was."}${note ? ` ${input.decidedBy.name ?? "Your manager"}: ${note}` : ""}`);
  await closeTask(r.id, "completed", input.decidedBy.id, `${input.approve ? "Approved" : "Denied"} by ${input.decidedBy.name ?? "a manager"}${note ? `: ${note}` : ""}. The employee was notified.`);
  return { approved: input.approve };
}

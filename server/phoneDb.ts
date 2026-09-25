// RingCentral: the practice's connection settings and the log of calls made or taken
// through the phone built into the app. Numbers are matched to patients here.
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, opportunityActions, phoneCalls, users } from "../drizzle/schema";
import { CLOSING_OUTCOMES, DEFAULT_RINGCENTRAL, normalizePhone, type CallOutcome, type RingCentralSettings } from "../shared/phone";
import { OPPORTUNITY_CATEGORY_LIST } from "../shared/workspace";
import { WorkspaceError, audit, findSubjectByPhone, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const RC_KEY = "ringcentral";

export async function getRingCentralSettings(): Promise<RingCentralSettings> {
  const d = await db();
  const [row] = await d.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, RC_KEY)).limit(1);
  return { ...DEFAULT_RINGCENTRAL, ...((row?.value as Partial<RingCentralSettings> | undefined) ?? {}) };
}

export async function saveRingCentralSettings(actor: WorkspaceActor, input: RingCentralSettings) {
  const d = await db();
  const value = { enabled: input.enabled, clientId: input.clientId.trim(), allowTexting: input.allowTexting };
  await d.insert(appSettings).values({ key: RC_KEY, value, updatedByUserId: actor.id }).onDuplicateKeyUpdate({ set: { value, updatedByUserId: actor.id } });
  await audit(actor, "manage_access", { entityType: "integration", description: `RingCentral ${value.enabled ? "on" : "off"}${value.clientId ? " (practice app)" : " (demo app)"}${value.allowTexting ? ", texting allowed" : ""}` });
  return value;
}

export interface CallContext {
  patientId?: number | null;
  subjectKey?: string | null;
  name?: string | null;
  source?: string | null;
}

/** Record a finished call. Safe to call twice for the same RingCentral session. */
export async function logCall(
  actor: WorkspaceActor,
  input: { sessionId: string | null; direction: "outbound" | "inbound"; phoneNumber: string; startedAt: Date; durationSec: number; result: string | null; context?: CallContext | null },
) {
  const d = await db();
  const phone = normalizePhone(input.phoneNumber);
  if (!phone) throw new WorkspaceError("That doesn't look like a phone number.");
  if (input.sessionId) {
    const [dup] = await d.select({ id: phoneCalls.id, contactName: phoneCalls.contactName }).from(phoneCalls).where(eq(phoneCalls.rcSessionId, input.sessionId)).limit(1);
    if (dup) return { id: dup.id, contactName: dup.contactName, duplicate: true };
  }
  // The row the call was started from wins; otherwise look the number up.
  const ctx = input.context ?? {};
  const match = ctx.subjectKey || ctx.patientId ? null : await findSubjectByPhone(phone);
  const patientId = ctx.patientId ?? match?.patientId ?? null;
  const subjectKey = ctx.subjectKey ?? (ctx.patientId ? `p:${ctx.patientId}` : null) ?? match?.key ?? null;
  const contactName = ctx.name ?? match?.name ?? null;
  const res = await d.insert(phoneCalls).values({
    userId: actor.id, direction: input.direction, phoneNumber: phone, patientId, subjectKey, contactName,
    startedAt: input.startedAt, durationSec: Math.max(0, Math.min(24 * 3600, Math.round(input.durationSec))),
    result: input.result?.slice(0, 60) ?? null, source: ctx.source?.slice(0, 40) ?? null, rcSessionId: input.sessionId,
  });
  return { id: (res as unknown as [{ insertId: number }])[0].insertId, contactName, duplicate: false };
}

/** Staff record how the call went. Closing outcomes take the person off the call lists for 30 days. */
export async function setCallOutcome(actor: WorkspaceActor, input: { callId: number; outcome: CallOutcome; note?: string | null }) {
  const d = await db();
  const [call] = await d.select().from(phoneCalls).where(eq(phoneCalls.id, input.callId)).limit(1);
  if (!call || (call.userId !== actor.id && actor.role !== "admin")) throw new WorkspaceError("Call not found.", "NOT_FOUND");
  await d.update(phoneCalls).set({ outcome: input.outcome, note: input.note?.trim() || null }).where(eq(phoneCalls.id, call.id));
  let closed = false;
  if (call.subjectKey && CLOSING_OUTCOMES.includes(input.outcome)) {
    // Close it on the list the call came from (the Fill-a-schedule list by default).
    const category = call.source && (OPPORTUNITY_CATEGORY_LIST as string[]).includes(call.source) ? call.source : "schedule_fill";
    await d.insert(opportunityActions).values({
      patientId: call.patientId, subjectKey: call.subjectKey, category,
      action: input.outcome === "booked" ? "reviewed" : "dismissed", userId: actor.id,
    });
    closed = true;
  }
  return { success: true, closed };
}

export async function callsForPatient(patientId: number) {
  const d = await db();
  return d
    .select({ id: phoneCalls.id, direction: phoneCalls.direction, startedAt: phoneCalls.startedAt, durationSec: phoneCalls.durationSec, result: phoneCalls.result, outcome: phoneCalls.outcome, note: phoneCalls.note, userName: users.name })
    .from(phoneCalls)
    .leftJoin(users, eq(users.id, phoneCalls.userId))
    .where(eq(phoneCalls.patientId, patientId))
    .orderBy(desc(phoneCalls.startedAt))
    .limit(100);
}

/** Recent calls per person (by Opportunity Finder key), for the call lists. */
export async function recentCallsBySubject(keys: string[], days = 90) {
  const out = new Map<string, { count: number; lastAt: Date; lastOutcome: string | null }>();
  if (!keys.length) return out;
  const d = await db();
  const since = new Date(Date.now() - days * 86_400_000);
  for (let i = 0; i < keys.length; i += 500) {
    const rows = await d
      .select({ subjectKey: phoneCalls.subjectKey, startedAt: phoneCalls.startedAt, outcome: phoneCalls.outcome })
      .from(phoneCalls)
      .where(and(inArray(phoneCalls.subjectKey, keys.slice(i, i + 500)), gte(phoneCalls.startedAt, since), eq(phoneCalls.direction, "outbound")));
    for (const r of rows) {
      if (!r.subjectKey) continue;
      const cur = out.get(r.subjectKey);
      if (!cur) out.set(r.subjectKey, { count: 1, lastAt: r.startedAt, lastOutcome: r.outcome });
      else {
        cur.count++;
        if (r.startedAt > cur.lastAt) { cur.lastAt = r.startedAt; cur.lastOutcome = r.outcome; }
      }
    }
  }
  return out;
}

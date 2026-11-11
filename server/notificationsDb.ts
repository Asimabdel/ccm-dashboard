// The bell: each person's notifications, which kinds they've switched off, and clearing them.
// Switched-off kinds aren't sent at all (every sender goes through `deliverableTo`), and switching a
// kind off marks the ones already waiting as read so the bell count drops straight away.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, notifications } from "../drizzle/schema";
import { cleanOffKinds, notificationKind, type NotificationKind } from "../shared/notifications";

const prefKey = (userId: number) => `notify_prefs:${userId}`;
const SHOWN = 30;

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export async function getOffKinds(userId: number): Promise<NotificationKind[]> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, prefKey(userId))).limit(1);
  return cleanOffKinds((row?.value as { off?: unknown } | undefined)?.off);
}

/** Of these people, who still wants this notification (one read for everyone). */
export async function deliverableTo(userIds: number[], type: string, title: string): Promise<number[]> {
  const ids = Array.from(new Set(userIds)).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const kind = notificationKind(type, title);
  const rows = await (await db()).select({ key: appSettings.key, value: appSettings.value }).from(appSettings)
    .where(inArray(appSettings.key, ids.map(prefKey)));
  const muted = new Set(rows.filter((r) => cleanOffKinds((r.value as { off?: unknown })?.off).includes(kind)).map((r) => Number(r.key.split(":")[1])));
  return ids.filter((id) => !muted.has(id));
}

export async function setOffKinds(userId: number, off: string[]) {
  const d = await db();
  const clean = cleanOffKinds(off);
  await d.insert(appSettings).values({ key: prefKey(userId), value: { off: clean }, updatedByUserId: userId })
    .onDuplicateKeyUpdate({ set: { value: { off: clean }, updatedByUserId: userId } });
  if (clean.length) {
    const waiting = await d.select({ id: notifications.id, type: notifications.type, title: notifications.title }).from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
    const ids = waiting.filter((n) => clean.includes(notificationKind(n.type, n.title))).map((n) => n.id);
    for (let i = 0; i < ids.length; i += 500) await d.update(notifications).set({ read: true }).where(inArray(notifications.id, ids.slice(i, i + 500)));
  }
  return { off: clean };
}

/** The newest notifications the person still wants, and how many are unread. */
export async function listForUser(userId: number) {
  const d = await db();
  const off = await getOffKinds(userId);
  const recent = await d.select().from(notifications).where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(SHOWN * 2);
  const items = recent.map((n) => ({ ...n, kind: notificationKind(n.type, n.title) })).filter((n) => !off.includes(n.kind)).slice(0, SHOWN);
  const [c] = await d.select({ n: sql<number>`count(*)` }).from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
  return { items, unread: Number(c?.n ?? 0), off };
}

export async function markRead(userId: number, id: number) {
  await (await db()).update(notifications).set({ read: true }).where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
}

export async function markAllRead(userId: number) {
  await (await db()).update(notifications).set({ read: true }).where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
}

/** Empty the person's bell. Only the alerts go: the tasks, requests and documents they pointed to stay. */
export async function clearAll(userId: number) {
  const res = await (await db()).delete(notifications).where(eq(notifications.userId, userId));
  return { cleared: Number((res as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0) };
}

/** IAM-only report: one person's notifications by kind (counts only). */
export async function notificationCounts(input: { userId: number }) {
  const d = await db();
  const rows = await d.select({ type: notifications.type, title: notifications.title, read: notifications.read, createdAt: notifications.createdAt })
    .from(notifications).where(eq(notifications.userId, input.userId));
  const weekAgo = Date.now() - 7 * 86_400_000;
  const byKind: Record<string, { total: number; unread: number; lastWeek: number }> = {};
  for (const r of rows) {
    const k = notificationKind(r.type, r.title);
    const b = (byKind[k] ??= { total: 0, unread: 0, lastWeek: 0 });
    b.total++;
    if (!r.read) b.unread++;
    if (new Date(r.createdAt).getTime() >= weekAgo) b.lastWeek++;
  }
  return { total: rows.length, unread: rows.filter((r) => !r.read).length, off: await getOffKinds(input.userId), byKind };
}

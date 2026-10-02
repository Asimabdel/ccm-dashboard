// Internal messaging (the practice's choices, 2026-10-02): direct messages and groups, built-in
// channels (everyone, each clinic's staff, each provider's team), conversations about a patient, and
// "make this a task". New messages show within seconds (the page checks every few seconds), with an
// unread badge and a browser pop-up that never carries the message or a patient's details.
//
// Who is in a built-in channel is worked out from Workforce and the provider teams every time, so it
// follows staffing changes. Admins are in every clinic channel. Nobody, admins included, can read a
// direct message or group they aren't in.
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "./db";
import { chatConversations, chatMembers, chatMessages, clinics, providerTeamMembers, providers, staffProfiles, users, workTasks } from "../drizzle/schema";
import { WorkspaceError, audit, subjectCare, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

type Conv = typeof chatConversations.$inferSelect;
const MAX_BODY = 4000;

/** People with a MyPCP login (not roster-only names, not "no access"). */
export async function staffDirectory() {
  const rows = await (await db()).select({ id: users.id, name: users.name, role: users.role, clinicId: staffProfiles.homeClinicId, active: staffProfiles.active })
    .from(users).leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .where(and(ne(users.role, "user"), sql`${users.openId} NOT LIKE 'roster:%'`)).orderBy(asc(users.name));
  return rows.filter((u) => u.name && u.active !== false);
}

/** The built-in channels: one for everyone, one per clinic, one per provider with a team. Created as needed
 *  (each has its own unique key, so two pages loading at once can't create it twice). */
async function ensureSystemConversations() {
  const d = await db();
  const have = new Set((await d.select({ k: chatConversations.uniqueKey }).from(chatConversations)
    .where(inArray(chatConversations.kind, ["everyone", "clinic", "team"]))).map((c) => c.k));
  const add: (typeof chatConversations.$inferInsert)[] = [];
  if (!have.has("everyone")) add.push({ kind: "everyone", title: "Everyone", uniqueKey: "everyone" });
  for (const c of await d.select({ id: clinics.id }).from(clinics)) if (!have.has(`clinic:${c.id}`)) add.push({ kind: "clinic", clinicId: c.id, uniqueKey: `clinic:${c.id}` });
  const teamProviders = await d.selectDistinct({ id: providerTeamMembers.providerId }).from(providerTeamMembers);
  for (const p of teamProviders) if (!have.has(`team:${p.id}`)) add.push({ kind: "team", providerId: p.id, uniqueKey: `team:${p.id}` });
  if (add.length) await d.insert(chatConversations).values(add).onDuplicateKeyUpdate({ set: { uniqueKey: sql`uniqueKey` } });
}

/** A direct message's other person. */
const dmOther = (c: Conv, me: number) => c.uniqueKey!.split(":").slice(1).map(Number).find((x) => x !== me) ?? me;

/** The clinics and provider teams a person belongs to (for the built-in channels). */
async function placesOf(user: { id: number; role: string }) {
  const d = await db();
  const clinicIds = new Set<number>();
  if (user.role === "admin") for (const c of await d.select({ id: clinics.id }).from(clinics)) clinicIds.add(c.id);
  const [home] = await d.select({ clinicId: staffProfiles.homeClinicId }).from(staffProfiles).where(eq(staffProfiles.userId, user.id)).limit(1);
  if (home?.clinicId) clinicIds.add(home.clinicId);
  const ownProviders = await d.select({ id: providers.id, clinicId: providers.clinicId }).from(providers).where(eq(providers.userId, user.id));
  for (const p of ownProviders) if (p.clinicId) clinicIds.add(p.clinicId);
  const teams = new Set<number>(ownProviders.map((p) => p.id));
  for (const t of await d.select({ providerId: providerTeamMembers.providerId }).from(providerTeamMembers).where(eq(providerTeamMembers.userId, user.id))) teams.add(t.providerId);
  return { clinicIds, teams };
}

/** Is this person in the conversation? */
async function canSee(user: { id: number; role: string }, c: Conv, places?: Awaited<ReturnType<typeof placesOf>>) {
  if (c.kind === "everyone") return true;
  if (c.kind === "clinic" || c.kind === "team") {
    const p = places ?? (await placesOf(user));
    return c.kind === "clinic" ? !!c.clinicId && p.clinicIds.has(c.clinicId) : !!c.providerId && p.teams.has(c.providerId);
  }
  const [m] = await (await db()).select({ id: chatMembers.id }).from(chatMembers)
    .where(and(eq(chatMembers.conversationId, c.id), eq(chatMembers.userId, user.id), isNull(chatMembers.leftAt))).limit(1);
  return !!m;
}

async function conversationOr404(user: { id: number; role: string }, id: number) {
  const [c] = await (await db()).select().from(chatConversations).where(eq(chatConversations.id, id)).limit(1);
  if (!c || !(await canSee(user, c))) throw new WorkspaceError("Conversation not found.", "NOT_FOUND");
  return c;
}

/** Everyone in a conversation (names), for the header. */
async function membersOf(c: Conv): Promise<{ id: number; name: string | null }[]> {
  const d = await db();
  if (c.kind === "everyone") return (await staffDirectory()).map((u) => ({ id: u.id, name: u.name }));
  if (c.kind === "clinic") {
    const staff = (await staffDirectory()).filter((u) => u.clinicId === c.clinicId || u.role === "admin");
    const provs = await d.select({ id: users.id, name: users.name }).from(providers).innerJoin(users, eq(users.id, providers.userId)).where(eq(providers.clinicId, c.clinicId!));
    return Array.from(new Map([...staff.map((u) => ({ id: u.id, name: u.name })), ...provs].map((u) => [u.id, u])).values());
  }
  if (c.kind === "team") {
    const team = await d.select({ id: users.id, name: users.name }).from(providerTeamMembers).innerJoin(users, eq(users.id, providerTeamMembers.userId)).where(eq(providerTeamMembers.providerId, c.providerId!));
    const own = await d.select({ id: users.id, name: users.name }).from(providers).innerJoin(users, eq(users.id, providers.userId)).where(eq(providers.id, c.providerId!));
    return Array.from(new Map([...own, ...team].map((u) => [u.id, u])).values());
  }
  return d.select({ id: users.id, name: users.name }).from(chatMembers).innerJoin(users, eq(users.id, chatMembers.userId))
    .where(and(eq(chatMembers.conversationId, c.id), isNull(chatMembers.leftAt)));
}

/** All conversations someone is in, newest activity first, with unread counts and the last message. */
export async function myConversations(user: { id: number; role: string }) {
  await ensureSystemConversations();
  const d = await db();
  const places = await placesOf(user);
  const mine = await d.select({ conversationId: chatMembers.conversationId, lastReadAt: chatMembers.lastReadAt }).from(chatMembers)
    .where(and(eq(chatMembers.userId, user.id), isNull(chatMembers.leftAt)));
  const readAt = new Map(mine.map((m) => [m.conversationId, m.lastReadAt]));
  const all = await d.select().from(chatConversations).where(sql`${chatConversations.kind} IN ('everyone','clinic','team') OR ${chatConversations.id} IN (${mine.length ? sql.join(mine.map((m) => sql`${m.conversationId}`), sql`, `) : sql`0`})`);
  const convs = all.filter((c) => c.kind === "everyone" || (c.kind === "clinic" ? !!c.clinicId && places.clinicIds.has(c.clinicId)
    : c.kind === "team" ? !!c.providerId && places.teams.has(c.providerId) : readAt.has(c.id)));
  if (!convs.length) return [];
  // A built-in channel someone sees for the first time: start their read position now (earlier messages aren't "unread").
  const fresh = convs.filter((c) => !readAt.has(c.id));
  if (fresh.length) {
    const now = new Date();
    await d.insert(chatMembers).values(fresh.map((c) => ({ conversationId: c.id, userId: user.id, lastReadAt: now, createdAt: now })))
      .onDuplicateKeyUpdate({ set: { userId: sql`userId` } });
  }
  const ids = convs.map((c) => c.id);
  // Unread: others' messages after my read position (none read yet = since I joined / since the channel showed up for me).
  const unreadRows = await d.select({ conversationId: chatMessages.conversationId, n: sql<number>`count(*)` }).from(chatMessages)
    .leftJoin(chatMembers, and(eq(chatMembers.conversationId, chatMessages.conversationId), eq(chatMembers.userId, user.id)))
    .where(and(inArray(chatMessages.conversationId, ids), ne(chatMessages.userId, user.id), isNull(chatMessages.deletedAt),
      sql`${chatMessages.createdAt} > COALESCE(${chatMembers.lastReadAt}, ${chatMembers.createdAt})`))
    .groupBy(chatMessages.conversationId);
  const unread = new Map(unreadRows.map((r) => [r.conversationId, Number(r.n)]));
  const lastIds = await d.select({ conversationId: chatMessages.conversationId, id: sql<number>`max(${chatMessages.id})` }).from(chatMessages)
    .where(inArray(chatMessages.conversationId, ids)).groupBy(chatMessages.conversationId);
  const lastRows = lastIds.length ? await d.select({ id: chatMessages.id, conversationId: chatMessages.conversationId, body: chatMessages.body, deletedAt: chatMessages.deletedAt, createdAt: chatMessages.createdAt, from: users.name, fromId: users.id })
    .from(chatMessages).innerJoin(users, eq(users.id, chatMessages.userId)).where(inArray(chatMessages.id, lastIds.map((l) => Number(l.id)))) : [];
  const last = new Map(lastRows.map((r) => [r.conversationId, r]));
  // Names for titles.
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));
  const provName = new Map((await d.select({ id: providers.id, name: providers.name }).from(providers)).map((p) => [p.id, p.name]));
  const dmOthers = convs.filter((c) => c.kind === "dm").map((c) => dmOther(c, user.id));
  const userName = new Map(dmOthers.length ? (await d.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, dmOthers))).map((u) => [u.id, u.name]) : []);
  return convs.map((c) => {
    const l = last.get(c.id);
    const other = c.kind === "dm" ? dmOther(c, user.id) : null;
    const title = c.kind === "dm" ? userName.get(other!) ?? "Direct message"
      : c.kind === "clinic" ? clinicName.get(c.clinicId!) ?? "Clinic"
      : c.kind === "team" ? `${provName.get(c.providerId!) ?? "Provider"}'s team`
      : c.title ?? "Group";
    return {
      id: c.id, kind: c.kind, title, subjectKey: c.subjectKey, otherUserId: other,
      unread: unread.get(c.id) ?? 0,
      last: l ? { from: l.fromId === user.id ? "You" : l.from, text: l.deletedAt ? "Message removed" : l.body.slice(0, 120), at: l.createdAt } : null,
      lastAt: c.lastMessageAt ?? c.createdAt,
    };
  }).sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());
}

/** The unread total and the newest unread message's sender, for the badge and the pop-up (no message text or title:
 *  a group about a patient is named after them, and pop-ups show on screen). */
export async function unreadSummary(user: { id: number; role: string }) {
  const list = await myConversations(user);
  const withUnread = list.filter((c) => c.unread > 0);
  const newest = withUnread.sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime())[0];
  return {
    total: withUnread.reduce((n, c) => n + c.unread, 0),
    newest: newest ? { conversationId: newest.id, from: newest.last?.from ?? null, at: newest.last?.at ?? newest.lastAt } : null,
  };
}

/** Mark read up to now (creates the read-position row for a built-in channel the first time). */
async function markRead(userId: number, conversationId: number) {
  const now = new Date();
  await (await db()).insert(chatMembers).values({ conversationId, userId, lastReadAt: now, createdAt: now })
    .onDuplicateKeyUpdate({ set: { lastReadAt: now } });
}

/** A conversation's messages (the latest 100, or those after `afterId`), and marks it read. */
export async function conversationDetail(user: { id: number; role: string }, id: number, afterId?: number) {
  const c = await conversationOr404(user, id);
  const d = await db();
  const cond = afterId ? and(eq(chatMessages.conversationId, id), gt(chatMessages.id, afterId)) : eq(chatMessages.conversationId, id);
  const rows = await d.select({ m: chatMessages, from: users.name }).from(chatMessages).innerJoin(users, eq(users.id, chatMessages.userId))
    .where(cond).orderBy(desc(chatMessages.id)).limit(100);
  await markRead(user.id, id);
  return {
    conversation: { id: c.id, kind: c.kind, subjectKey: c.subjectKey, canAddPeople: c.kind === "group" || c.kind === "patient" },
    members: afterId ? null : await membersOf(c),
    messages: rows.reverse().map(({ m, from }) => ({
      id: m.id, fromId: m.userId, from, mine: m.userId === user.id, at: m.createdAt,
      body: m.deletedAt ? null : m.body, deleted: !!m.deletedAt,
      patient: m.subjectKey && !m.deletedAt ? { key: m.subjectKey, name: m.patientName } : null, taskId: m.taskId,
    })),
  };
}

export async function sendMessage(actor: WorkspaceActor, input: { conversationId: number; body: string; subjectKey?: string | null }) {
  const body = input.body.trim();
  if (!body) throw new WorkspaceError("Type a message.");
  if (body.length > MAX_BODY) throw new WorkspaceError(`Messages can be up to ${MAX_BODY} characters.`);
  await conversationOr404(actor, input.conversationId);
  let patient: { patientId: number | null; name: string } | null = null;
  if (input.subjectKey) {
    patient = await subjectCare(input.subjectKey);
    if (!patient) {
      const { directoryEntry } = await import("./directoryDb");
      const e = await directoryEntry(input.subjectKey);
      patient = e ? { patientId: e.patientId, name: e.name } : null;
    }
    if (!patient) throw new WorkspaceError("That patient wasn't found.");
  }
  const d = await db();
  const now = new Date();
  const res = await d.insert(chatMessages).values({
    conversationId: input.conversationId, userId: actor.id, body, createdAt: now,
    subjectKey: patient ? input.subjectKey! : null, patientId: patient?.patientId ?? null, patientName: patient?.name.slice(0, 255) ?? null,
  });
  await d.update(chatConversations).set({ lastMessageAt: now }).where(eq(chatConversations.id, input.conversationId));
  await markRead(actor.id, input.conversationId);
  if (patient) await audit(actor, "update_patient", { entityType: "chat", entityId: input.conversationId, description: "Message about a patient sent" });
  return { id: Number((res as unknown as [{ insertId: number }])[0]?.insertId) };
}

/** Open (or create) the direct message with one person. */
export async function openDirect(actor: WorkspaceActor, otherUserId: number) {
  if (otherUserId === actor.id) throw new WorkspaceError("Pick someone else.");
  if (!(await staffDirectory()).some((u) => u.id === otherUserId)) throw new WorkspaceError("That person doesn't have a MyPCP login.");
  const d = await db();
  const uniqueKey = `dm:${[actor.id, otherUserId].sort((a, b) => a - b).join(":")}`;
  const find = async () => (await d.select({ id: chatConversations.id }).from(chatConversations).where(eq(chatConversations.uniqueKey, uniqueKey)).limit(1))[0];
  const c = await find();
  if (c) return { id: c.id };
  await d.insert(chatConversations).values({ kind: "dm", uniqueKey, createdByUserId: actor.id }).onDuplicateKeyUpdate({ set: { uniqueKey: sql`uniqueKey` } });
  const id = (await find())!.id;
  const now = new Date();
  await d.insert(chatMembers).values([{ conversationId: id, userId: actor.id, lastReadAt: now, createdAt: now }, { conversationId: id, userId: otherUserId, lastReadAt: null, createdAt: now }])
    .onDuplicateKeyUpdate({ set: { leftAt: null } });
  return { id };
}

/** A group (or a conversation about a patient): the starter plus the people picked. */
export async function createGroup(actor: WorkspaceActor, input: { title?: string | null; memberIds: number[]; subjectKey?: string | null }) {
  const staff = new Set((await staffDirectory()).map((u) => u.id));
  const memberIds = Array.from(new Set(input.memberIds)).filter((id) => id !== actor.id && staff.has(id));
  if (!memberIds.length) throw new WorkspaceError("Add at least one person.");
  let title = input.title?.trim().slice(0, 160) || null;
  let patientId: number | null = null;
  if (input.subjectKey) {
    const p = await subjectCare(input.subjectKey) ?? await (async () => { const { directoryEntry } = await import("./directoryDb"); const e = await directoryEntry(input.subjectKey!); return e ? { patientId: e.patientId, name: e.name } : null; })();
    if (!p) throw new WorkspaceError("That patient wasn't found.");
    patientId = p.patientId;
    title ??= `About ${p.name}`.slice(0, 160);
  }
  if (!title) throw new WorkspaceError("Give the group a name.");
  const d = await db();
  const res = await d.insert(chatConversations).values({ kind: input.subjectKey ? "patient" : "group", title, subjectKey: input.subjectKey ?? null, patientId, createdByUserId: actor.id });
  const id = Number((res as unknown as [{ insertId: number }])[0]?.insertId);
  const now = new Date();
  await d.insert(chatMembers).values([{ conversationId: id, userId: actor.id, lastReadAt: now, createdAt: now }, ...memberIds.map((userId) => ({ conversationId: id, userId, lastReadAt: null, createdAt: now }))]);
  if (input.subjectKey) await audit(actor, "update_patient", { entityType: "chat", entityId: id, description: "Conversation about a patient started" });
  return { id };
}

export async function addPeople(actor: WorkspaceActor, conversationId: number, userIds: number[]) {
  const c = await conversationOr404(actor, conversationId);
  if (c.kind !== "group" && c.kind !== "patient") throw new WorkspaceError("People can only be added to groups.");
  const staff = new Set((await staffDirectory()).map((u) => u.id));
  const add = Array.from(new Set(userIds)).filter((id) => staff.has(id));
  const d = await db();
  const now = new Date();
  for (const userId of add) {
    await d.insert(chatMembers).values({ conversationId, userId, lastReadAt: null, createdAt: now }).onDuplicateKeyUpdate({ set: { leftAt: null } });
  }
  return { added: add.length };
}

export async function leave(actor: WorkspaceActor, conversationId: number) {
  const c = await conversationOr404(actor, conversationId);
  if (c.kind !== "group" && c.kind !== "patient") throw new WorkspaceError("You can only leave a group.");
  await (await db()).update(chatMembers).set({ leftAt: new Date() }).where(and(eq(chatMembers.conversationId, conversationId), eq(chatMembers.userId, actor.id)));
  return { ok: true };
}

/** Remove one of my own messages (it shows as "Message removed"; the audit log keeps that it happened). */
export async function removeMessage(actor: WorkspaceActor, messageId: number) {
  const d = await db();
  const [m] = await d.select().from(chatMessages).where(eq(chatMessages.id, messageId)).limit(1);
  if (!m || m.userId !== actor.id) throw new WorkspaceError("You can only remove your own messages.");
  await d.update(chatMessages).set({ deletedAt: new Date() }).where(eq(chatMessages.id, messageId));
  await audit(actor, "update_task", { entityType: "chat", entityId: m.conversationId, description: "Chat message removed by its sender" });
  return { ok: true };
}

/** A task was made from a message: remember it on the message. */
export async function linkTask(actor: WorkspaceActor, messageId: number, taskId: number) {
  const d = await db();
  const [m] = await d.select().from(chatMessages).where(eq(chatMessages.id, messageId)).limit(1);
  if (!m) throw new WorkspaceError("Message not found.", "NOT_FOUND");
  await conversationOr404(actor, m.conversationId);
  const [t] = await d.select({ by: workTasks.createdByUserId }).from(workTasks).where(eq(workTasks.id, taskId)).limit(1);
  if (!t || t.by !== actor.id) throw new WorkspaceError("Task not found.", "NOT_FOUND");
  await d.update(chatMessages).set({ taskId }).where(eq(chatMessages.id, messageId));
  return { ok: true };
}

/** Patient 360 → Messages: the conversations about this patient that I'm in. */
export async function patientConversations(user: { id: number; role: string }, subjectKey: string) {
  const d = await db();
  const rows = await d.select({ c: chatConversations }).from(chatConversations)
    .innerJoin(chatMembers, and(eq(chatMembers.conversationId, chatConversations.id), eq(chatMembers.userId, user.id), isNull(chatMembers.leftAt)))
    .where(and(eq(chatConversations.kind, "patient"), eq(chatConversations.subjectKey, subjectKey))).orderBy(desc(chatConversations.lastMessageAt));
  return rows.map(({ c }) => ({ id: c.id, title: c.title, lastMessageAt: c.lastMessageAt ?? c.createdAt }));
}

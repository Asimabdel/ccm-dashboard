// Internal messaging (the practice's choices, 2026-10-02): direct messages and groups, built-in
// channels (everyone, each clinic's staff, each provider's team), conversations about a patient, and
// "make this a task". New messages show within seconds (the page checks every few seconds), with an
// unread badge and a browser pop-up that never carries the message or a patient's details.
//
// Who is in a built-in channel is worked out from Workforce and the provider teams every time, so it
// follows staffing changes. Admins are in every clinic channel. Nobody, admins included, can read a
// direct message or group they aren't in.
//
// Added the same day: mute (a muted conversation only counts @mentions of you), @mentions, read
// receipts, reactions, who's in today (time clock / shifts / time off), and Patient Flow posting
// "James S. is in Room 3, ready for @Dr" to the provider's team when a patient is roomed.
//
// Added 2026-10-04: replies, editing your own messages (the earlier wording is kept), search, pinned
// messages, "must read" messages with "I read this", announcement-only conversations (Everyone), and
// PDFs / photos in messages that can be filed in a patient's folder.
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  chatAcks, chatAttachments, chatConversations, chatMembers, chatMentions, chatMessageEdits, chatMessages, chatReactions, clinics, providerTeamMembers, providers, shifts, staffProfiles,
  timeOffRequests, timePunches, users, workTasks,
} from "../drizzle/schema";
import { WorkspaceError, audit, subjectCare, subjectKeyFor, type WorkspaceActor } from "./workspaceDb";
import { exists, onS3, putBytes, readTarget, uploadTarget } from "./docStore";
import {
  CHAT_FILE_MIME, MAX_CHAT_FILES, MAX_CHAT_FILE_BYTES, REACTIONS, canAnnounce, canPinIn, canPostIn, findMentions, likeContains, mentionName, presenceFor,
  shortPatientName, snippetAround, type Presence,
} from "../shared/chat";
import type { PatientFileType } from "../shared/folder";
import { localDateStr, localMinutes } from "../shared/workforce";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

type Conv = typeof chatConversations.$inferSelect;
type Person = { id: number; role: string };
const MAX_BODY = 4000;
const insertId = (res: unknown) => Number((res as [{ insertId: number }])[0]?.insertId);

/** People with a MyPCP login (not roster-only names, not "no access"). */
export async function staffDirectory() {
  const rows = await (await db()).select({ id: users.id, name: users.name, role: users.role, clinicId: staffProfiles.homeClinicId, active: staffProfiles.active, usesTimeClock: staffProfiles.usesTimeClock })
    .from(users).leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .where(and(ne(users.role, "user"), sql`${users.openId} NOT LIKE 'roster:%'`)).orderBy(asc(users.name));
  return rows.filter((u) => u.name && u.active !== false);
}

/** The built-in channels: one for everyone, one per clinic, one per provider (with a login or a team).
 *  Created as needed; each has its own unique key, so two pages loading at once can't create it twice. */
async function ensureSystemConversations() {
  const d = await db();
  const have = new Set((await d.select({ k: chatConversations.uniqueKey }).from(chatConversations)
    .where(inArray(chatConversations.kind, ["everyone", "clinic", "team"]))).map((c) => c.k));
  const add: (typeof chatConversations.$inferInsert)[] = [];
  if (!have.has("everyone")) add.push({ kind: "everyone", title: "Everyone", uniqueKey: "everyone" });
  for (const c of await d.select({ id: clinics.id }).from(clinics)) if (!have.has(`clinic:${c.id}`)) add.push({ kind: "clinic", clinicId: c.id, uniqueKey: `clinic:${c.id}` });
  const teamProviders = new Set((await d.selectDistinct({ id: providerTeamMembers.providerId }).from(providerTeamMembers)).map((p) => p.id));
  for (const p of await d.select({ id: providers.id }).from(providers).where(isNotNull(providers.userId))) teamProviders.add(p.id);
  for (const id of Array.from(teamProviders)) if (!have.has(`team:${id}`)) add.push({ kind: "team", providerId: id, uniqueKey: `team:${id}` });
  if (add.length) await d.insert(chatConversations).values(add).onDuplicateKeyUpdate({ set: { uniqueKey: sql`uniqueKey` } });
}

/** A direct message's other person. */
const dmOther = (c: Conv, me: number) => c.uniqueKey!.split(":").slice(1).map(Number).find((x) => x !== me) ?? me;

/** The clinics and provider teams a person belongs to (for the built-in channels). */
async function placesOf(user: Person) {
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
async function canSee(user: Person, c: Conv, places?: Awaited<ReturnType<typeof placesOf>>) {
  if (c.kind === "everyone") return true;
  if (c.kind === "clinic" || c.kind === "team") {
    const p = places ?? (await placesOf(user));
    return c.kind === "clinic" ? !!c.clinicId && p.clinicIds.has(c.clinicId) : !!c.providerId && p.teams.has(c.providerId);
  }
  const [m] = await (await db()).select({ id: chatMembers.id }).from(chatMembers)
    .where(and(eq(chatMembers.conversationId, c.id), eq(chatMembers.userId, user.id), isNull(chatMembers.leftAt))).limit(1);
  return !!m;
}

async function conversationOr404(user: Person, id: number) {
  const [c] = await (await db()).select().from(chatConversations).where(eq(chatConversations.id, id)).limit(1);
  if (!c || !(await canSee(user, c))) throw new WorkspaceError("Conversation not found.", "NOT_FOUND");
  return c;
}

/** Everyone in a conversation (names): the header, @mention suggestions, and who a mention may name. */
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

/** All conversations someone is in, newest activity first, with unread counts, @mentions and the last message. */
export async function myConversations(user: Person) {
  await ensureSystemConversations();
  const d = await db();
  const places = await placesOf(user);
  const mine = await d.select({ conversationId: chatMembers.conversationId, muted: chatMembers.muted }).from(chatMembers)
    .where(and(eq(chatMembers.userId, user.id), isNull(chatMembers.leftAt)));
  const memberOf = new Map(mine.map((m) => [m.conversationId, m]));
  const all = await d.select().from(chatConversations).where(sql`${chatConversations.kind} IN ('everyone','clinic','team') OR ${chatConversations.id} IN (${mine.length ? sql.join(mine.map((m) => sql`${m.conversationId}`), sql`, `) : sql`0`})`);
  const convs = all.filter((c) => c.kind === "everyone" || (c.kind === "clinic" ? !!c.clinicId && places.clinicIds.has(c.clinicId)
    : c.kind === "team" ? !!c.providerId && places.teams.has(c.providerId) : memberOf.has(c.id)));
  if (!convs.length) return [];
  // A built-in channel someone sees for the first time: unread counts from now (earlier messages aren't
  // "unread"). lastReadAt stays empty until they actually open it, so read receipts stay truthful.
  const fresh = convs.filter((c) => !memberOf.has(c.id));
  if (fresh.length) {
    const now = new Date();
    await d.insert(chatMembers).values(fresh.map((c) => ({ conversationId: c.id, userId: user.id, lastReadAt: null, createdAt: now })))
      .onDuplicateKeyUpdate({ set: { userId: sql`userId` } });
  }
  const ids = convs.map((c) => c.id);
  // After my read position: the newest message I've seen, or (never opened) when I joined.
  const after = (msgId: unknown, at: unknown) => sql`(CASE WHEN ${chatMembers.lastReadMessageId} IS NOT NULL THEN ${msgId} > ${chatMembers.lastReadMessageId} ELSE ${at} > ${chatMembers.createdAt} END)`;
  // Unread: others' messages after my read position.
  const unreadRows = await d.select({ conversationId: chatMessages.conversationId, n: sql<number>`count(*)` }).from(chatMessages)
    .innerJoin(chatMembers, and(eq(chatMembers.conversationId, chatMessages.conversationId), eq(chatMembers.userId, user.id)))
    .where(and(inArray(chatMessages.conversationId, ids), ne(chatMessages.userId, user.id), isNull(chatMessages.deletedAt), after(chatMessages.id, chatMessages.createdAt)))
    .groupBy(chatMessages.conversationId);
  const unread = new Map(unreadRows.map((r) => [r.conversationId, Number(r.n)]));
  // Unread @mentions of me (these count even when the conversation is muted).
  const mentionRows = await d.select({ conversationId: chatMentions.conversationId, n: sql<number>`count(*)`, lastId: sql<number>`max(${chatMentions.messageId})` }).from(chatMentions)
    .innerJoin(chatMembers, and(eq(chatMembers.conversationId, chatMentions.conversationId), eq(chatMembers.userId, user.id)))
    .innerJoin(chatMessages, eq(chatMessages.id, chatMentions.messageId))
    .where(and(eq(chatMentions.userId, user.id), inArray(chatMentions.conversationId, ids), isNull(chatMessages.deletedAt), after(chatMentions.messageId, chatMentions.createdAt)))
    .groupBy(chatMentions.conversationId);
  const mentions = new Map(mentionRows.map((r) => [r.conversationId, { n: Number(r.n), lastId: Number(r.lastId) }]));
  const lastIds = await d.select({ conversationId: chatMessages.conversationId, id: sql<number>`max(${chatMessages.id})` }).from(chatMessages)
    .where(inArray(chatMessages.conversationId, ids)).groupBy(chatMessages.conversationId);
  const lastRows = lastIds.length ? await d.select({ id: chatMessages.id, conversationId: chatMessages.conversationId, body: chatMessages.body, kind: chatMessages.kind, deletedAt: chatMessages.deletedAt, createdAt: chatMessages.createdAt, from: users.name, fromId: users.id })
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
    const muted = memberOf.get(c.id)?.muted ?? false;
    const u = unread.get(c.id) ?? 0;
    const m = mentions.get(c.id);
    return {
      id: c.id, kind: c.kind, title, subjectKey: c.subjectKey, otherUserId: other, muted,
      unread: u,
      mentions: m?.n ?? 0,
      /** What goes on the badge: everything new, or only @mentions of me when muted. */
      counted: muted ? m?.n ?? 0 : u,
      lastMentionId: m?.lastId ?? null,
      last: l ? { id: l.id, from: l.kind === "bot" ? "MyPCP" : l.fromId === user.id ? "You" : l.from, fromId: l.fromId, kind: l.kind, text: l.deletedAt ? "Message removed" : l.body.slice(0, 120), at: l.createdAt } : null,
      lastAt: c.lastMessageAt ?? c.createdAt,
    };
  }).sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());
}

/** The badge (unread, or only @mentions in muted conversations) and the newest such message's sender, for
 *  the pop-up. No message text or conversation title: a group about a patient is named after them. */
export async function unreadSummary(user: Person) {
  const list = await myConversations(user);
  const counted = list.filter((c) => c.counted > 0);
  const total = counted.reduce((n, c) => n + c.counted, 0);
  if (!counted.length) return { total, newest: null };
  // The newest counted message: the last message of an unmuted conversation, or my latest mention in a muted one.
  const pick = counted.map((c) => ({ c, id: c.muted ? c.lastMentionId! : c.last?.id ?? 0 })).sort((a, b) => b.id - a.id)[0]!;
  const d = await db();
  const [m] = await d.select({ at: chatMessages.createdAt, kind: chatMessages.kind, from: users.name }).from(chatMessages)
    .innerJoin(users, eq(users.id, chatMessages.userId)).where(eq(chatMessages.id, pick.id)).limit(1);
  const [mention] = await d.select({ id: chatMentions.id }).from(chatMentions).where(and(eq(chatMentions.messageId, pick.id), eq(chatMentions.userId, user.id))).limit(1);
  return {
    total,
    newest: m ? { conversationId: pick.c.id, messageId: pick.id, from: m.kind === "bot" ? "MyPCP" : m.from, at: m.at, mention: !!mention, flow: m.kind === "flow" } : null,
  };
}

/** Mark read up to a message (creates the row for a built-in channel the first time). */
async function markRead(userId: number, conversationId: number, upToId: number) {
  const now = new Date();
  await (await db()).insert(chatMembers).values({ conversationId, userId, lastReadAt: now, lastReadMessageId: upToId, createdAt: now })
    .onDuplicateKeyUpdate({ set: { lastReadAt: now, lastReadMessageId: sql`GREATEST(COALESCE(lastReadMessageId, 0), ${upToId})` } });
}

/**
 * A conversation's latest 100 messages (with mentions, reactions, replies, files, "I read this" and who has read
 * how far), its pinned messages, and marks it read. Opened from search (`focusId`): the messages around that one
 * too, if it's older (`gapAfterId` = the last of those, when newer ones are skipped before the latest 100).
 */
export async function conversationDetail(user: Person, id: number, focusId?: number | null) {
  const c = await conversationOr404(user, id);
  const d = await db();
  const pick = () => d.select({ m: chatMessages, from: users.name }).from(chatMessages).innerJoin(users, eq(users.id, chatMessages.userId));
  const latest = await pick().where(eq(chatMessages.conversationId, id)).orderBy(desc(chatMessages.id)).limit(100);
  let rows = latest;
  let gapAfterId: number | null = null;
  const oldestLatest = latest.at(-1)?.m.id ?? Number.MAX_SAFE_INTEGER;
  if (focusId && focusId < oldestLatest) {
    const before = await pick().where(and(eq(chatMessages.conversationId, id), lte(chatMessages.id, focusId))).orderBy(desc(chatMessages.id)).limit(20);
    const after = await pick().where(and(eq(chatMessages.conversationId, id), gt(chatMessages.id, focusId))).orderBy(asc(chatMessages.id)).limit(20);
    if (before.some((r) => r.m.id === focusId)) {
      const window = [...before, ...after].filter((r) => r.m.id < oldestLatest);
      // Newer messages are skipped between the two only if the window stops short of the latest 100.
      if (!after.some((r) => r.m.id >= oldestLatest) && after.length === 20) gapAfterId = Math.max(...window.map((r) => r.m.id));
      rows = Array.from(new Map([...latest, ...window].map((r) => [r.m.id, r])).values()).sort((a, b) => b.m.id - a.m.id);
    }
  }
  const msgIds = rows.map((r) => r.m.id);
  const mentionRows = msgIds.length ? await d.select({ messageId: chatMentions.messageId, userId: chatMentions.userId, name: users.name }).from(chatMentions)
    .innerJoin(users, eq(users.id, chatMentions.userId)).where(inArray(chatMentions.messageId, msgIds)) : [];
  const reactionRows = msgIds.length ? await d.select({ messageId: chatReactions.messageId, userId: chatReactions.userId, emoji: chatReactions.emoji, name: users.name }).from(chatReactions)
    .innerJoin(users, eq(users.id, chatReactions.userId)).where(inArray(chatReactions.messageId, msgIds)).orderBy(asc(chatReactions.id)) : [];
  // Replies: the messages they answer (they may be older than what's loaded).
  const replyIds = Array.from(new Set(rows.map((r) => r.m.replyToId).filter((x): x is number => !!x)));
  const replied = new Map((replyIds.length ? await d.select({ id: chatMessages.id, body: chatMessages.body, deletedAt: chatMessages.deletedAt, from: users.name })
    .from(chatMessages).innerJoin(users, eq(users.id, chatMessages.userId)).where(and(inArray(chatMessages.id, replyIds), eq(chatMessages.conversationId, id))) : []).map((r) => [r.id, r]));
  const files = msgIds.length ? await d.select().from(chatAttachments).where(and(inArray(chatAttachments.messageId, msgIds), eq(chatAttachments.status, "ready"))).orderBy(asc(chatAttachments.id)) : [];
  // Must read: how many have tapped "I read this", and whether I have.
  const ackIds = rows.filter((r) => r.m.requiresAck).map((r) => r.m.id);
  const acks = ackIds.length ? await d.select({ messageId: chatAcks.messageId, userId: chatAcks.userId }).from(chatAcks).where(inArray(chatAcks.messageId, ackIds)) : [];
  const pinned = await d.select({ id: chatMessages.id, body: chatMessages.body, at: chatMessages.createdAt, from: users.name }).from(chatMessages).innerJoin(users, eq(users.id, chatMessages.userId))
    .where(and(eq(chatMessages.conversationId, id), isNotNull(chatMessages.pinnedAt), isNull(chatMessages.deletedAt))).orderBy(desc(chatMessages.pinnedAt)).limit(20);
  const [me] = await d.select({ muted: chatMembers.muted }).from(chatMembers).where(and(eq(chatMembers.conversationId, id), eq(chatMembers.userId, user.id))).limit(1);
  // Read receipts: how far each other person has read (only people who actually opened it).
  const readers = await d.select({ id: users.id, name: users.name, upTo: chatMembers.lastReadMessageId }).from(chatMembers).innerJoin(users, eq(users.id, chatMembers.userId))
    .where(and(eq(chatMembers.conversationId, id), ne(chatMembers.userId, user.id), isNotNull(chatMembers.lastReadMessageId), isNull(chatMembers.leftAt)));
  await markRead(user.id, id, latest[0]?.m.id ?? 0);
  const members = await membersOf(c);
  const byMsg = <T extends { messageId: number }>(list: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of list) m.set(r.messageId, [...(m.get(r.messageId) ?? []), r]);
    return m;
  };
  const mentionsBy = byMsg(mentionRows);
  const reactionsBy = byMsg(reactionRows);
  return {
    conversation: {
      id: c.id, kind: c.kind, subjectKey: c.subjectKey, canAddPeople: c.kind === "group" || c.kind === "patient", muted: me?.muted ?? false,
      postingRestricted: c.postingRestricted, canPost: canPostIn(user.role, c), canPin: canPinIn(user.role, c.kind), canAnnounce: canAnnounce(user.role),
      canRestrict: user.role === "admin" && c.kind !== "dm",
    },
    members,
    readers: readers.map((r) => ({ id: r.id, name: r.name, upTo: r.upTo! })),
    pinned: pinned.map((p) => ({ id: p.id, from: p.from, text: p.body.slice(0, 160), at: p.at })),
    gapAfterId,
    messages: rows.reverse().map(({ m, from }) => {
      const ms = mentionsBy.get(m.id) ?? [];
      const rs = reactionsBy.get(m.id) ?? [];
      const reactions = REACTIONS.map((emoji) => rs.filter((r) => r.emoji === emoji)).filter((g) => g.length)
        .map((g) => ({ emoji: g[0]!.emoji, count: g.length, mine: g.some((r) => r.userId === user.id), names: g.map((r) => r.name ?? "") }));
      return {
        id: m.id, fromId: m.userId, from: m.kind === "bot" ? "MyPCP" : from, mine: m.userId === user.id && m.kind !== "bot", at: m.createdAt, kind: m.kind,
        body: m.deletedAt ? null : m.body, deleted: !!m.deletedAt,
        mentions: m.deletedAt ? [] : ms.map((x) => ({ id: x.userId, name: x.name })),
        mentionsMe: !m.deletedAt && ms.some((x) => x.userId === user.id),
        reactions: m.deletedAt ? [] : reactions,
        patient: m.subjectKey && !m.deletedAt ? { key: m.subjectKey, name: m.patientName } : null, taskId: m.taskId,
        replyTo: m.replyToId ? (() => {
          const r = replied.get(m.replyToId);
          return r ? { id: r.id, from: r.from, text: r.deletedAt ? null : r.body.slice(0, 140) } : { id: m.replyToId, from: null, text: null };
        })() : null,
        editedAt: m.deletedAt ? null : m.editedAt, pinned: !!m.pinnedAt && !m.deletedAt, requiresAck: m.requiresAck && !m.deletedAt,
        ack: m.requiresAck && !m.deletedAt ? {
          mine: acks.some((a) => a.messageId === m.id && a.userId === user.id),
          count: acks.filter((a) => a.messageId === m.id && a.userId !== m.userId).length,
          of: members.filter((x) => x.id !== m.userId).length,
        } : null,
        attachments: m.deletedAt ? [] : files.filter((f) => f.messageId === m.id).map((f) => ({ id: f.id, name: f.fileName, mimeType: f.mimeType, size: f.sizeBytes, savedToFolder: !!f.savedFileId })),
      };
    }),
  };
}

/** Record who a message @mentions. A mentioned person who has never opened a built-in channel gets their
 *  read position just before the message, so the mention shows as unread for them. */
async function addMentions(conversationId: number, messageId: number, at: Date, userIds: number[]) {
  if (!userIds.length) return;
  const d = await db();
  await d.insert(chatMentions).values(userIds.map((userId) => ({ messageId, conversationId, userId, createdAt: at })))
    .onDuplicateKeyUpdate({ set: { userId: sql`userId` } });
  const before = new Date(at.getTime() - 1000);
  await d.insert(chatMembers).values(userIds.map((userId) => ({ conversationId, userId, lastReadAt: null, createdAt: before })))
    .onDuplicateKeyUpdate({ set: { userId: sql`userId` } });
}

async function patientFor(subjectKey: string): Promise<{ patientId: number | null; name: string } | null> {
  const p = await subjectCare(subjectKey);
  if (p) return p;
  const { directoryEntry } = await import("./directoryDb");
  const e = await directoryEntry(subjectKey);
  return e ? { patientId: e.patientId, name: e.name } : null;
}

export async function sendMessage(actor: WorkspaceActor, input: { conversationId: number; body: string; subjectKey?: string | null; replyToId?: number | null; requiresAck?: boolean; attachmentIds?: number[] }) {
  const body = input.body.trim();
  const fileIds = Array.from(new Set(input.attachmentIds ?? []));
  if (!body && !fileIds.length) throw new WorkspaceError("Type a message.");
  if (body.length > MAX_BODY) throw new WorkspaceError(`Messages can be up to ${MAX_BODY} characters.`);
  if (fileIds.length > MAX_CHAT_FILES) throw new WorkspaceError(`Send up to ${MAX_CHAT_FILES} files at a time.`);
  const c = await conversationOr404(actor, input.conversationId);
  if (!canPostIn(actor.role, c)) throw new WorkspaceError("Only admins and office managers post here. You can still react, or tap “I read this”.", "FORBIDDEN");
  if (input.requiresAck && !canAnnounce(actor.role)) throw new WorkspaceError("Only admins and office managers can ask people to confirm they read a message.", "FORBIDDEN");
  const dd = await db();
  if (input.replyToId) {
    const [r] = await dd.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.id, input.replyToId), eq(chatMessages.conversationId, c.id))).limit(1);
    if (!r) throw new WorkspaceError("The message you're replying to wasn't found.");
  }
  if (fileIds.length) {
    const ok = await dd.select({ id: chatAttachments.id }).from(chatAttachments).where(and(inArray(chatAttachments.id, fileIds), eq(chatAttachments.uploadedByUserId, actor.id),
      eq(chatAttachments.conversationId, c.id), eq(chatAttachments.status, "ready"), isNull(chatAttachments.messageId)));
    if (ok.length !== fileIds.length) throw new WorkspaceError("A file didn't finish uploading. Remove it and try again.");
  }
  let patient: { patientId: number | null; name: string } | null = null;
  if (input.subjectKey) {
    patient = await patientFor(input.subjectKey);
    if (!patient) throw new WorkspaceError("That patient wasn't found.");
  }
  const d = await db();
  const now = new Date();
  const res = await d.insert(chatMessages).values({
    conversationId: input.conversationId, userId: actor.id, body, createdAt: now,
    subjectKey: patient ? input.subjectKey! : null, patientId: patient?.patientId ?? null, patientName: patient?.name.slice(0, 255) ?? null,
    replyToId: input.replyToId ?? null, requiresAck: !!input.requiresAck,
  });
  const id = insertId(res);
  if (fileIds.length) await d.update(chatAttachments).set({ messageId: id }).where(inArray(chatAttachments.id, fileIds));
  // @mentions: only people in this conversation.
  if (body.includes("@")) await addMentions(c.id, id, now, findMentions(body, await membersOf(c)).filter((u) => u !== actor.id));
  await d.update(chatConversations).set({ lastMessageAt: now }).where(eq(chatConversations.id, input.conversationId));
  await markRead(actor.id, input.conversationId, id);
  if (patient) await audit(actor, "update_patient", { entityType: "chat", entityId: input.conversationId, description: "Message about a patient sent" });
  if (fileIds.length) await audit(actor, "update_task", { entityType: "chat", entityId: input.conversationId, description: `${fileIds.length} file${fileIds.length === 1 ? "" : "s"} sent in Messages` });
  return { id };
}

/** Change one of my own messages. The earlier wording is kept (chatMessageEdits); edits don't send new alerts. */
export async function editMessage(actor: WorkspaceActor, messageId: number, body: string) {
  const text = body.trim();
  if (!text) throw new WorkspaceError("A message can't be empty. Remove it instead.");
  if (text.length > MAX_BODY) throw new WorkspaceError(`Messages can be up to ${MAX_BODY} characters.`);
  const d = await db();
  const [m] = await d.select().from(chatMessages).where(eq(chatMessages.id, messageId)).limit(1);
  if (!m || m.userId !== actor.id || m.deletedAt) throw new WorkspaceError("You can only edit your own messages.");
  if (m.kind !== "text") throw new WorkspaceError("This message can't be edited.");
  const c = await conversationOr404(actor, m.conversationId);
  if (text === m.body) return { ok: true };
  const now = new Date();
  await d.insert(chatMessageEdits).values({ messageId, previousBody: m.body, editedAt: now });
  await d.update(chatMessages).set({ body: text, editedAt: now }).where(eq(chatMessages.id, messageId));
  // Highlight anyone newly @mentioned (no new alert for an old message).
  if (text.includes("@")) {
    const had = new Set((await d.select({ userId: chatMentions.userId }).from(chatMentions).where(eq(chatMentions.messageId, messageId))).map((r) => r.userId));
    const add = findMentions(text, await membersOf(c)).filter((u) => u !== actor.id && !had.has(u));
    if (add.length) await d.insert(chatMentions).values(add.map((userId) => ({ messageId, conversationId: c.id, userId, createdAt: m.createdAt }))).onDuplicateKeyUpdate({ set: { userId: sql`userId` } });
  }
  return { ok: true };
}

/** Pin or unpin a message (anyone in a direct message / group; admins and office managers in the built-in channels). */
export async function setPinned(actor: WorkspaceActor, messageId: number, pinned: boolean) {
  const d = await db();
  const [m] = await d.select({ conversationId: chatMessages.conversationId, deletedAt: chatMessages.deletedAt }).from(chatMessages).where(eq(chatMessages.id, messageId)).limit(1);
  if (!m || m.deletedAt) throw new WorkspaceError("Message not found.", "NOT_FOUND");
  const c = await conversationOr404(actor, m.conversationId);
  if (!canPinIn(actor.role, c.kind)) throw new WorkspaceError("Only admins and office managers pin messages here.", "FORBIDDEN");
  await d.update(chatMessages).set(pinned ? { pinnedAt: new Date(), pinnedByUserId: actor.id } : { pinnedAt: null, pinnedByUserId: null }).where(eq(chatMessages.id, messageId));
  return { pinned };
}

/** "I read this" on a must-read message. */
export async function acknowledge(actor: WorkspaceActor, messageId: number) {
  const d = await db();
  const [m] = await d.select({ conversationId: chatMessages.conversationId, requiresAck: chatMessages.requiresAck, deletedAt: chatMessages.deletedAt }).from(chatMessages).where(eq(chatMessages.id, messageId)).limit(1);
  if (!m || m.deletedAt || !m.requiresAck) throw new WorkspaceError("Message not found.", "NOT_FOUND");
  await conversationOr404(actor, m.conversationId);
  await d.insert(chatAcks).values({ messageId, userId: actor.id }).onDuplicateKeyUpdate({ set: { userId: sql`userId` } });
  return { ok: true };
}

/** Who has (and hasn't) tapped "I read this": for the sender, admins and office managers. */
export async function ackStatus(actor: WorkspaceActor, messageId: number) {
  const d = await db();
  const [m] = await d.select({ conversationId: chatMessages.conversationId, userId: chatMessages.userId, requiresAck: chatMessages.requiresAck, deletedAt: chatMessages.deletedAt }).from(chatMessages).where(eq(chatMessages.id, messageId)).limit(1);
  if (!m || m.deletedAt || !m.requiresAck) throw new WorkspaceError("Message not found.", "NOT_FOUND");
  const c = await conversationOr404(actor, m.conversationId);
  if (m.userId !== actor.id && !canAnnounce(actor.role)) throw new WorkspaceError("Only the sender and admins see who has read it.", "FORBIDDEN");
  const acks = await d.select({ userId: chatAcks.userId, at: chatAcks.createdAt }).from(chatAcks).where(eq(chatAcks.messageId, messageId));
  const at = new Map(acks.map((a) => [a.userId, a.at]));
  const people = (await membersOf(c)).filter((p) => p.id !== m.userId).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return {
    read: people.filter((p) => at.has(p.id)).map((p) => ({ id: p.id, name: p.name, at: at.get(p.id)! })),
    notYet: people.filter((p) => !at.has(p.id)).map((p) => ({ id: p.id, name: p.name })),
  };
}

/** Announcements only (admins): just admins and office managers post; everyone else reacts / taps "I read this". */
export async function setPostingRestricted(actor: WorkspaceActor, conversationId: number, restricted: boolean) {
  if (actor.role !== "admin") throw new WorkspaceError("Only an admin can change who posts here.", "FORBIDDEN");
  const c = await conversationOr404(actor, conversationId);
  if (c.kind === "dm") throw new WorkspaceError("Direct messages can't be announcement-only.");
  await (await db()).update(chatConversations).set({ postingRestricted: restricted }).where(eq(chatConversations.id, conversationId));
  return { restricted };
}

/** Search the messages in every conversation I'm in (newest first). */
export async function searchMessages(user: Person, q: string) {
  const term = q.trim();
  if (term.length < 2) return [];
  const convs = await myConversations(user);
  if (!convs.length) return [];
  const byId = new Map(convs.map((c) => [c.id, c]));
  const rows = await (await db()).select({ id: chatMessages.id, conversationId: chatMessages.conversationId, body: chatMessages.body, at: chatMessages.createdAt, fromId: chatMessages.userId, from: users.name })
    .from(chatMessages).innerJoin(users, eq(users.id, chatMessages.userId))
    .where(and(inArray(chatMessages.conversationId, convs.map((c) => c.id)), isNull(chatMessages.deletedAt), sql`${chatMessages.body} LIKE ${likeContains(term)}`))
    .orderBy(desc(chatMessages.id)).limit(40);
  return rows.map((r) => ({
    messageId: r.id, conversationId: r.conversationId, title: byId.get(r.conversationId)?.title ?? "Conversation", kind: byId.get(r.conversationId)?.kind ?? "group",
    from: r.fromId === user.id ? "You" : r.from, at: r.at, snippet: snippetAround(r.body, term),
  }));
}

// ---------------------------------------------------------------------------
// Files in messages (PDFs and photos, private bucket; a copy can be filed in a patient's folder)
// ---------------------------------------------------------------------------

/** Start sending a file: the browser uploads it straight to storage (or through the API locally), then it's attached when the message is sent. */
export async function startAttachment(actor: WorkspaceActor, input: { conversationId: number; fileName: string; mimeType: string; size: number }) {
  const c = await conversationOr404(actor, input.conversationId);
  if (!canPostIn(actor.role, c)) throw new WorkspaceError("Only admins and office managers post here.", "FORBIDDEN");
  if (!(CHAT_FILE_MIME as readonly string[]).includes(input.mimeType)) throw new WorkspaceError("Send a PDF, JPG or PNG.");
  if (input.size <= 0 || input.size > MAX_CHAT_FILE_BYTES) throw new WorkspaceError("Files can be up to 25 MB.");
  const storageKey = `documents/chat/${randomUUID()}`;
  const res = await (await db()).insert(chatAttachments).values({
    conversationId: c.id, storageKey, fileName: input.fileName.replace(/[\r\n<>]/g, " ").slice(0, 255) || "File", mimeType: input.mimeType, sizeBytes: input.size, status: "uploading", uploadedByUserId: actor.id,
  });
  const id = insertId(res);
  return { id, upload: await uploadTarget(storageKey, input.mimeType) };
}

async function uploadingAttachment(actor: WorkspaceActor, id: number) {
  const [a] = await (await db()).select().from(chatAttachments).where(eq(chatAttachments.id, id)).limit(1);
  if (!a || a.uploadedByUserId !== actor.id || a.status !== "uploading") throw new WorkspaceError("That upload wasn't found.", "NOT_FOUND");
  return a;
}

/** Local development only: the bytes come through the API. */
export async function uploadAttachmentLocal(actor: WorkspaceActor, id: number, base64: string) {
  if (onS3()) throw new WorkspaceError("Upload straight to storage.");
  const a = await uploadingAttachment(actor, id);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_CHAT_FILE_BYTES) throw new WorkspaceError("Files can be up to 25 MB.");
  await putBytes(a.storageKey, bytes, a.mimeType);
  return { ok: true };
}

export async function finishAttachment(actor: WorkspaceActor, id: number) {
  const a = await uploadingAttachment(actor, id);
  if (!(await exists(a.storageKey))) throw new WorkspaceError("The file didn't arrive. Try again.");
  await (await db()).update(chatAttachments).set({ status: "ready" }).where(eq(chatAttachments.id, id));
  return { id, name: a.fileName, mimeType: a.mimeType, size: a.sizeBytes };
}

/** A sent file someone in the conversation may open. */
async function sentAttachment(actor: Person, id: number) {
  const d = await db();
  const [a] = await d.select().from(chatAttachments).where(and(eq(chatAttachments.id, id), eq(chatAttachments.status, "ready"))).limit(1);
  if (!a?.messageId) throw new WorkspaceError("That file wasn't found.", "NOT_FOUND");
  const [m] = await d.select({ deletedAt: chatMessages.deletedAt, subjectKey: chatMessages.subjectKey }).from(chatMessages).where(eq(chatMessages.id, a.messageId)).limit(1);
  if (!m || m.deletedAt) throw new WorkspaceError("That file wasn't found.", "NOT_FOUND");
  const c = await conversationOr404(actor, a.conversationId);
  return { a, subjectKey: m.subjectKey ?? c.subjectKey };
}

/** A short-lived link to view a file (every view is logged). */
export async function openAttachment(actor: WorkspaceActor, id: number) {
  const { a } = await sentAttachment(actor, id);
  await audit(actor, "view_document", { entityType: "chatAttachment", entityId: id, description: "Opened a file sent in Messages" });
  return { ...(await readTarget(a.storageKey, null, a.mimeType)), mimeType: a.mimeType, name: a.fileName };
}

/** File a copy of a sent PDF / photo in a patient's folder. */
export async function saveAttachmentToFolder(actor: WorkspaceActor, input: { attachmentId: number; subjectKey: string; fileType: PatientFileType; title: string; note?: string | null }) {
  const { a } = await sentAttachment(actor, input.attachmentId);
  const { addFileFromStorage } = await import("./folderDb");
  const fileId = await addFileFromStorage(actor, { subjectKey: input.subjectKey, fileType: input.fileType, title: input.title, note: input.note, sourceKey: a.storageKey, fileName: a.fileName, mimeType: a.mimeType, size: a.sizeBytes });
  await (await db()).update(chatAttachments).set({ savedFileId: fileId }).where(eq(chatAttachments.id, a.id));
  return { fileId };
}

/** Mute / unmute a conversation for me (muted: only @mentions of me count or pop up). */
export async function setMuted(user: Person, conversationId: number, muted: boolean) {
  await conversationOr404(user, conversationId);
  const now = new Date();
  await (await db()).insert(chatMembers).values({ conversationId, userId: user.id, lastReadAt: null, createdAt: now, muted })
    .onDuplicateKeyUpdate({ set: { muted } });
  return { muted };
}

/** Add or take back a reaction on a message. */
export async function react(user: Person, messageId: number, emoji: string) {
  if (!(REACTIONS as readonly string[]).includes(emoji)) throw new WorkspaceError("That reaction isn't available.");
  const d = await db();
  const [m] = await d.select({ conversationId: chatMessages.conversationId, deletedAt: chatMessages.deletedAt }).from(chatMessages).where(eq(chatMessages.id, messageId)).limit(1);
  if (!m || m.deletedAt) throw new WorkspaceError("Message not found.", "NOT_FOUND");
  await conversationOr404(user, m.conversationId);
  const where = and(eq(chatReactions.messageId, messageId), eq(chatReactions.userId, user.id), eq(chatReactions.emoji, emoji));
  const [had] = await d.select({ id: chatReactions.id }).from(chatReactions).where(where).limit(1);
  if (had) await d.delete(chatReactions).where(eq(chatReactions.id, had.id));
  else await d.insert(chatReactions).values({ messageId, userId: user.id, emoji }).onDuplicateKeyUpdate({ set: { emoji } });
  return { on: !had };
}

/** Who's in today, for everyone with a login: on the clock, scheduled, done, off (time off / called out), or not scheduled. */
export async function presence(): Promise<Record<number, Presence>> {
  const d = await db();
  const today = localDateStr();
  const people = await staffDirectory();
  const punches = await d.select({ userId: timePunches.userId, clockOutAt: timePunches.clockOutAt }).from(timePunches).where(eq(timePunches.workDate, today));
  const todayShifts = await d.select({ userId: shifts.userId, startTime: shifts.startTime, endTime: shifts.endTime, status: shifts.status }).from(shifts).where(eq(shifts.date, today));
  const off = new Set((await d.select({ userId: timeOffRequests.userId }).from(timeOffRequests)
    .where(and(eq(timeOffRequests.status, "approved"), lte(timeOffRequests.startDate, today), gte(timeOffRequests.endDate, today)))).map((r) => r.userId));
  const now = localMinutes();
  return Object.fromEntries(people.map((p) => {
    const mine = punches.filter((x) => x.userId === p.id);
    return [p.id, presenceFor({
      clockedIn: mine.some((x) => !x.clockOutAt),
      clockedOutToday: mine.some((x) => !!x.clockOutAt),
      timeOff: off.has(p.id),
      shifts: todayShifts.filter((s) => s.userId === p.id),
      usesTimeClock: !!p.usesTimeClock,
      now,
    })];
  }));
}

/**
 * Patient Flow: a patient was roomed → "James S. is in Room 3, ready for @Dr Chen" in the provider's team
 * channel (the provider is @mentioned, so it reaches them even if they muted it). A provider without a
 * login or team: the clinic's channel. Sent as the person who moved the patient.
 */
export async function postFlowPing(actor: WorkspaceActor, a: { providerId: number | null; providerName: string | null; clinicId: number | null; patientId: number | null; patientName: string; dateOfBirth: Date | null; room: string | null }) {
  const d = await db();
  await ensureSystemConversations();
  const [p] = a.providerId ? await d.select({ id: providers.id, name: providers.name, userId: providers.userId, login: users.name })
    .from(providers).leftJoin(users, eq(users.id, providers.userId)).where(eq(providers.id, a.providerId)).limit(1) : [];
  const key = p ? `team:${p.id}` : null;
  let [conv] = key ? await d.select().from(chatConversations).where(eq(chatConversations.uniqueKey, key)).limit(1) : [];
  if (!conv && a.clinicId) [conv] = await d.select().from(chatConversations).where(eq(chatConversations.uniqueKey, `clinic:${a.clinicId}`)).limit(1);
  if (!conv) return null;
  const who = p?.userId && p.login ? `@${mentionName(p.login)}` : p?.name ?? a.providerName ?? "the provider";
  const body = `${shortPatientName(a.patientName)} is ${a.room ? `in ${a.room}` : "roomed"}, ready for ${who}.`;
  const subjectKey = subjectKeyFor(a.patientId, a.patientName, a.dateOfBirth);
  const now = new Date();
  const res = await d.insert(chatMessages).values({
    conversationId: conv.id, userId: actor.id, body, kind: "flow", createdAt: now,
    subjectKey, patientId: a.patientId, patientName: a.patientName.slice(0, 255),
  });
  if (p?.userId && p.userId !== actor.id) await addMentions(conv.id, insertId(res), now, [p.userId]);
  await d.update(chatConversations).set({ lastMessageAt: now }).where(eq(chatConversations.id, conv.id));
  return { conversationId: conv.id };
}

/**
 * A message from MyPCP itself (e.g. the Monday perfect-attendance shout-out) in a built-in channel. It's
 * stored under the first admin (every message needs a sender) but always shows as "MyPCP".
 */
export async function postBotMessage(uniqueKey: string, body: string) {
  await ensureSystemConversations();
  const d = await db();
  const [conv] = await d.select().from(chatConversations).where(eq(chatConversations.uniqueKey, uniqueKey)).limit(1);
  const [admin] = await d.select({ id: users.id }).from(users).where(eq(users.role, "admin")).orderBy(asc(users.id)).limit(1);
  if (!conv || !admin) return null;
  const now = new Date();
  const res = await d.insert(chatMessages).values({ conversationId: conv.id, userId: admin.id, body: body.slice(0, MAX_BODY), kind: "bot", createdAt: now });
  await d.update(chatConversations).set({ lastMessageAt: now }).where(eq(chatConversations.id, conv.id));
  return { id: insertId(res), conversationId: conv.id };
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
  await d.insert(chatMembers).values([{ conversationId: id, userId: actor.id, lastReadAt: now, lastReadMessageId: 0, createdAt: now }, { conversationId: id, userId: otherUserId, lastReadAt: null, createdAt: now }])
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
    const p = await patientFor(input.subjectKey);
    if (!p) throw new WorkspaceError("That patient wasn't found.");
    patientId = p.patientId;
    title ??= `About ${p.name}`.slice(0, 160);
  }
  if (!title) throw new WorkspaceError("Give the group a name.");
  const d = await db();
  const res = await d.insert(chatConversations).values({ kind: input.subjectKey ? "patient" : "group", title, subjectKey: input.subjectKey ?? null, patientId, createdByUserId: actor.id });
  const id = insertId(res);
  const now = new Date();
  await d.insert(chatMembers).values([{ conversationId: id, userId: actor.id, lastReadAt: now, lastReadMessageId: 0, createdAt: now }, ...memberIds.map((userId) => ({ conversationId: id, userId, lastReadAt: null, createdAt: now }))]);
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
export async function patientConversations(user: Person, subjectKey: string) {
  const d = await db();
  const rows = await d.select({ c: chatConversations }).from(chatConversations)
    .innerJoin(chatMembers, and(eq(chatMembers.conversationId, chatConversations.id), eq(chatMembers.userId, user.id), isNull(chatMembers.leftAt)))
    .where(and(eq(chatConversations.kind, "patient"), eq(chatConversations.subjectKey, subjectKey))).orderBy(desc(chatConversations.lastMessageAt));
  return rows.map(({ c }) => ({ id: c.id, title: c.title, lastMessageAt: c.lastMessageAt ?? c.createdAt }));
}


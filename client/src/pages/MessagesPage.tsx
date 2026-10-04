import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  ArrowLeft, AtSign, Bell, BellOff, Building2, CheckCheck, DoorOpen, HeartPulse, ListPlus, Loader2, LogOut, Megaphone, MessagesSquare, MoreHorizontal, Paperclip, Pencil, Pin, PinOff,
  Plus, Reply, Search, Send, SmilePlus, Stethoscope, Trash2, User, UserPlus, Users, X, Zap,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, cardCls, fmtClock, inputCls } from "@/components/workspace/ui";
import { NewTaskDialog, type NewTaskDefaults } from "@/components/workspace/NewTaskDialog";
import { NewConversationDialog, type NewConversationMode } from "@/components/messages/NewConversationDialog";
import { PatientSearchBox, type PickedPatient } from "@/components/messages/PatientSearchBox";
import { popupsSupported } from "@/components/messages/useUnreadMessages";
import { PresenceDot, PresenceLabel, usePresence } from "@/components/messages/presence";
import { MessageFiles, PendingFiles, useChatUploads } from "@/components/messages/attachments";
import { AckList, MessageSearchResults } from "@/components/messages/MessageSearch";
import { TextsInbox } from "@/components/texts/TextsInbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { CLINIC_TZ } from "@shared/workforce";
import { CHAT_FILE_MIME, FLOW_QUICK_REPLIES, QUICK_REPLIES, REACTIONS, mentionName, splitMentions, type Presence } from "@shared/chat";
import { cn } from "@/lib/utils";

type Conversation = RouterOutputs["workspace"]["chat"]["conversations"][number];
type Detail = RouterOutputs["workspace"]["chat"]["get"];
type Message = Detail["messages"][number];
type Member = Detail["members"][number];

const KIND_ICON: Record<string, React.ElementType> = { dm: User, group: Users, patient: HeartPulse, everyone: Megaphone, clinic: Building2, team: Stethoscope };
const KIND_HINT: Record<string, string> = {
  everyone: "Everyone with a MyPCP login",
  clinic: "Everyone who works at this clinic (and the admins)",
  team: "The provider and their team",
  group: "A group",
  patient: "About a patient",
  dm: "Direct message",
};

const dayKey = (d: Date | string) => new Date(d).toLocaleDateString("en-CA", { timeZone: CLINIC_TZ });
function fmtDayLabel(d: Date | string) {
  const k = dayKey(d);
  if (k === dayKey(new Date())) return "Today";
  if (k === dayKey(new Date(Date.now() - 86_400_000))) return "Yesterday";
  return new Date(d).toLocaleDateString("en-US", { timeZone: CLINIC_TZ, weekday: "short", month: "short", day: "numeric" });
}
/** List times: today → 2:15 PM, earlier → Sep 30. */
function fmtListTime(d: Date | string) {
  return dayKey(d) === dayKey(new Date()) ? fmtClock(d) : new Date(d).toLocaleDateString("en-US", { timeZone: CLINIC_TZ, month: "short", day: "numeric" });
}
const patientHref = (key: string) => `/patients/${/^p:\d+$/.test(key) ? key.slice(2) : encodeURIComponent(key)}?tab=overview`;
const firstNames = (names: (string | null)[]) => names.map((n) => mentionName(n).split(" ")[0] || "Someone");

/**
 * Messages: talk to anyone at the practice. Direct messages, groups, each clinic's channel, each
 * provider's team, a channel for everyone, and conversations about a patient. Any message can become
 * a task. Mute a conversation to only hear about @mentions of you. The page checks every few seconds.
 * Reply to a message, edit your own, send PDFs / photos (and file them in a patient's folder), pin,
 * search everything, and post "must read" announcements (Everyone is announcements only).
 */
export default function MessagesPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const { caps, loading } = useWorkspace();
  if (!user || loading) return null;
  if (!caps?.messages) return <CCMDashboardLayout title="Messages"><EmptyState title="No access" body="Your role doesn't include messages." /></CCMDashboardLayout>;
  return <Messages />;
}

/** Team messages | Patient texts (for people who handle the practice's texts). */
function InboxTabs({ active, onChange }: { active: "team" | "texts"; onChange: (t: "team" | "texts") => void }) {
  const team = trpc.workspace.chat.unread.useQuery(undefined, { staleTime: 10_000 });
  const texts = trpc.workspace.texts.unread.useQuery(undefined, { refetchInterval: 20_000, staleTime: 10_000 });
  const tab = (t: "team" | "texts", label: string, n: number) => (
    <button onClick={() => onChange(t)} aria-pressed={active === t}
      className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold", active === t ? "bg-white text-slate-900 shadow-sm dark:bg-slate-600 dark:text-white" : "text-slate-500 hover:text-slate-800 dark:text-slate-400")}>
      {label}
      {n > 0 && <span className="rounded-full bg-brand px-1.5 text-[10px] font-bold tabular-nums text-white">{n > 99 ? "99+" : n}</span>}
    </button>
  );
  return (
    <div className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-700/60" role="group" aria-label="Inbox">
      {tab("team", "Team", team.data?.total ?? 0)}
      {tab("texts", "Patient texts", texts.data?.total ?? 0)}
    </div>
  );
}

function Messages() {
  const [params, setParams] = useUrlParams();
  const { caps } = useWorkspace();
  const tab: "team" | "texts" = caps?.texts && params.get("tab") === "texts" ? "texts" : "team";
  const tabs = caps?.texts ? <InboxTabs active={tab} onChange={(t) => setParams({ tab: t === "texts" ? "texts" : null, c: null, m: null, t: null })} /> : null;
  const selected = Number(params.get("c")) || null;
  const focus = Number(params.get("m")) || null;
  const [filter, setFilter] = useState("");
  const [newMode, setNewMode] = useState<NewConversationMode | null>(null);
  const list = trpc.workspace.chat.conversations.useQuery(undefined, { refetchInterval: 10_000 });
  const presence = usePresence();

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (list.data ?? []).filter((c) => !f || c.title.toLowerCase().includes(f));
  }, [list.data, filter]);
  const current = (list.data ?? []).find((c) => c.id === selected) ?? null;
  const searching = filter.trim().length >= 3;

  if (tab === "texts") {
    return (
      <CCMDashboardLayout title="Messages" pageTitle={false}>
        <div className={cn(cardCls, "flex overflow-hidden dark:bg-slate-800 h-[calc(100dvh-5.5rem)] md:h-[calc(100dvh-6.5rem)]")}>
          <TextsInbox threadId={Number(params.get("t")) || null} onOpen={(t) => setParams({ t })} tabs={tabs} />
        </div>
      </CCMDashboardLayout>
    );
  }

  return (
    <CCMDashboardLayout title="Messages" pageTitle={false}>
      <div className={cn(cardCls, "flex overflow-hidden dark:bg-slate-800 h-[calc(100dvh-5.5rem)] md:h-[calc(100dvh-6.5rem)]")}>
        {/* Conversation list (on phones: hidden while a conversation is open) */}
        <aside className={cn("flex w-full flex-col border-r border-slate-200 dark:border-slate-700 md:w-80 md:shrink-0", selected && "hidden md:flex")}>
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50">Messages</h1>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Btn size="sm"><Plus size={14} /> New</Btn>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => setNewMode("dm")}><User size={14} className="mr-2" /> Direct message</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setNewMode("group")}><Users size={14} className="mr-2" /> Group</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setNewMode("patient")}><HeartPulse size={14} className="mr-2" /> About a patient</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {tabs && <div className="mt-2">{tabs}</div>}
          </div>
          <div className="border-b border-slate-200 p-3 dark:border-slate-700">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className={cn(inputCls, "pl-8 pr-8")} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search conversations and messages" aria-label="Search conversations and messages" />
              {filter && <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700" onClick={() => setFilter("")} aria-label="Clear search"><X size={14} /></button>}
            </div>
          </div>
          <PopupPrompt />
          <div className="flex-1 overflow-y-auto">
            {list.isLoading && <Loading />}
            {list.error && <div className="p-3"><ErrorNote message={list.error.message} /></div>}
            {searching && shown.length > 0 && <p className="bg-slate-50 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">Conversations</p>}
            {shown.map((c) => <ConversationRow key={c.id} c={c} active={c.id === selected} presence={c.otherUserId ? presence[c.otherUserId] : undefined} onOpen={() => setParams({ c: c.id, m: null })} />)}
            {list.data && shown.length === 0 && !searching && <p className="px-4 py-6 text-center text-sm text-slate-400">No conversations match.</p>}
            <MessageSearchResults q={filter} onOpen={(c, m) => setParams({ c, m })} />
          </div>
        </aside>

        {/* The open conversation */}
        <section className={cn("min-w-0 flex-1 flex-col", selected ? "flex" : "hidden md:flex")}>
          {selected ? (
            <Thread key={selected} id={selected} focusId={focus} summary={current} presence={presence}
              onFocus={(m) => setParams({ m })} onBack={() => setParams({ c: null, m: null })} onLeft={() => setParams({ c: null, m: null })} />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState icon={MessagesSquare} title="Pick a conversation" body="Or start one with New: a direct message, a group, or a conversation about a patient." />
            </div>
          )}
        </section>
      </div>

      <NewConversationDialog open={!!newMode} onOpenChange={(o) => !o && setNewMode(null)} mode={newMode ?? "dm"} onOpened={(id) => { void list.refetch(); setParams({ c: id, m: null }); }} />
    </CCMDashboardLayout>
  );
}

/** Ask once (on a click, as browsers require) to show a pop-up when a message comes in. */
function PopupPrompt() {
  const [perm, setPerm] = useState(() => (popupsSupported() ? Notification.permission : "denied"));
  if (perm !== "default") return null;
  return (
    <div className="flex items-start gap-2 border-b border-slate-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 dark:border-slate-700 dark:bg-amber-500/10 dark:text-amber-200">
      <Bell size={14} className="mt-0.5 shrink-0" />
      <div className="flex-1">
        Get a pop-up when a message comes in (it shows only who it's from).
        <button className="ml-1 font-semibold underline" onClick={() => void Notification.requestPermission().then(setPerm)}>Turn on</button>
      </div>
    </div>
  );
}

function ConversationRow({ c, active, presence, onOpen }: { c: Conversation; active: boolean; presence?: Presence; onOpen: () => void }) {
  const Icon = KIND_ICON[c.kind] ?? Users;
  const bold = c.counted > 0;
  return (
    <button onClick={onOpen} className={cn("flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-700/40", active && "bg-slate-100 dark:bg-slate-700/60")}>
      <span className="relative mt-0.5 shrink-0">
        <span className={cn("flex h-9 w-9 items-center justify-center rounded-full", c.kind === "patient" ? "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300" : c.kind === "dm" ? "bg-brand-soft text-brand" : "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300")}>
          <Icon size={16} />
        </span>
        {presence && <PresenceDot p={presence} className="absolute -bottom-0.5 -right-0.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn("flex min-w-0 items-center gap-1 text-sm text-slate-900 dark:text-slate-50", bold ? "font-bold" : "font-medium")}>
            <span className="truncate">{c.title}</span>
            {c.muted && <BellOff size={12} className="shrink-0 text-slate-400" aria-label="Muted" />}
          </span>
          {c.last && <span className="shrink-0 text-[11px] text-slate-400">{fmtListTime(c.last.at)}</span>}
        </span>
        <span className="mt-0.5 flex items-center justify-between gap-2">
          <span className={cn("truncate text-xs", bold ? "text-slate-700 dark:text-slate-200" : "text-slate-500 dark:text-slate-400")}>
            {c.last ? `${c.last.from}: ${c.last.text || "Sent a file"}` : KIND_HINT[c.kind]}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {c.mentions > 0 && <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1 text-white" title={`${c.mentions} mention${c.mentions === 1 ? "" : "s"} of you`}><AtSign size={11} /></span>}
            {!c.muted && c.unread > 0 && <span className="rounded-full bg-brand px-1.5 text-[11px] font-bold tabular-nums text-white">{c.unread > 99 ? "99+" : c.unread}</span>}
            {c.muted && c.unread > 0 && <span className="rounded-full bg-slate-200 px-1.5 text-[11px] font-semibold tabular-nums text-slate-600 dark:bg-slate-600 dark:text-slate-200" title="New messages (muted)">{c.unread > 99 ? "99+" : c.unread}</span>}
          </span>
        </span>
      </span>
    </button>
  );
}

function Thread({ id, focusId, summary, presence, onFocus, onBack, onLeft }: {
  id: number; focusId: number | null; summary: Conversation | null; presence: Record<number, Presence>;
  onFocus: (messageId: number | null) => void; onBack: () => void; onLeft: () => void;
}) {
  const { caps, user } = useWorkspace();
  const utils = trpc.useUtils();
  const q = trpc.workspace.chat.get.useQuery({ id, focusId }, { refetchInterval: 5_000 });
  const [showPeople, setShowPeople] = useState(false);
  const [adding, setAdding] = useState(false);
  const [taskFrom, setTaskFrom] = useState<{ messageId: number; defaults: NewTaskDefaults } | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [ackFor, setAckFor] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const focusDone = useRef<number | null>(null);
  const loadedOnce = useRef(false);
  const lastId = q.data?.messages.at(-1)?.id;

  // Opening marks it read: refresh the list and the badge.
  useEffect(() => {
    if (!q.data) return;
    void utils.workspace.chat.conversations.invalidate();
    void utils.workspace.chat.unread.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, !!q.data]);

  const flash = (messageId: number) => {
    setHighlight(messageId);
    setTimeout(() => setHighlight((h) => (h === messageId ? null : h)), 2500);
  };
  // Opened from search / a pin / a reply: bring that message into view. Otherwise follow new messages,
  // unless I've scrolled up to read older ones.
  useEffect(() => {
    if (!q.data) return;
    if (focusId && focusDone.current !== focusId) {
      const el = document.getElementById(`msg-${focusId}`);
      if (el) { el.scrollIntoView({ block: "center" }); flash(focusId); focusDone.current = focusId; loadedOnce.current = true; return; }
    }
    const s = scroller.current;
    const nearBottom = !s || s.scrollHeight - s.scrollTop - s.clientHeight < 160;
    if (!loadedOnce.current || nearBottom || q.data.messages.at(-1)?.mine) bottom.current?.scrollIntoView({ block: "end" });
    loadedOnce.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, !!q.data, focusId, q.dataUpdatedAt]);

  // A photo finished loading (it makes the conversation taller): stay at the bottom if I was there.
  useEffect(() => {
    const onMedia = () => {
      const s = scroller.current;
      if (!s || focusId) return;
      if (s.scrollHeight - s.scrollTop - s.clientHeight < 400) bottom.current?.scrollIntoView({ block: "end" });
    };
    window.addEventListener("chat:media-loaded", onMedia);
    return () => window.removeEventListener("chat:media-loaded", onMedia);
  }, [focusId]);

  /** Show a message: scroll to it if it's loaded, otherwise load the messages around it. */
  const jump = (messageId: number) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); flash(messageId); }
    else onFocus(messageId);
  };

  const refresh = () => { void q.refetch(); void utils.workspace.chat.conversations.invalidate(); };
  const send = trpc.workspace.chat.send.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const remove = trpc.workspace.chat.remove.useMutation({ onSuccess: () => void q.refetch(), onError: (e) => toast.error(e.message) });
  const react = trpc.workspace.chat.react.useMutation({ onSuccess: () => void q.refetch(), onError: (e) => toast.error(e.message) });
  const edit = trpc.workspace.chat.edit.useMutation({ onSuccess: () => void q.refetch(), onError: (e) => toast.error(e.message) });
  const pin = trpc.workspace.chat.pin.useMutation({ onSuccess: (r) => { toast.success(r.pinned ? "Pinned." : "Unpinned."); void q.refetch(); }, onError: (e) => toast.error(e.message) });
  const ack = trpc.workspace.chat.ack.useMutation({ onSuccess: () => void q.refetch(), onError: (e) => toast.error(e.message) });
  const restrict = trpc.workspace.chat.restrict.useMutation({
    onSuccess: (r) => { toast.success(r.restricted ? "Announcements only: just admins and office managers post here now." : "Everyone here can post again."); void q.refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const mute = trpc.workspace.chat.mute.useMutation({
    onSuccess: (r) => { toast.success(r.muted ? "Muted. You'll only hear about @mentions of you." : "Unmuted."); refresh(); void utils.workspace.chat.unread.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const leave = trpc.workspace.chat.leave.useMutation({
    onSuccess: () => { toast.success("You left the conversation."); void utils.workspace.chat.conversations.invalidate(); onLeft(); },
    onError: (e) => toast.error(e.message),
  });
  const linkTask = trpc.workspace.chat.linkTask.useMutation({ onSuccess: () => void q.refetch() });

  const makeTask = (m: Message) => {
    const key = m.patient?.key;
    setTaskFrom({
      messageId: m.id,
      defaults: {
        title: (m.body ?? "").split("\n")[0]!.slice(0, 120) || "Follow up on a message",
        description: `Message from ${m.mine ? "me" : m.from} (${fmtDayLabel(m.at)} ${fmtClock(m.at)}):\n${m.body ?? ""}`,
        ...(key ? (/^p:\d+$/.test(key) ? { patientId: Number(key.slice(2)) } : { subjectKey: key }) : {}),
        patientName: m.patient?.name ?? undefined,
      },
    });
  };

  const conv = q.data?.conversation;
  const members = q.data?.members ?? [];
  const messages = q.data?.messages ?? [];
  const pinned = q.data?.pinned ?? [];
  const kind = conv?.kind ?? summary?.kind ?? "group";
  const Icon = KIND_ICON[kind] ?? Users;
  const other = summary?.otherUserId ? presence[summary.otherUserId] : undefined;
  // Files on a message go to its patient's folder by default, or the patient this conversation is about.
  const convPatient: PickedPatient | null = conv?.subjectKey ? { key: conv.subjectKey, name: (summary?.title ?? "").replace(/^About /, "") || "Patient" } : null;
  const groups = useMemo(() => {
    const out: { day: string; label: string; items: Message[] }[] = [];
    for (const m of messages) {
      const k = dayKey(m.at);
      if (out.at(-1)?.day !== k) out.push({ day: k, label: fmtDayLabel(m.at), items: [] });
      out.at(-1)!.items.push(m);
    }
    return out;
  }, [messages]);

  // Read receipt under my message when it's the newest one: who has read up to it.
  const newest = messages.at(-1);
  const seenBy = newest?.mine && !newest.deleted ? (q.data?.readers ?? []).filter((r) => r.upTo >= newest.id) : [];
  const receipt = !seenBy.length ? null
    : kind === "dm" ? "Seen"
    : `Seen by ${firstNames(seenBy.slice(0, 3).map((r) => r.name)).join(", ")}${seenBy.length > 3 ? ` +${seenBy.length - 3}` : ""}`;

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <button className="-ml-1 rounded-lg p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 md:hidden" onClick={onBack} aria-label="Back to conversations"><ArrowLeft size={18} /></button>
        <span className="relative shrink-0">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300"><Icon size={16} /></span>
          {other && <PresenceDot p={other} className="absolute -bottom-0.5 -right-0.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate font-semibold text-slate-900 dark:text-slate-50">
            <span className="truncate">{summary?.title ?? "Conversation"}</span>
            {conv?.muted && <BellOff size={13} className="shrink-0 text-slate-400" aria-label="Muted" />}
          </p>
          {kind === "dm" && other ? <PresenceLabel p={other} /> : (
            <button className="text-xs text-slate-500 hover:underline dark:text-slate-400" onClick={() => setShowPeople((s) => !s)}>
              {conv?.postingRestricted ? "Announcements" : KIND_HINT[kind]}{members.length ? ` · ${members.length} ${members.length === 1 ? "person" : "people"}` : ""}
            </button>
          )}
        </div>
        {conv?.subjectKey && caps?.flowView && (
          <Link href={patientHref(conv.subjectKey)} className="hidden items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700 sm:inline-flex">
            <HeartPulse size={13} /> Open patient
          </Link>
        )}
        {conv && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700" aria-label="Conversation options"><MoreHorizontal size={18} /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onClick={() => mute.mutate({ conversationId: id, muted: !conv.muted })}>
                {conv.muted ? <><Bell size={14} className="mr-2" /> Unmute</> : <><BellOff size={14} className="mr-2" /> Mute (only @mentions)</>}
              </DropdownMenuItem>
              {kind !== "dm" && <DropdownMenuItem onClick={() => setShowPeople((s) => !s)}><Users size={14} className="mr-2" /> {showPeople ? "Hide" : "Show"} people</DropdownMenuItem>}
              {conv.canRestrict && (
                <DropdownMenuItem onClick={() => restrict.mutate({ conversationId: id, restricted: !conv.postingRestricted })}>
                  <Megaphone size={14} className="mr-2" /> {conv.postingRestricted ? "Let everyone post" : "Announcements only"}
                </DropdownMenuItem>
              )}
              {conv.canAddPeople && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setAdding(true)}><UserPlus size={14} className="mr-2" /> Add people</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { if (window.confirm("Leave this conversation? You won't see new messages in it.")) leave.mutate({ conversationId: id }); }}>
                    <LogOut size={14} className="mr-2" /> Leave
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {pinned.length > 0 && (
        <div className="flex items-center gap-2 border-b border-slate-200 bg-amber-50/70 px-4 py-1.5 text-xs dark:border-slate-700 dark:bg-amber-500/10">
          <Pin size={13} className="shrink-0 text-amber-600 dark:text-amber-400" />
          <button className="min-w-0 flex-1 truncate text-left text-slate-700 hover:underline dark:text-slate-200" onClick={() => jump(pinned[0]!.id)}>
            <span className="font-semibold">{pinned[0]!.from}:</span> {pinned[0]!.text || "A file"}
          </button>
          {pinned.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="shrink-0 rounded-md px-1.5 py-0.5 font-semibold text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20">{pinned.length} pinned</button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                {pinned.map((p) => (
                  <DropdownMenuItem key={p.id} onClick={() => jump(p.id)} className="block truncate">
                    <span className="font-semibold">{p.from}:</span> {p.text || "A file"}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      {showPeople && members.length > 0 && (
        <div className="max-h-44 overflow-y-auto border-b border-slate-200 bg-slate-50 px-4 py-2 dark:border-slate-700 dark:bg-slate-900/40">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {[...members].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")).map((m) => (
              <span key={m.id} className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300" title={presence[m.id]?.label}>
                <PresenceDot p={presence[m.id]} className="ring-0" /> {m.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-4">
        {q.isLoading && <Loading />}
        {q.error && <ErrorNote message={q.error.message} />}
        {q.data && messages.length === 0 && <p className="py-10 text-center text-sm text-slate-400">No messages yet. Say hello.</p>}
        {groups.map((g) => (
          <div key={g.day}>
            <div className="my-3 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" /> {g.label} <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            </div>
            {g.items.map((m, i) => (
              <div key={m.id}>
                <Bubble m={m} showName={!m.mine && (g.items[i - 1]?.fromId !== m.fromId || g.items[i - 1]?.kind === "flow")} canOpenPatient={!!caps?.flowView}
                  receipt={m.id === newest?.id ? receipt : null} highlighted={highlight === m.id} canPin={!!conv?.canPin} canSeeAcks={!!conv?.canAnnounce}
                  defaultPatient={m.patient ? { key: m.patient.key, name: m.patient.name ?? "Patient" } : convPatient}
                  onReact={(emoji) => react.mutate({ messageId: m.id, emoji })}
                  onQuickReply={(text) => send.mutate({ conversationId: id, body: text, subjectKey: m.patient?.key ?? null, replyToId: m.id })}
                  onReply={conv?.canPost !== false ? () => setReplyTo(m) : undefined}
                  onEdit={m.mine && m.kind === "text" ? (body) => edit.mutateAsync({ messageId: m.id, body }) : undefined}
                  onPin={conv?.canPin ? () => pin.mutate({ messageId: m.id, pinned: !m.pinned }) : undefined}
                  onAck={() => ack.mutate({ messageId: m.id })}
                  onShowAcks={() => setAckFor(m.id)}
                  onJump={jump}
                  onTask={caps?.tasks ? () => makeTask(m) : undefined}
                  onRemove={m.mine ? () => { if (window.confirm("Remove this message?")) remove.mutate({ messageId: m.id }); } : undefined} />
                {q.data?.gapAfterId === m.id && (
                  <div className="my-3 flex items-center gap-3 text-[11px] font-semibold text-slate-400">
                    <span className="h-px flex-1 border-t border-dashed border-slate-300 dark:border-slate-600" />
                    <button className="hover:text-brand hover:underline" onClick={() => { onFocus(null); requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: "end" })); }}>Later messages · jump to the newest</button>
                    <span className="h-px flex-1 border-t border-dashed border-slate-300 dark:border-slate-600" />
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {conv && !conv.canPost ? (
        <div className="flex items-center justify-center gap-2 border-t border-slate-200 px-4 py-3 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
          <Megaphone size={14} className="shrink-0" /> Announcements: only admins and office managers post here. You can react, or tap “I read this”.
        </div>
      ) : (
        <Composer conversationId={id} members={members} myId={user?.id ?? 0} canLinkPatient={!!caps?.flowView} canAnnounce={!!conv?.canAnnounce} sending={send.isPending}
          replyTo={replyTo} onCancelReply={() => setReplyTo(null)}
          onSend={(body, subjectKey, extra, done) => send.mutate({ conversationId: id, body, subjectKey, replyToId: replyTo?.id ?? null, ...extra }, { onSuccess: () => { done(); setReplyTo(null); } })} />
      )}

      <AddPeopleDialog open={adding} onOpenChange={setAdding} conversationId={id} existing={members.map((m) => m.id)} onDone={() => void q.refetch()} />
      <NewTaskDialog open={!!taskFrom} onOpenChange={(o) => !o && setTaskFrom(null)} defaults={taskFrom?.defaults}
        onCreated={(taskId) => { if (taskFrom) linkTask.mutate({ messageId: taskFrom.messageId, taskId }); }} />
      {ackFor && <AckList messageId={ackFor} onClose={() => setAckFor(null)} />}
    </>
  );
}

/**
 * The message box: Enter sends; "@" suggests people in this conversation; ⚡ quick replies; link a patient;
 * 📎 attach PDFs / photos (or paste a screenshot, or drop files on it); 📣 must read (admins / office managers).
 */
function Composer({ conversationId, members, myId, canLinkPatient, canAnnounce, sending, replyTo, onCancelReply, onSend }: {
  conversationId: number; members: Member[]; myId: number; canLinkPatient: boolean; canAnnounce: boolean; sending: boolean;
  replyTo: Message | null; onCancelReply: () => void;
  onSend: (body: string, subjectKey: string | null, extra: { requiresAck: boolean; attachmentIds: number[] }, done: () => void) => void;
}) {
  const [text, setText] = useState("");
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [pickPatient, setPickPatient] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [pick, setPick] = useState(0);
  const [mustRead, setMustRead] = useState(false);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploads = useChatUploads(conversationId);

  // After "Reply" in a message menu: put the cursor in the box (once the menu has closed).
  useEffect(() => { if (replyTo) { const t = setTimeout(() => box.current?.focus(), 30); return () => clearTimeout(t); } }, [replyTo]);

  const suggestions = useMemo(() => {
    if (!mention) return [];
    const qy = mention.query.toLowerCase();
    return members.filter((m) => m.id !== myId && m.name)
      .map((m) => ({ id: m.id, label: mentionName(m.name) }))
      .filter((m) => !qy || m.label.toLowerCase().split(" ").some((w) => w.startsWith(qy)) || m.label.toLowerCase().startsWith(qy))
      .sort((a, b) => a.label.localeCompare(b.label)).slice(0, 6);
  }, [mention, members, myId]);

  // Is the caret right after "@something" (at the start or after a space)?
  const track = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const at = before.lastIndexOf("@");
    const query = at >= 0 ? before.slice(at + 1) : "";
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]!)) && !/\n/.test(query) && query.length <= 30 && query.split(" ").length <= 2) {
      setMention({ start: at, query });
      setPick(0);
    } else setMention(null);
  };

  const insertMention = (label: string) => {
    if (!mention) return;
    const caret = mention.start + 1 + mention.query.length;
    const next = `${text.slice(0, mention.start)}@${label} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    const pos = mention.start + label.length + 2;
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(pos, pos); });
  };

  const canSend = (body: string) => (!!body.trim() || uploads.readyIds.length > 0) && !sending && !uploads.busy;
  const submit = (body = text) => {
    if (!canSend(body)) return;
    onSend(body.trim(), patient?.key ?? null, { requiresAck: mustRead, attachmentIds: uploads.readyIds }, () => {
      if (body === text) setText("");
      setPatient(null); setMention(null); setMustRead(false); uploads.clear();
    });
  };

  return (
    <div className={cn("relative border-t border-slate-200 p-3 dark:border-slate-700", dragging && "bg-brand-soft/40")}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); uploads.add(e.dataTransfer.files); } setDragging(false); }}>
      {mention && suggestions.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 z-20 mb-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-600 dark:bg-slate-800" role="listbox" aria-label="People to mention">
          {suggestions.map((s, i) => (
            <button key={s.id} type="button" role="option" aria-selected={i === pick} onMouseDown={(e) => { e.preventDefault(); insertMention(s.label); }}
              className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm", i === pick ? "bg-slate-100 dark:bg-slate-700" : "hover:bg-slate-50 dark:hover:bg-slate-700/60")}>
              <AtSign size={13} className="text-slate-400" /> {s.label}
            </button>
          ))}
        </div>
      )}
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-l-2 border-brand bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 dark:bg-slate-700/40 dark:text-slate-300">
          <Reply size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">Replying to <span className="font-semibold">{replyTo.mine ? "yourself" : replyTo.from}</span>: {replyTo.body || "a file"}</span>
          <button onClick={onCancelReply} aria-label="Cancel reply" className="shrink-0 text-slate-400 hover:text-slate-700"><X size={13} /></button>
        </div>
      )}
      {patient && (
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-200">
          <HeartPulse size={12} /> About {patient.name}
          <button onClick={() => setPatient(null)} aria-label="Remove patient"><X size={12} /></button>
        </div>
      )}
      {mustRead && (
        <div className="mb-2 ml-1.5 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
          <Megaphone size={12} /> Must read: everyone is asked to tap “I read this”
          <button onClick={() => setMustRead(false)} aria-label="Not must read"><X size={12} /></button>
        </div>
      )}
      <PendingFiles items={uploads.items} onRemove={uploads.remove} />
      {pickPatient && !patient && (
        <div className="mb-2"><PatientSearchBox autoFocus dropUp onPick={(p) => { setPatient(p); setPickPatient(false); }} /></div>
      )}
      <input ref={fileInput} type="file" multiple accept={CHAT_FILE_MIME.join(",")} className="hidden" onChange={(e) => { if (e.target.files?.length) uploads.add(e.target.files); e.target.value = ""; }} />
      <div className="flex items-end gap-1.5">
        <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700" onClick={() => fileInput.current?.click()} title="Attach a PDF or photo (or paste a screenshot)" aria-label="Attach a file">
          <Paperclip size={18} />
        </button>
        {canLinkPatient && (
          <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700" onClick={() => setPickPatient((s) => !s)} title="About a patient" aria-label="Link a patient">
            <HeartPulse size={18} />
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700" title="Quick replies" aria-label="Quick replies"><Zap size={18} /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-52">
            {QUICK_REPLIES.map((r) => <DropdownMenuItem key={r} onClick={() => submit(r)}>{r}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        {canAnnounce && (
          <button className={cn("rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-700", mustRead ? "text-amber-600" : "text-slate-500")} onClick={() => setMustRead((v) => !v)}
            title="Must read: ask everyone to tap “I read this”" aria-label="Must read" aria-pressed={mustRead}>
            <Megaphone size={18} />
          </button>
        )}
        <textarea
          ref={box}
          className={cn(inputCls, "max-h-40 min-h-[42px] flex-1 resize-none py-2.5")}
          rows={1}
          value={text}
          maxLength={4000}
          onChange={(e) => { setText(e.target.value); track(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); uploads.add(e.clipboardData.files); } }}
          onKeyDown={(e) => {
            if (mention && suggestions.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setPick((p) => (p + 1) % suggestions.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setPick((p) => (p - 1 + suggestions.length) % suggestions.length); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertMention(suggestions[pick]!.label); return; }
              if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
            }
            if (e.key === "Escape" && replyTo) { e.preventDefault(); onCancelReply(); return; }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          placeholder={replyTo ? "Write a reply" : "Write a message"}
          title="@ to mention someone · Enter sends · Shift+Enter for a new line · paste or drop a photo / PDF to attach it"
          aria-label="Message"
        />
        <Btn onClick={() => submit()} disabled={!canSend(text)} aria-label="Send">
          {sending || uploads.busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </Btn>
      </div>
    </div>
  );
}

function Bubble({ m, showName, canOpenPatient, receipt, highlighted, canPin, canSeeAcks, defaultPatient, onReact, onQuickReply, onReply, onEdit, onPin, onAck, onShowAcks, onJump, onTask, onRemove }: {
  m: Message; showName: boolean; canOpenPatient: boolean; receipt: string | null; highlighted: boolean; canPin: boolean; canSeeAcks: boolean; defaultPatient: PickedPatient | null;
  onReact: (emoji: string) => void; onQuickReply: (text: string) => void; onReply?: () => void; onEdit?: (body: string) => Promise<unknown>;
  onPin?: () => void; onAck: () => void; onShowAcks: () => void; onJump: (messageId: number) => void; onTask?: () => void; onRemove?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const flow = m.kind === "flow" && !m.deleted;
  const mineSide = m.mine && !flow;
  const pieces = m.body ? splitMentions(m.body, m.mentions.map((x) => x.name ?? "")) : [];
  const chip = m.patient && (
    canOpenPatient ? (
      <Link href={patientHref(m.patient.key)} className={cn("mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        mineSide ? "bg-white/20 text-white hover:bg-white/30" : "bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-200")}>
        <HeartPulse size={11} /> {m.patient.name ?? "Patient"}
      </Link>
    ) : <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold"><HeartPulse size={11} /> {m.patient.name ?? "Patient"}</span>
  );
  const save = async () => {
    if (!onEdit || !draft.trim()) return;
    setSaving(true);
    try { await onEdit(draft); setEditing(false); } catch { /* the toast says why */ } finally { setSaving(false); }
  };
  // A message that's only files: no empty bubble.
  const hasBubble = m.deleted || editing || !!m.body || m.requiresAck || !!chip;
  return (
    <div id={`msg-${m.id}`} className={cn("group -mx-2 mb-1.5 flex rounded-xl px-2 transition-colors duration-700", mineSide ? "justify-end" : "justify-start", highlighted && "bg-amber-100/80 dark:bg-amber-500/15")}>
      <div className={cn("flex max-w-[85%] items-end gap-1 md:max-w-[70%]", mineSide && "flex-row-reverse")}>
        <div className="min-w-0">
          {(showName || flow) && <p className="mb-0.5 ml-1 mt-2 text-xs font-semibold text-slate-600 dark:text-slate-300">{m.mine ? "You" : m.from}{flow ? " · Patient Flow" : ""}</p>}
          {m.replyTo && !m.deleted && (
            <button onClick={() => onJump(m.replyTo!.id)} className={cn("mb-0.5 flex max-w-full items-center gap-1 truncate rounded-lg border-l-2 border-slate-300 bg-slate-50 px-2 py-1 text-left text-[11px] text-slate-500 hover:bg-slate-100 dark:border-slate-500 dark:bg-slate-800/60 dark:text-slate-400 dark:hover:bg-slate-700", mineSide && "ml-auto")}>
              <Reply size={11} className="shrink-0" />
              <span className="truncate"><span className="font-semibold">{m.replyTo.from ?? "A message"}</span>{m.replyTo.text != null ? `: ${m.replyTo.text || "a file"}` : ": message removed"}</span>
            </button>
          )}
          {hasBubble && (
            <div className={cn("rounded-2xl px-3.5 py-2 text-sm",
              m.deleted ? "border border-dashed border-slate-300 italic text-slate-400 dark:border-slate-600"
                : flow ? "border border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100"
                : m.requiresAck && !m.mine ? "border border-amber-300 bg-amber-50 text-slate-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-slate-50"
                : m.mine ? "bg-brand text-white" : "bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-100",
              m.mentionsMe && !m.mine && "ring-2 ring-amber-400")}>
              {m.requiresAck && <p className={cn("mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider", m.mine ? "text-white/80" : "text-amber-700 dark:text-amber-300")}><Megaphone size={11} /> Must read</p>}
              {m.deleted ? "Message removed" : editing ? (
                <div>
                  <textarea autoFocus value={draft} maxLength={4000} rows={Math.min(8, draft.split("\n").length + 1)}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void save(); }
                    }}
                    className="w-full min-w-[14rem] resize-none rounded-lg border border-slate-300 bg-white p-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand/40" aria-label="Edit message" />
                  <div className="mt-1 flex justify-end gap-1.5 text-xs">
                    <button onClick={() => setEditing(false)} className={cn("rounded-md px-2 py-1 font-semibold", m.mine ? "text-white/90 hover:bg-white/15" : "text-slate-600 hover:bg-slate-200")}>Cancel</button>
                    <button onClick={() => void save()} disabled={saving || !draft.trim()} className={cn("rounded-md px-2 py-1 font-semibold disabled:opacity-50", m.mine ? "bg-white text-brand" : "bg-brand text-white")}>{saving ? "Saving…" : "Save"}</button>
                  </div>
                </div>
              ) : m.body ? (
                <p className="whitespace-pre-wrap break-words">
                  {flow && <DoorOpen size={14} className="mr-1.5 inline -mt-0.5" />}
                  {pieces.map((p, i) => p.mention ? <span key={i} className={cn("font-semibold", m.mine && !flow && !m.requiresAck ? "underline decoration-white/50" : m.mine ? "underline decoration-white/50" : "text-brand")}>{p.text}</span> : <span key={i}>{p.text}</span>)}
                </p>
              ) : null}
              {chip}
            </div>
          )}
          <MessageFiles files={m.attachments} mine={mineSide} defaultPatient={defaultPatient} />
          {m.reactions.length > 0 && (
            <div className={cn("mt-1 flex flex-wrap gap-1", mineSide && "justify-end")}>
              {m.reactions.map((r) => (
                <button key={r.emoji} onClick={() => onReact(r.emoji)} title={r.names.join(", ")}
                  className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs", r.mine ? "border-brand bg-brand-soft/60 dark:bg-brand/15" : "border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800")}>
                  <span>{r.emoji}</span><span className="tabular-nums text-slate-600 dark:text-slate-300">{r.count}</span>
                </button>
              ))}
            </div>
          )}
          {m.ack && (
            <div className={cn("mt-1 flex flex-wrap items-center gap-2 text-xs", mineSide && "justify-end")}>
              {!m.mine && !m.ack.mine && <Btn size="sm" onClick={onAck}><CheckCheck size={13} /> I read this</Btn>}
              {!m.mine && m.ack.mine && <span className="inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400"><CheckCheck size={13} /> You read this</span>}
              {(m.mine || canSeeAcks) && <button onClick={onShowAcks} className="font-semibold text-slate-500 hover:text-slate-800 hover:underline dark:text-slate-400">Read by {m.ack.count} of {m.ack.of}</button>}
            </div>
          )}
          {flow && !m.mine && (
            <div className="mt-1 flex flex-wrap gap-1">
              {FLOW_QUICK_REPLIES.map((r) => (
                <button key={r} onClick={() => onQuickReply(r)} className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">{r}</button>
              ))}
            </div>
          )}
          <p className={cn("mt-0.5 flex items-center gap-2 px-1 text-[10px] text-slate-400", mineSide && "justify-end")}>
            {fmtClock(m.at)}
            {m.editedAt && <span title={`Edited ${fmtDayLabel(m.editedAt)} ${fmtClock(m.editedAt)}`}>edited</span>}
            {m.pinned && <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400"><Pin size={10} /> pinned</span>}
            {m.taskId && <Link href={`/my-work?task=${m.taskId}`} className="font-semibold text-brand hover:underline">Task made</Link>}
            {receipt && <span className="font-medium text-slate-500 dark:text-slate-400">{receipt}</span>}
          </p>
        </div>
        {!m.deleted && !editing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="mb-5 rounded-md p-1 text-slate-400 opacity-0 hover:bg-slate-100 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-slate-700" aria-label="Message options"><MoreHorizontal size={15} /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={m.mine ? "end" : "start"} className="w-48" onCloseAutoFocus={(e) => e.preventDefault()}>
              <div className="flex items-center justify-between px-1 py-1" aria-label="React">
                {REACTIONS.map((e) => (
                  <DropdownMenuItem key={e} onClick={() => onReact(e)} className="justify-center px-1.5 text-base" aria-label={`React ${e}`}>{e}</DropdownMenuItem>
                ))}
              </div>
              <DropdownMenuSeparator />
              {onReply && <DropdownMenuItem onClick={onReply}><Reply size={14} className="mr-2" /> Reply</DropdownMenuItem>}
              {onEdit && m.body && <DropdownMenuItem onClick={() => { setDraft(m.body ?? ""); setEditing(true); }}><Pencil size={14} className="mr-2" /> Edit</DropdownMenuItem>}
              {onPin && canPin && <DropdownMenuItem onClick={onPin}>{m.pinned ? <><PinOff size={14} className="mr-2" /> Unpin</> : <><Pin size={14} className="mr-2" /> Pin</>}</DropdownMenuItem>}
              {onTask && <DropdownMenuItem onClick={onTask}><ListPlus size={14} className="mr-2" /> Make a task</DropdownMenuItem>}
              {onRemove && <DropdownMenuItem onClick={onRemove} className="text-red-600"><Trash2 size={14} className="mr-2" /> Remove</DropdownMenuItem>}
              {!onTask && !onRemove && !onReply && <p className="px-2 py-1.5 text-xs text-slate-400"><SmilePlus size={12} className="mr-1 inline" /> React to acknowledge</p>}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

function AddPeopleDialog({ open, onOpenChange, conversationId, existing, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; conversationId: number; existing: number[]; onDone: () => void }) {
  const [picked, setPicked] = useState<number[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => { if (open) { setPicked([]); setQ(""); } }, [open]);
  const people = trpc.workspace.chat.people.useQuery(undefined, { enabled: open, staleTime: 60_000 });
  const add = trpc.workspace.chat.addPeople.useMutation({
    onSuccess: (r) => { toast.success(`Added ${r.added}.`); onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e.message),
  });
  if (!open) return null;
  const list = (people.data ?? []).filter((p) => !existing.includes(p.id) && (!q.trim() || (p.name ?? "").toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => onOpenChange(false)}>
      <div className={cn(cardCls, "w-full max-w-md p-5 dark:bg-slate-800")} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add people">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-slate-900 dark:text-slate-50">Add people</h2>
          <button onClick={() => onOpenChange(false)} aria-label="Close"><X size={16} className="text-slate-400" /></button>
        </div>
        <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names" aria-label="Search names" autoFocus />
        <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700">
          {list.map((p) => {
            const on = picked.includes(p.id);
            return (
              <label key={p.id} className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-0 hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-700/50">
                <input type="checkbox" checked={on} onChange={() => setPicked((x) => (on ? x.filter((i) => i !== p.id) : [...x, p.id]))} />
                <span className="truncate">{p.name}</span>
              </label>
            );
          })}
          {people.data && list.length === 0 && <p className="px-3 py-3 text-xs text-slate-400">Nobody else to add.</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Btn>
          <Btn disabled={!picked.length || add.isPending} onClick={() => add.mutate({ conversationId, userIds: picked })}>Add {picked.length || ""}</Btn>
        </div>
      </div>
    </div>
  );
}

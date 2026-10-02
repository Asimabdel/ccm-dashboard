import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  ArrowLeft, AtSign, Bell, BellOff, Building2, DoorOpen, HeartPulse, ListPlus, Loader2, LogOut, Megaphone, MessagesSquare, MoreHorizontal, Paperclip, Plus, Search, Send,
  SmilePlus, Stethoscope, Trash2, User, UserPlus, Users, X, Zap,
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { CLINIC_TZ } from "@shared/workforce";
import { FLOW_QUICK_REPLIES, QUICK_REPLIES, REACTIONS, mentionName, splitMentions, type Presence } from "@shared/chat";
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
 */
export default function MessagesPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const { caps, loading } = useWorkspace();
  if (!user || loading) return null;
  if (!caps?.messages) return <CCMDashboardLayout title="Messages"><EmptyState title="No access" body="Your role doesn't include messages." /></CCMDashboardLayout>;
  return <Messages />;
}

function Messages() {
  const [params, setParams] = useUrlParams();
  const selected = Number(params.get("c")) || null;
  const [filter, setFilter] = useState("");
  const [newMode, setNewMode] = useState<NewConversationMode | null>(null);
  const list = trpc.workspace.chat.conversations.useQuery(undefined, { refetchInterval: 10_000 });
  const presence = usePresence();

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (list.data ?? []).filter((c) => !f || c.title.toLowerCase().includes(f));
  }, [list.data, filter]);
  const current = (list.data ?? []).find((c) => c.id === selected) ?? null;

  return (
    <CCMDashboardLayout title="Messages" pageTitle={false}>
      <div className={cn(cardCls, "flex overflow-hidden dark:bg-slate-800 h-[calc(100dvh-5.5rem)] md:h-[calc(100dvh-6.5rem)]")}>
        {/* Conversation list (on phones: hidden while a conversation is open) */}
        <aside className={cn("flex w-full flex-col border-r border-slate-200 dark:border-slate-700 md:w-80 md:shrink-0", selected && "hidden md:flex")}>
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
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
          <div className="border-b border-slate-200 p-3 dark:border-slate-700">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className={cn(inputCls, "pl-8")} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a conversation" aria-label="Find a conversation" />
            </div>
          </div>
          <PopupPrompt />
          <div className="flex-1 overflow-y-auto">
            {list.isLoading && <Loading />}
            {list.error && <div className="p-3"><ErrorNote message={list.error.message} /></div>}
            {shown.map((c) => <ConversationRow key={c.id} c={c} active={c.id === selected} presence={c.otherUserId ? presence[c.otherUserId] : undefined} onOpen={() => setParams({ c: c.id })} />)}
            {list.data && shown.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-400">No conversations match.</p>}
          </div>
        </aside>

        {/* The open conversation */}
        <section className={cn("min-w-0 flex-1 flex-col", selected ? "flex" : "hidden md:flex")}>
          {selected ? (
            <Thread key={selected} id={selected} summary={current} presence={presence} onBack={() => setParams({ c: null })} onLeft={() => setParams({ c: null })} />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState icon={MessagesSquare} title="Pick a conversation" body="Or start one with New: a direct message, a group, or a conversation about a patient." />
            </div>
          )}
        </section>
      </div>

      <NewConversationDialog open={!!newMode} onOpenChange={(o) => !o && setNewMode(null)} mode={newMode ?? "dm"} onOpened={(id) => { void list.refetch(); setParams({ c: id }); }} />
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
            {c.last ? `${c.last.from}: ${c.last.text}` : KIND_HINT[c.kind]}
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

function Thread({ id, summary, presence, onBack, onLeft }: { id: number; summary: Conversation | null; presence: Record<number, Presence>; onBack: () => void; onLeft: () => void }) {
  const { caps, user } = useWorkspace();
  const utils = trpc.useUtils();
  const q = trpc.workspace.chat.get.useQuery({ id }, { refetchInterval: 5_000 });
  const [showPeople, setShowPeople] = useState(false);
  const [adding, setAdding] = useState(false);
  const [taskFrom, setTaskFrom] = useState<{ messageId: number; defaults: NewTaskDefaults } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const lastId = q.data?.messages.at(-1)?.id;

  // Opening marks it read: refresh the list and the badge.
  useEffect(() => {
    if (!q.data) return;
    void utils.workspace.chat.conversations.invalidate();
    void utils.workspace.chat.unread.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, !!q.data]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [lastId]);

  const refresh = () => { void q.refetch(); void utils.workspace.chat.conversations.invalidate(); };
  const send = trpc.workspace.chat.send.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const remove = trpc.workspace.chat.remove.useMutation({ onSuccess: () => void q.refetch(), onError: (e) => toast.error(e.message) });
  const react = trpc.workspace.chat.react.useMutation({ onSuccess: () => void q.refetch(), onError: (e) => toast.error(e.message) });
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
        title: (m.body ?? "").split("\n")[0]!.slice(0, 120),
        description: `Message from ${m.mine ? "me" : m.from} (${fmtDayLabel(m.at)} ${fmtClock(m.at)}):\n${m.body ?? ""}`,
        ...(key ? (/^p:\d+$/.test(key) ? { patientId: Number(key.slice(2)) } : { subjectKey: key }) : {}),
        patientName: m.patient?.name ?? undefined,
      },
    });
  };

  const conv = q.data?.conversation;
  const members = q.data?.members ?? [];
  const messages = q.data?.messages ?? [];
  const kind = conv?.kind ?? summary?.kind ?? "group";
  const Icon = KIND_ICON[kind] ?? Users;
  const other = summary?.otherUserId ? presence[summary.otherUserId] : undefined;
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
              {KIND_HINT[kind]}{members.length ? ` · ${members.length} ${members.length === 1 ? "person" : "people"}` : ""}
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
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => mute.mutate({ conversationId: id, muted: !conv.muted })}>
                {conv.muted ? <><Bell size={14} className="mr-2" /> Unmute</> : <><BellOff size={14} className="mr-2" /> Mute (only @mentions)</>}
              </DropdownMenuItem>
              {kind !== "dm" && <DropdownMenuItem onClick={() => setShowPeople((s) => !s)}><Users size={14} className="mr-2" /> {showPeople ? "Hide" : "Show"} people</DropdownMenuItem>}
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
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {q.isLoading && <Loading />}
        {q.error && <ErrorNote message={q.error.message} />}
        {q.data && messages.length === 0 && <p className="py-10 text-center text-sm text-slate-400">No messages yet. Say hello.</p>}
        {groups.map((g) => (
          <div key={g.day}>
            <div className="my-3 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" /> {g.label} <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            </div>
            {g.items.map((m, i) => (
              <Bubble key={m.id} m={m} showName={!m.mine && (g.items[i - 1]?.fromId !== m.fromId || g.items[i - 1]?.kind === "flow")} canOpenPatient={!!caps?.flowView}
                receipt={m.id === newest?.id ? receipt : null}
                onReact={(emoji) => react.mutate({ messageId: m.id, emoji })}
                onQuickReply={(text) => send.mutate({ conversationId: id, body: text, subjectKey: m.patient?.key ?? null })}
                onTask={caps?.tasks ? () => makeTask(m) : undefined}
                onRemove={m.mine ? () => { if (window.confirm("Remove this message?")) remove.mutate({ messageId: m.id }); } : undefined} />
            ))}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <Composer conversationId={id} members={members} myId={user?.id ?? 0} canLinkPatient={!!caps?.flowView} sending={send.isPending}
        onSend={(body, subjectKey, done) => send.mutate({ conversationId: id, body, subjectKey }, { onSuccess: done })} />

      <AddPeopleDialog open={adding} onOpenChange={setAdding} conversationId={id} existing={members.map((m) => m.id)} onDone={() => void q.refetch()} />
      <NewTaskDialog open={!!taskFrom} onOpenChange={(o) => !o && setTaskFrom(null)} defaults={taskFrom?.defaults}
        onCreated={(taskId) => { if (taskFrom) linkTask.mutate({ messageId: taskFrom.messageId, taskId }); }} />
    </>
  );
}

/** The message box: Enter sends; "@" suggests people in this conversation; ⚡ quick replies; link a patient. */
function Composer({ members, myId, canLinkPatient, sending, onSend }: {
  conversationId: number; members: Member[]; myId: number; canLinkPatient: boolean; sending: boolean;
  onSend: (body: string, subjectKey: string | null, done: () => void) => void;
}) {
  const [text, setText] = useState("");
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [pickPatient, setPickPatient] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [pick, setPick] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);

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

  const submit = (body = text) => {
    if (!body.trim() || sending) return;
    onSend(body.trim(), patient?.key ?? null, () => { if (body === text) setText(""); setPatient(null); setMention(null); });
  };

  return (
    <div className="relative border-t border-slate-200 p-3 dark:border-slate-700">
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
      {patient && (
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-200">
          <HeartPulse size={12} /> About {patient.name}
          <button onClick={() => setPatient(null)} aria-label="Remove patient"><X size={12} /></button>
        </div>
      )}
      {pickPatient && !patient && (
        <div className="mb-2"><PatientSearchBox autoFocus dropUp onPick={(p) => { setPatient(p); setPickPatient(false); }} /></div>
      )}
      <div className="flex items-end gap-1.5">
        {canLinkPatient && (
          <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700" onClick={() => setPickPatient((s) => !s)} title="Link a patient" aria-label="Link a patient">
            <Paperclip size={18} />
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
        <textarea
          ref={box}
          className={cn(inputCls, "max-h-40 min-h-[42px] flex-1 resize-none py-2.5")}
          rows={1}
          value={text}
          maxLength={4000}
          onChange={(e) => { setText(e.target.value); track(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
          onKeyDown={(e) => {
            if (mention && suggestions.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setPick((p) => (p + 1) % suggestions.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setPick((p) => (p - 1 + suggestions.length) % suggestions.length); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertMention(suggestions[pick]!.label); return; }
              if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
            }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          placeholder="Write a message (@ to mention someone; Enter sends)"
          aria-label="Message"
        />
        <Btn onClick={() => submit()} disabled={!text.trim() || sending} aria-label="Send">
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </Btn>
      </div>
    </div>
  );
}

function Bubble({ m, showName, canOpenPatient, receipt, onReact, onQuickReply, onTask, onRemove }: {
  m: Message; showName: boolean; canOpenPatient: boolean; receipt: string | null;
  onReact: (emoji: string) => void; onQuickReply: (text: string) => void; onTask?: () => void; onRemove?: () => void;
}) {
  const flow = m.kind === "flow" && !m.deleted;
  const pieces = m.body ? splitMentions(m.body, m.mentions.map((x) => x.name ?? "")) : [];
  const chip = m.patient && (
    canOpenPatient ? (
      <Link href={patientHref(m.patient.key)} className={cn("mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        m.mine && !flow ? "bg-white/20 text-white hover:bg-white/30" : "bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-200")}>
        <HeartPulse size={11} /> {m.patient.name ?? "Patient"}
      </Link>
    ) : <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold"><HeartPulse size={11} /> {m.patient.name ?? "Patient"}</span>
  );
  return (
    <div className={cn("group mb-1.5 flex", m.mine && !flow ? "justify-end" : "justify-start")}>
      <div className={cn("flex max-w-[85%] items-end gap-1 md:max-w-[70%]", m.mine && !flow && "flex-row-reverse")}>
        <div className="min-w-0">
          {(showName || flow) && <p className="mb-0.5 ml-1 mt-2 text-xs font-semibold text-slate-600 dark:text-slate-300">{m.mine ? "You" : m.from}{flow ? " · Patient Flow" : ""}</p>}
          <div className={cn("rounded-2xl px-3.5 py-2 text-sm",
            m.deleted ? "border border-dashed border-slate-300 italic text-slate-400 dark:border-slate-600"
              : flow ? "border border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100"
              : m.mine ? "bg-brand text-white" : "bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-100",
            m.mentionsMe && !m.mine && "ring-2 ring-amber-400")}>
            {m.deleted ? "Message removed" : (
              <p className="whitespace-pre-wrap break-words">
                {flow && <DoorOpen size={14} className="mr-1.5 inline -mt-0.5" />}
                {pieces.map((p, i) => p.mention ? <span key={i} className={cn("font-semibold", m.mine && !flow ? "underline decoration-white/50" : "text-brand")}>{p.text}</span> : <span key={i}>{p.text}</span>)}
              </p>
            )}
            {chip}
          </div>
          {m.reactions.length > 0 && (
            <div className={cn("mt-1 flex flex-wrap gap-1", m.mine && !flow && "justify-end")}>
              {m.reactions.map((r) => (
                <button key={r.emoji} onClick={() => onReact(r.emoji)} title={r.names.join(", ")}
                  className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs", r.mine ? "border-brand bg-brand-soft/60 dark:bg-brand/15" : "border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800")}>
                  <span>{r.emoji}</span><span className="tabular-nums text-slate-600 dark:text-slate-300">{r.count}</span>
                </button>
              ))}
            </div>
          )}
          {flow && !m.mine && (
            <div className="mt-1 flex flex-wrap gap-1">
              {FLOW_QUICK_REPLIES.map((r) => (
                <button key={r} onClick={() => onQuickReply(r)} className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">{r}</button>
              ))}
            </div>
          )}
          <p className={cn("mt-0.5 flex items-center gap-2 px-1 text-[10px] text-slate-400", m.mine && !flow && "justify-end")}>
            {fmtClock(m.at)}
            {m.taskId && <Link href={`/my-work?task=${m.taskId}`} className="font-semibold text-brand hover:underline">Task made</Link>}
            {receipt && <span className="font-medium text-slate-500 dark:text-slate-400">{receipt}</span>}
          </p>
        </div>
        {!m.deleted && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="mb-5 rounded-md p-1 text-slate-400 opacity-0 hover:bg-slate-100 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-slate-700" aria-label="Message options"><MoreHorizontal size={15} /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={m.mine ? "end" : "start"} className="w-48">
              <div className="flex items-center justify-between px-1 py-1" aria-label="React">
                {REACTIONS.map((e) => (
                  <DropdownMenuItem key={e} onClick={() => onReact(e)} className="justify-center px-1.5 text-base" aria-label={`React ${e}`}>{e}</DropdownMenuItem>
                ))}
              </div>
              <DropdownMenuSeparator />
              {onTask && <DropdownMenuItem onClick={onTask}><ListPlus size={14} className="mr-2" /> Make a task</DropdownMenuItem>}
              {onRemove && <DropdownMenuItem onClick={onRemove} className="text-red-600"><Trash2 size={14} className="mr-2" /> Remove</DropdownMenuItem>}
              {!onTask && !onRemove && <p className="px-2 py-1.5 text-xs text-slate-400"><SmilePlus size={12} className="mr-1 inline" /> React to acknowledge</p>}
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

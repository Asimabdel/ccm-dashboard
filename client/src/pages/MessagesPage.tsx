import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  ArrowLeft, Bell, Building2, HeartPulse, ListPlus, Loader2, LogOut, Megaphone, MessagesSquare, MoreHorizontal, Paperclip, Plus, Search, Send,
  Stethoscope, Trash2, User, UserPlus, Users, X,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, cardCls, fmtClock, inputCls } from "@/components/workspace/ui";
import { NewTaskDialog, type NewTaskDefaults } from "@/components/workspace/NewTaskDialog";
import { NewConversationDialog, type NewConversationMode } from "@/components/messages/NewConversationDialog";
import { PatientSearchBox, type PickedPatient } from "@/components/messages/PatientSearchBox";
import { popupsSupported } from "@/components/messages/useUnreadMessages";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { CLINIC_TZ } from "@shared/workforce";
import { cn } from "@/lib/utils";

type Conversation = RouterOutputs["workspace"]["chat"]["conversations"][number];
type Message = RouterOutputs["workspace"]["chat"]["get"]["messages"][number];

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

/**
 * Messages: talk to anyone at the practice. Direct messages, groups, each clinic's channel, each
 * provider's team, a channel for everyone, and conversations about a patient. Any message can become
 * a task. The page checks for new messages every few seconds.
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
            {shown.map((c) => <ConversationRow key={c.id} c={c} active={c.id === selected} onOpen={() => setParams({ c: c.id })} />)}
            {list.data && shown.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-400">No conversations match.</p>}
          </div>
        </aside>

        {/* The open conversation */}
        <section className={cn("min-w-0 flex-1 flex-col", selected ? "flex" : "hidden md:flex")}>
          {selected ? (
            <Thread key={selected} id={selected} summary={current} onBack={() => setParams({ c: null })} onLeft={() => setParams({ c: null })} />
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

function ConversationRow({ c, active, onOpen }: { c: Conversation; active: boolean; onOpen: () => void }) {
  const Icon = KIND_ICON[c.kind] ?? Users;
  return (
    <button onClick={onOpen} className={cn("flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-700/40", active && "bg-slate-100 dark:bg-slate-700/60")}>
      <span className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full", c.kind === "patient" ? "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300" : c.kind === "dm" ? "bg-brand-soft text-brand" : "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300")}>
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-sm text-slate-900 dark:text-slate-50", c.unread ? "font-bold" : "font-medium")}>{c.title}</span>
          {c.last && <span className="shrink-0 text-[11px] text-slate-400">{fmtListTime(c.last.at)}</span>}
        </span>
        <span className="mt-0.5 flex items-center justify-between gap-2">
          <span className={cn("truncate text-xs", c.unread ? "text-slate-700 dark:text-slate-200" : "text-slate-500 dark:text-slate-400")}>
            {c.last ? `${c.last.from}: ${c.last.text}` : KIND_HINT[c.kind]}
          </span>
          {c.unread > 0 && <span className="shrink-0 rounded-full bg-brand px-1.5 text-[11px] font-bold tabular-nums text-white">{c.unread > 99 ? "99+" : c.unread}</span>}
        </span>
      </span>
    </button>
  );
}

function Thread({ id, summary, onBack, onLeft }: { id: number; summary: Conversation | null; onBack: () => void; onLeft: () => void }) {
  const { caps } = useWorkspace();
  const utils = trpc.useUtils();
  const q = trpc.workspace.chat.get.useQuery({ id }, { refetchInterval: 5_000 });
  const [text, setText] = useState("");
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [pickPatient, setPickPatient] = useState(false);
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

  const send = trpc.workspace.chat.send.useMutation({
    onSuccess: () => { setText(""); setPatient(null); void q.refetch(); void utils.workspace.chat.conversations.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.workspace.chat.remove.useMutation({ onSuccess: () => void q.refetch(), onError: (e) => toast.error(e.message) });
  const leave = trpc.workspace.chat.leave.useMutation({
    onSuccess: () => { toast.success("You left the conversation."); void utils.workspace.chat.conversations.invalidate(); onLeft(); },
    onError: (e) => toast.error(e.message),
  });
  const linkTask = trpc.workspace.chat.linkTask.useMutation({ onSuccess: () => void q.refetch() });

  const submit = () => {
    if (!text.trim() || send.isPending) return;
    send.mutate({ conversationId: id, body: text.trim(), subjectKey: patient?.key ?? null });
  };

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
  const Icon = KIND_ICON[conv?.kind ?? summary?.kind ?? "group"] ?? Users;
  const groups = useMemo(() => {
    const out: { day: string; label: string; items: Message[] }[] = [];
    for (const m of q.data?.messages ?? []) {
      const k = dayKey(m.at);
      if (out.at(-1)?.day !== k) out.push({ day: k, label: fmtDayLabel(m.at), items: [] });
      out.at(-1)!.items.push(m);
    }
    return out;
  }, [q.data?.messages]);

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <button className="-ml-1 rounded-lg p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 md:hidden" onClick={onBack} aria-label="Back to conversations"><ArrowLeft size={18} /></button>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300"><Icon size={16} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900 dark:text-slate-50">{summary?.title ?? "Conversation"}</p>
          <button className="text-xs text-slate-500 hover:underline dark:text-slate-400" onClick={() => setShowPeople((s) => !s)}>
            {KIND_HINT[conv?.kind ?? "group"]}{members.length ? ` · ${members.length} ${members.length === 1 ? "person" : "people"}` : ""}
          </button>
        </div>
        {conv?.subjectKey && caps?.flowView && (
          <Link href={patientHref(conv.subjectKey)} className="hidden items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700 sm:inline-flex">
            <HeartPulse size={13} /> Open patient
          </Link>
        )}
        {conv?.canAddPeople && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700" aria-label="Conversation options"><MoreHorizontal size={18} /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => setAdding(true)}><UserPlus size={14} className="mr-2" /> Add people</DropdownMenuItem>
              <DropdownMenuItem onClick={() => { if (window.confirm("Leave this conversation? You won't see new messages in it.")) leave.mutate({ conversationId: id }); }}>
                <LogOut size={14} className="mr-2" /> Leave
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {showPeople && members.length > 0 && (
        <div className="max-h-40 overflow-y-auto border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300">
          {members.map((m) => m.name).filter(Boolean).sort().join(", ")}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {q.isLoading && <Loading />}
        {q.error && <ErrorNote message={q.error.message} />}
        {q.data && q.data.messages.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-400">No messages yet. Say hello.</p>
        )}
        {groups.map((g) => (
          <div key={g.day}>
            <div className="my-3 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" /> {g.label} <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            </div>
            {g.items.map((m, i) => (
              <Bubble key={m.id} m={m} showName={!m.mine && g.items[i - 1]?.fromId !== m.fromId} canOpenPatient={!!caps?.flowView}
                onTask={caps?.tasks ? () => makeTask(m) : undefined} onRemove={m.mine ? () => { if (window.confirm("Remove this message?")) remove.mutate({ messageId: m.id }); } : undefined} />
            ))}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {/* Composer */}
      <div className="border-t border-slate-200 p-3 dark:border-slate-700">
        {patient && (
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-200">
            <HeartPulse size={12} /> About {patient.name}
            <button onClick={() => setPatient(null)} aria-label="Remove patient"><X size={12} /></button>
          </div>
        )}
        {pickPatient && !patient && (
          <div className="mb-2"><PatientSearchBox autoFocus dropUp onPick={(p) => { setPatient(p); setPickPatient(false); }} /></div>
        )}
        <div className="flex items-end gap-2">
          {caps?.flowView && (
            <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700" onClick={() => setPickPatient((s) => !s)} title="Link a patient" aria-label="Link a patient">
              <Paperclip size={18} />
            </button>
          )}
          <textarea
            className={cn(inputCls, "max-h-40 min-h-[42px] flex-1 resize-none py-2.5")}
            rows={1}
            value={text}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder="Write a message (Enter sends, Shift+Enter for a new line)"
            aria-label="Message"
          />
          <Btn onClick={submit} disabled={!text.trim() || send.isPending} aria-label="Send">
            {send.isPending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </Btn>
        </div>
      </div>

      <AddPeopleDialog open={adding} onOpenChange={setAdding} conversationId={id} existing={members.map((m) => m.id)} onDone={() => void q.refetch()} />
      <NewTaskDialog open={!!taskFrom} onOpenChange={(o) => !o && setTaskFrom(null)} defaults={taskFrom?.defaults}
        onCreated={(taskId) => { if (taskFrom) linkTask.mutate({ messageId: taskFrom.messageId, taskId }); }} />
    </>
  );
}

function Bubble({ m, showName, canOpenPatient, onTask, onRemove }: { m: Message; showName: boolean; canOpenPatient: boolean; onTask?: () => void; onRemove?: () => void }) {
  return (
    <div className={cn("group mb-1.5 flex", m.mine ? "justify-end" : "justify-start")}>
      <div className={cn("flex max-w-[85%] items-end gap-1 md:max-w-[70%]", m.mine && "flex-row-reverse")}>
        <div className="min-w-0">
          {showName && <p className="mb-0.5 ml-1 mt-2 text-xs font-semibold text-slate-600 dark:text-slate-300">{m.from}</p>}
          <div className={cn("rounded-2xl px-3.5 py-2 text-sm", m.deleted ? "border border-dashed border-slate-300 italic text-slate-400 dark:border-slate-600" : m.mine ? "bg-brand text-white" : "bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-100")}>
            {m.deleted ? "Message removed" : <p className="whitespace-pre-wrap break-words">{m.body}</p>}
            {m.patient && (
              canOpenPatient ? (
                <Link href={patientHref(m.patient.key)} className={cn("mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", m.mine ? "bg-white/20 text-white hover:bg-white/30" : "bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-200")}>
                  <HeartPulse size={11} /> {m.patient.name ?? "Patient"}
                </Link>
              ) : <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold"><HeartPulse size={11} /> {m.patient.name ?? "Patient"}</span>
            )}
          </div>
          <p className={cn("mt-0.5 flex items-center gap-2 px-1 text-[10px] text-slate-400", m.mine && "justify-end")}>
            {fmtClock(m.at)}
            {m.taskId && <Link href={`/my-work?task=${m.taskId}`} className="font-semibold text-brand hover:underline">Task made</Link>}
          </p>
        </div>
        {!m.deleted && (onTask || onRemove) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="mb-5 rounded-md p-1 text-slate-400 opacity-0 hover:bg-slate-100 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-slate-700" aria-label="Message options"><MoreHorizontal size={15} /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={m.mine ? "end" : "start"} className="w-44">
              {onTask && <DropdownMenuItem onClick={onTask}><ListPlus size={14} className="mr-2" /> Make a task</DropdownMenuItem>}
              {onRemove && <DropdownMenuItem onClick={onRemove} className="text-red-600"><Trash2 size={14} className="mr-2" /> Remove</DropdownMenuItem>}
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

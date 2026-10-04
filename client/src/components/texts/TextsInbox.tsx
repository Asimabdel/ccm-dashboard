import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowLeft, Ban, CheckCircle2, CircleDot, HeartPulse, ImageIcon, Loader2, MessageSquareText, NotebookPen, Plus, Search, Send, ShieldAlert, UserRoundSearch,
} from "lucide-react";
import { Btn, EmptyState, ErrorNote, Loading, fmtClock, inputCls } from "@/components/workspace/ui";
import { PatientSearchBox } from "@/components/messages/PatientSearchBox";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { CLINIC_TZ } from "@shared/workforce";
import { MAX_TEXT_LENGTH, TEXT_FILTERS, TEXT_STATUS_LABELS, textSegments, type TextFilter, type TextStatus } from "@shared/texts";

type Row = RouterOutputs["workspace"]["texts"]["list"][number];
type Detail = RouterOutputs["workspace"]["texts"]["get"];

const dayKey = (d: Date | string) => new Date(d).toLocaleDateString("en-CA", { timeZone: CLINIC_TZ });
const fmtWhen = (d: Date | string) => dayKey(d) === dayKey(new Date()) ? fmtClock(d)
  : new Date(d).toLocaleDateString("en-US", { timeZone: CLINIC_TZ, month: "short", day: "numeric" });
const fmtDay = (d: Date | string) => {
  const k = dayKey(d);
  if (k === dayKey(new Date())) return "Today";
  if (k === dayKey(new Date(Date.now() - 86_400_000))) return "Yesterday";
  return new Date(d).toLocaleDateString("en-US", { timeZone: CLINIC_TZ, weekday: "short", month: "short", day: "numeric" });
};
const patientHref = (key: string) => `/patients/${/^p:\d+$/.test(key) ? key.slice(2) : encodeURIComponent(key)}?tab=overview`;

/**
 * Patient texts (Messages → Patient texts): the practice's main number as one shared inbox. Each person sees
 * their clinic's conversations, plus numbers nobody has matched to a patient yet. Assign, close, add notes
 * for the team, and see whether a patient said No to texts or texted STOP.
 */
export function TextsInbox({ threadId, onOpen, tabs }: { threadId: number | null; onOpen: (id: number | null) => void; tabs: React.ReactNode }) {
  const [filter, setFilter] = useState<TextFilter>("open");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [starting, setStarting] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const status = trpc.workspace.texts.status.useQuery(undefined, { staleTime: 60_000 });
  const list = trpc.workspace.texts.list.useQuery({ filter, q: debounced || null }, { refetchInterval: 10_000, enabled: !!status.data?.enabled });
  const open = trpc.workspace.texts.openForPatient.useMutation({
    onSuccess: (r) => { setStarting(false); onOpen(r.id); void list.refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const off = status.data && !status.data.enabled;
  return (
    <>
      <aside className={cn("flex w-full flex-col border-r border-slate-200 dark:border-slate-700 md:w-80 md:shrink-0", threadId && "hidden md:flex")}>
        <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50">Messages</h1>
            {!off && <Btn size="sm" onClick={() => setStarting((v) => !v)}><Plus size={14} /> Text</Btn>}
          </div>
          <div className="mt-2">{tabs}</div>
          {status.data?.number && <p className="mt-1.5 text-[11px] text-slate-500">Patients text {status.data.number}</p>}
        </div>
        {starting && (
          <div className="border-b border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/40">
            <p className="mb-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300">Text a patient (their number on file)</p>
            <PatientSearchBox autoFocus onPick={(p) => open.mutate({ subjectKey: p.key })} />
          </div>
        )}
        {!off && (
          <div className="space-y-2 border-b border-slate-200 p-3 dark:border-slate-700">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className={cn(inputCls, "pl-8")} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or phone number" aria-label="Find a texting conversation" />
            </div>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
              {(Object.keys(TEXT_FILTERS) as TextFilter[]).map((f) => (
                <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
                  className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", filter === f ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300")}>
                  {TEXT_FILTERS[f]}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {status.isLoading && <Loading />}
          {off && (
            <div className="p-4 text-sm text-slate-500">
              <p className="font-semibold text-slate-700 dark:text-slate-200">Patient texting isn't on yet.</p>
              <p className="mt-1">An admin picks the practice's texting number in Admin → Integrations (the number must be text-enabled and registered for business texting in RingCentral).</p>
            </div>
          )}
          {list.error && <div className="p-3"><ErrorNote message={list.error.message} /></div>}
          {list.isLoading && !off && <Loading />}
          {(list.data ?? []).map((r) => <ThreadRow key={r.id} r={r} active={r.id === threadId} onOpen={() => onOpen(r.id)} />)}
          {list.data && list.data.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-400">No conversations here.</p>}
        </div>
      </aside>
      <section className={cn("min-w-0 flex-1 flex-col", threadId ? "flex" : "hidden md:flex")}>
        {threadId ? <TextThread key={threadId} id={threadId} onBack={() => onOpen(null)} onChanged={() => void list.refetch()} /> : (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState icon={MessageSquareText} title="Patient texts" body="Pick a conversation, or start one with Text." />
          </div>
        )}
      </section>
    </>
  );
}

function ThreadRow({ r, active, onOpen }: { r: Row; active: boolean; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className={cn("flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-700/40", active && "bg-slate-100 dark:bg-slate-700/60")}>
      <span className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full", r.subjectKey ? "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300" : "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300")}>
        {r.subjectKey ? <HeartPulse size={16} /> : <UserRoundSearch size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-sm text-slate-900 dark:text-slate-50", r.unread ? "font-bold" : "font-medium")}>{r.name ?? r.phone}</span>
          <span className="shrink-0 text-[11px] text-slate-400">{fmtWhen(r.lastAt)}</span>
        </span>
        <span className="mt-0.5 flex items-center justify-between gap-2">
          <span className={cn("truncate text-xs", r.unread ? "text-slate-700 dark:text-slate-200" : "text-slate-500 dark:text-slate-400")}>
            {r.last ? `${r.last.fromPatient ? "" : "You: "}${r.last.text}` : "No texts yet"}
          </span>
          {r.unread && <CircleDot size={12} className="shrink-0 text-brand" aria-label="Unread" />}
        </span>
        <span className="mt-1 flex flex-wrap gap-1 text-[10px] font-semibold">
          {r.name && <span className="text-slate-400">{r.phone}</span>}
          {!r.subjectKey && <span className="rounded bg-amber-100 px-1.5 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">{r.ambiguous ? "Shared number" : "Who is this?"}</span>}
          {r.clinic && <span className="rounded bg-slate-100 px-1.5 text-slate-600 dark:bg-slate-700 dark:text-slate-300">{r.clinic}</span>}
          {r.assignee && <span className="rounded bg-brand-soft px-1.5 text-brand">{r.assignee.split(" ")[0]}</span>}
          {r.optedOut && <span className="rounded bg-red-100 px-1.5 text-red-700 dark:bg-red-500/20 dark:text-red-200">Texted STOP</span>}
          {r.status === "closed" && <span className="rounded bg-slate-100 px-1.5 text-slate-500 dark:bg-slate-700">Closed</span>}
        </span>
      </span>
    </button>
  );
}

function TextThread({ id, onBack, onChanged }: { id: number; onBack: () => void; onChanged: () => void }) {
  const utils = trpc.useUtils();
  const q = trpc.workspace.texts.get.useQuery({ id }, { refetchInterval: 5_000 });
  const bottom = useRef<HTMLDivElement>(null);
  const lastId = q.data?.messages.at(-1)?.id;
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [lastId]);
  useEffect(() => { if (q.data) { void utils.workspace.texts.unread.invalidate(); onChanged(); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [!!q.data]);
  const refresh = () => { void q.refetch(); onChanged(); void utils.workspace.texts.unread.invalidate(); };
  const assign = trpc.workspace.texts.assign.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const setStatus = trpc.workspace.texts.setStatus.useMutation({ onSuccess: (_, v) => { toast.success(v.status === "closed" ? "Closed." : "Reopened."); refresh(); }, onError: (e) => toast.error(e.message) });
  const match = trpc.workspace.texts.match.useMutation({ onSuccess: () => { toast.success("Matched. It's now in that patient's clinic inbox."); refresh(); }, onError: (e) => toast.error(e.message) });
  const [matching, setMatching] = useState(false);

  if (q.isLoading) return <Loading />;
  if (q.error) return <div className="p-4"><ErrorNote message={q.error.message} /></div>;
  const { thread: t, messages, assignable } = q.data!;
  const blockedReason = t.optedOut ? "This patient texted STOP. They can't get texts until they text START. Call them instead."
    : t.consent === "no" && !t.recentInbound ? "This patient said No to texts on their consent form. Call them instead (if they text us first, you can reply)." : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <button className="-ml-1 rounded-lg p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 md:hidden" onClick={onBack} aria-label="Back to texts"><ArrowLeft size={18} /></button>
        <div className="min-w-[9rem] flex-1">
          <p className="truncate font-semibold text-slate-900 dark:text-slate-50">{t.name ?? t.phone}</p>
          <p className="truncate text-xs text-slate-500">{t.name ? `${t.phone} · ` : ""}{t.clinic ?? "No clinic yet"}{t.status === "closed" ? " · Closed" : ""}</p>
        </div>
        {t.subjectKey && (
          <Link href={patientHref(t.subjectKey)} className="hidden items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700 sm:inline-flex">
            <HeartPulse size={13} /> Open patient
          </Link>
        )}
        <div className="flex items-center gap-2">
        <select className={cn(inputCls, "w-36 py-1.5 text-xs")} value={t.assignedUserId ?? ""} aria-label="Assigned to"
          onChange={(e) => assign.mutate({ threadId: id, userId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Unassigned</option>
          {assignable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Btn size="sm" variant="secondary" onClick={() => setStatus.mutate({ threadId: id, status: t.status === "closed" ? "open" : "closed" })}>
          {t.status === "closed" ? "Reopen" : <><CheckCircle2 size={14} /> Close</>}
        </Btn>
        </div>
      </div>

      {!t.subjectKey && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <p className="flex items-center gap-1.5 font-semibold"><UserRoundSearch size={14} /> {t.candidates.length ? "More than one patient has this number. Who is texting?" : "Who is this? Match the number to a patient so it goes to their clinic."}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {t.candidates.map((c) => (
              <button key={c.key} onClick={() => match.mutate({ threadId: id, subjectKey: c.key })} className="rounded-full border border-amber-300 bg-white px-2.5 py-0.5 font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-100">{c.name}</button>
            ))}
            <button onClick={() => setMatching((v) => !v)} className="font-semibold underline">{matching ? "Cancel" : t.candidates.length ? "Someone else" : "Find the patient"}</button>
          </div>
          {matching && <div className="mt-2 max-w-md"><PatientSearchBox autoFocus onPick={(p) => { setMatching(false); match.mutate({ threadId: id, subjectKey: p.key }); }} /></div>}
        </div>
      )}
      {t.optedOut && <Banner tone="red" icon={Ban}>This patient texted STOP. Texts to them are blocked until they text START.</Banner>}
      {!t.optedOut && t.consent === "no" && <Banner tone="amber" icon={ShieldAlert}>This patient said No to texts on their consent form.{t.recentInbound ? " They texted us today, so you can reply." : " Call them instead."}</Banner>}

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && <p className="py-10 text-center text-sm text-slate-400">No texts yet.</p>}
        <Messages messages={messages} />
        <div ref={bottom} />
      </div>

      <Composer threadId={id} blockedReason={blockedReason} onSent={refresh} />
    </>
  );
}

function Banner({ tone, icon: Icon, children }: { tone: "red" | "amber"; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <p className={cn("flex items-center gap-2 border-b px-4 py-2 text-xs font-medium",
      tone === "red" ? "border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200" : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100")}>
      <Icon size={14} className="shrink-0" /> {children}
    </p>
  );
}

function Messages({ messages }: { messages: Detail["messages"] }) {
  const groups = useMemo(() => {
    const out: { day: string; label: string; items: Detail["messages"] }[] = [];
    for (const m of messages) {
      const k = dayKey(m.at);
      if (out.at(-1)?.day !== k) out.push({ day: k, label: fmtDay(m.at), items: [] });
      out.at(-1)!.items.push(m);
    }
    return out;
  }, [messages]);
  return (
    <>
      {groups.map((g) => (
        <div key={g.day}>
          <div className="my-3 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" /> {g.label} <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
          </div>
          {g.items.map((m) => m.direction === "note" ? (
            <div key={m.id} className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
              <p className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300"><NotebookPen size={12} /> Note for the team · {m.by ?? "Someone"} · {fmtClock(m.at)}</p>
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
            </div>
          ) : (
            <div key={m.id} className={cn("mb-1.5 flex", m.direction === "out" ? "justify-end" : "justify-start")}>
              <div className="max-w-[85%] md:max-w-[70%]">
                <div className={cn("rounded-2xl px-3.5 py-2 text-sm", m.direction === "out" ? (m.status === "failed" ? "border border-red-300 bg-red-50 text-red-900 dark:bg-red-500/10 dark:text-red-100" : "bg-brand text-white") : "bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-100")}>
                  {m.hasMedia && <p className="mb-1 flex items-center gap-1 text-xs font-semibold opacity-80"><ImageIcon size={13} /> Picture message (open it in the RingCentral app)</p>}
                  {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                </div>
                <p className={cn("mt-0.5 flex flex-wrap items-center gap-2 px-1 text-[10px] text-slate-400", m.direction === "out" && "justify-end")}>
                  {fmtClock(m.at)}
                  {m.direction === "out" && m.by && <span>{m.by}</span>}
                  {m.direction === "out" && <span className={cn("font-semibold", m.status === "failed" ? "text-red-600" : m.status === "delivered" ? "text-emerald-600" : "")}>{TEXT_STATUS_LABELS[m.status as TextStatus] ?? m.status}</span>}
                  {m.error && <span className="text-red-600" title={m.error}><AlertTriangle size={11} className="inline" /> {m.error.slice(0, 80)}</span>}
                </p>
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/** Write a text (sent to the patient) or a note (for the team only). */
function Composer({ threadId, blockedReason, onSent }: { threadId: number; blockedReason: string | null; onSent: () => void }) {
  const [mode, setMode] = useState<"text" | "note">("text");
  const [body, setBody] = useState("");
  const send = trpc.workspace.texts.send.useMutation({ onSuccess: () => { setBody(""); onSent(); }, onError: (e) => toast.error(e.message) });
  const note = trpc.workspace.texts.note.useMutation({ onSuccess: () => { setBody(""); onSent(); }, onError: (e) => toast.error(e.message) });
  const busy = send.isPending || note.isPending;
  const blocked = mode === "text" && !!blockedReason;
  const submit = () => {
    const text = body.trim();
    if (!text || busy || blocked) return;
    if (mode === "text") send.mutate({ threadId, body: text });
    else note.mutate({ threadId, body: text });
  };
  const parts = textSegments(body);
  return (
    <div className={cn("border-t border-slate-200 p-3 dark:border-slate-700", mode === "note" && "bg-amber-50/60 dark:bg-amber-500/5")}>
      <div className="mb-2 flex items-center gap-1" role="group" aria-label="Write">
        <button onClick={() => setMode("text")} aria-pressed={mode === "text"} className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold", mode === "text" ? "bg-brand text-white" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700")}><Send size={12} /> Text the patient</button>
        <button onClick={() => setMode("note")} aria-pressed={mode === "note"} className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold", mode === "note" ? "bg-amber-500 text-white" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700")}><NotebookPen size={12} /> Note for the team</button>
        {mode === "text" && body && <span className="ml-auto text-[11px] text-slate-400">{body.length}/{MAX_TEXT_LENGTH}{parts > 1 ? ` · ${parts} texts` : ""}</span>}
      </div>
      {blocked ? (
        <p className="flex items-center gap-2 rounded-xl bg-slate-100 px-3 py-2.5 text-xs text-slate-600 dark:bg-slate-700/60 dark:text-slate-300"><Ban size={14} className="shrink-0" /> {blockedReason}</p>
      ) : (
        <div className="flex items-end gap-1.5">
          <textarea className={cn(inputCls, "max-h-40 min-h-[42px] flex-1 resize-none py-2.5")} rows={1} value={body} maxLength={mode === "text" ? MAX_TEXT_LENGTH : 2000}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder={mode === "text" ? "Text to the patient (keep health details to a minimum)" : "Only your team sees this"}
            aria-label={mode === "text" ? "Text to the patient" : "Note for the team"} />
          <Btn onClick={submit} disabled={!body.trim() || busy} aria-label={mode === "text" ? "Send text" : "Add note"} className={mode === "note" ? "bg-amber-500 hover:bg-amber-600" : undefined}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : mode === "text" ? <Send size={15} /> : <NotebookPen size={15} />}
          </Btn>
        </div>
      )}
      {mode === "text" && !blocked && <p className="mt-1.5 text-[10px] text-slate-400">Texts go from the practice's number and are saved here. Don't send test results or detailed health information by text.</p>}
    </div>
  );
}

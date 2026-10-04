import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtClock } from "@/components/workspace/ui";
import { CLINIC_TZ } from "@shared/workforce";

const fmtWhen = (d: Date | string) => {
  const day = (x: Date | string) => new Date(x).toLocaleDateString("en-CA", { timeZone: CLINIC_TZ });
  return day(d) === day(new Date()) ? fmtClock(d) : new Date(d).toLocaleDateString("en-US", { timeZone: CLINIC_TZ, month: "short", day: "numeric", year: "2-digit" });
};

/** The match in bold. */
function Highlight({ text, q }: { text: string; q: string }) {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="rounded bg-amber-100 px-0.5 text-inherit dark:bg-amber-500/30">{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
}

/** Messages that match the search box (3+ letters), across every conversation I'm in. */
export function MessageSearchResults({ q, onOpen }: { q: string; onOpen: (conversationId: number, messageId: number) => void }) {
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const enabled = term.length >= 3;
  const r = trpc.workspace.chat.search.useQuery({ q: term }, { enabled, staleTime: 15_000 });
  if (!enabled) return null;
  return (
    <div className="border-t border-slate-200 dark:border-slate-700">
      <p className="flex items-center gap-2 bg-slate-50 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
        Messages {r.isFetching && <Loader2 size={11} className="animate-spin" />}
      </p>
      {r.data?.length === 0 && <p className="px-4 py-3 text-xs text-slate-400">No messages mention “{term}”.</p>}
      {(r.data ?? []).map((m) => (
        <button key={m.messageId} onClick={() => onOpen(m.conversationId, m.messageId)}
          className="block w-full border-b border-slate-100 px-4 py-2.5 text-left hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-700/40">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xs font-semibold text-slate-800 dark:text-slate-100">{m.title}</span>
            <span className="shrink-0 text-[11px] text-slate-400">{fmtWhen(m.at)}</span>
          </span>
          <span className="mt-0.5 line-clamp-2 block text-xs text-slate-600 dark:text-slate-300">
            <span className="font-medium">{m.from}:</span> <Highlight text={m.snippet} q={term} />
          </span>
        </button>
      ))}
    </div>
  );
}

/** Who has tapped "I read this" on a must-read message, and who hasn't yet. */
export function AckList({ messageId, onClose }: { messageId: number; onClose: () => void }) {
  const q = trpc.workspace.chat.ackStatus.useQuery({ messageId });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-800" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Who has read it">
        <h2 className="mb-3 font-semibold text-slate-900 dark:text-slate-50">Who has read it</h2>
        {q.isLoading && <p className="text-sm text-slate-400"><Loader2 size={14} className="mr-1 inline animate-spin" /> Loading…</p>}
        {q.error && <p className="text-sm text-red-600">{q.error.message}</p>}
        {q.data && (
          <div className="grid max-h-80 grid-cols-2 gap-4 overflow-y-auto text-sm">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-600">Read ({q.data.read.length})</p>
              {q.data.read.map((p) => <p key={p.id} className="truncate text-slate-700 dark:text-slate-200" title={`${fmtWhen(p.at)}`}>{p.name}</p>)}
              {!q.data.read.length && <p className="text-xs text-slate-400">Nobody yet</p>}
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-600">Not yet ({q.data.notYet.length})</p>
              {q.data.notYet.map((p) => <p key={p.id} className="truncate text-slate-700 dark:text-slate-200">{p.name}</p>)}
              {!q.data.notYet.length && <p className="text-xs text-slate-400">Everyone has read it</p>}
            </div>
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700">Close</button>
        </div>
      </div>
    </div>
  );
}

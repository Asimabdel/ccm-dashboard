import { useState } from "react";
import { Trophy } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { CONVERSATION_MIN_SEC } from "@shared/metrics";
import { cardCls } from "./ui";

// Rank badges for the top three (text stays in text colors; the badge carries the medal).
const MEDAL = ["bg-amber-400 text-amber-950", "bg-slate-300 text-slate-800", "bg-orange-300 text-orange-950"];

/**
 * My Work → Top callers: everyone sees the top five today or this week, and where they stand. Ranked by conversations
 * (calls of 30 s or more, made or answered), then by calls (made + answered, the same count as My calls). Names and counts only.
 */
export function CallLeaderboard() {
  const [period, setPeriod] = useState<"today" | "week">("today");
  // Live: every 30 seconds (and as soon as the tab is back in view); RingCentral calls arrive about a minute after they end.
  const q = trpc.workspace.metrics.leaderboard.useQuery({ period }, { refetchInterval: 30_000, refetchOnWindowFocus: true, staleTime: 10_000, placeholderData: (prev) => prev });
  const d = q.data;
  if (!d) return null;
  const top = Math.max(1, ...d.top.map((r) => r.conversations));
  return (
    <section aria-label="Top callers" className={cn(cardCls, "mb-6 p-4")}>
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-50"><Trophy size={15} className="text-amber-500" /> Top callers</h3>
        <div className="ml-auto inline-flex rounded-lg bg-slate-100 p-0.5 text-xs dark:bg-slate-800" role="group" aria-label="Period">
          {(["today", "week"] as const).map((p) => (
            <button key={p} type="button" onClick={() => setPeriod(p)} aria-pressed={period === p}
              className={cn("rounded-md px-2.5 py-1 font-semibold", period === p ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-50" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200")}>
              {p === "today" ? "Today" : "This week"}
            </button>
          ))}
        </div>
      </div>
      {d.top.length === 0 ? (
        <p className="py-3 text-sm text-slate-500">No calls yet {period === "today" ? "today" : "this week"}. The first call puts you on the board.</p>
      ) : (
        <ol className="space-y-1.5">
          {d.top.map((r, i) => (
            <li key={`${r.rank}-${i}`} className={cn("flex items-center gap-2.5 rounded-lg px-2 py-1.5", r.you && "bg-orange-50 ring-1 ring-orange-200 dark:bg-orange-950/40 dark:ring-orange-900")}>
              <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums", MEDAL[r.rank - 1] ?? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")}>{r.rank}</span>
              <span className="w-28 shrink-0 truncate text-sm font-medium text-slate-800 dark:text-slate-100">{r.name}{r.you && <span className="ml-1 text-[11px] font-semibold text-orange-700 dark:text-orange-300">(you)</span>}</span>
              <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" aria-hidden>
                <span className={cn("block h-full rounded-full", r.rank === 1 ? "bg-amber-400" : "bg-brand/70")} style={{ width: `${Math.max(4, Math.round((r.conversations / top) * 100))}%` }} />
              </span>
              <span className="shrink-0 text-right text-sm tabular-nums" title={`${r.conversations} conversations · ${r.calls} calls`}>
                <b className="text-slate-900 dark:text-slate-50">{r.conversations}</b>
                <span className="ml-1 text-[11px] text-slate-400">/ {r.calls} calls</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2.5 text-[11px] text-slate-500">
        {d.you.inTop ? "You're in the top 5. Keep it up!"
          : d.you.rank ? <>You're <b className="text-slate-700 dark:text-slate-200">#{d.you.rank}</b> of {d.callers} with {d.you.conversations} conversation{d.you.conversations === 1 ? "" : "s"} ({d.you.calls} call{d.you.calls === 1 ? "" : "s"}).</>
          : d.top.length ? "Make a call to get on the board." : null}
        <span className="text-slate-400"> · Ranked by conversations (calls of {CONVERSATION_MIN_SEC} seconds or more), then calls made + answered{period === "week" ? ", Monday to today" : ""}. Updated {new Date(q.dataUpdatedAt || Date.now()).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}; a call shows about a minute after it ends.</span>
      </p>
    </section>
  );
}

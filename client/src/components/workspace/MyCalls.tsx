import { useState } from "react";
import { Clock, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, CalendarCheck, Lock } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDay, localDateStr } from "@shared/workforce";
import { fmtMinutes } from "@shared/metrics";
import { cardCls, inputCls } from "./ui";

/**
 * My Work → My calls: the signed-in person's own RingCentral numbers for a day (made, answered,
 * missed, time on the phone, booked) and their last 7 days. Only ever their own; nobody else's.
 */
export function MyCalls() {
  const today = localDateStr();
  const [date, setDate] = useState(today);
  const q = trpc.workspace.metrics.myCalls.useQuery({ date }, { refetchInterval: date === today ? 60_000 : false, placeholderData: (prev) => prev });
  const d = q.data;
  if (!d || !d.show) return null;
  const isToday = d.date === today;
  const top = Math.max(1, ...d.days.map((x) => x.calls));
  const tiles: { label: string; value: string; icon: React.ElementType; tone?: "bad" }[] = [
    { label: "Made", value: String(d.made), icon: PhoneOutgoing },
    { label: "Answered", value: String(d.answered), icon: PhoneIncoming },
    { label: "Missed", value: String(d.missed), icon: PhoneMissed, tone: d.missed ? "bad" : undefined },
    { label: "On the phone", value: fmtMinutes(d.talkMin), icon: Clock },
    { label: "Booked", value: String(d.booked), icon: CalendarCheck },
  ];

  return (
    <section aria-label="My calls" className={cn(cardCls, "mb-6 p-4")}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-50"><PhoneCall size={15} className="text-brand" /> My calls</h3>
        <input type="date" aria-label="Day" className={cn(inputCls, "w-auto py-1 text-xs")} value={d.date} max={today} onChange={(e) => setDate(e.target.value || today)} />
        {!isToday && <button className="text-xs font-semibold text-slate-500 hover:text-slate-800" onClick={() => setDate(today)}>Back to today</button>}
        <span className="ml-auto flex items-center gap-1 text-[11px] text-slate-400"><Lock size={11} /> Only you see these{d.ringCentral ? " · from RingCentral, updates about every 10 minutes" : ""}</span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_auto]">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <div className="rounded-xl bg-orange-50 px-3 py-2.5 ring-1 ring-orange-200 dark:bg-orange-950/40 dark:ring-orange-900">
            <p className="text-[11px] font-medium text-orange-700 dark:text-orange-300">Calls {isToday ? "today" : fmtDay(d.date)}</p>
            <p className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{d.calls}</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{d.usual != null ? `Your usual day: ${d.usual}` : "Made + answered"}</p>
          </div>
          {tiles.map((t) => (
            <div key={t.label} className="rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800">
              <p className="flex items-center gap-1 text-[11px] font-medium text-slate-500"><t.icon size={11} /> {t.label}</p>
              <p className={cn("text-xl font-bold tabular-nums", t.tone === "bad" ? "text-rose-600 dark:text-rose-400" : "text-slate-900 dark:text-slate-50")}>{t.value}</p>
            </div>
          ))}
        </div>

        {/* The last 7 days: calls per day (click a day to see it). */}
        <div className="flex items-end gap-1.5" role="list" aria-label="Calls per day, last 7 days">
          {d.days.map((x) => {
            const on = x.date === d.date;
            return (
              <button key={x.date} role="listitem" onClick={() => setDate(x.date)}
                aria-label={`${fmtDay(x.date)}: ${x.calls} call${x.calls === 1 ? "" : "s"}, ${x.missed} missed`}
                title={`${fmtDay(x.date)}: ${x.calls} calls, ${x.missed} missed`}
                className={cn("group flex w-9 flex-col items-center gap-1 rounded-lg px-0.5 pt-1 pb-0.5", on ? "bg-slate-100 dark:bg-slate-700" : "hover:bg-slate-50 dark:hover:bg-slate-800")}>
                <span className="text-[11px] font-semibold tabular-nums text-slate-700 dark:text-slate-200">{x.calls}</span>
                <span className="flex h-12 w-4 items-end">
                  <span className={cn("block w-full rounded-t-[4px]", on ? "bg-brand" : "bg-slate-300 group-hover:bg-slate-400 dark:bg-slate-600")} style={{ height: `${Math.max(x.calls ? 8 : 2, Math.round((x.calls / top) * 100))}%` }} />
                </span>
                <span className="text-[10px] text-slate-500">{fmtDay(x.date, { weekday: "short" })}</span>
              </button>
            );
          })}
        </div>
      </div>

      {d.ringCentral && !d.linked && (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
          Your RingCentral line isn't matched to your MyPCP login yet, so only calls you place from MyPCP count here. Lines are matched by the email on your RingCentral account, or by your exact name. Ask an admin if this looks wrong.
        </p>
      )}
    </section>
  );
}

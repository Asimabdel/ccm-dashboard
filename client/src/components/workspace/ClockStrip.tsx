import { useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, Clock, Coffee, Loader2, LogIn, LogOut, UsersRound, Wrench } from "lucide-react";
import { fmtDuration, fmtTime, localMinutes, timeToMinutes } from "@shared/workforce";
import { useClock } from "@/components/workforce/useClock";
import { FixPunchDialog } from "@/components/workforce/FixPunchDialog";
import { cardCls } from "./ui";
import { cn } from "@/lib/utils";

const clockTime = (d: Date | string) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

/**
 * The time clock on Home, for hourly staff only (people without the clock never see it). It says what
 * to do right now: clock in when the shift is starting, Start / End lunch, clock out when it's over.
 */
export function ClockStrip({ className }: { className?: string }) {
  const c = useClock();
  // Keep the "on the clock for…" time and the reminders current between refreshes.
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  const [fixing, setFixing] = useState<{ date: string; punchId?: number } | null>(null);

  const d = c.day;
  if (!d || !c.enabled) return null;
  const { open, onLunchSince, shift } = c;
  const now = localMinutes();
  const starts = shift ? timeToMinutes(shift.startTime) : null;
  const ends = shift ? timeToMinutes(shift.endTime) : null;

  // What to tell them right now.
  let tone: "go" | "warn" | "on" | "idle" = "idle";
  let headline: string;
  if (open) {
    const over = ends != null && now >= ends + 5;
    tone = over ? "warn" : "on";
    headline = over ? `Your shift ended at ${fmtTime(shift!.endTime)}. Remember to clock out.` : `You're on the clock since ${clockTime(open.clockInAt)}`;
  } else if (onLunchSince && ends != null && now < ends) {
    tone = c.nudge === "end_lunch" ? "warn" : "on";
    headline = `On lunch since ${clockTime(onLunchSince)}`;
  } else if (shift && starts != null && ends != null && now >= starts - 15 && now < ends) {
    tone = d.punches.length ? "idle" : "go";
    headline = d.punches.length ? "You're clocked out" : now >= starts ? `Time to clock in: your shift started at ${fmtTime(shift.startTime)}` : `Your shift starts at ${fmtTime(shift.startTime)}. Clock in when you arrive.`;
  } else if (shift && starts != null && now < starts) {
    headline = `Your shift today starts at ${fmtTime(shift.startTime)}`;
  } else {
    headline = d.punches.length ? "You're clocked out for today" : shift ? "Your shift is over for today" : "You're not on the schedule today";
  }

  const wrap = {
    go: "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40",
    warn: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40",
    on: "",
    idle: "",
  }[tone];
  const big = "inline-flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-bold text-white transition active:scale-[0.98] disabled:opacity-60";

  return (
    <section aria-label="Time clock" className={cn(cardCls, "flex flex-col gap-3 p-4", wrap, className)}>
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg",
          tone === "go" ? "bg-emerald-600 text-white" : tone === "warn" ? "bg-amber-500 text-white" : open ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200" : "bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300")}>
          {onLunchSince && !open ? <Coffee size={18} /> : <Clock size={18} />}
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Time clock</p>
          <p className="font-semibold leading-snug text-slate-900 dark:text-slate-100">{headline}</p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {shift ? `Today ${fmtTime(shift.startTime)} – ${fmtTime(shift.endTime)} ${shift.clinicId ? `at ${shift.clinicName}` : "(remote)"}` : "No shift today"}
            {c.workedMinutes > 0 ? ` · ${fmtDuration(c.workedMinutes)} worked` : ""}
          </p>
        </div>
      </div>
      {d.missedClockOuts.length > 0 && (
        <p className="flex flex-wrap items-start gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
          <AlertTriangle size={13} className="mt-px shrink-0" /> You didn't clock out on {d.missedClockOuts.length === 1 ? "a recent day" : `${d.missedClockOuts.length} days`}.
          <button className="inline-flex items-center gap-1 underline" onClick={() => setFixing({ date: d.missedClockOuts[0]!.workDate, punchId: d.missedClockOuts[0]!.id })}><Wrench size={12} /> Fix it</button>
        </p>
      )}
      <div className="flex gap-2">
        {open ? (
          <>
            <button onClick={c.startLunch} disabled={c.busy} className={cn(big, "bg-amber-500 hover:bg-amber-600")}><Coffee size={18} /> Start lunch</button>
            <button onClick={c.clockOut} disabled={c.busy} className={cn(big, "bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600")}>{c.busy ? <Loader2 size={18} className="animate-spin" /> : <LogOut size={18} />} Clock out</button>
          </>
        ) : onLunchSince && ends != null && now < ends ? (
          <button onClick={c.endLunch} disabled={c.busy} className={cn(big, "bg-emerald-600 hover:bg-emerald-700")}>{c.busy ? <Loader2 size={18} className="animate-spin" /> : <LogIn size={18} />} End lunch</button>
        ) : (
          <button onClick={c.clockIn} disabled={c.busy} className={cn(big, "bg-emerald-600 hover:bg-emerald-700")}>{c.busy ? <Loader2 size={18} className="animate-spin" /> : <LogIn size={18} />} Clock in</button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/team-schedule" className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400"><UsersRound size={13} /> Who's working today</Link>
        <button onClick={() => setFixing({ date: d.today })} className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400"><Wrench size={13} /> Fix a punch</button>
      </div>
      <FixPunchDialog open={!!fixing} onClose={() => setFixing(null)} date={fixing?.date} punchId={fixing?.punchId} />
    </section>
  );
}

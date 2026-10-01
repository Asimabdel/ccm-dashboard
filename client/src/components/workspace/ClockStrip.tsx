import { useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { AlertTriangle, Clock, Loader2, LogIn, LogOut, UsersRound } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtDuration, fmtTime, localMinutes, timeToMinutes } from "@shared/workforce";
import { cardCls } from "./ui";
import { cn } from "@/lib/utils";

const clockTime = (d: Date | string) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

/**
 * The time clock on Home, for hourly staff only (people without the clock never see it). It says what
 * to do right now: clock in when the shift is starting, clock out when it's over.
 */
export function ClockStrip({ className }: { className?: string }) {
  const utils = trpc.useUtils();
  const day = trpc.workforce.me.today.useQuery(undefined, { refetchInterval: 60_000 });
  // Keep the "on the clock for…" time and the reminders current between refreshes.
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  const refresh = () => utils.workforce.me.today.invalidate();
  const clockIn = trpc.workforce.me.clockIn.useMutation({
    onSuccess: (r) => { refresh(); r.minutesLate > 0 ? toast.warning(`Clocked in, ${r.minutesLate} min after your shift start`) : toast.success("Clocked in. Have a great shift!"); },
    onError: (e) => toast.error(e.message),
  });
  const clockOut = trpc.workforce.me.clockOut.useMutation({
    onSuccess: () => { refresh(); toast.success("Clocked out. See you next time!"); },
    onError: (e) => toast.error(e.message),
  });

  const d = day.data;
  if (!d || (!d.clockEnabled && !d.openPunch)) return null;
  const open = d.openPunch;
  const worked = d.punches.reduce((s, p) => s + Math.max(0, Math.round(((p.clockOutAt ? +new Date(p.clockOutAt) : Date.now()) - +new Date(p.clockInAt)) / 60000)), 0);
  const shift = d.shifts.find((s) => s.status === "scheduled");
  const now = localMinutes();
  const starts = shift ? timeToMinutes(shift.startTime) : null;
  const ends = shift ? timeToMinutes(shift.endTime) : null;
  const busy = clockIn.isPending || clockOut.isPending;

  // What to tell them right now.
  let tone: "go" | "warn" | "on" | "idle" = "idle";
  let headline: string;
  if (open) {
    const over = ends != null && now >= ends + 5;
    tone = over ? "warn" : "on";
    headline = over ? `Your shift ended at ${fmtTime(shift!.endTime)}. Remember to clock out.` : `You're on the clock since ${clockTime(open.clockInAt)}`;
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

  return (
    <section aria-label="Time clock" className={cn(cardCls, "flex flex-col gap-3 p-4", wrap, className)}>
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg",
          tone === "go" ? "bg-emerald-600 text-white" : tone === "warn" ? "bg-amber-500 text-white" : open ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200" : "bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300")}>
          <Clock size={18} />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Time clock</p>
          <p className="font-semibold leading-snug text-slate-900 dark:text-slate-100">{headline}</p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {shift ? `Today ${fmtTime(shift.startTime)} – ${fmtTime(shift.endTime)} ${shift.clinicId ? `at ${shift.clinicName}` : "(remote)"}` : "No shift today"}
            {worked > 0 ? ` · ${fmtDuration(worked)} worked` : ""}
          </p>
        </div>
      </div>
      {d.missedClockOuts.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
          <AlertTriangle size={13} className="mt-px shrink-0" /> You didn't clock out on {d.missedClockOuts.length === 1 ? "a recent day" : `${d.missedClockOuts.length} days`}. Tell your manager what time you left.
        </p>
      )}
      <button
        onClick={() => (open ? clockOut.mutate() : clockIn.mutate())}
        disabled={busy}
        className={cn("inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-bold text-white transition active:scale-[0.98] disabled:opacity-60",
          open ? "bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600" : "bg-emerald-600 hover:bg-emerald-700")}
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : open ? <LogOut size={18} /> : <LogIn size={18} />}
        {open ? "Clock out" : "Clock in"}
      </button>
      <Link href="/team-schedule" className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400"><UsersRound size={13} /> Who's working today</Link>
    </section>
  );
}

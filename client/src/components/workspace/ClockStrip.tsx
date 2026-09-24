import { Link } from "wouter";
import { toast } from "sonner";
import { AlertTriangle, Clock, Loader2, LogIn, LogOut } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtDuration, fmtTime } from "@shared/workforce";
import { Btn, ToneTile, cardCls } from "./ui";
import { cn } from "@/lib/utils";

const clockTime = (d: Date | string) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

/** Time clock on Home, for hourly staff only (people without the clock never see it). */
export function ClockStrip() {
  const utils = trpc.useUtils();
  const day = trpc.workforce.me.today.useQuery(undefined, { refetchInterval: 60_000 });
  const refresh = () => utils.workforce.me.today.invalidate();
  const clockIn = trpc.workforce.me.clockIn.useMutation({
    onSuccess: (r) => { refresh(); r.minutesLate > 0 ? toast.warning(`Clocked in — ${r.minutesLate} min after your shift start`) : toast.success("Clocked in. Have a great shift!"); },
    onError: (e) => toast.error(e.message),
  });
  const clockOut = trpc.workforce.me.clockOut.useMutation({
    onSuccess: () => { refresh(); toast.success("Clocked out"); },
    onError: (e) => toast.error(e.message),
  });

  const d = day.data;
  if (!d || (!d.clockEnabled && !d.openPunch)) return null;
  const open = d.openPunch;
  const worked = d.punches.reduce((s, p) => s + Math.max(0, Math.round(((p.clockOutAt ? +new Date(p.clockOutAt) : Date.now()) - +new Date(p.clockInAt)) / 60000)), 0);
  const shift = d.shifts.find((s) => s.status === "scheduled");
  const busy = clockIn.isPending || clockOut.isPending;

  return (
    <div className={cn(cardCls, "mb-6 flex flex-wrap items-center justify-between gap-3 px-4 py-3")}>
      <div className="flex items-center gap-3 min-w-0">
        <ToneTile icon={Clock} tone={open ? "success" : "neutral"} size="sm" />
        <div className="text-sm min-w-0">
          <p className="font-semibold text-slate-900 dark:text-slate-100">
            {open ? `On the clock since ${clockTime(open.clockInAt)}` : worked > 0 ? "You're clocked out" : "You're not clocked in"}
            {worked > 0 && <span className="font-normal text-slate-500"> · {fmtDuration(worked)} today</span>}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
            {shift ? `Today: ${fmtTime(shift.startTime)} – ${fmtTime(shift.endTime)} at ${shift.clinicName}` : "Not on the schedule today"}
            {" · "}<Link href="/team-schedule" className="underline hover:text-slate-800">Who's working</Link>
          </p>
          {d.missedClockOuts.length > 0 && (
            <p className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-amber-700"><AlertTriangle size={12} /> You didn't clock out on {d.missedClockOuts.length === 1 ? "a recent day" : `${d.missedClockOuts.length} days`} — tell your manager when you left.</p>
          )}
        </div>
      </div>
      <Btn variant={open ? "primary" : "brand"} disabled={busy} onClick={() => (open ? clockOut.mutate() : clockIn.mutate())}>
        {busy ? <Loader2 size={15} className="animate-spin" /> : open ? <LogOut size={15} /> : <LogIn size={15} />}
        {open ? "Clock out" : "Clock in"}
      </Btn>
    </div>
  );
}

import { useEffect } from "react";
import { useLocation } from "wouter";
import { Clock, Coffee, Loader2, LogIn, LogOut } from "lucide-react";
import { fmtTime } from "@shared/workforce";
import { useClock } from "./useClock";
import { popupsSupported } from "@/components/messages/useUnreadMessages";
import { cn } from "@/lib/utils";

// Reminders already popped up this session (date + what + shift), so each shows once.
const shown = new Set<string>();
const clockTime = (d: Date | string) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

/**
 * A banner across every page (except Home and My Day, which have the clock already) when the time clock
 * needs them: time to clock in, still on lunch, or still clocked in after the shift. Also a browser pop-up,
 * once per reminder. Only for people on the time clock.
 */
export function ClockBanner() {
  const [location] = useLocation();
  const c = useClock();
  const key = c.nudge && c.day ? `${c.day.today}:${c.nudge}:${c.shift?.id ?? 0}` : null;

  useEffect(() => {
    if (!key || shown.has(key)) return;
    shown.add(key);
    try {
      if (sessionStorage.getItem(`clock-nudge:${key}`)) return;
      sessionStorage.setItem(`clock-nudge:${key}`, "1");
    } catch { /* private mode: the banner still shows */ }
    if (!popupsSupported() || Notification.permission !== "granted") return;
    try {
      const n = new Notification(c.nudge === "clock_out" ? "Still clocked in" : c.nudge === "end_lunch" ? "Still on lunch?" : "Time to clock in", { body: text(c), tag: "mypcp-clock", icon: "/icon-192.png" });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* the banner still shows */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!c.nudge || location === "/" || location === "/home" || location.startsWith("/my-day")) return null;
  const warn = c.nudge === "late" || c.nudge === "clock_out";
  return (
    <div className={cn("flex flex-wrap items-center gap-3 border-b px-4 py-2.5 text-sm md:px-6", warn ? "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100" : "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100")} role="status">
      {c.nudge === "end_lunch" ? <Coffee size={16} className="shrink-0" /> : <Clock size={16} className="shrink-0" />}
      <span className="min-w-0 flex-1 font-medium">{text(c)}</span>
      <button disabled={c.busy} onClick={c.nudge === "clock_out" ? c.clockOut : c.nudge === "end_lunch" ? c.endLunch : c.clockIn}
        className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60", c.nudge === "clock_out" ? "bg-slate-900 hover:bg-slate-800" : "bg-emerald-600 hover:bg-emerald-700")}>
        {c.busy ? <Loader2 size={13} className="animate-spin" /> : c.nudge === "clock_out" ? <LogOut size={13} /> : <LogIn size={13} />}
        {c.nudge === "clock_out" ? "Clock out" : c.nudge === "end_lunch" ? "End lunch" : "Clock in"}
      </button>
    </div>
  );
}

function text(c: ReturnType<typeof useClock>): string {
  const s = c.shift;
  if (c.nudge === "clock_out") return `Your shift ended at ${s ? fmtTime(s.endTime) : "its end time"} and you're still clocked in.`;
  if (c.nudge === "end_lunch") return `You've been on lunch since ${c.onLunchSince ? clockTime(c.onLunchSince) : "a while"}. Back? End lunch.`;
  if (c.nudge === "late") return `Your shift started at ${s ? fmtTime(s.startTime) : "its start time"} and you're not clocked in.`;
  return `Your shift ${s ? `starts at ${fmtTime(s.startTime)}` : "is starting"}. Clock in when you arrive.`;
}

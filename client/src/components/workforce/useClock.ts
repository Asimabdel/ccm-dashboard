import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { localMinutes, timeToMinutes } from "@shared/workforce";
import { clockNudge, dayWork, type ClockNudge, type PunchLike } from "@shared/attendance";

/**
 * The time clock for the signed-in person: today's data, what they should do now (shared/attendance
 * clockNudge, the same rule the reminder job uses), and clock in / out / lunch actions with friendly toasts.
 */
export function useClock(enabled = true) {
  const utils = trpc.useUtils();
  const day = trpc.workforce.me.today.useQuery(undefined, { enabled, refetchInterval: 60_000, refetchIntervalInBackground: true, staleTime: 20_000 });
  const refresh = () => { void utils.workforce.me.today.invalidate(); void utils.workforce.me.attendance.invalidate(); };
  const clockIn = trpc.workforce.me.clockIn.useMutation({
    onSuccess: (r) => { refresh(); r.minutesLate > 0 ? toast.warning(`Clocked in, ${r.minutesLate} min after your shift start`) : toast.success("Clocked in. Have a great shift!"); },
    onError: (e) => toast.error(e.message),
  });
  const clockOut = trpc.workforce.me.clockOut.useMutation({ onSuccess: () => { refresh(); toast.success("Clocked out. See you next time!"); }, onError: (e) => toast.error(e.message) });
  const startLunch = trpc.workforce.me.startLunch.useMutation({ onSuccess: () => { refresh(); toast.success("Enjoy your lunch. Tap End lunch when you're back."); }, onError: (e) => toast.error(e.message) });
  const endLunch = trpc.workforce.me.endLunch.useMutation({ onSuccess: () => { refresh(); toast.success("Welcome back. You're on the clock."); }, onError: (e) => toast.error(e.message) });

  const d = day.data;
  const punches = (d?.punches ?? []) as PunchLike[];
  const work = dayWork(punches);
  const nowMin = localMinutes();
  const scheduled = (d?.shifts ?? []).filter((s) => s.status === "scheduled");
  // The shift that matters now: the one under way, else the next one today, else the last one.
  const shift = scheduled.find((s) => timeToMinutes(s.endTime) > nowMin) ?? scheduled.at(-1) ?? null;
  const nudge: ClockNudge = d && (d.clockEnabled || d.openPunch) ? clockNudge({ shift, punches, nowMinutes: nowMin }) : null;
  return {
    day: d,
    loading: day.isLoading,
    enabled: !!d && (d.clockEnabled || !!d.openPunch),
    open: d?.openPunch ?? null,
    onLunchSince: work.onLunchSince,
    workedMinutes: work.workedMinutes,
    shift,
    nudge,
    busy: clockIn.isPending || clockOut.isPending || startLunch.isPending || endLunch.isPending,
    clockIn: () => clockIn.mutate(),
    clockOut: () => clockOut.mutate(),
    startLunch: () => startLunch.mutate(),
    endLunch: () => endLunch.mutate(),
  };
}

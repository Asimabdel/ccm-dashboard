import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import type { Presence, PresenceStatus } from "@shared/chat";

/** Who's in today (time clock, shifts, time off), refreshed every minute. */
export function usePresence(enabled = true): Record<number, Presence> {
  const q = trpc.workspace.chat.presence.useQuery(undefined, { enabled, refetchInterval: 60_000, staleTime: 30_000 });
  return q.data ?? {};
}

const DOT: Record<PresenceStatus, string> = {
  in: "bg-emerald-500",
  scheduled: "bg-amber-400",
  away: "bg-slate-400",
  off: "bg-rose-400",
  none: "bg-slate-300 dark:bg-slate-600",
};

/** A small status dot (with the label as its tooltip and for screen readers). */
export function PresenceDot({ p, className }: { p: Presence | undefined; className?: string }) {
  if (!p) return null;
  return <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white dark:ring-slate-800", DOT[p.status], className)} title={p.label} aria-label={p.label} role="img" />;
}

/** Dot + label ("On the clock", "On time off today"…). */
export function PresenceLabel({ p, className }: { p: Presence | undefined; className?: string }) {
  if (!p) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400", className)}>
      <PresenceDot p={p} className="ring-0" /> {p.label}
    </span>
  );
}

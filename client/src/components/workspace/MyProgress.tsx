import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  BadgeDollarSign, Building2, CalendarCheck, CheckCircle2, Clock, DoorOpen, Gauge, HeartPulse, Inbox, ListTodo, Loader2,
  PhoneCall, PhoneMissed, Receipt, Settings2, Stethoscope, Target, Timer, UserCheck,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDay } from "@shared/workforce";
import {
  GOAL_METRICS, ROLE_GOAL_KEYS, ROLE_METRIC_LABELS, ROLE_PRIMARY, progressOf,
  type DailyGoals, type Metric, type MetricKey,
} from "@shared/metrics";

export const ICON: Record<MetricKey, React.ElementType> = {
  missed: PhoneMissed, calls: PhoneCall, talk: Clock, booked: CalendarCheck, tasks_done: CheckCircle2, tasks_left: ListTodo, hours: Timer,
  care_calls: HeartPulse, ccm_month: Target, checkins: UserCheck, roomed: DoorOpen, seen: Stethoscope, waiting: Inbox,
  ready_to_bill: Receipt, billed_month: BadgeDollarSign, practice_visits: Building2, practice_calls: PhoneCall, practice_ccm: Target,
};

/** Short word after the number in the top bar. */
export const SHORT: Record<MetricKey, string> = {
  missed: "missed", calls: "calls", talk: "on phone", booked: "booked", tasks_done: "tasks done", tasks_left: "tasks left", hours: "on clock",
  care_calls: "care calls", ccm_month: "this month", checkins: "checked in", roomed: "roomed", seen: "seen", waiting: "waiting",
  ready_to_bill: "to bill", billed_month: "billed", practice_visits: "visits", practice_calls: "calls", practice_ccm: "care calls (mo)",
};

const valueText = (m: Metric) => m.display ?? String(m.value);
const withGoal = (m: Metric) => (m.goal ? `${valueText(m)}/${m.goal}` : valueText(m));

/**
 * Top-bar "My progress": the role's three key numbers for today; click for the full list with
 * progress against a goal (or against the person's usual day when no goal is set).
 */
export function MyProgress({ isAdmin }: { isAdmin: boolean }) {
  const q = trpc.workspace.metrics.mine.useQuery(undefined, { refetchInterval: 60_000, refetchOnWindowFocus: true, retry: false });
  const [open, setOpen] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [, setLocation] = useLocation();
  const data = q.data;
  if (!data || !data.metrics.length) return null;
  const primaryKeys = ROLE_PRIMARY[data.role] ?? [];
  const primary = data.metrics.filter((m) => primaryKeys.includes(m.key)).slice(0, 3);
  const top = primary[0] ?? data.metrics[0]!;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" aria-label="My progress today"
            className="flex items-center gap-1 h-9 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 text-sm hover:border-slate-300 dark:hover:border-slate-500 transition-colors">
            {/* Phones / small screens: one number */}
            <span className="flex xl:hidden items-center gap-1.5 px-0.5">
              <Gauge size={16} className="text-brand" />
              <b className="tabular-nums text-slate-900 dark:text-slate-50">{withGoal(top)}</b>
              <span className="hidden sm:inline text-xs text-slate-500">{SHORT[top.key]}</span>
            </span>
            {/* Wide screens: the role's three numbers */}
            <span className="hidden xl:flex items-center divide-x divide-slate-200 dark:divide-slate-700">
              {primary.map((m) => {
                const Icon = ICON[m.key];
                const p = progressOf(m);
                return (
                  <span key={m.key} className="relative flex items-center gap-1.5 px-2.5 first:pl-1 last:pr-1" title={m.label}>
                    <Icon size={14} className="text-slate-400" />
                    <b className="tabular-nums text-slate-900 dark:text-slate-50">{withGoal(m)}</b>
                    <span className="text-xs text-slate-500 whitespace-nowrap">{SHORT[m.key]}</span>
                    {p != null && <span className="absolute left-2.5 right-2.5 -bottom-[7px] h-[3px] rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
                      <span className={cn("block h-full rounded-full", p >= 1 ? "bg-emerald-500" : "bg-brand")} style={{ width: `${Math.round(p * 100)}%` }} />
                    </span>}
                  </span>
                );
              })}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[22rem] p-0">
          <div className="flex items-baseline justify-between px-4 pt-3.5 pb-2">
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">My progress today</p>
            <span className="text-xs text-slate-500">{fmtDay(data.date)}</span>
          </div>
          <ul className="max-h-[70vh] overflow-y-auto pb-1">
            {data.metrics.map((m) => <MetricRow key={m.key} m={m} onGo={m.href ? () => { setOpen(false); setLocation(m.href!); } : undefined} />)}
          </ul>
          <div className="flex items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-700 px-4 py-2.5">
            <span className="text-[11px] text-slate-400">Updates every minute. Calls from RingCentral can take ~10 minutes to show.</span>
            {isAdmin && <Btn size="sm" variant="ghost" onClick={() => { setOpen(false); setGoalsOpen(true); }}><Settings2 size={13} /> Goals</Btn>}
          </div>
        </PopoverContent>
      </Popover>
      {goalsOpen && <GoalsDialog onClose={() => setGoalsOpen(false)} />}
    </>
  );
}

export function MetricRow({ m, onGo }: { m: Metric; onGo?: () => void }) {
  const Icon = ICON[m.key];
  const p = progressOf(m);
  const compare = m.goal ? `Goal ${m.goal}${m.goalLabel ? ` (${m.goalLabel})` : ""}` : m.usual ? `Your usual day: ${m.usual}` : null;
  const Row = onGo ? "button" : "div";
  return (
    <li>
      <Row type={onGo ? "button" : undefined} onClick={onGo} className={cn("w-full text-left flex gap-3 px-4 py-2.5", onGo && "hover:bg-slate-50 dark:hover:bg-slate-800")}>
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"><Icon size={14} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-sm text-slate-700 dark:text-slate-200">{m.label}</span>
            <b className="tabular-nums text-slate-900 dark:text-slate-50">{valueText(m)}</b>
          </span>
          {p != null && (
            <span className="mt-1.5 block h-1.5 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
              <span className={cn("block h-full rounded-full", p >= 1 ? "bg-emerald-500" : "bg-brand")} style={{ width: `${Math.round(p * 100)}%` }} />
            </span>
          )}
          {(compare || m.hint) && <span className="mt-1 block text-[11px] text-slate-500">{[compare, m.hint].filter(Boolean).join(" · ")}</span>}
        </span>
      </Row>
    </li>
  );
}

function GoalsDialog({ onClose }: { onClose: () => void }) {
  const q = trpc.workspace.metrics.goals.useQuery();
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<DailyGoals | null>(null);
  const goals = draft ?? q.data ?? {};
  const save = trpc.workspace.metrics.setGoals.useMutation({
    onSuccess: () => { void utils.workspace.metrics.invalidate(); toast.success("Daily goals saved"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const set = (role: string, key: MetricKey, v: string) => {
    const n = v === "" ? undefined : Math.max(0, Math.min(1000, Math.round(Number(v))));
    setDraft({ ...goals, [role]: { ...(goals[role] ?? {}), [key]: n } });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Daily goals</DialogTitle>
          <DialogDescription>Each person's bar fills toward these. Leave blank to compare with their own usual day instead. Monthly care-call goals per coordinator stay on the Coordinators page.</DialogDescription>
        </DialogHeader>
        {q.isLoading ? <Loader2 size={16} className="animate-spin text-slate-400" /> : (
          <div className="max-h-[60vh] overflow-y-auto space-y-4">
            {Object.entries(ROLE_GOAL_KEYS).map(([role, keys]) => (
              <div key={role}>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1.5">{ROLE_METRIC_LABELS[role] ?? role}</p>
                <div className="grid grid-cols-2 gap-2">
                  {keys.map((k) => (
                    <label key={k} className="text-xs text-slate-600 dark:text-slate-300">{GOAL_METRICS[k]}
                      <input type="number" min={0} max={1000} className={cn(inputCls, "mt-1")} placeholder="No goal"
                        value={goals[role]?.[k] ?? ""} onChange={(e) => set(role, k, e.target.value)} />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn disabled={save.isPending || !q.data} onClick={() => save.mutate(JSON.parse(JSON.stringify(goals)) as Record<string, Record<string, number>>)}>
            {save.isPending && <Loader2 size={14} className="animate-spin" />} Save goals
          </Btn>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import type React from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { Loader2, CheckCircle2, ListTodo, TrendingUp, Target, Phone, Save, Users, PhoneMissed, Clock } from "lucide-react";
import { STATUS_LABELS, statusBadgeClass, currentMonthStr, fmtDate } from "@/lib/ccm";

type Tone = "default" | "good" | "warn" | "accent";
function StatCard({ icon: Icon, label, value, sub, tone = "default" }: {
  icon: React.ElementType; label: string; value: React.ReactNode; sub?: string; tone?: Tone;
}) {
  const iconBg = {
    default: "bg-slate-100 text-slate-600",
    good: "bg-emerald-100 text-emerald-600",
    warn: "bg-amber-100 text-amber-600",
    accent: "bg-orange-100 text-orange-700",
  }[tone];
  return (
    <div className="bg-white rounded-3xl p-5 border border-slate-100 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-400">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900 font-mono tabular-nums">{value}</p>
          {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
        </div>
        <span className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${iconBg}`}><Icon size={18} /></span>
      </div>
    </div>
  );
}

type QueueItem = { taskId: number; patientId: number; name: string; status: string; lastCalledAt: string | Date | null };
type Dash = {
  staffName?: string; assigned?: number; completed?: number; remaining?: number;
  avgPerDay?: number; completedToday?: number; daysElapsed?: number; daysInMonth?: number;
  daysRemaining?: number; goal?: number; neededPerDay?: number; projectedEom?: number;
  workDaysPerWeek?: number; workDaysElapsed?: number; workDaysRemaining?: number;
  statusCounts?: Record<string, number>;
  callbackCount?: number; overdueCount?: number;
  callbackQueue?: QueueItem[]; overdueQueue?: QueueItem[];
};

function QueueCard({ title, icon: Icon, items, total, emptyText }: {
  title: string; icon: React.ElementType; items: QueueItem[]; total: number; emptyText: string;
}) {
  const [, setLocation] = useLocation();
  return (
    <div className="bg-white rounded-3xl p-5 border border-slate-100 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2"><Icon size={16} className="text-amber-500" /><h3 className="font-bold text-slate-800">{title}</h3></div>
        <span className="text-sm font-semibold text-slate-500">{total}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400 py-5 text-center">{emptyText}</p>
      ) : (
        <div className="divide-y divide-slate-50">
          {items.map((it) => (
            <button key={it.taskId} onClick={() => setLocation(`/workflow/${it.taskId}`)}
              className="w-full flex items-center justify-between gap-3 py-2.5 px-2 -mx-2 text-left rounded-lg hover:bg-slate-50/70 transition">
              <div className="min-w-0">
                <p className="font-medium text-slate-800 truncate">{it.name}</p>
                <p className="text-xs text-slate-400 truncate">{STATUS_LABELS[it.status] ?? it.status} · {it.lastCalledAt ? `last called ${fmtDate(it.lastCalledAt)}` : "never called"}</p>
              </div>
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-[hsl(17_68%_47%)] shrink-0"><Phone size={12} /> Call</span>
            </button>
          ))}
          {total > items.length && <p className="pt-2 text-xs text-slate-400 text-center">+{total - items.length} more — see your worklist</p>}
        </div>
      )}
    </div>
  );
}

function DashboardView({ d, month }: { d: Dash; month: string }) {
  const completed = d.completed ?? 0;
  const goal = d.goal ?? 0;
  const pct = goal > 0 ? Math.min(100, Math.round((completed / goal) * 100)) : 0;
  const onPace = (d.projectedEom ?? 0) >= goal;
  return (
    <div className="space-y-5">
      <div className="bg-white rounded-3xl p-6 border border-slate-100 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-slate-700"><Target size={18} className="text-[hsl(17_66%_52%)]" /><h3 className="font-bold">Monthly goal</h3></div>
          <span className="text-sm text-slate-500">{month}{d.workDaysPerWeek ? ` · ${d.workDaysPerWeek} days/wk` : ""}</span>
        </div>
        {goal > 0 ? (
          <>
            <div className="flex items-end justify-between mb-2 gap-3 flex-wrap">
              <p className="text-3xl font-bold text-slate-900 font-mono tabular-nums">{completed} <span className="text-lg font-medium text-slate-400">/ {goal}</span></p>
              <p className={`text-sm font-semibold ${onPace ? "text-emerald-600" : "text-amber-600"}`}>{pct}% — {onPace ? "on pace" : "behind pace"}</p>
            </div>
            <div className="h-3 w-full rounded-full bg-slate-100 overflow-hidden">
              <div className={`h-full rounded-full transition-all ${onPace ? "bg-emerald-500" : "bg-amber-500"}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-500">
              <span><b className="text-slate-700">{Math.max(0, goal - completed)}</b> to go</span>
              {goal > completed ? (
                <span>Need ~<b className="text-slate-700">{d.neededPerDay}/work day</b>{(d.workDaysRemaining ?? 0) > 0 ? ` for the remaining ${d.workDaysRemaining} work day(s)` : ""}</span>
              ) : (
                <span className="text-emerald-600 font-medium">Goal reached 🎉</span>
              )}
              <span>Projected month-end: <b className="text-slate-700">{d.projectedEom ?? 0}</b></span>
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-400">No goal set for {month} yet. An admin can set it below.</p>
        )}
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={CheckCircle2} tone="good" label="Completed this month" value={completed} sub={`${d.completedToday ?? 0} today`} />
        <StatCard icon={ListTodo} tone="warn" label="Remaining" value={d.remaining ?? 0} sub={`of ${d.assigned ?? 0} assigned`} />
        <StatCard icon={TrendingUp} tone="accent" label="Avg / work day" value={d.avgPerDay ?? 0} sub={`over ${d.workDaysElapsed ?? 0} work day(s) so far`} />
        <StatCard icon={Phone} label="My patients" value={d.assigned ?? 0} sub={`${d.workDaysRemaining ?? 0} work day(s) left this month`} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <QueueCard title="Needs a call-back" icon={PhoneMissed} items={d.callbackQueue || []} total={d.callbackCount ?? 0} emptyText="No call-backs pending — nice work." />
        <QueueCard title="Overdue / not started" icon={Clock} items={d.overdueQueue || []} total={d.overdueCount ?? 0} emptyText="All caught up on outreach." />
      </div>

      {d.statusCounts && Object.keys(d.statusCounts).length > 0 && (
        <div className="bg-white rounded-3xl p-6 border border-slate-100 shadow-sm">
          <h3 className="font-bold text-slate-700 mb-3">My list breakdown</h3>
          <div className="flex flex-wrap gap-2">
            {Object.entries(d.statusCounts).sort((a, b) => b[1] - a[1]).map(([s, n]) => (
              <span key={s} className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${statusBadgeClass(s)}`}>{STATUS_LABELS[s] ?? s}: {n}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function CoordinatorDashboard() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const isAdmin = user?.role === "admin";
  const month = currentMonthStr();
  const utils = trpc.useUtils();

  const [selectedStaff, setSelectedStaff] = useState<number>(0);
  const [goalInputs, setGoalInputs] = useState<Record<number, string>>({});
  const [workInputs, setWorkInputs] = useState<Record<number, string>>({});

  const staffList = trpc.staff.all.useQuery(undefined, { enabled: !!user && isAdmin });
  const dash = trpc.coordinator.dashboard.useQuery(
    isAdmin ? { staffId: selectedStaff || undefined, month } : { month },
    { enabled: !!user && (!isAdmin || selectedStaff > 0) },
  );
  const goalsOverview = trpc.coordinator.goalsOverview.useQuery({ month }, { enabled: !!user && isAdmin });
  const setGoal = trpc.coordinator.setGoal.useMutation({
    onSuccess: () => { utils.coordinator.goalsOverview.invalidate(); utils.coordinator.dashboard.invalidate(); toast.success("Saved."); },
    onError: (e) => toast.error(e.message),
  });
  const setWorkDays = trpc.coordinator.setWorkDays.useMutation({
    onSuccess: () => { utils.coordinator.goalsOverview.invalidate(); utils.coordinator.dashboard.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const valFor = (r: { userId: number; goal: number }) => goalInputs[r.userId] ?? String(r.goal);
  const workValFor = (r: { userId: number; workDaysPerWeek: number }) => workInputs[r.userId] ?? String(r.workDaysPerWeek);
  const saveRow = (r: { userId: number; goal: number; workDaysPerWeek: number }) => {
    setGoal.mutate({ userId: r.userId, month, goal: Math.max(0, parseInt(valFor(r), 10) || 0) });
    const wd = Math.min(7, Math.max(1, parseInt(workValFor(r), 10) || 5));
    if (wd !== r.workDaysPerWeek) setWorkDays.mutate({ userId: r.userId, workDaysPerWeek: wd });
  };

  // --- Staff: just their own dashboard ---
  if (!isAdmin) {
    return (
      <CCMDashboardLayout title="My Dashboard">
        {dash.isLoading ? (
          <div className="py-16 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>
        ) : (
          <DashboardView d={(dash.data as Dash) || {}} month={month} />
        )}
      </CCMDashboardLayout>
    );
  }

  // --- Admin: goal management + view any coordinator ---
  const rows = goalsOverview.data || [];
  return (
    <CCMDashboardLayout title="Coordinator Dashboards">
      {/* Monthly goals management */}
      <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden mb-6">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
          <Target size={16} className="text-[hsl(17_66%_52%)]" />
          <h3 className="font-bold text-slate-800">Set monthly goals — {month}</h3>
        </div>
        {goalsOverview.isLoading ? (
          <div className="py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>
        ) : rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-slate-400 text-sm">No care coordinators yet. Add staff on the Team &amp; Access page.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-slate-100 bg-slate-50/50">
                <th className="px-5 py-3 font-medium">Coordinator</th>
                <th className="px-5 py-3 font-medium">Completed</th>
                <th className="px-5 py-3 font-medium">Assigned</th>
                <th className="px-5 py-3 font-medium">Days/wk</th>
                <th className="px-5 py-3 font-medium">Goal</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                  <td className="px-5 py-3 font-semibold text-slate-800">{r.name}</td>
                  <td className="px-5 py-3 text-emerald-700 font-semibold">{r.completed}</td>
                  <td className="px-5 py-3 text-slate-500">{r.assigned}</td>
                  <td className="px-5 py-3">
                    <input
                      type="number" min={1} max={7}
                      className="w-16 px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)]"
                      value={workValFor(r)}
                      onChange={(e) => setWorkInputs((w) => ({ ...w, [r.userId]: e.target.value }))}
                    />
                  </td>
                  <td className="px-5 py-3">
                    <input
                      type="number" min={0}
                      className="w-24 px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)]"
                      value={valFor(r)}
                      onChange={(e) => setGoalInputs((g) => ({ ...g, [r.userId]: e.target.value }))}
                    />
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        onClick={() => saveRow(r)}
                        disabled={setGoal.isPending || setWorkDays.isPending}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50"
                      >
                        <Save size={13} /> Save
                      </button>
                      <button
                        onClick={() => setSelectedStaff(r.userId)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50"
                      >
                        View
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* View a coordinator's dashboard */}
      <div className="flex items-center gap-2 mb-4">
        <Users size={16} className="text-slate-400" />
        <span className="text-sm text-slate-500">View a coordinator:</span>
        <select
          className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)]"
          value={selectedStaff}
          onChange={(e) => setSelectedStaff(Number(e.target.value))}
        >
          <option value={0}>Select…</option>
          {(staffList.data || []).filter((s) => s.role === "staff").map((s) => (
            <option key={s.id} value={s.id}>{s.name || s.email}</option>
          ))}
        </select>
      </div>

      {selectedStaff > 0 ? (
        dash.isLoading ? (
          <div className="py-16 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>
        ) : (
          <>
            <h2 className="text-lg font-bold text-slate-900 mb-3">{(dash.data as Dash)?.staffName}</h2>
            <DashboardView d={(dash.data as Dash) || {}} month={month} />
          </>
        )
      ) : (
        <div className="bg-white rounded-3xl border border-dashed border-slate-200 p-10 text-center text-slate-400 text-sm">
          Pick a coordinator above to see their full dashboard.
        </div>
      )}
    </CCMDashboardLayout>
  );
}

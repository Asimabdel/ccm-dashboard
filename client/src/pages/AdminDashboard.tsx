import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  Users, ClipboardCheck, PhoneOff, AlertTriangle, TrendingUp, Database, Loader2,
  ArrowUpRight, ArrowDownRight, Receipt, ArrowRight, CheckCircle2, ClipboardList,
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  PieChart, Pie, Cell, BarChart, Bar, Legend, Label,
} from "recharts";
import { STATUS_LABELS, currentMonthStr } from "@/lib/ccm";
import { cn } from "@/lib/utils";

/** Previous YYYY-MM relative to a YYYY-MM string. */
function prevMonthStr(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 2, 1); // m is 1-based, m-2 → previous month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

type Delta = { diff: number; good: boolean };
/** Build a delta vs the previous period. `goodWhenUp` flips the colour semantics. */
function makeDelta(curr?: number, prev?: number, goodWhenUp = true): Delta | undefined {
  if (curr == null || prev == null) return undefined;
  const diff = curr - prev;
  if (diff === 0) return undefined;
  return { diff, good: goodWhenUp ? diff > 0 : diff < 0 };
}

const ACCENT = "hsl(200 100% 50%)";
const PIE_COLORS = ["#34d399", "#60a5fa", "#fbbf24", "#fb7185", "#a78bfa", "#94a3b8", "#f472b6", "#22d3ee"];

function StatCard({ icon: Icon, label, value, sub, tone = "default", index = 0, delta }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string;
  tone?: "default" | "good" | "warn" | "bad"; index?: number; delta?: Delta;
}) {
  const iconBg = {
    default: "bg-slate-100 text-slate-600",
    good: "bg-emerald-100 text-emerald-600",
    warn: "bg-amber-100 text-amber-600",
    bad: "bg-rose-100 text-rose-600",
  }[tone];
  return (
    <div
      className="group bg-white rounded-3xl p-5 border border-slate-100 shadow-soft hover:shadow-soft-lg hover:-translate-y-0.5 transition-all duration-300 animate-fade-in-up"
      style={{ animationDelay: `${index * 45}ms` }}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-xs font-light uppercase tracking-wider text-slate-400">{label}</p>
          <div className="mt-2 flex items-center gap-2">
            <p className="text-3xl font-extrabold tracking-tight text-slate-900">{value}</p>
            {delta && (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 text-xs font-semibold rounded-full px-1.5 py-0.5",
                  delta.good ? "text-emerald-600 bg-emerald-50" : "text-rose-600 bg-rose-50"
                )}
                title="vs last month"
              >
                {delta.diff > 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                {Math.abs(delta.diff)}
              </span>
            )}
          </div>
          {sub && <p className="mt-1 text-xs font-light text-slate-400 truncate">{sub}</p>}
        </div>
        <div className={`w-10 h-10 rounded-2xl flex items-center justify-center transition-transform duration-300 group-hover:scale-110 shrink-0 ${iconBg}`}>
          <Icon size={18} />
        </div>
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const { user, loading: authLoading } = useAuth({ redirectOnUnauthenticated: true });
  const [, setLocation] = useLocation();
  const [month] = useState(currentMonthStr());
  const utils = trpc.useUtils();

  const isAdmin = !!user && user.role === "admin";
  const seedStatus = trpc.admin.seedStatus.useQuery(undefined, { enabled: !!user });
  const stats = trpc.admin.stats.useQuery({ month }, { enabled: isAdmin });
  const prevStats = trpc.admin.stats.useQuery({ month: prevMonthStr(month) }, { enabled: isAdmin });
  const staffPerf = trpc.admin.staffPerformance.useQuery({ month }, { enabled: isAdmin });
  const clinicPerf = trpc.admin.clinicPerformance.useQuery({ month }, { enabled: isAdmin });
  const trend = trpc.admin.dailyTrend.useQuery({ month }, { enabled: isAdmin });

  const seed = trpc.admin.seed.useMutation({
    onSuccess: async (s: any) => {
      toast.success(`Seeded ${s.patients} patients, ${s.tasks} tasks, ${s.notes} notes.`);
      await utils.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <Loader2 className="animate-spin text-slate-400" />
      </div>
    );
  }

  const s = stats.data;
  const ps = prevStats.data;
  const totalTasks = s?.totalTasks ?? 0;

  type AttentionItem = {
    icon: React.ElementType; label: string; count: number; sub: string;
    tone: "default" | "good" | "warn" | "bad"; path: string;
  };
  const attention: AttentionItem[] = s
    ? ([
        s.pendingEscalations > 0 && { icon: AlertTriangle, label: "Pending escalations", count: s.pendingEscalations, sub: "Awaiting provider review", tone: "bad", path: "/escalations" },
        s.needsReview > 0 && { icon: AlertTriangle, label: "Needs provider review", count: s.needsReview, sub: "Flagged during CCM calls", tone: "warn", path: "/escalations" },
        s.notReached > 0 && { icon: PhoneOff, label: "Patients not reached", count: s.notReached, sub: "No answer / voicemail", tone: "warn", path: "/worklist" },
        s.notStarted > 0 && { icon: ClipboardList, label: "Not started", count: s.notStarted, sub: "Awaiting first contact", tone: "default", path: "/worklist" },
        s.readyForBilling > 0 && { icon: Receipt, label: "Ready to bill", count: s.readyForBilling, sub: "Documentation complete", tone: "good", path: "/billing" },
      ].filter(Boolean) as AttentionItem[])
    : [];

  const statusData = s
    ? Object.entries(s.statusDistribution).map(([k, v]) => ({ name: STATUS_LABELS[k] || k, value: v as number }))
    : [];
  const staffData = (staffPerf.data || []).map((p) => ({
    name: (p.staffName || "Unassigned").split(" ")[0],
    Completed: p.completed,
    Remaining: Math.max(p.assigned - p.completed, 0),
  }));
  const trendData = (trend.data || []).map((d) => ({ date: d.date.slice(5), Completed: d.count }));

  return (
    <CCMDashboardLayout title="Program Overview">
      {seedStatus.data && !seedStatus.data.seeded && (
        <div className="mb-6 rounded-3xl border border-blue-100 bg-blue-50/60 p-5 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Database className="text-blue-500" size={20} />
            <div>
              <p className="font-semibold text-slate-800">No data yet</p>
              <p className="text-sm font-light text-slate-500">Load realistic demo data to explore the full system.</p>
            </div>
          </div>
          <button
            onClick={() => seed.mutate()}
            disabled={seed.isPending}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-60"
          >
            {seed.isPending ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />}
            Load demo data
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard index={0} icon={Users} label="Active Patients" value={s?.totalActivePatients ?? "—"} sub={`${totalTasks} tasks this month`} delta={makeDelta(s?.totalActivePatients, ps?.totalActivePatients, true)} />
        <StatCard index={1} icon={ClipboardCheck} label="Completed" value={s?.completed ?? "—"} sub={`${s?.completionPct ?? 0}% completion`} tone="good" delta={makeDelta(s?.completed, ps?.completed, true)} />
        <StatCard index={2} icon={PhoneOff} label="Not Reached" value={s?.notReached ?? "—"} sub="Called No Answer / Voicemail" tone="warn" delta={makeDelta(s?.notReached, ps?.notReached, false)} />
        <StatCard index={3} icon={AlertTriangle} label="Pending Escalations" value={s?.pendingEscalations ?? "—"} sub="Awaiting provider review" tone="bad" delta={makeDelta(s?.pendingEscalations, ps?.pendingEscalations, false)} />
        <StatCard index={4} icon={ClipboardCheck} label="Not Started" value={s?.notStarted ?? "—"} sub="Awaiting first contact" delta={makeDelta(s?.notStarted, ps?.notStarted, false)} />
        <StatCard index={5} icon={TrendingUp} label="In Progress" value={s?.inProgress ?? "—"} sub="Currently being worked" delta={makeDelta(s?.inProgress, ps?.inProgress, true)} />
        <StatCard index={6} icon={AlertTriangle} label="Needs Review" value={s?.needsReview ?? "—"} sub="Flagged for provider" tone="warn" delta={makeDelta(s?.needsReview, ps?.needsReview, false)} />
      </div>

      <div className="mt-6 bg-white rounded-3xl p-6 border border-slate-100 shadow-soft">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-slate-900 tracking-tight">Needs attention</h3>
          {(s?.pendingEscalations ?? 0) > 0 && (
            <span className="text-xs font-semibold text-rose-600 bg-rose-50 rounded-full px-2.5 py-1">{s?.pendingEscalations} urgent</span>
          )}
        </div>
        {attention.length === 0 ? (
          <div className="flex items-center gap-3 py-8 justify-center text-slate-400">
            <CheckCircle2 size={20} className="text-emerald-500" />
            <span className="text-sm font-light">All clear — nothing needs attention right now.</span>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {attention.map((a, i) => {
              const toneClasses = {
                default: "bg-slate-100 text-slate-600",
                good: "bg-emerald-100 text-emerald-600",
                warn: "bg-amber-100 text-amber-600",
                bad: "bg-rose-100 text-rose-600",
              }[a.tone];
              return (
                <button
                  key={i}
                  onClick={() => setLocation(a.path)}
                  className="group flex items-center gap-3 rounded-2xl border border-slate-100 p-3 text-left hover:bg-slate-50 hover:border-slate-200 transition-all"
                >
                  <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0", toneClasses)}>
                    <a.icon size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold text-slate-900">{a.count}</span>
                      <span className="text-sm font-medium text-slate-700 truncate">{a.label}</span>
                    </div>
                    <p className="text-xs font-light text-slate-400 truncate">{a.sub}</p>
                  </div>
                  <ArrowRight size={16} className="text-slate-300 group-hover:text-slate-500 group-hover:translate-x-0.5 transition-all shrink-0" />
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-6 bg-white rounded-3xl p-6 border border-slate-100">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-slate-900 tracking-tight">Monthly Completion</h3>
          <span className="text-sm font-light text-slate-400">{s?.completed ?? 0} of {s?.totalTasks ?? 0}</span>
        </div>
        <div className="h-3 rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${s?.completionPct ?? 0}%`, background: `linear-gradient(90deg, hsl(200 100% 60%), hsl(345 80% 70%))` }}
          />
        </div>
        <p className="mt-2 text-sm font-light text-slate-500">{s?.completionPct ?? 0}% of this month's CCM outreach is complete.</p>
      </div>

      <div className="mt-6 grid lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-3xl p-6 border border-slate-100">
          <h3 className="font-bold text-slate-900 tracking-tight mb-4">Daily Completion Trend</h3>
          {trendData.length === 0 ? (
            <p className="text-sm font-light text-slate-400 py-12 text-center">No completions recorded yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ACCENT} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="#94a3b8" fontSize={12} allowDecimals={false} tickLine={false} axisLine={false} width={28} />
                <RTooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.06)" }} />
                <Area type="monotone" dataKey="Completed" stroke={ACCENT} strokeWidth={2.5} fill="url(#trendFill)" dot={{ r: 3, strokeWidth: 0, fill: ACCENT }} activeDot={{ r: 5 }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-white rounded-3xl p-6 border border-slate-100">
          <h3 className="font-bold text-slate-900 tracking-tight mb-4">Status Distribution</h3>
          {statusData.length === 0 ? (
            <p className="text-sm font-light text-slate-400 py-12 text-center">No tasks yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} innerRadius={55} paddingAngle={2}>
                  {statusData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  <Label
                    position="center"
                    content={({ viewBox }) => {
                      const vb = viewBox as { cx: number; cy: number };
                      return (
                        <text x={vb.cx} y={vb.cy} textAnchor="middle">
                          <tspan x={vb.cx} dy="-0.1em" fontSize="26" fontWeight="800" fill="#0f172a">{totalTasks}</tspan>
                          <tspan x={vb.cx} dy="1.5em" fontSize="11" fill="#94a3b8">tasks</tspan>
                        </text>
                      );
                    }}
                  />
                </Pie>
                <RTooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.06)" }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="mt-6 bg-white rounded-3xl p-6 border border-slate-100">
        <h3 className="font-bold text-slate-900 tracking-tight mb-4">Staff Performance</h3>
        {staffData.length === 0 ? (
          <p className="text-sm font-light text-slate-400 py-12 text-center">No staff assignments yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={staffData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="name" stroke="#94a3b8" fontSize={12} />
              <YAxis stroke="#94a3b8" fontSize={12} allowDecimals={false} />
              <RTooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Completed" stackId="a" fill="#34d399" />
              <Bar dataKey="Remaining" stackId="a" fill="#fbbf24" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-6 bg-white rounded-3xl p-6 border border-slate-100">
        <h3 className="font-bold text-slate-900 tracking-tight mb-4">Clinic Performance</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-slate-100">
                <th className="pb-3 font-medium">Clinic</th>
                <th className="pb-3 font-medium">Location</th>
                <th className="pb-3 font-medium">Total</th>
                <th className="pb-3 font-medium">Completed</th>
                <th className="pb-3 font-medium w-48">Progress</th>
              </tr>
            </thead>
            <tbody>
              {(clinicPerf.data || []).map((c) => {
                const pct = c.total ? Math.round((c.completed / c.total) * 100) : 0;
                return (
                  <tr key={c.clinicId} className="border-b border-slate-50 last:border-0">
                    <td className="py-3 font-medium text-slate-800">{c.clinicName}</td>
                    <td className="py-3 text-slate-500">{c.location}</td>
                    <td className="py-3 text-slate-500">{c.total}</td>
                    <td className="py-3 text-slate-500">{c.completed}</td>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                          <div className="h-full bg-[hsl(200_100%_50%)] rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs text-slate-400 w-9 text-right">{pct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {(clinicPerf.data || []).length === 0 && (
                <tr><td colSpan={5} className="py-10 text-center text-slate-400 font-light">No clinic data yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-6 grid sm:grid-cols-3 gap-4">
        {[
          { label: "Monthly Worklist", path: "/worklist" },
          { label: "Staff Assignment", path: "/assignment" },
          { label: "Reports", path: "/reports" },
        ].map((a) => (
          <button
            key={a.path}
            onClick={() => setLocation(a.path)}
            className="group bg-white rounded-2xl p-5 border border-slate-100 shadow-soft text-left hover:shadow-soft-lg hover:-translate-y-0.5 transition-all duration-300 font-semibold text-slate-800"
          >
            <span className="inline-flex items-center gap-1.5">{a.label} <span className="transition-transform duration-300 group-hover:translate-x-1">→</span></span>
          </button>
        ))}
      </div>
    </CCMDashboardLayout>
  );
}

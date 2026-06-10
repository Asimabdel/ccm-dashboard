import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  Users, ClipboardCheck, PhoneOff, AlertTriangle, Receipt, TrendingUp, Database, Loader2,
} from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  PieChart, Pie, Cell, BarChart, Bar, Legend,
} from "recharts";
import { STATUS_LABELS, currentMonthStr } from "@/lib/ccm";

const ACCENT = "hsl(200 100% 50%)";
const PIE_COLORS = ["#34d399", "#60a5fa", "#fbbf24", "#fb7185", "#a78bfa", "#94a3b8", "#f472b6", "#22d3ee"];

function StatCard({ icon: Icon, label, value, sub, tone = "default" }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const iconBg = {
    default: "bg-slate-100 text-slate-600",
    good: "bg-emerald-100 text-emerald-600",
    warn: "bg-amber-100 text-amber-600",
    bad: "bg-rose-100 text-rose-600",
  }[tone];
  return (
    <div className="bg-white rounded-3xl p-5 border border-slate-100">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-light uppercase tracking-wider text-slate-400">{label}</p>
          <p className="mt-2 text-3xl font-extrabold tracking-tight text-slate-900">{value}</p>
          {sub && <p className="mt-1 text-xs font-light text-slate-400">{sub}</p>}
        </div>
        <div className={`w-10 h-10 rounded-2xl flex items-center justify-center ${iconBg}`}>
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
      <div className="min-h-screen flex items-center justify-center bg-[hsl(240_10%_97%)]">
        <Loader2 className="animate-spin text-slate-400" />
      </div>
    );
  }

  const s = stats.data;
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
        <StatCard icon={Users} label="Active Patients" value={s?.totalActivePatients ?? "-"} sub={`${s?.totalTasks ?? 0} tasks this month`} />
        <StatCard icon={ClipboardCheck} label="Completed" value={s?.completed ?? "-"} sub={`${s?.completionPct ?? 0}% completion`} tone="good" />
        <StatCard icon={PhoneOff} label="Not Reached" value={s?.notReached ?? "-"} sub="Called No Answer / Voicemail" tone="warn" />
        <StatCard icon={AlertTriangle} label="Pending Escalations" value={s?.pendingEscalations ?? "-"} sub="Awaiting provider review" tone="bad" />
        <StatCard icon={Receipt} label="Ready for Billing" value={s?.readyForBilling ?? "-"} sub="Meets CMS criteria" tone="good" />
        <StatCard icon={TrendingUp} label="In Progress" value={s?.inProgress ?? "-"} sub="Currently being worked" />
        <StatCard icon={AlertTriangle} label="Needs Review" value={s?.needsReview ?? "-"} sub="Flagged for provider" tone="warn" />
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
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} />
                <YAxis stroke="#94a3b8" fontSize={12} allowDecimals={false} />
                <RTooltip />
                <Line type="monotone" dataKey="Completed" stroke={ACCENT} strokeWidth={2.5} dot={{ r: 3 }} />
              </LineChart>
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
                <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} innerRadius={50} paddingAngle={2}>
                  {statusData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <RTooltip />
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
            className="bg-white rounded-2xl p-5 border border-slate-100 text-left hover:border-slate-300 transition-colors font-semibold text-slate-800"
          >
            {a.label} {"->"}
          </button>
        ))}
      </div>
    </CCMDashboardLayout>
  );
}

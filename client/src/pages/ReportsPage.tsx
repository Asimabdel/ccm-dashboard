import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from "recharts";
import { STATUS_LABELS, currentMonthStr } from "@/lib/ccm";

const ACCENT = "hsl(200 80% 62%)";
const PINK = "hsl(345 80% 80%)";

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white rounded-3xl border border-slate-100 p-5">
      <p className="text-xs uppercase tracking-wider text-slate-400">{label}</p>
      <p className="text-3xl font-bold text-slate-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

export default function ReportsPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [month, setMonth] = useState(currentMonthStr());

  const input = useMemo(() => ({ month }), [month]);
  const report = trpc.reports.summary.useQuery(input, { enabled: !!user });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-[hsl(240_10%_97%)]"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const data = report.data;
  const stats = data?.stats;
  const staffData = (data?.staffPerformance || []).map((s) => ({
    name: s.staffName, completed: s.completed, assigned: s.assigned,
    pct: s.assigned ? Math.round((s.completed / s.assigned) * 100) : 0,
  }));
  const trendData = (data?.dailyTrend || []) as { day?: string; date?: string; count: number }[];
  const trend = trendData.map((t: any) => ({ day: (t.day || t.date || "").slice(5), count: t.count }));

  return (
    <CCMDashboardLayout title="Reports & Analytics">
      <div className="flex items-center gap-2 mb-6">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value || currentMonthStr())}
          className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]" />
      </div>

      {report.isLoading && <div className="py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>}

      {stats && (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <Stat label="Active Patients" value={stats.totalActivePatients} />
            <Stat label="Completion Rate" value={`${stats.completionPct}%`} sub={`${stats.completed} of ${stats.totalTasks} tasks`} />
            <Stat label="Not Reached" value={stats.notReached} />
            <Stat label="Pending Escalations" value={stats.pendingEscalations} />
          </div>

          <div className="grid lg:grid-cols-2 gap-5 mb-6">
            <div className="bg-white rounded-3xl border border-slate-100 p-6">
              <h3 className="font-semibold text-slate-900 mb-4">Daily Completion Trend</h3>
              {trend.length === 0 ? <p className="text-sm text-slate-400 py-12 text-center">No completions recorded.</p> : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                    <XAxis dataKey="day" tick={{ fontSize: 12, fill: "#94a3b8" }} />
                    <YAxis tick={{ fontSize: 12, fill: "#94a3b8" }} allowDecimals={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" stroke={ACCENT} strokeWidth={2.5} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="bg-white rounded-3xl border border-slate-100 p-6">
              <h3 className="font-semibold text-slate-900 mb-4">Staff Completion %</h3>
              {staffData.length === 0 ? <p className="text-sm text-slate-400 py-12 text-center">No staff activity.</p> : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={staffData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                    <YAxis tick={{ fontSize: 12, fill: "#94a3b8" }} domain={[0, 100]} />
                    <Tooltip />
                    <Bar dataKey="pct" radius={[6, 6, 0, 0]}>
                      {staffData.map((_, i) => <Cell key={i} fill={i % 2 === 0 ? ACCENT : PINK} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-100 p-6 mb-6">
            <h3 className="font-semibold text-slate-900 mb-4">Clinic Performance</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-500 text-xs uppercase tracking-wider border-b border-slate-100">
                    <th className="text-left font-medium py-2">Clinic</th>
                    <th className="text-left font-medium py-2">Location</th>
                    <th className="text-right font-medium py-2">Completed</th>
                    <th className="text-right font-medium py-2">Total</th>
                    <th className="text-left font-medium py-2 pl-6 w-1/3">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.clinicPerformance || []).map((c) => {
                    const pct = c.total ? Math.round((c.completed / c.total) * 100) : 0;
                    return (
                      <tr key={c.clinicId} className="border-b border-slate-50">
                        <td className="py-3 font-medium text-slate-800">{c.clinicName}</td>
                        <td className="py-3 text-slate-500">{c.location}</td>
                        <td className="py-3 text-right text-slate-700">{c.completed}</td>
                        <td className="py-3 text-right text-slate-700">{c.total}</td>
                        <td className="py-3 pl-6">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: ACCENT }} />
                            </div>
                            <span className="text-xs text-slate-500 w-10 text-right">{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {(data?.clinicPerformance || []).length === 0 && (
                    <tr><td colSpan={5} className="py-8 text-center text-slate-400">No clinic data.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-100 p-6">
            <h3 className="font-semibold text-slate-900 mb-4">Status Breakdown</h3>
            <div className="flex flex-wrap gap-3">
              {Object.entries(stats.statusDistribution).map(([k, v]) => (
                <div key={k} className="px-4 py-3 rounded-2xl bg-slate-50 min-w-[120px]">
                  <p className="text-2xl font-bold text-slate-900">{v as number}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{STATUS_LABELS[k] || k}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </CCMDashboardLayout>
  );
}

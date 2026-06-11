import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Loader2, Download, BarChart3, Calendar, Stethoscope, User, Building2, CalendarRange } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from "recharts";
import { STATUS_LABELS, currentMonthStr } from "@/lib/ccm";
import { toast } from "sonner";

type Dim = "date" | "week" | "provider" | "employee" | "clinic";
const DIM_META: { key: Dim; label: string; icon: any }[] = [
  { key: "date", label: "Day", icon: Calendar },
  { key: "week", label: "Week", icon: CalendarRange },
  { key: "provider", label: "Provider", icon: Stethoscope },
  { key: "employee", label: "Employee", icon: User },
  { key: "clinic", label: "Clinic", icon: Building2 },
];

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
  const [tab, setTab] = useState<"custom" | "monthly">("custom");
  const [month, setMonth] = useState(currentMonthStr());

  const input = useMemo(() => ({ month }), [month]);
  const report = trpc.reports.summary.useQuery(input, { enabled: !!user && tab === "monthly" });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
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
      {/* Tabs */}
      <div className="inline-flex p-1 rounded-2xl bg-slate-100 mb-6">
        {([["custom", "Custom Report"], ["monthly", "Monthly Summary"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${tab === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "custom" && <CustomReport enabled={!!user} />}

      {tab === "monthly" && (
      <>
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
      </>
      )}
    </CCMDashboardLayout>
  );
}

function CustomReport({ enabled }: { enabled: boolean }) {
  const [dims, setDims] = useState<Dim[]>(["date"]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const toggleDim = (d: Dim) => {
    setDims((cur) => {
      if (cur.includes(d)) return cur.filter((x) => x !== d);
      if (cur.length >= 3) { toast.warning("You can combine up to 3 dimensions."); return cur; }
      return [...cur, d];
    });
  };

  const queryInput = useMemo(() => ({
    groupBy: dims,
    from: from ? new Date(from + "T00:00:00").getTime() : undefined,
    to: to ? new Date(to + "T23:59:59").getTime() : undefined,
  }), [dims, from, to]);

  const report = trpc.reports.completions.useQuery(queryInput, { enabled: enabled && dims.length > 0 });
  const rows = report.data?.rows || [];

  const colFor = (d: Dim, r: any): string => {
    switch (d) {
      case "date": return r.date || "";
      case "week": return r.week || "";
      case "provider": return r.providerName || "Unassigned";
      case "employee": return r.employeeName || "Unknown";
      case "clinic": return r.clinicName || "Unassigned";
    }
  };

  const exportCsv = () => {
    if (rows.length === 0) { toast.warning("Nothing to export."); return; }
    const headers = [...dims.map((d) => DIM_META.find((m) => m.key === d)!.label), "CCMs Completed"];
    const lines = [headers.join(",")];
    for (const r of rows) {
      const cells = [...dims.map((d) => `"${String(colFor(d, r)).replace(/"/g, '""')}"`), String(r.count)];
      lines.push(cells.join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ccm-completions-${dims.join("-")}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="bg-white rounded-3xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-6 mb-6">
        <div className="flex items-center gap-2 mb-4"><BarChart3 size={17} className="text-[hsl(200_100%_45%)]" /><h3 className="font-bold text-slate-900">Completed CCMs — group by</h3></div>
        <div className="flex flex-wrap gap-2 mb-5">
          {DIM_META.map(({ key, label, icon: Icon }) => {
            const active = dims.includes(key);
            return (
              <button key={key} onClick={() => toggleDim(key)}
                className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl text-sm font-semibold border transition active:scale-[0.97] ${active ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"}`}>
                <Icon size={14} /> {label}{active && <span className="ml-1 text-[10px] opacity-70">{dims.indexOf(key) + 1}</span>}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]" />
          </div>
          {(from || to) && (
            <button onClick={() => { setFrom(""); setTo(""); }} className="text-xs font-semibold text-slate-400 hover:text-slate-600 px-2 py-2">Clear dates</button>
          )}
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-slate-500">Total: <span className="font-bold text-slate-900">{report.data?.total ?? 0}</span></span>
            <button onClick={exportCsv} disabled={rows.length === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.97] transition disabled:opacity-40">
              <Download size={14} /> Export CSV
            </button>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-400">Tip: combine up to 3 — e.g. Provider + Employee, Provider + Clinic, Employee + Day, or Clinic + Week.</p>
      </div>

      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        {report.isLoading ? (
          <div className="py-16 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-slate-400 font-light">No completed CCMs match this selection.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-slate-100 bg-slate-50/50">
                  {dims.map((d) => <th key={d} className="px-5 py-3 font-medium">{DIM_META.find((m) => m.key === d)!.label}</th>)}
                  <th className="px-5 py-3 font-medium text-right">CCMs Completed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any, i: number) => (
                  <tr key={i} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                    {dims.map((d) => <td key={d} className="px-5 py-3 text-slate-700">{colFor(d, r)}</td>)}
                    <td className="px-5 py-3 text-right font-semibold text-slate-900">{r.count}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50/70 font-bold text-slate-900">
                  <td className="px-5 py-3" colSpan={dims.length}>Total</td>
                  <td className="px-5 py-3 text-right">{report.data?.total ?? 0}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

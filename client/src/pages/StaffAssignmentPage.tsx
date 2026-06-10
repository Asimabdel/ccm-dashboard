import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Users, Wand2 } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from "recharts";
import { StatusBadge } from "@/components/CCMBadges";
import { currentMonthStr } from "@/lib/ccm";

const ACCENT = "hsl(200 80% 62%)";
const PINK = "hsl(345 80% 80%)";

export default function StaffAssignmentPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [month] = useState(currentMonthStr());
  const [selected, setSelected] = useState<number[]>([]);
  const [bulkStaffId, setBulkStaffId] = useState<string>("");

  const monthInput = useMemo(() => ({ month }), [month]);
  const workload = trpc.staff.workload.useQuery(monthInput, { enabled: !!user });
  const staffAll = trpc.staff.all.useQuery(undefined, { enabled: !!user });
  const worklist = trpc.worklist.forMonth.useQuery(monthInput, { enabled: !!user });

  const utils = trpc.useUtils();
  const refresh = () => { utils.staff.workload.invalidate(); utils.worklist.forMonth.invalidate(); };

  const assign = trpc.worklist.assign.useMutation({
    onSuccess: (r) => { refresh(); setSelected([]); toast.success(`Assigned ${r.count} task(s).`); },
    onError: (e) => toast.error(e.message),
  });
  const autoBalance = trpc.worklist.autoBalance.useMutation({
    onSuccess: (r) => { refresh(); toast.success(`Auto-balanced ${r.assigned} unassigned task(s).`); },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-[hsl(240_10%_97%)]"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const wl = worklist.data || [];
  const staffOptions = (staffAll.data || []).filter((s) => s.role === "staff");
  const chartData = (workload.data || []).map((w) => ({ name: w.name, open: w.openTasks, completed: w.completed, total: w.totalAssigned }));
  const field = "px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]";

  const toggle = (id: number) => setSelected((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);

  return (
    <CCMDashboardLayout title="Staff Assignment">
      <div className="grid lg:grid-cols-2 gap-5 mb-6">
        <div className="bg-white rounded-3xl border border-slate-100 p-6">
          <h3 className="font-semibold text-slate-900 mb-4">Workload by Staff</h3>
          {chartData.length === 0 ? <p className="text-sm text-slate-400 py-12 text-center">No staff workload data.</p> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                <YAxis tick={{ fontSize: 12, fill: "#94a3b8" }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="open" name="Open" radius={[6, 6, 0, 0]}>
                  {chartData.map((_, i) => <Cell key={i} fill={i % 2 === 0 ? ACCENT : PINK} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-white rounded-3xl border border-slate-100 p-6 flex flex-col">
          <h3 className="font-semibold text-slate-900 mb-1 flex items-center gap-2"><Wand2 size={16} className="text-[hsl(200_70%_55%)]" /> Rule-Based Assignment</h3>
          <p className="text-sm text-slate-500 mb-4">Distribute all unassigned tasks evenly, preferring staff at the matching clinic location.</p>
          <button disabled={autoBalance.isPending} onClick={() => autoBalance.mutate({ month })}
            className="self-start px-4 py-2.5 rounded-xl text-sm font-semibold bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-300 transition inline-flex items-center gap-2">
            {autoBalance.isPending ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />} Auto-Balance Workload
          </button>
          <div className="mt-5 space-y-2">
            {(workload.data || []).map((w) => (
              <div key={w.staffId} className="flex items-center justify-between text-sm">
                <span className="text-slate-700">{w.name} <span className="text-slate-400">· {w.clinicLocation || "—"}</span></span>
                <span className="text-slate-500">{w.openTasks} open / {w.totalAssigned} total</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="flex items-center justify-between gap-3 p-5 border-b border-slate-50 flex-wrap">
          <h3 className="font-semibold text-slate-900 flex items-center gap-2"><Users size={16} /> Worklist ({wl.length})</h3>
          {selected.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-500">{selected.length} selected</span>
              <select className={field} value={bulkStaffId} onChange={(e) => setBulkStaffId(e.target.value)}>
                <option value="">Assign to…</option>
                {staffOptions.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
              </select>
              <button disabled={!bulkStaffId || assign.isPending}
                onClick={() => assign.mutate({ taskIds: selected, staffId: Number(bulkStaffId) })}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-900 text-white disabled:bg-slate-200 hover:bg-slate-700">Bulk Assign</button>
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50/70 text-slate-500 text-xs uppercase tracking-wider">
                <th className="px-5 py-3 w-10"></th>
                <th className="text-left font-medium px-3 py-3">Patient</th>
                <th className="text-left font-medium px-3 py-3">Status</th>
                <th className="text-left font-medium px-3 py-3">Clinic</th>
                <th className="text-left font-medium px-3 py-3">Assigned To</th>
                <th className="text-right font-medium px-5 py-3">Assign</th>
              </tr>
            </thead>
            <tbody>
              {worklist.isLoading && <tr><td colSpan={6} className="py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></td></tr>}
              {!worklist.isLoading && wl.length === 0 && <tr><td colSpan={6} className="py-12 text-center text-slate-400">No tasks for this month.</td></tr>}
              {wl.map((r) => (
                <tr key={r.task.id} className="border-t border-slate-50 hover:bg-slate-50/40">
                  <td className="px-5 py-3"><input type="checkbox" checked={selected.includes(r.task.id)} onChange={() => toggle(r.task.id)} className="rounded border-slate-300" /></td>
                  <td className="px-3 py-3 font-medium text-slate-800 whitespace-nowrap">{r.patient.name}</td>
                  <td className="px-3 py-3"><StatusBadge status={r.task.status as string} /></td>
                  <td className="px-3 py-3 text-slate-500 whitespace-nowrap">{r.clinicName || "—"}</td>
                  <td className="px-3 py-3 text-slate-600 whitespace-nowrap">{r.staffName || <span className="text-slate-400">Unassigned</span>}</td>
                  <td className="px-5 py-3 text-right">
                    <select className={field} defaultValue="" onChange={(e) => { if (e.target.value) assign.mutate({ taskIds: [r.task.id], staffId: Number(e.target.value) }); }}>
                      <option value="">Assign…</option>
                      {staffOptions.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}

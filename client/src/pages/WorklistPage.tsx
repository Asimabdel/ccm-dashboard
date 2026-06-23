import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Loader2, Phone, X, CheckCircle2, ListChecks } from "lucide-react";
import {
  STATUS_LABELS, STATUS_OPTIONS, statusBadgeClass, currentMonthStr,
} from "@/lib/ccm";

export default function WorklistPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [, setLocation] = useLocation();
  const [month] = useState(currentMonthStr());
  const [statusFilter, setStatusFilter] = useState("");
  const [clinicFilter, setClinicFilter] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [bulkStatus, setBulkStatus] = useState("");
  // Staff default to viewing only their own assigned tasks; admins see all.
  const [mineOnly, setMineOnly] = useState(() => user?.role === "staff");

  const clinics = trpc.clinics.list.useQuery(undefined, { enabled: !!user });
  const filters = useMemo(() => ({
    month,
    status: statusFilter || undefined,
    clinicId: clinicFilter || undefined,
    assignedStaffId: mineOnly && user ? user.id : undefined,
  }), [month, statusFilter, clinicFilter, mineOnly, user]);
  const worklist = trpc.worklist.forMonth.useQuery(filters, { enabled: !!user });
  const utils = trpc.useUtils();

  const isStaff = user && ["admin", "staff"].includes(user.role);

  const updateStatus = trpc.worklist.updateStatus.useMutation({
    onSuccess: () => { utils.worklist.forMonth.invalidate(); toast.success("Status updated."); },
    onError: (e) => toast.error(e.message),
  });
  const bulkUpdate = trpc.worklist.bulkUpdateStatus.useMutation({
    onSuccess: (r) => { utils.worklist.forMonth.invalidate(); setSelected([]); setBulkStatus(""); toast.success(`Updated ${r.count} tasks.`); },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const rows = worklist.data || [];
  const field = "px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]";
  const toggle = (id: number) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  return (
    <CCMDashboardLayout title={`Monthly Worklist - ${month}`}>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="flex items-center gap-2 flex-wrap">
          <select className={field} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All Statuses</option>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          <select className={field} value={clinicFilter} onChange={(e) => setClinicFilter(Number(e.target.value))}>
            <option value={0}>All Clinics</option>
            {(clinics.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {(statusFilter || clinicFilter) && (
            <button onClick={() => { setStatusFilter(""); setClinicFilter(0); }} className="inline-flex items-center gap-1 px-3 py-2 rounded-xl text-sm text-slate-500 hover:bg-slate-100"><X size={14} /> Clear</button>
          )}
          {user?.role === "staff" && (
            <button onClick={() => setMineOnly((m) => !m)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium transition ${mineOnly ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"}`}>
              {mineOnly ? "My Tasks" : "All Tasks"}
            </button>
          )}
        </div>
        {isStaff && selected.length > 0 && (
          <div className="flex items-center gap-2 bg-slate-900 text-white rounded-2xl px-3 py-2">
            <ListChecks size={16} />
            <span className="text-sm font-medium">{selected.length} selected</span>
            <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} className="px-2 py-1 rounded-lg text-slate-800 text-xs">
              <option value="">Set status...</option>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
            <button disabled={!bulkStatus || bulkUpdate.isPending} onClick={() => bulkUpdate.mutate({ ids: selected, status: bulkStatus as any })} className="px-3 py-1 rounded-lg bg-white text-slate-900 text-xs font-semibold disabled:opacity-50">Apply</button>
          </div>
        )}
      </div>

      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-slate-100 bg-slate-50/50">
                {isStaff && <th className="px-4 py-3 w-10"></th>}
                <th className="px-5 py-3 font-medium">Patient</th>
                <th className="px-5 py-3 font-medium">Provider</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {worklist.isLoading && <tr><td colSpan={7} className="px-5 py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></td></tr>}
              {!worklist.isLoading && rows.length === 0 && <tr><td colSpan={7} className="px-5 py-12 text-center text-slate-400 font-light">No tasks for this month. An admin can generate the worklist from the Admin Dashboard.</td></tr>}
              {rows.map((r) => (
                <tr key={r.task.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                  {isStaff && (
                    <td className="px-4 py-3"><input type="checkbox" checked={selected.includes(r.task.id)} onChange={() => toggle(r.task.id)} className="accent-slate-900" /></td>
                  )}
                  <td className="px-5 py-3">
                    <p className="font-semibold text-slate-800">{r.patient.name}</p>
                    <p className="text-xs text-slate-400">{r.clinicName} - {r.staffName || "Unassigned"}</p>
                  </td>
                  <td className="px-5 py-3 text-slate-600">{r.providerName || "-"}</td>
                  <td className="px-5 py-3">
                    {isStaff ? (
                      <select value={r.task.status ?? "not_started"} onChange={(e) => updateStatus.mutate({ id: r.task.id, status: e.target.value as any })}
                        className={`px-2 py-1 rounded-full text-[11px] font-semibold border-0 max-w-[170px] ${statusBadgeClass(r.task.status ?? "not_started")}`}>
                        {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                      </select>
                    ) : (
                      <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${statusBadgeClass(r.task.status ?? "not_started")}`}>{STATUS_LABELS[r.task.status ?? "not_started"]}</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {isStaff && (
                      <button onClick={() => setLocation(`/workflow/${r.task.id}`)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[hsl(200_100%_50%)] text-white text-xs font-semibold hover:brightness-95">
                        {r.task.status === "completed" ? <CheckCircle2 size={13} /> : <Phone size={13} />}
                        {r.task.status === "completed" ? "Review" : "Start Call"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-sm font-light text-slate-400">{rows.length} tasks</p>
    </CCMDashboardLayout>
  );
}

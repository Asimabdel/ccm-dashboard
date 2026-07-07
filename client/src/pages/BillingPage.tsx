import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Check, X, DollarSign, FileCheck, Download } from "lucide-react";
import { BILLING_STATUS_LABELS, billingBadgeClass, currentMonthStr, fmtDate } from "@/lib/ccm";

const CHECKS: { key: string; label: string }[] = [
  { key: "documentationComplete", label: "Documentation" },
  { key: "providerAssociated", label: "Provider Linked" },
  { key: "carePlanReviewed", label: "Care Plan" },
  { key: "noMissingFields", label: "No Missing Fields" },
  { key: "providerReviewCompleted", label: "Provider Review" },
];

/** CPT for CCM clinical-staff time: 99490 at >=20 min, +99439 per extra 20 (max 2). */
function cptFor(minutes: number): { code: string; addOnUnits: number } | null {
  if (minutes < 20) return null;
  return { code: "99490", addOnUnits: Math.min(2, Math.floor((minutes - 20) / 20)) };
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function YN({ ok }: { ok: boolean }) {
  return ok
    ? <span className="inline-flex w-6 h-6 rounded-full bg-emerald-100 items-center justify-center"><Check size={13} className="text-emerald-700" /></span>
    : <span className="inline-flex w-6 h-6 rounded-full bg-rose-50 items-center justify-center"><X size={13} className="text-rose-400" /></span>;
}

export default function BillingPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [month, setMonth] = useState(currentMonthStr());
  const [statusFilter, setStatusFilter] = useState("");

  const queryInput = useMemo(() => ({ month, status: statusFilter || undefined }), [month, statusFilter]);
  const list = trpc.billing.list.useQuery(queryInput, { enabled: !!user });
  const utils = trpc.useUtils();
  const markBilled = trpc.billing.markBilled.useMutation({
    onSuccess: () => { utils.billing.list.invalidate(); toast.success("Marked as billed."); },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const rows = list.data || [];
  const billedCount = rows.filter((r) => r.billing.billingStatus === "billed").length;
  const readyCount = rows.filter((r) => r.billing.billingStatus === "ready_for_billing").length;
  const timeMetCount = rows.filter((r) => (r.task?.timeSpentMinutes ?? 0) >= 20).length;
  const field = "px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)]";

  const exportCsv = () => {
    const header = ["Patient", "DOB", "Provider", "Month", "Minutes", "CPT", "99439 Units", "Time Met", "Status", "Completed At"];
    const lines = rows.map((r) => {
      const mins = r.task?.timeSpentMinutes ?? 0;
      const cpt = cptFor(mins);
      return [
        r.patient.name,
        r.patient.dateOfBirth ? new Date(r.patient.dateOfBirth).toLocaleDateString() : "",
        r.providerName || "",
        month,
        mins,
        cpt ? cpt.code : "TIME NOT MET",
        cpt ? cpt.addOnUnits : 0,
        mins >= 20 ? "YES" : "NO",
        BILLING_STATUS_LABELS[r.billing.billingStatus || "not_started"],
        r.task?.completedAt ? new Date(r.task.completedAt).toLocaleDateString() : "",
      ].map(csvEscape).join(",");
    });
    const blob = new Blob(["﻿" + [header.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ccm-billing-${month}${statusFilter ? `-${statusFilter}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success(`Exported ${rows.length} rows.`);
  };

  return (
    <CCMDashboardLayout title="Billing Readiness">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-3xl border border-slate-100 p-5">
          <p className="text-xs uppercase tracking-wider text-slate-400">Total Records</p>
          <p className="text-3xl font-bold text-slate-900 mt-1 font-mono tabular-nums">{rows.length}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-100 p-5">
          <p className="text-xs uppercase tracking-wider text-slate-400">20-min Time Met</p>
          <p className="text-3xl font-bold text-slate-900 mt-1 font-mono tabular-nums">{timeMetCount}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-100 p-5">
          <p className="text-xs uppercase tracking-wider text-slate-400">Ready for Billing</p>
          <p className="text-3xl font-bold text-slate-900 mt-1 font-mono tabular-nums">{readyCount}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-100 p-5">
          <p className="text-xs uppercase tracking-wider text-slate-400">Billed</p>
          <p className="text-3xl font-bold text-slate-900 mt-1 font-mono tabular-nums">{billedCount}</p>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="flex items-center gap-2">
          <input type="month" className={field} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          <select className={field} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All Statuses</option>
            {Object.entries(BILLING_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <button onClick={exportCsv} disabled={rows.length === 0}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.97] disabled:opacity-50 transition">
          <Download size={15} /> Export CSV ({rows.length})
        </button>
      </div>

      {list.isLoading && <div className="py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>}
      {!list.isLoading && rows.length === 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 py-16 text-center">
          <DollarSign className="mx-auto text-slate-300 mb-3" size={32} />
          <p className="text-slate-400 font-light">No billing records for this month.</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50/70 text-slate-500 text-xs uppercase tracking-wider">
                  <th className="text-left font-medium px-5 py-3">Patient</th>
                  <th className="text-left font-medium px-3 py-3" title="Documented clinical staff minutes this month (20 required)">Time</th>
                  <th className="text-left font-medium px-3 py-3">CPT</th>
                  {CHECKS.map((c) => <th key={c.key} className="font-medium px-3 py-3 text-center whitespace-nowrap">{c.label}</th>)}
                  <th className="text-left font-medium px-3 py-3">Status</th>
                  <th className="text-right font-medium px-5 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const allReady = CHECKS.every((c) => (r.billing as any)[c.key]);
                  const isBilled = r.billing.billingStatus === "billed";
                  const mins = r.task?.timeSpentMinutes ?? 0;
                  const cpt = cptFor(mins);
                  return (
                    <tr key={r.billing.id} className="border-t border-slate-50 hover:bg-slate-50/40">
                      <td className="px-5 py-3 font-medium text-slate-800 whitespace-nowrap">{r.patient.name}</td>
                      <td className={`px-3 py-3 font-mono tabular-nums font-semibold whitespace-nowrap ${mins >= 20 ? "text-emerald-600" : "text-amber-600"}`}>{mins}m</td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {cpt
                          ? <span className="font-mono text-xs font-semibold text-slate-700">{cpt.code}{cpt.addOnUnits > 0 ? ` +99439×${cpt.addOnUnits}` : ""}</span>
                          : <span className="text-xs text-amber-600 font-medium">needs time</span>}
                      </td>
                      {CHECKS.map((c) => <td key={c.key} className="px-3 py-3 text-center"><YN ok={!!(r.billing as any)[c.key]} /></td>)}
                      <td className="px-3 py-3"><span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap ${billingBadgeClass(r.billing.billingStatus || "not_started")}`}>{BILLING_STATUS_LABELS[r.billing.billingStatus || "not_started"]}</span></td>
                      <td className="px-5 py-3 text-right">
                        {isBilled ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-semibold"><FileCheck size={14} /> Billed</span>
                        ) : (
                          <button
                            disabled={!allReady || markBilled.isPending}
                            onClick={() => markBilled.mutate({ id: r.billing.id, ccmTaskId: r.billing.ccmTaskId })}
                            className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-900 text-white disabled:bg-slate-200 disabled:text-slate-400 hover:bg-slate-700 transition">
                            Mark Billed
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </CCMDashboardLayout>
  );
}

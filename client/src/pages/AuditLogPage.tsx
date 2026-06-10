import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Loader2, ShieldCheck, Filter } from "lucide-react";

const ACTION_LABELS: Record<string, string> = {
  view_patient: "Viewed Patient",
  list_patients: "Listed Patients",
  create_patient: "Created Patient",
  update_patient: "Updated Patient",
  bulk_import_patients: "Bulk Imported",
  update_rpm: "Updated RPM",
  view_worklist: "Viewed Worklist",
  complete_ccm_note: "Completed CCM Note",
  view_billing: "Viewed Billing",
  export_data: "Exported Data",
  login: "Login",
  logout: "Logout",
};

function actionColor(a: string): string {
  if (["create_patient", "bulk_import_patients"].includes(a)) return "bg-emerald-100 text-emerald-700";
  if (["update_patient", "update_rpm"].includes(a)) return "bg-blue-100 text-blue-700";
  if (a === "export_data") return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-600";
}

export default function AuditLogPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [actionFilter, setActionFilter] = useState("");

  const isAdmin = user?.role === "admin";
  const input = useMemo(() => ({ limit: 300, action: actionFilter || undefined }), [actionFilter]);
  const logs = trpc.audit.list.useQuery(input, { enabled: isAdmin });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-[hsl(240_10%_97%)]"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  if (!isAdmin) {
    return (
      <CCMDashboardLayout title="Audit Log">
        <div className="bg-white rounded-3xl border border-slate-100 p-10 text-center text-slate-500">
          The HIPAA audit log is restricted to administrators.
        </div>
      </CCMDashboardLayout>
    );
  }

  const field = "px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]";

  return (
    <CCMDashboardLayout title="HIPAA Audit Log">
      <div className="flex items-center gap-2 mb-5 text-slate-500 text-sm">
        <ShieldCheck size={16} className="text-emerald-600" />
        Immutable record of access to and changes of protected health information (PHI).
      </div>
      <div className="flex items-center gap-2 mb-4">
        <Filter size={15} className="text-slate-400" />
        <select className={field} value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          <option value="">All actions</option>
          {Object.keys(ACTION_LABELS).map((a) => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto max-h-[70vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50">
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 font-medium">Time</th>
                <th className="px-5 py-3 font-medium">User</th>
                <th className="px-5 py-3 font-medium">Role</th>
                <th className="px-5 py-3 font-medium">Action</th>
                <th className="px-5 py-3 font-medium">Detail</th>
                <th className="px-5 py-3 font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {logs.isLoading && <tr><td colSpan={6} className="px-5 py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></td></tr>}
              {!logs.isLoading && (logs.data || []).length === 0 && <tr><td colSpan={6} className="px-5 py-12 text-center text-slate-400 font-light">No audit entries yet.</td></tr>}
              {(logs.data || []).map((l) => (
                <tr key={l.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                  <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{new Date(l.createdAt).toLocaleString()}</td>
                  <td className="px-5 py-3 text-slate-800">{l.userName || "—"}</td>
                  <td className="px-5 py-3 text-slate-500">{l.userRole || "—"}</td>
                  <td className="px-5 py-3"><span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${actionColor(l.action)}`}>{ACTION_LABELS[l.action] || l.action}</span></td>
                  <td className="px-5 py-3 text-slate-600 max-w-[320px] truncate" title={l.description || ""}>{l.description || "—"}</td>
                  <td className="px-5 py-3 text-slate-400 text-xs">{l.ipAddress || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-sm font-light text-slate-400">{(logs.data || []).length} entries</p>
    </CCMDashboardLayout>
  );
}

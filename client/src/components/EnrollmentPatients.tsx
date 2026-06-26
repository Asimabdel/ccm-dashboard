import type React from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Loader2, RotateCcw } from "lucide-react";
import { fmtDate } from "@/lib/ccm";

/** A filtered patient list for an enrollment status (inactive / declined), with a reactivate action. */
export function EnrollmentPatients({ status, title, emptyText, reactivateLabel, icon: Icon, note }: {
  status: "inactive" | "declined";
  title: string;
  emptyText: string;
  reactivateLabel: string;
  icon: React.ElementType;
  note: string;
}) {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  // Coordinators see only their own patients; admins see everyone's.
  const list = trpc.patients.list.useQuery(
    { enrollmentStatus: status, ...(user && user.role === "staff" ? { assignedStaffId: user.id } : {}) },
    { enabled: !!user },
  );
  const update = trpc.patients.update.useMutation({
    onSuccess: () => {
      utils.patients.list.invalidate();
      utils.worklist.forMonth.invalidate();
      toast.success("Patient moved back to active.");
    },
    onError: (e) => toast.error(e.message),
  });
  const canEdit = !!user && ["admin", "staff", "front_desk"].includes(user.role);

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const rows = list.data || [];
  return (
    <CCMDashboardLayout title={title}>
      <p className="text-sm text-slate-500 mb-4 flex items-center gap-1.5"><Icon size={15} className="text-slate-400" /> {note}</p>
      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <p className="text-sm font-semibold text-slate-700">{rows.length} {rows.length === 1 ? "patient" : "patients"}</p>
        </div>
        <div className="overflow-x-auto max-h-[70vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 z-10">
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                <th className="px-5 py-3 font-medium">Patient</th>
                <th className="px-5 py-3 font-medium">Provider</th>
                <th className="px-5 py-3 font-medium">Clinic</th>
                <th className="px-5 py-3 font-medium">Last Called</th>
                {canEdit && <th className="px-5 py-3 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {list.isLoading && (
                <tr><td colSpan={5} className="px-5 py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></td></tr>
              )}
              {!list.isLoading && rows.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-16 text-center text-slate-400 font-light">{emptyText}</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.patient.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                  <td className="px-5 py-3 cursor-pointer" onClick={() => setLocation(`/patients/${r.patient.id}`)}>
                    <p className="font-semibold text-slate-800">{r.patient.name}</p>
                    <p className="text-xs text-slate-400">{r.patient.phoneNumber}</p>
                  </td>
                  <td className="px-5 py-3 text-slate-600">{r.providerName || "—"}</td>
                  <td className="px-5 py-3 text-slate-600">{r.clinicName || "—"}</td>
                  <td className="px-5 py-3 text-slate-600 whitespace-nowrap">{fmtDate(r.patient.lastCalledAt)}</td>
                  {canEdit && (
                    <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => update.mutate({ id: r.patient.id, ccmEnrollmentStatus: "active" })}
                        disabled={update.isPending}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
                        title="Move back to active — they'll return to the worklist"
                      >
                        <RotateCcw size={13} /> {reactivateLabel}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}

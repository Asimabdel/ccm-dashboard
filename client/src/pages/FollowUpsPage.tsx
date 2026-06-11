import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, CalendarClock, Check } from "lucide-react";
import { FOLLOWUP_TYPE_LABELS, FOLLOWUP_STATUS_LABELS, followupBadgeClass, fmtDate } from "@/lib/ccm";

const STATUSES = ["pending", "scheduled", "completed"] as const;

export default function FollowUpsPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [scheduleId, setScheduleId] = useState<number | null>(null);
  const [scheduleDate, setScheduleDate] = useState("");

  const queryInput = useMemo(() => ({ status: statusFilter || undefined, type: typeFilter || undefined }), [statusFilter, typeFilter]);
  const list = trpc.followUps.list.useQuery(queryInput, { enabled: !!user });
  const utils = trpc.useUtils();
  const update = trpc.followUps.updateStatus.useMutation({
    onSuccess: () => { utils.followUps.list.invalidate(); toast.success("Follow-up updated."); setScheduleId(null); setScheduleDate(""); },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const rows = list.data || [];
  const field = "px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]";

  return (
    <CCMDashboardLayout title="Follow-Up Tracking">
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <select className={field} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{FOLLOWUP_STATUS_LABELS[s]}</option>)}
        </select>
        <select className={field} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All Types</option>
          {Object.entries(FOLLOWUP_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {list.isLoading && <div className="py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>}
      {!list.isLoading && rows.length === 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 py-16 text-center">
          <CalendarClock className="mx-auto text-slate-300 mb-3" size={32} />
          <p className="text-slate-400 font-light">No follow-up items match these filters.</p>
        </div>
      )}

      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.followUp.id} className="bg-white rounded-3xl border border-slate-100 p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-slate-900">{r.patient.name}</p>
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[hsl(210_60%_94%)] text-slate-700">{FOLLOWUP_TYPE_LABELS[r.followUp.type] || r.followUp.type}</span>
                  <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${followupBadgeClass(r.followUp.status || "pending")}`}>{FOLLOWUP_STATUS_LABELS[r.followUp.status || "pending"]}</span>
                </div>
                <p className="text-sm text-slate-500 mt-1">{r.clinicName || "—"}</p>
                {r.followUp.notes && <p className="text-sm text-slate-600 mt-2">{r.followUp.notes}</p>}
                <div className="flex gap-4 mt-2 text-xs text-slate-400">
                  {r.followUp.scheduledDate && <span>Scheduled: {fmtDate(r.followUp.scheduledDate)}</span>}
                  {r.followUp.completedDate && <span>Completed: {fmtDate(r.followUp.completedDate)}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {scheduleId === r.followUp.id ? (
                  <div className="flex items-center gap-2">
                    <input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} className={field} />
                    <button disabled={!scheduleDate || update.isPending}
                      onClick={() => update.mutate({ id: r.followUp.id, status: "scheduled", scheduledDate: new Date(scheduleDate) })}
                      className="px-3 py-2 rounded-xl text-xs font-semibold bg-slate-900 text-white disabled:bg-slate-200 hover:bg-slate-700">Save</button>
                    <button onClick={() => { setScheduleId(null); setScheduleDate(""); }} className="px-3 py-2 rounded-xl text-xs text-slate-500 hover:bg-slate-50">Cancel</button>
                  </div>
                ) : (
                  <>
                    {r.followUp.status !== "scheduled" && (
                      <button onClick={() => { setScheduleId(r.followUp.id); setScheduleDate(""); }}
                        className="px-3 py-2 rounded-xl text-xs font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50">Schedule</button>
                    )}
                    {r.followUp.status !== "completed" && (
                      <button disabled={update.isPending} onClick={() => update.mutate({ id: r.followUp.id, status: "completed" })}
                        className="inline-flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500"><Check size={13} /> Complete</button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </CCMDashboardLayout>
  );
}

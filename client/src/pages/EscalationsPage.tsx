import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, AlertTriangle, Stethoscope, ChevronDown, ChevronUp } from "lucide-react";
import { ESCALATION_STATUS_LABELS, escalationBadgeClass, fmtDate } from "@/lib/ccm";

const ACTIONS = ["pending", "reviewed", "action_needed", "completed"] as const;

export default function EscalationsPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [statusFilter, setStatusFilter] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<number, { recommendedAction: string; providerNotes: string }>>({});

  const list = trpc.escalations.list.useQuery(
    { status: statusFilter || undefined },
    { enabled: !!user }
  );
  const utils = trpc.useUtils();
  const update = trpc.escalations.updateStatus.useMutation({
    onSuccess: () => { utils.escalations.list.invalidate(); toast.success("Escalation updated."); },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const rows = list.data || [];
  const field = "px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]";

  return (
    <CCMDashboardLayout title="Provider Escalations">
      <div className="flex items-center gap-2 mb-5">
        <select className={field} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          {ACTIONS.map((s) => <option key={s} value={s}>{ESCALATION_STATUS_LABELS[s]}</option>)}
        </select>
      </div>

      {list.isLoading && <div className="py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>}
      {!list.isLoading && rows.length === 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 py-16 text-center">
          <Stethoscope className="mx-auto text-slate-300 mb-3" size={32} />
          <p className="text-slate-400 font-light">No escalations to review.</p>
        </div>
      )}

      <div className="space-y-3">
        {rows.map((r) => {
          const d = draft[r.escalation.id] || { recommendedAction: r.escalation.recommendedAction || "", providerNotes: r.escalation.providerNotes || "" };
          const open = expanded === r.escalation.id;
          return (
            <div key={r.escalation.id} className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
              <button onClick={() => setExpanded(open ? null : r.escalation.id)} className="w-full flex items-center justify-between gap-4 p-5 text-left hover:bg-slate-50/60">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-2xl bg-rose-50 flex items-center justify-center shrink-0"><AlertTriangle size={18} className="text-rose-500" /></div>
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 truncate">{r.patient.name}</p>
                    <p className="text-sm text-slate-500 truncate">{r.escalation.reason}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-slate-400 hidden sm:block">{fmtDate(r.escalation.createdAt)}</span>
                  <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${escalationBadgeClass(r.escalation.escalationStatus || "pending")}`}>{ESCALATION_STATUS_LABELS[r.escalation.escalationStatus || "pending"]}</span>
                  {open ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                </div>
              </button>

              {open && (
                <div className="px-5 pb-5 border-t border-slate-50 pt-4 space-y-4">
                  {r.note?.generatedNote && (
                    <div>
                      <p className="text-xs uppercase tracking-wider text-slate-400 mb-1.5">CCM Note Summary</p>
                      <div className="text-sm text-slate-600 bg-slate-50 rounded-2xl p-4 whitespace-pre-wrap max-h-48 overflow-y-auto">{r.note.generatedNote}</div>
                    </div>
                  )}
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs uppercase tracking-wider text-slate-400 mb-1.5">Recommended Action</label>
                      <textarea rows={3} value={d.recommendedAction} onChange={(e) => setDraft((p) => ({ ...p, [r.escalation.id]: { ...d, recommendedAction: e.target.value } }))}
                        className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]" placeholder="e.g. Order labs, adjust medication, schedule visit…" />
                    </div>
                    <div>
                      <label className="block text-xs uppercase tracking-wider text-slate-400 mb-1.5">Provider Notes</label>
                      <textarea rows={3} value={d.providerNotes} onChange={(e) => setDraft((p) => ({ ...p, [r.escalation.id]: { ...d, providerNotes: e.target.value } }))}
                        className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]" placeholder="Clinical notes…" />
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2 flex-wrap">
                    {ACTIONS.map((a) => (
                      <button key={a} disabled={update.isPending}
                        onClick={() => update.mutate({ id: r.escalation.id, escalationStatus: a, recommendedAction: d.recommendedAction, providerNotes: d.providerNotes })}
                        className={`px-3.5 py-2 rounded-xl text-xs font-semibold border transition ${r.escalation.escalationStatus === a ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                        {ESCALATION_STATUS_LABELS[a]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </CCMDashboardLayout>
  );
}

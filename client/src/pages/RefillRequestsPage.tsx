import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Pill, CheckCircle2, CalendarClock, Ban, Clock, ShieldCheck } from "lucide-react";
import { fmtDateTime } from "@/lib/ccm";

type Med = { name: string; note?: string };
const STATUS: Record<string, { label: string; cls: string; icon: any }> = {
  pending: { label: "Pending", cls: "bg-amber-100 text-amber-800", icon: Clock },
  approved: { label: "Approved", cls: "bg-emerald-100 text-emerald-800", icon: CheckCircle2 },
  schedule_visit: { label: "Schedule visit", cls: "bg-blue-100 text-blue-800", icon: CalendarClock },
  denied: { label: "Don't refill", cls: "bg-rose-100 text-rose-800", icon: Ban },
};

export default function RefillRequestsPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const list = trpc.refills.mine.useQuery({ status: tab === "pending" ? "pending" : undefined }, { enabled: !!user });
  const utils = trpc.useUtils();
  const decide = trpc.refills.decide.useMutation({
    onSuccess: () => { utils.refills.mine.invalidate(); utils.refills.myPendingCount.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  if (!["provider", "admin"].includes(user.role)) {
    return <CCMDashboardLayout title="Refill Requests"><p className="text-slate-400 font-light">This area is for providers.</p></CCMDashboardLayout>;
  }

  const rows = list.data || [];

  return (
    <CCMDashboardLayout title="Refill Requests">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="inline-flex p-1 rounded-2xl bg-slate-100">
          {([["pending", "Pending"], ["all", "All"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${tab === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
        <p className="text-sm text-slate-400 flex items-center gap-1.5"><ShieldCheck size={14} className="text-emerald-500" /> Requests for your patients only</p>
      </div>

      {list.isLoading && <div className="py-16 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>}
      {!list.isLoading && rows.length === 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 py-16 text-center">
          <Pill className="mx-auto text-slate-300 mb-3" size={32} />
          <p className="text-slate-400 font-light">{tab === "pending" ? "No pending refill requests. You're all caught up." : "No refill requests yet."}</p>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {rows.map((r) => <RefillCard key={r.req.id} r={r} onDecide={(status, note) => decide.mutate({ id: r.req.id, status, providerNote: note || undefined })} pending={decide.isPending} />)}
      </div>
    </CCMDashboardLayout>
  );
}

function RefillCard({ r, onDecide, pending }: { r: any; onDecide: (status: "approved" | "schedule_visit" | "denied", note: string) => void; pending: boolean }) {
  const [note, setNote] = useState("");
  const meds = (r.req.medications as Med[] | null) || [];
  const s = STATUS[r.req.status] || STATUS.pending;
  const Icon = s.icon;
  const decided = r.req.status !== "pending";

  return (
    <div className="bg-white rounded-3xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="font-bold text-slate-900">{r.patient.name}</p>
          <p className="text-xs text-slate-400">{fmtDateTime(r.req.createdAt)}{r.requesterName ? ` · from ${r.requesterName}` : ""}</p>
        </div>
        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap ${s.cls}`}><Icon size={12} /> {s.label}</span>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-2">
        {meds.map((m) => <span key={m.name} className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 text-sm font-medium">{m.name}</span>)}
      </div>
      {r.req.note && <p className="text-sm text-slate-500 mb-2">“{r.req.note}”</p>}
      {decided && r.req.providerNote && <p className="text-xs text-slate-400 mb-2">Your note: “{r.req.providerNote}”</p>}

      {!decided && (
        <>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note back to the coordinator (optional)…"
            className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)] mb-3" />
          <div className="grid grid-cols-3 gap-2">
            <button disabled={pending} onClick={() => onDecide("approved", note)}
              className="inline-flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-semibold hover:brightness-110 active:scale-[0.97] disabled:opacity-50 transition">
              <CheckCircle2 size={14} /> Approve
            </button>
            <button disabled={pending} onClick={() => onDecide("schedule_visit", note)}
              className="inline-flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-semibold hover:brightness-110 active:scale-[0.97] disabled:opacity-50 transition">
              <CalendarClock size={14} /> Schedule visit
            </button>
            <button disabled={pending} onClick={() => onDecide("denied", note)}
              className="inline-flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-xl bg-white border border-rose-200 text-rose-700 text-xs font-semibold hover:bg-rose-50 active:scale-[0.97] disabled:opacity-50 transition">
              <Ban size={14} /> Don't refill
            </button>
          </div>
        </>
      )}
      {decided && r.deciderName && <p className="text-[11px] text-slate-400 mt-1">Decided by {r.deciderName} · {fmtDateTime(r.req.decidedAt)}</p>}
    </div>
  );
}

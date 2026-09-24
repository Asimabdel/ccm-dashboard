import { useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Pill, Search, X, Plus, Send, CheckCircle2, Clock, CalendarClock, Ban } from "lucide-react";
import { COMMON_MEDICATIONS } from "@/lib/medications";
import { fmtDateTime } from "@/lib/ccm";

type Med = { name: string; note?: string };

/** Coordinator panel: search + pick medications a patient wants refilled, then send
 *  the request to the patient's provider. Also shows this patient's refill history. */
export function MedRefillPanel({ patientId, ccmTaskId, providerName }: { patientId: number; ccmTaskId?: number; providerName?: string | null }) {
  const utils = trpc.useUtils();
  const history = trpc.refills.forPatient.useQuery(patientId, { enabled: !!patientId });
  const [meds, setMeds] = useState<Med[]>([]);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = trpc.refills.create.useMutation({
    onSuccess: () => {
      utils.refills.forPatient.invalidate(patientId);
      setMeds([]); setNote(""); setQuery("");
      toast.success(providerName ? `Sent to ${providerName}.` : "Sent to provider.");
    },
    onError: (e) => toast.error(e.message),
  });

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMON_MEDICATIONS.slice(0, 8);
    return COMMON_MEDICATIONS.filter((m) => m.toLowerCase().includes(q)).slice(0, 10);
  }, [query]);
  const exact = COMMON_MEDICATIONS.some((m) => m.toLowerCase() === query.trim().toLowerCase());
  const already = (name: string) => meds.some((m) => m.name.toLowerCase() === name.toLowerCase());

  const add = (name: string) => {
    const n = name.trim();
    if (!n || already(n)) { setQuery(""); return; }
    setMeds((m) => [...m, { name: n }]);
    setQuery(""); setOpen(false);
  };

  return (
    <div className="bg-white rounded-3xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-6">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2"><Pill size={16} className="text-[hsl(17_68%_47%)]" /><h3 className="font-bold text-slate-900">Medication refill requests</h3></div>
        {providerName && <span className="text-xs text-slate-400">Sends to <b className="text-slate-600">{providerName}</b></span>}
      </div>
      <p className="text-xs text-slate-400 mb-3">Search and add the medications the patient asked to refill, then send them to the provider to approve.</p>

      {/* search dropdown */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
          onKeyDown={(e) => { if (e.key === "Enter" && query.trim()) { e.preventDefault(); add(query); } }}
          placeholder="Search medications…"
          className="w-full pl-9 pr-3 py-2.5 rounded-2xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)]"
        />
        {open && (matches.length > 0 || (query.trim() && !exact)) && (
          <div onMouseDown={() => { if (blurTimer.current) clearTimeout(blurTimer.current); }}
            className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-2xl shadow-lg max-h-64 overflow-y-auto py-1">
            {matches.map((m) => (
              <button key={m} onMouseDown={(e) => e.preventDefault()} onClick={() => add(m)} disabled={already(m)}
                className={`w-full text-left px-4 py-2 text-sm flex items-center justify-between hover:bg-slate-50 ${already(m) ? "text-slate-300" : "text-slate-700"}`}>
                {m} {already(m) && <CheckCircle2 size={14} className="text-emerald-400" />}
              </button>
            ))}
            {query.trim() && !exact && (
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => add(query)}
                className="w-full text-left px-4 py-2 text-sm flex items-center gap-2 text-[hsl(17_66%_45%)] hover:bg-orange-50 border-t border-slate-100">
                <Plus size={14} /> Add “{query.trim()}”
              </button>
            )}
          </div>
        )}
      </div>

      {/* selected meds */}
      {meds.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {meds.map((m) => (
            <span key={m.name} className="inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-full bg-[hsl(22_64%_93%)] text-[hsl(17_66%_34%)] text-sm font-medium">
              {m.name}
              <button onClick={() => setMeds((cur) => cur.filter((x) => x.name !== m.name))} className="w-5 h-5 rounded-full hover:bg-[hsl(22_64%_86%)] flex items-center justify-center"><X size={12} /></button>
            </span>
          ))}
        </div>
      )}

      {meds.length > 0 && (
        <>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note to provider (optional) — e.g. patient out of refills, pharmacy…"
            className="mt-3 w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)]" />
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-slate-400">{meds.length} medication{meds.length === 1 ? "" : "s"}</span>
            <button disabled={send.isPending} onClick={() => send.mutate({ patientId, medications: meds, note: note || undefined, ccmTaskId })}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-2xl bg-[hsl(17_66%_52%)] text-white text-sm font-semibold hover:brightness-95 active:scale-[0.97] disabled:opacity-50 transition">
              <Send size={15} /> Send to Provider
            </button>
          </div>
        </>
      )}
      {!providerName && (
        <p className="mt-3 text-[11px] text-amber-700 bg-amber-50 rounded-xl px-3 py-2">This patient has no provider assigned — assign one on their patient page so the request can be routed.</p>
      )}

      {/* history */}
      {(history.data?.length ?? 0) > 0 && (
        <div className="mt-5 pt-4 border-t border-slate-100">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Refill history</p>
          <div className="space-y-2">
            {history.data!.slice(0, 6).map((h) => <RefillHistoryRow key={h.req.id} h={h} />)}
          </div>
        </div>
      )}
    </div>
  );
}

const DECISION: Record<string, { label: string; cls: string; icon: any }> = {
  pending: { label: "Pending", cls: "bg-amber-100 text-amber-800", icon: Clock },
  approved: { label: "Approved", cls: "bg-emerald-100 text-emerald-800", icon: CheckCircle2 },
  schedule_visit: { label: "Schedule visit", cls: "bg-blue-100 text-blue-800", icon: CalendarClock },
  denied: { label: "Don't refill", cls: "bg-rose-100 text-rose-800", icon: Ban },
};

function RefillHistoryRow({ h }: { h: any }) {
  const meds = (h.req.medications as Med[] | null) || [];
  const d = DECISION[h.req.status] || DECISION.pending;
  const Icon = d.icon;
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <div className="min-w-0">
        <p className="text-slate-700 truncate">{meds.map((m) => m.name).join(", ") || "—"}</p>
        <p className="text-[11px] text-slate-400">{fmtDateTime(h.req.createdAt)}{h.requesterName ? ` · ${h.requesterName}` : ""}{h.req.providerNote ? ` · “${h.req.providerNote}”` : ""}</p>
      </div>
      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap ${d.cls}`}><Icon size={12} /> {d.label}</span>
    </div>
  );
}

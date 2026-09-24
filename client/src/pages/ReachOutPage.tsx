import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { fmtDateTime } from "@/lib/ccm";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, PhoneOutgoing, Phone, Search, Upload, X, PhoneMissed, Voicemail,
  PhoneOff, RotateCcw, CheckCircle2, CalendarCheck, CalendarPlus, ThumbsDown, Ban, MinusCircle,
} from "lucide-react";

type CallStatus = "not_called" | "no_answer" | "voicemail" | "wrong_number" | "callback" | "reached" | "do_not_call";
type Outcome = "pending" | "wants_appointment" | "appointment_scheduled" | "already_scheduled" | "not_interested" | "declined";

const CALL_STATUS: Record<CallStatus, { label: string; cls: string; icon: any }> = {
  not_called: { label: "Not called", cls: "bg-slate-100 text-slate-600", icon: Phone },
  no_answer: { label: "No answer", cls: "bg-amber-100 text-amber-800", icon: PhoneMissed },
  voicemail: { label: "Voicemail", cls: "bg-violet-100 text-violet-800", icon: Voicemail },
  wrong_number: { label: "Wrong number", cls: "bg-rose-100 text-rose-800", icon: PhoneOff },
  callback: { label: "Callback", cls: "bg-blue-100 text-blue-800", icon: RotateCcw },
  reached: { label: "Reached", cls: "bg-emerald-100 text-emerald-800", icon: CheckCircle2 },
  do_not_call: { label: "Do not call", cls: "bg-zinc-800 text-white", icon: Ban },
};
const OUTCOME: Record<Outcome, { label: string; cls: string; icon: any }> = {
  pending: { label: "—", cls: "bg-slate-100 text-slate-500", icon: MinusCircle },
  wants_appointment: { label: "Wants appt", cls: "bg-emerald-100 text-emerald-800", icon: CalendarPlus },
  appointment_scheduled: { label: "Scheduled ✓", cls: "bg-green-600 text-white", icon: CalendarCheck },
  already_scheduled: { label: "Already booked", cls: "bg-teal-100 text-teal-800", icon: CalendarCheck },
  not_interested: { label: "Not interested", cls: "bg-slate-200 text-slate-600", icon: ThumbsDown },
  declined: { label: "Declined", cls: "bg-rose-100 text-rose-700", icon: X },
};
const CALL_ORDER: CallStatus[] = ["reached", "no_answer", "voicemail", "callback", "wrong_number", "do_not_call"];
const OUTCOME_ORDER: Outcome[] = ["wants_appointment", "appointment_scheduled", "already_scheduled", "not_interested", "declined"];

function Badge({ map, k }: { map: any; k: string }) {
  const s = map[k] || map.pending || map.not_called;
  const Icon = s.icon;
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${s.cls}`}><Icon size={11} /> {s.label}</span>;
}

export default function ReachOutPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [callStatus, setCallStatus] = useState<string>("");
  const [outcome, setOutcome] = useState<string>("");
  const [uncontactedOnly, setUncontactedOnly] = useState(false);
  const [limit, setLimit] = useState(100);
  const [logTarget, setLogTarget] = useState<any | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const isAdmin = user?.role === "admin";
  const filters = useMemo(() => ({
    search: search.trim() || undefined,
    callStatus: callStatus || undefined,
    outcome: outcome || undefined,
    uncontactedOnly: uncontactedOnly || undefined,
    limit,
  }), [search, callStatus, outcome, uncontactedOnly, limit]);

  const stats = trpc.reachOut.stats.useQuery(undefined, { enabled: !!user });
  const list = trpc.reachOut.list.useQuery(filters, { enabled: !!user });

  const logCall = trpc.reachOut.logCall.useMutation({
    onSuccess: () => { utils.reachOut.list.invalidate(); utils.reachOut.stats.invalidate(); setLogTarget(null); toast.success("Call logged"); },
    onError: (e) => toast.error(e.message),
  });

  const resetFilters = () => { setSearch(""); setCallStatus(""); setOutcome(""); setUncontactedOnly(false); setLimit(100); };

  if (loading || !user) return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  if (!["admin", "staff"].includes(user.role)) {
    return <CCMDashboardLayout title="Reach Out"><p className="text-slate-400 font-light">This area is for care coordinators.</p></CCMDashboardLayout>;
  }

  const s = stats.data;
  const rows = list.data?.rows || [];
  const total = list.data?.total || 0;
  const pct = s && s.total ? Math.round((s.called / s.total) * 100) : 0;
  const reachRate = s && s.called ? Math.round((s.reached / s.called) * 100) : 0;

  return (
    <CCMDashboardLayout title="Reach Out">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-5">
        <p className="text-sm text-slate-500 max-w-xl font-light">
          Insurance-eligible patients we're calling to offer an appointment. Work the shared list top-down —
          log each call's result and, if you reach them, whether they'd like to schedule.
        </p>
        {isAdmin && (
          <button onClick={() => setImportOpen(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.98] transition">
            <Upload size={15} /> Import list
          </button>
        )}
      </div>

      {/* ---- Campaign dashboard ---- */}
      {s && (
        <div className="mb-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            <StatCard label="Called" value={`${s.called.toLocaleString()} / ${s.total.toLocaleString()}`} sub={`${pct}% of list`} accent="text-slate-900" />
            <StatCard label="Reached" value={s.reached.toLocaleString()} sub={`${reachRate}% of calls answered`} accent="text-emerald-600" />
            <StatCard label="Appointments" value={(s.scheduled + s.wantsAppt).toLocaleString()} sub={`${s.scheduled} booked · ${s.wantsAppt} want one`} accent="text-green-600" />
            <StatCard label="Remaining" value={(s.total - s.called).toLocaleString()} sub={`${s.callback} callbacks queued`} accent="text-blue-600" />
          </div>
          <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full bg-gradient-to-r from-emerald-500 to-green-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-slate-500">
            <span>No answer: <b className="text-slate-700">{s.noAnswer}</b></span>
            <span>Voicemail: <b className="text-slate-700">{s.voicemail}</b></span>
            <span>Wrong #: <b className="text-slate-700">{s.wrongNumber}</b></span>
            <span>Not interested: <b className="text-slate-700">{s.notInterested}</b></span>
            <span>Do not call: <b className="text-slate-700">{s.doNotCall}</b></span>
            {s.byCaller.length > 0 && <span className="text-slate-400">·</span>}
            {s.byCaller.slice(0, 4).map((c) => <span key={c.name}>{c.name}: <b className="text-slate-700">{c.calls}</b> calls, {c.scheduled} booked</span>)}
          </div>
        </div>
      )}

      {/* ---- Toolbar ---- */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setLimit(100); }} placeholder="Search name or phone…"
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400" />
        </div>
        <button onClick={() => { setUncontactedOnly((v) => !v); setLimit(100); }}
          className={`px-3 py-2 rounded-xl text-sm font-semibold transition ${uncontactedOnly ? "bg-emerald-600 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
          Not yet called
        </button>
        <select value={callStatus} onChange={(e) => { setCallStatus(e.target.value); setLimit(100); }} className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white text-slate-700">
          <option value="">All call results</option>
          {(Object.keys(CALL_STATUS) as CallStatus[]).map((k) => <option key={k} value={k}>{CALL_STATUS[k].label}</option>)}
        </select>
        <select value={outcome} onChange={(e) => { setOutcome(e.target.value); setLimit(100); }} className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white text-slate-700">
          <option value="">All outcomes</option>
          {(Object.keys(OUTCOME) as Outcome[]).map((k) => <option key={k} value={k}>{OUTCOME[k].label}</option>)}
        </select>
        {(search || callStatus || outcome || uncontactedOnly) && (
          <button onClick={resetFilters} className="px-3 py-2 rounded-xl text-sm text-slate-500 hover:text-slate-700">Clear</button>
        )}
      </div>

      {/* ---- List ---- */}
      {list.isLoading && <div className="py-16 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>}
      {!list.isLoading && rows.length === 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 py-16 text-center">
          <PhoneOutgoing className="mx-auto text-slate-300 mb-3" size={32} />
          <p className="text-slate-400 font-light">{s && s.total === 0 ? "No contacts yet. Import your list to get started." : "No contacts match these filters."}</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                  <th className="px-4 py-3 font-medium">Patient</th>
                  <th className="px-4 py-3 font-medium">Phone</th>
                  <th className="px-4 py-3 font-medium">Language</th>
                  <th className="px-4 py-3 font-medium text-center">Att.</th>
                  <th className="px-4 py-3 font-medium">Last call</th>
                  <th className="px-4 py-3 font-medium">Result</th>
                  <th className="px-4 py-3 font-medium">Outcome</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ c, callerName }: any) => (
                  <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-800">{c.name}</div>
                      {c.dateOfBirth && <div className="text-xs text-slate-400">DOB {new Date(c.dateOfBirth).toLocaleDateString()}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <a href={`tel:${c.phoneNumber}`} className="inline-flex items-center gap-1.5 text-emerald-700 font-medium hover:underline"><Phone size={13} /> {c.phoneNumber || "—"}</a>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{c.language || "—"}</td>
                    <td className="px-4 py-3 text-center text-slate-500">{c.attempts || 0}</td>
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{c.lastCalledAt ? <span>{fmtDateTime(c.lastCalledAt)}{callerName ? <span className="text-slate-400"> · {callerName}</span> : null}</span> : "—"}</td>
                    <td className="px-4 py-3"><Badge map={CALL_STATUS} k={c.callStatus} /></td>
                    <td className="px-4 py-3">{c.outcome !== "pending" ? <Badge map={OUTCOME} k={c.outcome} /> : <span className="text-slate-300">—</span>}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setLogTarget(c)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:brightness-110 active:scale-95 transition">
                        <PhoneOutgoing size={13} /> Log call
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > rows.length && (
            <div className="p-4 text-center border-t border-slate-100">
              <button onClick={() => setLimit((l) => Math.min(l + 100, 500))} disabled={list.isFetching}
                className="px-4 py-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                {list.isFetching ? "Loading…" : `Load more (${rows.length} of ${total.toLocaleString()})`}
              </button>
            </div>
          )}
        </div>
      )}

      {logTarget && <LogCallModal contact={logTarget} onClose={() => setLogTarget(null)} onSave={(payload) => logCall.mutate({ id: logTarget.id, ...payload })} pending={logCall.isPending} />}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); utils.reachOut.list.invalidate(); utils.reachOut.stats.invalidate(); }} />}
    </CCMDashboardLayout>
  );
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-0.5 ${accent || "text-slate-900"}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function LogCallModal({ contact, onClose, onSave, pending }: { contact: any; onClose: () => void; onSave: (p: { callStatus: CallStatus; outcome?: Outcome; note?: string }) => void; pending: boolean }) {
  const [callStatus, setCallStatus] = useState<CallStatus | "">("");
  const [outcome, setOutcome] = useState<Outcome | "">("");
  const [note, setNote] = useState("");
  const reached = callStatus === "reached";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold text-slate-900">{contact.name}</h3>
            <a href={`tel:${contact.phoneNumber}`} className="inline-flex items-center gap-1.5 mt-1 text-emerald-700 font-semibold hover:underline"><Phone size={15} /> {contact.phoneNumber}</a>
            {contact.dateOfBirth && <span className="text-xs text-slate-400 ml-2">DOB {new Date(contact.dateOfBirth).toLocaleDateString()}</span>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X size={18} /></button>
        </div>

        <a href={`tel:${contact.phoneNumber}`} className="flex items-center justify-center gap-2 w-full py-3 mb-5 rounded-xl bg-emerald-600 text-white font-semibold hover:brightness-110 active:scale-[0.99] transition">
          <Phone size={16} /> Call {contact.phoneNumber}
        </a>

        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Call result</p>
        <select value={callStatus} onChange={(e) => { const v = e.target.value as CallStatus | ""; setCallStatus(v); if (v !== "reached") setOutcome(""); }}
          className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm bg-white text-slate-700 mb-4 focus:outline-none focus:ring-2 focus:ring-emerald-400">
          <option value="">Select a result…</option>
          {CALL_ORDER.map((k) => <option key={k} value={k}>{CALL_STATUS[k].label}</option>)}
        </select>

        {reached && (
          <div className="mb-4 animate-fade-in-up">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Do they want an appointment?</p>
            <div className="grid grid-cols-2 gap-2">
              {OUTCOME_ORDER.map((k) => {
                const info = OUTCOME[k]; const Icon = info.icon; const active = outcome === k;
                return (
                  <button key={k} onClick={() => setOutcome(k)}
                    className={`inline-flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-semibold border transition ${active ? "border-green-500 bg-green-50 text-green-800 ring-1 ring-green-400" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                    <Icon size={15} /> {info.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Note {reached && <span className="text-slate-400 normal-case font-normal">(e.g. "prefers mornings, booked 9/20 w/ Dr Mansour")</span>}</p>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Optional note…"
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-emerald-400 mb-4" />

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-500 hover:bg-slate-100">Cancel</button>
          <button disabled={!callStatus || pending} onClick={() => onSave({ callStatus: callStatus as CallStatus, outcome: reached && outcome ? (outcome as Outcome) : undefined, note: note.trim() || undefined })}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-40 transition">
            {pending ? <Loader2 size={15} className="animate-spin" /> : "Save call"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const doImport = trpc.reachOut.import.useMutation({
    onSuccess: (r) => { toast.success(`Imported ${r.imported.toLocaleString()} contacts`); onDone(); },
    onError: (e) => toast.error(e.message),
  });

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result || ""));
    reader.readAsText(f);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Import Reach Out list</h3>
            <p className="text-sm text-slate-500 mt-1">CSV with a header row. Recognized columns: <b>Name</b> (or First/Last), <b>Phone</b> (or Mobile), and optional <b>DOB</b>, <b>Insurance</b>, <b>Language</b>.</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X size={18} /></button>
        </div>

        <label className="flex items-center gap-2 px-4 py-2.5 mb-3 rounded-xl border border-dashed border-slate-300 text-sm text-slate-600 cursor-pointer hover:bg-slate-50">
          <Upload size={15} /> {fileName || "Choose a .csv file"}
          <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
        </label>
        <p className="text-xs text-slate-400 mb-1">…or paste CSV text:</p>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} placeholder={"Name,Phone,DOB,Insurance\nJane Doe,(832) 555-1234,01/15/1970,Aetna"}
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-emerald-400 mb-4" />

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-500 hover:bg-slate-100">Cancel</button>
          <button disabled={!csv.trim() || doImport.isPending} onClick={() => doImport.mutate({ csv })}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-40 transition">
            {doImport.isPending ? <Loader2 size={15} className="animate-spin" /> : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}

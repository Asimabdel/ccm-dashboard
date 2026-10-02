import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, MapPin, CalendarPlus, X } from "lucide-react";
import { fmtDay, fmtTime, localDateStr } from "@shared/workforce";
import { MyWeekCard } from "@/components/workforce/MyWeekCard";

export const TIME_OFF_TYPE: Record<string, string> = { pto: "PTO", sick: "Sick", unpaid: "Unpaid", other: "Other" };
export const TIME_OFF_STATUS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800", approved: "bg-emerald-100 text-emerald-800",
  denied: "bg-rose-100 text-rose-700", cancelled: "bg-slate-100 text-slate-500",
};
const inputCls = "w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400";

export default function MySchedulePage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const utils = trpc.useUtils();
  const sched = trpc.workforce.me.schedule.useQuery(undefined, { enabled: !!user });
  const [formOpen, setFormOpen] = useState(false);
  const today = localDateStr();
  const [form, setForm] = useState({ startDate: today, endDate: today, type: "pto" as "pto" | "sick" | "unpaid" | "other", reason: "" });

  const request = trpc.workforce.me.requestTimeOff.useMutation({
    onSuccess: () => { utils.workforce.me.schedule.invalidate(); setFormOpen(false); toast.success("Request sent to your manager"); },
    onError: (e) => toast.error(e.message),
  });
  const cancel = trpc.workforce.me.cancelTimeOff.useMutation({
    onSuccess: () => { utils.workforce.me.schedule.invalidate(); toast.success("Request cancelled"); },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;

  const shifts = sched.data?.shifts || [];
  const timeOff = sched.data?.timeOff || [];

  return (
    <CCMDashboardLayout title="My Schedule">
      <div className="grid lg:grid-cols-2 gap-5">
        <MyWeekCard />
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-soft">
          <h2 className="text-lg font-bold tracking-tight text-slate-900">Next 4 weeks</h2>
          {sched.isLoading && <Loader2 className="animate-spin text-slate-400 mt-4" />}
          {!sched.isLoading && shifts.length === 0 && <p className="mt-4 text-sm text-slate-500">No shifts scheduled yet.</p>}
          <ul className="mt-4 space-y-2">
            {shifts.map((s) => (
              <li key={s.id} className={`flex items-center justify-between gap-3 rounded-2xl px-4 py-3 border ${s.status === "called_out" ? "bg-rose-50 border-rose-200" : s.date === today ? "bg-emerald-50 border-emerald-200" : "bg-slate-50 border-slate-200"}`}>
                <div>
                  <p className="text-sm font-semibold text-slate-800">{fmtDay(s.date)}{s.date === today && <span className="ml-2 text-[10px] uppercase tracking-widest text-emerald-700">Today</span>}</p>
                  <p className="flex items-center gap-1 text-xs text-slate-500 mt-0.5"><MapPin size={11} /> {s.clinicName}{s.coversShiftId ? " · coverage" : ""}{s.status === "called_out" ? " · called out" : ""}</p>
                </div>
                <p className="text-sm font-medium text-slate-700 whitespace-nowrap">{fmtTime(s.startTime)} – {fmtTime(s.endTime)}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-soft">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold tracking-tight text-slate-900">Time off</h2>
            <button onClick={() => setFormOpen((v) => !v)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.98] transition">
              {formOpen ? <X size={15} /> : <CalendarPlus size={15} />} {formOpen ? "Close" : "Request time off"}
            </button>
          </div>

          {formOpen && (
            <form className="mt-4 p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-3"
              onSubmit={(e) => { e.preventDefault(); request.mutate({ ...form, reason: form.reason.trim() || undefined }); }}>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-semibold text-slate-600">First day
                  <input type="date" required min={today} value={form.startDate} className={`${inputCls} mt-1`}
                    onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value, endDate: f.endDate < e.target.value ? e.target.value : f.endDate }))} />
                </label>
                <label className="text-xs font-semibold text-slate-600">Last day
                  <input type="date" required min={form.startDate} value={form.endDate} className={`${inputCls} mt-1`}
                    onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
                </label>
              </div>
              <label className="block text-xs font-semibold text-slate-600">Type
                <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as typeof f.type }))} className={`${inputCls} mt-1`}>
                  {Object.entries(TIME_OFF_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="block text-xs font-semibold text-slate-600">Note for your manager (optional)
                <textarea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} rows={2} className={`${inputCls} mt-1`}
                  placeholder="Please don't include medical details." />
              </label>
              <button type="submit" disabled={request.isPending} className="w-full px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60">
                {request.isPending ? "Sending…" : "Send request"}
              </button>
            </form>
          )}

          {timeOff.length === 0 && !formOpen && <p className="mt-4 text-sm text-slate-500">No time-off requests yet.</p>}
          <ul className="mt-4 space-y-2">
            {timeOff.map((r) => (
              <li key={r.id} className="rounded-2xl px-4 py-3 border border-slate-200">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">{fmtDay(r.startDate)}{r.endDate !== r.startDate && ` → ${fmtDay(r.endDate)}`} <span className="font-normal text-slate-500">· {TIME_OFF_TYPE[r.type]}</span></p>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold capitalize ${TIME_OFF_STATUS[r.status]}`}>{r.status}</span>
                </div>
                {r.managerNote && <p className="text-xs text-slate-500 mt-1">Manager: {r.managerNote}</p>}
                {(r.status === "pending" || (r.status === "approved" && r.startDate > today)) && (
                  <button onClick={() => cancel.mutate(r.id)} className="mt-1 text-xs text-slate-400 hover:text-rose-600">Cancel request</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}

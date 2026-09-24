import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, LogIn, LogOut, CheckCircle2, Circle, MapPin, Clock, ClipboardCheck, BookOpen } from "lucide-react";
import { fmtDay, fmtDuration, fmtTime, type DutyFrequency } from "@shared/workforce";

const FREQ_LABEL: Record<DutyFrequency, string> = {
  daily: "Today", weekly: "This week", monthly: "This month", as_needed: "As needed",
};

const clockTime = (d: Date | string) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

export default function MyDayPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const utils = trpc.useUtils();
  const day = trpc.workforce.me.today.useQuery(undefined, { enabled: !!user, refetchInterval: 60000 });

  // Tick once a minute so the "on the clock" timer stays live.
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  const refresh = () => utils.workforce.me.today.invalidate();
  const clockIn = trpc.workforce.me.clockIn.useMutation({
    onSuccess: (r) => { refresh(); r.minutesLate > 0 ? toast.warning(`Clocked in — ${r.minutesLate} min after your shift start`) : toast.success("Clocked in. Have a great shift!"); },
    onError: (e) => toast.error(e.message),
  });
  const clockOut = trpc.workforce.me.clockOut.useMutation({
    onSuccess: () => { refresh(); toast.success("Clocked out"); },
    onError: (e) => toast.error(e.message),
  });
  const toggle = trpc.workforce.me.toggleDuty.useMutation({
    // Optimistic check-off so the list feels instant on a busy clinic floor.
    onMutate: async ({ dutyId, done }) => {
      await utils.workforce.me.today.cancel();
      const prev = utils.workforce.me.today.getData();
      utils.workforce.me.today.setData(undefined, (d) => d && { ...d, duties: d.duties.map((x) => (x.id === dutyId ? { ...x, done } : x)) });
      return { prev };
    },
    onError: (e, _v, c) => { if (c?.prev) utils.workforce.me.today.setData(undefined, c.prev); toast.error(e.message); },
    onSettled: refresh,
  });

  const d = day.data;
  const grouped = useMemo(() => {
    const tracked = (d?.duties || []).filter((x) => x.frequency !== "as_needed");
    const out: { freq: DutyFrequency; categories: { name: string; items: typeof tracked }[] }[] = [];
    for (const freq of ["daily", "weekly", "monthly"] as DutyFrequency[]) {
      const items = tracked.filter((x) => x.frequency === freq);
      if (!items.length) continue;
      const names = Array.from(new Set(items.map((x) => x.category)));
      out.push({ freq, categories: names.map((name) => ({ name, items: items.filter((x) => x.category === name) })) });
    }
    return out;
  }, [d]);

  if (loading || !user || day.isLoading) return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;

  const open = d?.openPunch;
  const workedMin = (d?.punches || []).reduce((s, p) => s + Math.max(0, Math.round(((p.clockOutAt ? +new Date(p.clockOutAt) : now) - +new Date(p.clockInAt)) / 60000)), 0);
  const daily = (d?.duties || []).filter((x) => x.frequency === "daily");
  const dailyDone = daily.filter((x) => x.done).length;
  const pct = daily.length ? Math.round((dailyDone / daily.length) * 100) : 0;
  const reference = (d?.duties || []).filter((x) => x.frequency === "as_needed");
  const busy = clockIn.isPending || clockOut.isPending;

  return (
    <CCMDashboardLayout title="My Day">
      <div className="grid lg:grid-cols-3 gap-5">
        {/* ---- Time clock ---- */}
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-soft">
          <p className="text-xs uppercase tracking-widest text-slate-400 font-medium">{d ? fmtDay(d.today, { weekday: "long", month: "long", day: "numeric" }) : ""}</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">Hi {user.name?.split(" ")[0] || "there"}</h2>

          <div className="mt-4 space-y-2">
            {(d?.shifts || []).length === 0 && <p className="text-sm text-slate-500">You're not on the schedule today.</p>}
            {(d?.shifts || []).map((s) => (
              <div key={s.id} className={`rounded-2xl px-4 py-3 border ${s.status === "called_out" ? "bg-rose-50 border-rose-200" : "bg-slate-50 border-slate-200"}`}>
                <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800"><Clock size={14} /> {fmtTime(s.startTime)} – {fmtTime(s.endTime)}</p>
                <p className="flex items-center gap-1.5 text-xs text-slate-500 mt-0.5"><MapPin size={12} /> {s.clinicName}{s.coversShiftId ? " · coverage shift" : ""}{s.status === "called_out" ? " · called out" : ""}</p>
              </div>
            ))}
          </div>

          <button
            onClick={() => (open ? clockOut.mutate() : clockIn.mutate())}
            disabled={busy}
            className={`mt-5 w-full inline-flex items-center justify-center gap-2 px-5 py-4 rounded-2xl text-white text-lg font-bold active:scale-[0.98] transition disabled:opacity-60 ${open ? "bg-slate-900 hover:bg-slate-800" : "bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700"}`}
          >
            {busy ? <Loader2 size={20} className="animate-spin" /> : open ? <LogOut size={20} /> : <LogIn size={20} />}
            {open ? "Clock out" : "Clock in"}
          </button>
          <p className="mt-3 text-center text-sm text-slate-500">
            {open ? <>On the clock since <b className="text-slate-800">{clockTime(open.clockInAt)}</b></> : workedMin > 0 ? "You're clocked out." : "Not clocked in yet."}
            {workedMin > 0 && <> · <b className="text-slate-800">{fmtDuration(workedMin)}</b> today</>}
          </p>
          {(d?.punches || []).length > 0 && (
            <ul className="mt-3 pt-3 border-t border-slate-100 space-y-1 text-xs text-slate-500">
              {d!.punches.map((p) => (
                <li key={p.id} className="flex justify-between">
                  <span>{clockTime(p.clockInAt)} → {p.clockOutAt ? clockTime(p.clockOutAt) : "now"}</span>
                  {p.minutesLate > 0 && <span className="text-amber-600 font-medium">{p.minutesLate} min late</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ---- Checklist ---- */}
        <div className="lg:col-span-2 bg-white rounded-3xl border border-slate-200 p-6 shadow-soft">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-slate-900"><ClipboardCheck size={18} /> {d?.jobRole?.name ?? "My responsibilities"}</h2>
              {d?.homeClinicName && <p className="text-xs text-slate-400 mt-0.5">Home clinic: {d.homeClinicName}</p>}
            </div>
            {daily.length > 0 && <span className="text-sm font-semibold text-slate-700">{dailyDone} / {daily.length} daily duties · {pct}%</span>}
          </div>
          {daily.length > 0 && (
            <div className="mt-3 h-2 w-full rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-emerald-500 to-green-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}

          {!d?.jobRole && (
            <p className="mt-6 text-sm text-slate-500">Your manager hasn't assigned your job role yet. Once they do, your responsibilities and daily checklist will show up here. You can still clock in and out.</p>
          )}
          {d?.jobRole?.summary && <p className="mt-4 text-sm text-slate-600 leading-relaxed">{d.jobRole.summary}</p>}

          {grouped.map((g) => (
            <div key={g.freq} className="mt-6">
              <p className="text-[11px] uppercase tracking-widest font-semibold text-slate-400 mb-2">{FREQ_LABEL[g.freq]}</p>
              {g.categories.map((c) => (
                <div key={c.name} className="mb-3">
                  <p className="text-xs font-semibold text-slate-500 mb-1">{c.name}</p>
                  <div className="space-y-1">
                    {c.items.map((x) => (
                      <button key={x.id} onClick={() => toggle.mutate({ dutyId: x.id, done: !x.done })}
                        className={`w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-xl border transition ${x.done ? "bg-emerald-50/70 border-emerald-200" : "bg-white border-slate-200 hover:bg-slate-50"}`}>
                        {x.done ? <CheckCircle2 size={20} className="text-emerald-600 shrink-0 mt-0.5" /> : <Circle size={20} className="text-slate-300 shrink-0 mt-0.5" />}
                        <span>
                          <span className={`block text-sm font-medium ${x.done ? "text-slate-500 line-through" : "text-slate-800"}`}>{x.title}</span>
                          {x.detail && <span className="block text-xs text-slate-500 mt-0.5">{x.detail}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}

          {reference.length > 0 && (
            <div className="mt-6 pt-5 border-t border-slate-100">
              <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest font-semibold text-slate-400 mb-2"><BookOpen size={12} /> Also part of your role (as needed)</p>
              <ul className="space-y-2">
                {reference.map((x) => (
                  <li key={x.id} className="text-sm">
                    <span className="font-medium text-slate-800">{x.title}</span>
                    {x.detail && <span className="block text-xs text-slate-500">{x.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </CCMDashboardLayout>
  );
}

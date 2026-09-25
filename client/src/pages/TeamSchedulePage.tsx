import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Loader2, MapPin, Radio } from "lucide-react";
import { addDays, fmtDay, fmtTime, localDateStr, weekDates, weekStart } from "@shared/workforce";

const btn = "inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:bg-slate-50 transition";
const shortTime = (t: string) => fmtTime(t).replace(":00", "");

/**
 * Everyone's schedule, for everyone: who works where this week and who is in right now.
 * Lateness, punch times and time-off reasons are manager-only and never reach this page.
 */
export default function TeamSchedulePage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const today = localDateStr();
  const [monday, setMonday] = useState(weekStart(today));
  const [clinicId, setClinicId] = useState<number | "all">("all");
  const [mobileDay, setMobileDay] = useState(today);
  const days = weekDates(monday);
  const week = trpc.workforce.team.week.useQuery({ from: days[0], to: days[6] }, { enabled: !!user, refetchInterval: 60000 });
  // Today's panel has its own query so it stays put while you browse other weeks.
  const todayQ = trpc.workforce.team.week.useQuery({ from: today, to: today }, { enabled: !!user, refetchInterval: 60000 });

  const d = week.data;
  const clinicName = useMemo(() => new Map((d?.clinics || []).map((c) => [c.id, c.name])), [d]);
  const shifts = (d?.shifts || []).filter((s) => clinicId === "all" || s.clinicId === clinicId);
  const offDays = d?.offDays || [];
  const isOff = (userId: number, date: string) => offDays.some((o) => o.userId === userId && o.date === date);
  // With a clinic picked: people working there this week, plus that clinic's own staff who are off.
  const rows = (d?.people || []).filter((p) => clinicId === "all" || shifts.some((s) => s.userId === p.userId) || (p.homeClinicId === clinicId && offDays.some((o) => o.userId === p.userId)));
  // Everyone working today, by clinic: their shift, plus an "In" tag once they've clocked in.
  const t = todayQ.data;
  const todayGroups = useMemo(() => {
    if (!t) return [];
    const inNow = new Map(t.workingNow.map((w) => [w.userId, w]));
    const person = new Map(t.people.map((p) => [p.userId, p]));
    const groups = new Map<number | null, { name: string; rows: { userId: number; name: string; role: string | null; time: string | null; out: boolean; isIn: boolean }[] }>();
    const add = (cid: number | null, row: { userId: number; name: string; role: string | null; time: string | null; out: boolean; isIn: boolean }) => {
      if (clinicId !== "all" && cid !== clinicId) return;
      const g = groups.get(cid) ?? { name: cid ? t.clinics.find((c) => c.id === cid)?.name ?? "Clinic" : "No clinic", rows: [] };
      if (!g.rows.some((r) => r.userId === row.userId)) g.rows.push(row);
      groups.set(cid, g);
    };
    for (const sh of t.shifts) {
      const p = person.get(sh.userId);
      add(sh.clinicId, { userId: sh.userId, name: p?.name ?? "Someone", role: p?.jobRoleName ?? null, time: `${shortTime(sh.startTime)} – ${shortTime(sh.endTime)}`, out: sh.out, isIn: inNow.has(sh.userId) });
    }
    // Clocked in without a shift today (e.g. covering or extra hours).
    for (const w of t.workingNow) {
      if (!t.shifts.some((sh) => sh.userId === w.userId && !sh.out)) add(w.clinicId, { userId: w.userId, name: w.name, role: w.jobRoleName, time: null, out: false, isIn: true });
    }
    return Array.from(groups.values())
      .map((g) => ({ ...g, rows: g.rows.sort((a, b) => Number(a.out) - Number(b.out) || a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [t, clinicId]);
  const todayWorking = todayGroups.reduce((n, g) => n + g.rows.filter((r) => !r.out).length, 0);
  const todayIn = todayGroups.reduce((n, g) => n + g.rows.filter((r) => r.isIn).length, 0);
  const todayOff = (t?.people || []).filter((p) => t?.offDays.some((o) => o.userId === p.userId) && (clinicId === "all" || p.homeClinicId === clinicId));

  if (loading || !user) return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;

  const showDay = days.includes(mobileDay) ? mobileDay : days[0];
  const dayShifts = shifts.filter((s) => s.date === showDay);
  const dayByClinic = Array.from(new Set(dayShifts.map((s) => s.clinicId))).map((cid) => ({ cid, name: clinicName.get(cid) ?? "Clinic", items: dayShifts.filter((s) => s.clinicId === cid) })).sort((a, b) => a.name.localeCompare(b.name));
  const dayOff = rows.filter((p) => isOff(p.userId, showDay));
  const personName = (id: number) => d?.people.find((p) => p.userId === id)?.name ?? "Someone";

  return (
    <CCMDashboardLayout title="Team Schedule">
      {/* ---- Working today ---- */}
      <div className="bg-white rounded-3xl border border-slate-200 p-5 shadow-soft mb-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-slate-900">
            <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" /></span>
            Working today <span className="text-sm font-medium text-slate-400">{fmtDay(today, { weekday: "long", month: "short", day: "numeric" })}</span>
          </h2>
          <span className="text-sm text-slate-500">{todayWorking} working · {todayIn} clocked in</span>
        </div>
        {todayQ.isLoading && <Loader2 className="animate-spin text-slate-400 mt-3" />}
        {!todayQ.isLoading && todayGroups.length === 0 && <p className="mt-3 text-sm text-slate-500">No one is on the schedule today.</p>}
        {todayGroups.length > 0 && (
          <div className="mt-4 grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {todayGroups.map((g) => (
              <div key={g.name} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-700"><MapPin size={12} /> {g.name} <span className="ml-auto text-slate-500">{g.rows.filter((r) => !r.out).length}</span></p>
                <ul className="mt-2 space-y-1.5">
                  {g.rows.map((r) => (
                    <li key={r.userId} className={`text-sm ${r.out ? "opacity-60" : ""}`}>
                      <span className="flex items-center gap-1.5">
                        <span className={`font-semibold text-slate-800 truncate ${r.out ? "line-through" : ""}`}>{r.name}</span>
                        {r.userId === user.id && <span className="text-[10px] uppercase tracking-widest text-amber-700">You</span>}
                        {r.isIn && <span className="ml-auto shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-semibold"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />In</span>}
                        {r.out && <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-600 text-[10px] font-semibold">Out</span>}
                      </span>
                      <span className="block text-xs text-slate-500">{r.role ?? "Team member"}{r.time ? ` · ${r.time}` : " · extra hours"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {todayOff.length > 0 && <p className="mt-3 text-xs text-slate-500"><b className="text-slate-600">Off today:</b> {todayOff.map((p) => p.name).join(", ")}</p>}
        <p className="mt-3 text-[11px] text-slate-400 flex items-center gap-1"><Radio size={11} /> "In" means they clocked in on the time clock. Updates every minute.</p>
      </div>

      {/* ---- Week ---- */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button className={btn} onClick={() => setMonday(addDays(monday, -7))} aria-label="Previous week">←</button>
        <span className="text-sm font-semibold text-slate-800 min-w-[170px] text-center">{fmtDay(days[0], { month: "short", day: "numeric" })} – {fmtDay(days[6], { month: "short", day: "numeric", year: "numeric" })}</span>
        <button className={btn} onClick={() => setMonday(addDays(monday, 7))} aria-label="Next week">→</button>
        {monday !== weekStart(today) && <button className={btn} onClick={() => { setMonday(weekStart(today)); setMobileDay(today); }}>This week</button>}
        <select value={clinicId} onChange={(e) => setClinicId(e.target.value === "all" ? "all" : Number(e.target.value))}
          className="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400">
          <option value="all">All clinics</option>
          {(d?.clinics || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {!week.isLoading && rows.length === 0 && (
        <p className="text-sm text-slate-500 bg-white border border-slate-200 rounded-2xl p-5">No one is on the schedule {clinicId === "all" ? "" : "at this clinic "}this week yet.</p>
      )}

      {rows.length > 0 && (
        <>
          {/* Desktop / tablet: people × days */}
          <div className="hidden md:block bg-white rounded-3xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm min-w-[860px] table-fixed">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-4 py-3 text-xs uppercase tracking-widest font-medium text-slate-400 w-48">Team member</th>
                  {days.map((day) => (
                    <th key={day} className={`px-2 py-3 text-xs font-semibold text-center ${day === today ? "text-emerald-700 bg-emerald-50/60" : "text-slate-600"}`}>{fmtDay(day, { weekday: "short", day: "numeric" })}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const mine = shifts.filter((s) => s.userId === p.userId);
                  const me = p.userId === user.id;
                  return (
                    <tr key={p.userId} className={`border-b border-slate-100 last:border-0 align-top ${me ? "bg-amber-50/40" : ""}`}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-800 truncate">{p.name}{me && <span className="ml-1.5 text-[10px] uppercase tracking-widest text-amber-700">You</span>}</p>
                        <p className="text-xs text-slate-400 truncate">{p.jobRoleName ?? "Team member"}</p>
                      </td>
                      {days.map((day) => {
                        const cell = mine.filter((s) => s.date === day);
                        const off = isOff(p.userId, day);
                        return (
                          <td key={day} className={`px-1.5 py-2 ${day === today ? "bg-emerald-50/40" : ""}`}>
                            <div className="space-y-1 min-h-[36px]">
                              {off && <div className="px-2 py-1 rounded-lg text-[11px] font-semibold text-center bg-slate-100 text-slate-500">Off</div>}
                              {cell.map((s) => (
                                <div key={s.id} className={`px-2 py-1 rounded-lg text-[11px] leading-tight border ${s.out ? "bg-slate-50 border-slate-200 text-slate-400" : "bg-emerald-50 border-emerald-200 text-emerald-900"}`}>
                                  <span className={`block font-semibold ${s.out ? "line-through" : ""}`}>{shortTime(s.startTime)} – {shortTime(s.endTime)}</span>
                                  {s.out ? <span className="block font-semibold">Out</span> : clinicId === "all" && <span className="block truncate opacity-80">{clinicName.get(s.clinicId)}</span>}
                                </div>
                              ))}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Phone: one day at a time, grouped by clinic */}
          <div className="md:hidden">
            <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1">
              {days.map((day) => (
                <button key={day} onClick={() => setMobileDay(day)}
                  className={`shrink-0 px-3 py-2 rounded-xl text-xs font-semibold border ${day === showDay ? "bg-slate-900 text-white border-slate-900" : day === today ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-white text-slate-600 border-slate-200"}`}>
                  {fmtDay(day, { weekday: "short", day: "numeric" })}
                </button>
              ))}
            </div>
            <div className="mt-3 space-y-3">
              {dayByClinic.length === 0 && <p className="text-sm text-slate-500 bg-white border border-slate-200 rounded-2xl p-4">No one is scheduled on {fmtDay(showDay)}.</p>}
              {dayByClinic.map((g) => (
                <div key={g.cid} className="bg-white rounded-2xl border border-slate-200 p-4">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-500"><MapPin size={12} /> {g.name}</p>
                  <ul className="mt-2 divide-y divide-slate-100">
                    {g.items.map((s) => (
                      <li key={s.id} className="flex items-center justify-between py-2 text-sm">
                        <span className={`font-medium ${s.out ? "text-slate-400 line-through" : "text-slate-800"}`}>{personName(s.userId)}{s.userId === user.id && <span className="ml-1 text-[10px] uppercase tracking-widest text-amber-700 no-underline">You</span>}</span>
                        <span className={s.out ? "text-xs font-semibold text-slate-400" : "text-slate-600 whitespace-nowrap"}>{s.out ? "Out" : `${shortTime(s.startTime)} – ${shortTime(s.endTime)}`}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {dayOff.length > 0 && <p className="text-xs text-slate-500 px-1"><b className="text-slate-600">Off:</b> {dayOff.map((p) => p.name).join(", ")}</p>}
            </div>
          </div>
        </>
      )}
    </CCMDashboardLayout>
  );
}

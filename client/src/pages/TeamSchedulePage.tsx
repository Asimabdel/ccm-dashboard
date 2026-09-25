import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { Fragment, useMemo, useState } from "react";
import { Loader2, MapPin, Radio, Stethoscope, Users } from "lucide-react";
import { addDays, fmtDay, fmtTime, localDateStr, weekDates, weekStart } from "@shared/workforce";

const btn = "inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:bg-slate-50 transition";
const shortTime = (t: string) => fmtTime(t).replace(":00", "");
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/** Providers first, then everyone else — the two sections inside every clinic. */
function splitByRole<T extends { isProvider: boolean }>(items: T[]) {
  return [
    { key: "providers", label: "Providers", icon: Stethoscope, items: items.filter((x) => x.isProvider) },
    { key: "staff", label: "Staff", icon: Users, items: items.filter((x) => !x.isProvider) },
  ].filter((s) => s.items.length > 0);
}

function SectionLabel({ icon: Icon, label, count }: { icon: React.ElementType; label: string; count: number }) {
  return (
    <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
      <Icon size={11} /> {label} <span className="text-slate-300">·</span> {count}
    </p>
  );
}

interface TodayRow { userId: number; name: string; role: string | null; time: string | null; out: boolean; isIn: boolean; isProvider: boolean }

/**
 * Everyone's schedule, for everyone: who works where, grouped by clinic with providers
 * and staff in separate sections, plus who is in right now. Lateness, punch times and
 * time-off reasons are manager-only and never reach this page.
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

  // ---- Working today: clinic → providers / staff ----
  const t = todayQ.data;
  const todayGroups = useMemo(() => {
    if (!t) return [];
    const inNow = new Set(t.workingNow.map((w) => w.userId));
    const person = new Map(t.people.map((p) => [p.userId, p]));
    const groups = new Map<number | null, { name: string; rows: TodayRow[] }>();
    const add = (cid: number | null, row: TodayRow) => {
      if (clinicId !== "all" && cid !== clinicId) return;
      const g = groups.get(cid) ?? { name: cid ? t.clinics.find((c) => c.id === cid)?.name ?? "Clinic" : "No clinic", rows: [] };
      if (!g.rows.some((r) => r.userId === row.userId)) g.rows.push(row);
      groups.set(cid, g);
    };
    for (const sh of t.shifts) {
      const p = person.get(sh.userId);
      add(sh.clinicId, { userId: sh.userId, name: p?.name ?? "Someone", role: p?.jobRoleName ?? null, time: `${shortTime(sh.startTime)} – ${shortTime(sh.endTime)}`, out: sh.out, isIn: inNow.has(sh.userId), isProvider: !!p?.isProvider });
    }
    // Clocked in without a shift today (e.g. covering or extra hours).
    for (const w of t.workingNow) {
      if (!t.shifts.some((sh) => sh.userId === w.userId && !sh.out)) add(w.clinicId, { userId: w.userId, name: w.name, role: w.jobRoleName, time: null, out: false, isIn: true, isProvider: w.isProvider });
    }
    return Array.from(groups.values())
      .map((g) => ({ ...g, rows: g.rows.sort((a, b) => Number(a.out) - Number(b.out) || byName(a, b)) }))
      .sort(byName);
  }, [t, clinicId]);
  const todayWorking = todayGroups.reduce((n, g) => n + g.rows.filter((r) => !r.out).length, 0);
  const todayIn = todayGroups.reduce((n, g) => n + g.rows.filter((r) => r.isIn).length, 0);
  const todayOff = (t?.people || []).filter((p) => t?.offDays.some((o) => o.userId === p.userId) && (clinicId === "all" || p.homeClinicId === clinicId));

  // ---- The week: clinic → providers / staff → one row per person ----
  const d = week.data;
  const offDays = d?.offDays || [];
  const isOff = (userId: number, date: string) => offDays.some((o) => o.userId === userId && o.date === date);
  const weekSections = useMemo(() => {
    if (!d) return [];
    const byClinic = new Map<number | null, Set<number>>();
    const put = (cid: number | null, userId: number) => byClinic.set(cid, (byClinic.get(cid) ?? new Set()).add(userId));
    // Someone who works at two clinics this week appears under both, with that clinic's shifts.
    for (const s of d.shifts) put(s.clinicId, s.userId);
    // Off all week with no shifts: list them under their home clinic.
    for (const o of d.offDays) if (!d.shifts.some((s) => s.userId === o.userId)) put(d.people.find((p) => p.userId === o.userId)?.homeClinicId ?? null, o.userId);
    return Array.from(byClinic.entries())
      .filter(([cid]) => clinicId === "all" || cid === clinicId)
      .map(([cid, ids]) => ({
        cid,
        name: cid ? d.clinics.find((c) => c.id === cid)?.name ?? "Clinic" : "No clinic",
        people: d.people.filter((p) => ids.has(p.userId)).sort(byName),
      }))
      .sort(byName);
  }, [d, clinicId]);

  if (loading || !user) return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;

  const showDay = days.includes(mobileDay) ? mobileDay : days[0];
  const person = (id: number) => d?.people.find((p) => p.userId === id);
  const dayGroups = weekSections
    .map((sec) => ({
      ...sec,
      shifts: (d?.shifts || []).filter((s) => s.date === showDay && s.clinicId === sec.cid)
        .map((s) => ({ ...s, name: person(s.userId)?.name ?? "Someone", isProvider: !!person(s.userId)?.isProvider }))
        .sort((a, b) => Number(a.out) - Number(b.out) || byName(a, b)),
    }))
    .filter((g) => g.shifts.length > 0);
  const dayOff = (d?.people || []).filter((p) => isOff(p.userId, showDay) && (clinicId === "all" || p.homeClinicId === clinicId));

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
                {splitByRole(g.rows).map((sec) => (
                  <div key={sec.key} className="mt-3">
                    <SectionLabel icon={sec.icon} label={sec.label} count={sec.items.length} />
                    <ul className="mt-1.5 space-y-1.5">
                      {sec.items.map((r) => (
                        <li key={r.userId} className={`text-sm ${r.out ? "opacity-60" : ""}`}>
                          <span className="flex items-center gap-1.5">
                            <span className={`font-semibold text-slate-800 truncate ${r.out ? "line-through" : ""}`}>{r.name}</span>
                            {r.userId === user.id && <span className="text-[10px] uppercase tracking-widest text-amber-700">You</span>}
                            {r.isIn && <span className="ml-auto shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-semibold"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />In</span>}
                            {r.out && <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-600 text-[10px] font-semibold">Out</span>}
                          </span>
                          <span className="block text-xs text-slate-500">{r.role ?? (r.isProvider ? "Provider" : "Team member")}{r.time ? ` · ${r.time}` : " · extra hours"}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
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
          {(d?.clinics || t?.clinics || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {week.isLoading && <Loader2 className="animate-spin text-slate-400" />}
      {!week.isLoading && weekSections.length === 0 && (
        <p className="text-sm text-slate-500 bg-white border border-slate-200 rounded-2xl p-5">No one is on the schedule {clinicId === "all" ? "" : "at this clinic "}this week yet.</p>
      )}

      {weekSections.length > 0 && (
        <>
          {/* Desktop / tablet: clinic → providers / staff → person × day */}
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
                {weekSections.map((sec) => (
                  <Fragment key={sec.cid ?? "none"}>
                    <tr className="bg-slate-100/80 border-y border-slate-200">
                      <td colSpan={8} className="px-4 py-2.5">
                        <span className="flex items-center gap-1.5 font-bold text-slate-900"><MapPin size={14} className="text-slate-400" /> {sec.name}
                          <span className="ml-2 text-xs font-medium text-slate-500">{sec.people.length} {sec.people.length === 1 ? "person" : "people"}</span>
                        </span>
                      </td>
                    </tr>
                    {splitByRole(sec.people).map((grp) => (
                      <Fragment key={grp.key}>
                        <tr className="border-b border-slate-100">
                          <td colSpan={8} className="px-4 pt-3 pb-1.5"><SectionLabel icon={grp.icon} label={grp.label} count={grp.items.length} /></td>
                        </tr>
                        {grp.items.map((p) => {
                          const mine = (d?.shifts || []).filter((s) => s.userId === p.userId && s.clinicId === sec.cid);
                          const me = p.userId === user.id;
                          return (
                            <tr key={p.userId} className={`border-b border-slate-100 align-top ${me ? "bg-amber-50/40" : ""}`}>
                              <td className="px-4 py-3">
                                <p className="font-semibold text-slate-800 truncate">{p.name}{me && <span className="ml-1.5 text-[10px] uppercase tracking-widest text-amber-700">You</span>}</p>
                                <p className="text-xs text-slate-400 truncate">{p.jobRoleName ?? (p.isProvider ? "Provider" : "Team member")}</p>
                              </td>
                              {days.map((day) => {
                                const cell = mine.filter((s) => s.date === day);
                                const off = isOff(p.userId, day);
                                return (
                                  <td key={day} className={`px-1.5 py-2 ${day === today ? "bg-emerald-50/40" : ""}`}>
                                    <div className="space-y-1 min-h-[32px]">
                                      {off && <div className="px-2 py-1 rounded-lg text-[11px] font-semibold text-center bg-slate-100 text-slate-500">Off</div>}
                                      {cell.map((s) => (
                                        <div key={s.id} className={`px-2 py-1 rounded-lg text-[11px] leading-tight border text-center ${s.out ? "bg-slate-50 border-slate-200 text-slate-400" : p.isProvider ? "bg-blue-50 border-blue-200 text-blue-900" : "bg-emerald-50 border-emerald-200 text-emerald-900"}`}>
                                          <span className={`block font-semibold ${s.out ? "line-through" : ""}`}>{shortTime(s.startTime)} – {shortTime(s.endTime)}</span>
                                          {s.out && <span className="block font-semibold">Out</span>}
                                        </div>
                                      ))}
                                    </div>
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone: one day at a time — clinic → providers / staff */}
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
              {dayGroups.length === 0 && <p className="text-sm text-slate-500 bg-white border border-slate-200 rounded-2xl p-4">No one is scheduled on {fmtDay(showDay)}.</p>}
              {dayGroups.map((g) => (
                <div key={g.cid ?? "none"} className="bg-white rounded-2xl border border-slate-200 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-bold text-slate-900"><MapPin size={13} className="text-slate-400" /> {g.name}</p>
                  {splitByRole(g.shifts).map((sec) => (
                    <div key={sec.key} className="mt-3">
                      <SectionLabel icon={sec.icon} label={sec.label} count={sec.items.length} />
                      <ul className="mt-1 divide-y divide-slate-100">
                        {sec.items.map((s) => (
                          <li key={s.id} className="flex items-center justify-between py-2 text-sm">
                            <span className={`font-medium ${s.out ? "text-slate-400 line-through" : "text-slate-800"}`}>{s.name}{s.userId === user.id && <span className="ml-1 text-[10px] uppercase tracking-widest text-amber-700 no-underline">You</span>}</span>
                            <span className={s.out ? "text-xs font-semibold text-slate-400" : "text-slate-600 whitespace-nowrap"}>{s.out ? "Out" : `${shortTime(s.startTime)} – ${shortTime(s.endTime)}`}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
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

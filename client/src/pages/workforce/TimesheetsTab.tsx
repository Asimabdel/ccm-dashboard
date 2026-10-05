import { trpc } from "@/lib/trpc";
import { Fragment, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Download, Loader2, Plus } from "lucide-react";
import { addDays, fmtDay, fmtDuration, localDateStr, weekStart } from "@shared/workforce";
import { StatCard, btnGhost, inputCls } from "./ui";
import { PayPeriodsPanel } from "./PayPeriodsPanel";
import { AddTimeDialog, DayPanel, NeedsFixingPanel, PunchDays } from "./PunchFixing";

type Preset = "this_week" | "last_week" | "two_weeks" | "this_month" | "last_month" | "custom";

function presetRange(p: Exclude<Preset, "custom">, today: string): { from: string; to: string } {
  const monday = weekStart(today);
  const monthStart = `${today.slice(0, 8)}01`;
  switch (p) {
    case "this_week": return { from: monday, to: addDays(monday, 6) };
    case "last_week": return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case "two_weeks": return { from: addDays(monday, -7), to: addDays(monday, 6) };
    case "this_month": return { from: monthStart, to: today };
    case "last_month": {
      const end = addDays(monthStart, -1);
      return { from: `${end.slice(0, 8)}01`, to: end };
    }
  }
}

const PRESETS: { key: Exclude<Preset, "custom">; label: string }[] = [
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "two_weeks", label: "Last 2 weeks" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
];

const clockTime = (d: Date | string) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
const hours = (mins: number) => (mins / 60).toFixed(2);
const csvEscape = (v: unknown) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function downloadCsv(name: string, header: string[], rows: unknown[][]) {
  const body = [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

type View = "fix" | "day" | "pay" | "dates";

export function TimesheetsTab() {
  const today = localDateStr();
  // Needs fixing (one-click fixes), a day against the schedule, pay periods (approve, close, QuickBooks), or any dates (CSVs).
  const [view, setView] = useState<View>("fix");
  const [day, setDay] = useState(today);
  const fixes = trpc.workforce.fixes.list.useQuery({ days: 14 });
  const fixCount = fixes.data?.fixCount ?? 0;
  const openDay = (d: string) => { setDay(d); setView("day"); };
  const views: [View, React.ReactNode][] = [
    ["fix", <>Needs fixing{fixCount > 0 && <span className="ml-1.5 rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{fixCount}</span>}</>],
    ["day", "Day"],
    ["pay", "Pay periods"],
    ["dates", "Any dates"],
  ];
  return (
    <div>
      <div className="mb-4 inline-flex flex-wrap rounded-xl bg-slate-100 p-1" role="group" aria-label="Timesheets view">
        {views.map(([k, label]) => (
          <button key={k} onClick={() => setView(k)} aria-pressed={view === k} className={`inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-semibold ${view === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}>{label}</button>
        ))}
      </div>
      {view === "fix" && <NeedsFixingPanel onOpenDay={openDay} />}
      {view === "day" && <DayPanel date={day} setDate={setDay} />}
      {view === "pay" && <PayPeriodsPanel />}
      {view === "dates" && <AnyDates />}
    </div>
  );
}

/** Any date range: hours per person (CSV downloads) and their punches (click a time to change it). */
function AnyDates() {
  const today = localDateStr();
  const [preset, setPreset] = useState<Preset>("last_week");
  const [range, setRange] = useState(presetRange("last_week", today));
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState<{ userId: number; name: string } | null>(null);
  const sheet = trpc.workforce.timesheet.useQuery(range);

  const people = sheet.data?.people || [];
  const totals = people.reduce(
    (t, p) => ({ total: t.total + p.totalMinutes, ot: t.ot + p.overtimeMinutes, missed: t.missed + p.missedClockOuts, onClock: t.onClock + (p.onTheClock ? 1 : 0) }),
    { total: 0, ot: 0, missed: 0, onClock: 0 },
  );

  const pick = (p: Exclude<Preset, "custom">) => { setPreset(p); setRange(presetRange(p, today)); };
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const exportSummary = () => downloadCsv(`timesheet-summary-${range.from}-to-${range.to}.csv`,
    ["Employee", "Job role", "Home clinic", "Days worked", "Regular hours", "Overtime hours", "Total hours", "Scheduled hours", "Late arrivals", "Missed clock-outs"],
    people.map((p) => [p.name, p.jobRoleName ?? "", p.homeClinicName ?? "", p.daysWorked, hours(p.regularMinutes), hours(p.overtimeMinutes), hours(p.totalMinutes), hours(p.scheduledMinutes), p.lateCount, p.missedClockOuts]));
  const exportDetail = () => downloadCsv(`timesheet-punches-${range.from}-to-${range.to}.csv`,
    ["Employee", "Date", "Clinic", "Clock in", "Clock out", "Hours", "Minutes late", "Note", "Edited by manager"],
    people.flatMap((p) => p.punches.map((x) => [p.name, x.workDate, x.clinicName ?? "", clockTime(x.clockInAt), x.clockOutAt ? clockTime(x.clockOutAt) : "MISSING", x.clockOutAt ? hours(x.minutes) : "", x.minutesLate, x.note ?? "", x.edited ? "Yes" : "No"])));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {PRESETS.map((p) => (
          <button key={p.key} onClick={() => pick(p.key)} className={`${btnGhost} ${preset === p.key ? "!bg-slate-900 !text-white !border-slate-900" : ""}`}>{p.label}</button>
        ))}
        <input type="date" value={range.from} max={range.to} onChange={(e) => { setPreset("custom"); setRange((r) => ({ ...r, from: e.target.value })); }} className={`${inputCls} !w-auto`} aria-label="From" />
        <span className="text-slate-400 text-sm">to</span>
        <input type="date" value={range.to} min={range.from} onChange={(e) => { setPreset("custom"); setRange((r) => ({ ...r, to: e.target.value })); }} className={`${inputCls} !w-auto`} aria-label="To" />
        <div className="ml-auto flex gap-2">
          <button className={btnGhost} disabled={!people.length} onClick={exportSummary}><Download size={14} /> Summary CSV</button>
          <button className={btnGhost} disabled={!people.length} onClick={exportDetail}><Download size={14} /> Punches CSV</button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Total hours" value={fmtDuration(totals.total)} sub={`${fmtDay(range.from, { month: "short", day: "numeric" })} – ${fmtDay(range.to, { month: "short", day: "numeric" })}`} />
        <StatCard label="Overtime" value={fmtDuration(totals.ot)} sub="Over 40 h in a Mon–Sun week" accent={totals.ot ? "text-amber-600" : "text-slate-900"} />
        <StatCard label="Missed clock-outs" value={totals.missed} sub={totals.missed ? "Fix before payroll" : "Nothing to fix"} accent={totals.missed ? "text-rose-600" : "text-slate-900"} />
        <StatCard label="On the clock now" value={totals.onClock} />
      </div>

      {sheet.isLoading && <Loader2 className="animate-spin text-slate-400" />}
      {!sheet.isLoading && people.length === 0 && (
        <p className="text-sm text-slate-500 bg-white border border-slate-200 rounded-2xl p-5">No one is on the time clock yet. Open the <b>People</b> tab, edit each hourly employee and turn on <b>Uses time clock</b>.</p>
      )}

      {people.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-widest font-medium text-slate-400">
                <th className="text-left px-4 py-3">Employee</th>
                <th className="px-3 py-3 text-center">Days</th>
                <th className="px-3 py-3 text-right">Regular</th>
                <th className="px-3 py-3 text-right">Overtime</th>
                <th className="px-3 py-3 text-right">Total</th>
                <th className="px-3 py-3 text-right">Scheduled</th>
                <th className="px-3 py-3 text-center">Late</th>
                <th className="px-3 py-3 text-center">To fix</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const expanded = open.has(p.userId);
                return (
                  <Fragment key={p.userId}>
                    <tr className="border-b border-slate-100 hover:bg-slate-50/60 cursor-pointer" onClick={() => toggle(p.userId)}>
                      <td className="px-4 py-3">
                        <p className="flex items-center gap-1.5 font-semibold text-slate-800">
                          {expanded ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
                          {p.name}
                          {p.onTheClock && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-semibold">On the clock</span>}
                          {!p.usesTimeClock && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10px] font-semibold">Clock off</span>}
                        </p>
                        <p className="text-xs text-slate-400 ml-5">{p.jobRoleName ?? "No job role"}{p.homeClinicName ? ` · ${p.homeClinicName}` : ""}</p>
                      </td>
                      <td className="px-3 py-3 text-center text-slate-700">{p.daysWorked}</td>
                      <td className="px-3 py-3 text-right text-slate-700 tabular-nums">{fmtDuration(p.regularMinutes)}</td>
                      <td className={`px-3 py-3 text-right tabular-nums ${p.overtimeMinutes ? "text-amber-600 font-semibold" : "text-slate-300"}`}>{p.overtimeMinutes ? fmtDuration(p.overtimeMinutes) : "—"}</td>
                      <td className="px-3 py-3 text-right font-semibold text-slate-900 tabular-nums">{fmtDuration(p.totalMinutes)}</td>
                      <td className="px-3 py-3 text-right text-slate-500 tabular-nums">{p.scheduledMinutes ? fmtDuration(p.scheduledMinutes) : "—"}</td>
                      <td className={`px-3 py-3 text-center ${p.lateCount ? "text-amber-600 font-semibold" : "text-slate-300"}`}>{p.lateCount || "—"}</td>
                      <td className="px-3 py-3 text-center">{p.missedClockOuts ? <span className="inline-flex items-center gap-1 text-rose-600 font-semibold"><AlertTriangle size={13} /> {p.missedClockOuts}</span> : <span className="text-slate-300">—</span>}</td>
                      <td className="px-3 py-3 text-right">
                        <button onClick={(e) => { e.stopPropagation(); setAdding({ userId: p.userId, name: p.name }); }}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100"><Plus size={12} /> Add time</button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-slate-100 bg-slate-50/50">
                        <td colSpan={9} className="px-4 py-3">
                          {p.punches.length === 0 && <p className="text-xs text-slate-500 ml-5">No punches in this range.</p>}
                          {p.punches.length > 0 && <PunchDays punches={p.punches} />}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-400">Hours count only finished punches. A punch with a missing clock-out counts as 0 hours until you fix it. Overtime is time over 40 hours in a Monday–Sunday week (Texas follows the federal rule).</p>

      {adding && <AddTimeDialog {...adding} date={range.to > today ? today : range.to} clockIn="09:00" clockOut="17:00" onClose={() => setAdding(null)} />}
    </div>
  );
}

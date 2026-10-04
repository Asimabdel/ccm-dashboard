import { trpc } from "@/lib/trpc";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, ChevronRight, Download, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { addDays, fmtDay, fmtDuration, localDateStr, localMinutes, weekStart } from "@shared/workforce";
import { clinicLocalToUtc } from "@shared/workspace";
import { Field, Modal, StatCard, btnGhost, btnPrimary, inputCls } from "./ui";

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
const hhmm = (d: Date | string) => { const m = localMinutes(new Date(d)); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
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

interface PunchDraft { id?: number; userId: number; name: string; date: string; inTime: string; outTime: string; note: string }

export function TimesheetsTab() {
  const utils = trpc.useUtils();
  const today = localDateStr();
  const [preset, setPreset] = useState<Preset>("last_week");
  const [range, setRange] = useState(presetRange("last_week", today));
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [draft, setDraft] = useState<PunchDraft | null>(null);

  const sheet = trpc.workforce.timesheet.useQuery(range);
  const onError = (e: { message: string }) => toast.error(e.message);
  const done = (msg: string) => { utils.workforce.invalidate(); setDraft(null); toast.success(msg); };
  const edit = trpc.workforce.punches.edit.useMutation({ onSuccess: () => done("Punch updated"), onError });
  const add = trpc.workforce.punches.add.useMutation({ onSuccess: () => done("Punch added"), onError });
  const remove = trpc.workforce.punches.delete.useMutation({ onSuccess: () => done("Punch deleted"), onError });

  const people = sheet.data?.people || [];
  const totals = people.reduce(
    (t, p) => ({ total: t.total + p.totalMinutes, ot: t.ot + p.overtimeMinutes, missed: t.missed + p.missedClockOuts, onClock: t.onClock + (p.onTheClock ? 1 : 0) }),
    { total: 0, ot: 0, missed: 0, onClock: 0 },
  );

  const pick = (p: Exclude<Preset, "custom">) => { setPreset(p); setRange(presetRange(p, today)); };
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const submit = () => {
    if (!draft) return;
    const clockInAt = clinicLocalToUtc(draft.date, draft.inTime);
    let clockOutAt: Date | null = null;
    if (draft.outTime) {
      // An out time earlier than the in time means the shift ran past midnight.
      clockOutAt = clinicLocalToUtc(draft.outTime < draft.inTime ? addDays(draft.date, 1) : draft.date, draft.outTime);
    }
    const note = draft.note.trim() || null;
    if (draft.id) edit.mutate({ id: draft.id, clockInAt, clockOutAt, note });
    else add.mutate({ userId: draft.userId, clockInAt, clockOutAt, note });
  };

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
                        <button onClick={(e) => { e.stopPropagation(); setDraft({ userId: p.userId, name: p.name, date: range.to > today ? today : range.to, inTime: "08:00", outTime: "17:00", note: "" }); }}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100"><Plus size={12} /> Add punch</button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-slate-100 bg-slate-50/50">
                        <td colSpan={9} className="px-4 py-3">
                          {p.punches.length === 0 && <p className="text-xs text-slate-500 ml-5">No punches in this range.</p>}
                          {p.punches.length > 0 && (
                            <table className="w-full text-xs ml-5 max-w-3xl">
                              <thead>
                                <tr className="text-slate-400 uppercase tracking-widest text-[10px]">
                                  <th className="text-left py-1.5">Date</th><th className="text-left py-1.5">Clinic</th><th className="text-left py-1.5">In</th><th className="text-left py-1.5">Out</th>
                                  <th className="text-right py-1.5">Hours</th><th className="text-left py-1.5 pl-4">Note</th><th />
                                </tr>
                              </thead>
                              <tbody>
                                {p.punches.map((x) => (
                                  <tr key={x.id} className={`border-t border-slate-200/70 ${x.missingClockOut ? "bg-rose-50" : ""}`}>
                                    <td className="py-1.5 font-medium text-slate-700">{fmtDay(x.workDate)}</td>
                                    <td className="py-1.5 text-slate-500">{x.clinicName ?? "—"}</td>
                                    <td className="py-1.5 text-slate-700">{clockTime(x.clockInAt)}{x.minutesLate > 0 && <span className="ml-1 text-amber-600">({x.minutesLate}m late)</span>}</td>
                                    <td className="py-1.5 text-slate-700">{x.clockOutAt ? <>{clockTime(x.clockOutAt)}{x.lunch && <span className="ml-1 text-[11px] font-semibold text-amber-600">lunch</span>}</> : x.missingClockOut ? <span className="font-semibold text-rose-600">Missing</span> : <span className="text-emerald-700">On the clock</span>}</td>
                                    <td className="py-1.5 text-right tabular-nums text-slate-700">{x.clockOutAt ? fmtDuration(x.minutes) : "—"}</td>
                                    <td className="py-1.5 pl-4 text-slate-500 truncate max-w-[200px]">{x.note}{x.edited && <span className="ml-1 text-[10px] text-slate-400">(edited)</span>}</td>
                                    <td className="py-1.5 text-right whitespace-nowrap">
                                      <button onClick={() => setDraft({ id: x.id, userId: p.userId, name: p.name, date: x.workDate, inTime: hhmm(x.clockInAt), outTime: x.clockOutAt ? hhmm(x.clockOutAt) : "", note: x.note ?? "" })}
                                        className="p-1 rounded hover:bg-slate-200 text-slate-500" title="Edit"><Pencil size={12} /></button>
                                      <button onClick={() => { if (confirm(`Delete this punch for ${p.name} on ${fmtDay(x.workDate)}?`)) remove.mutate(x.id); }}
                                        className="p-1 rounded hover:bg-rose-100 text-slate-400 hover:text-rose-600" title="Delete"><Trash2 size={12} /></button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
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

      {draft && (
        <Modal title={`${draft.id ? "Fix punch" : "Add punch"} · ${draft.name}`} onClose={() => setDraft(null)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <Field label="Date"><input type="date" required max={today} value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} className={inputCls} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Clock in"><input type="time" required value={draft.inTime} onChange={(e) => setDraft({ ...draft, inTime: e.target.value })} className={inputCls} /></Field>
              <Field label="Clock out"><input type="time" value={draft.outTime} onChange={(e) => setDraft({ ...draft, outTime: e.target.value })} className={inputCls} /></Field>
            </div>
            <Field label="Note (why it was changed)"><input value={draft.note} placeholder="e.g. Forgot to clock out — left at 5:10" onChange={(e) => setDraft({ ...draft, note: e.target.value })} className={inputCls} /></Field>
            <p className="text-xs text-slate-400">Times are clinic time (Central). Leave clock-out empty only if they're still working.</p>
            <button type="submit" disabled={edit.isPending || add.isPending} className={`${btnPrimary} w-full`}>{edit.isPending || add.isPending ? "Saving…" : "Save punch"}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CalendarDays, Check, ChevronLeft, ChevronRight, Loader2, Plus, Trash2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { addDays, fmtDay, fmtDuration, fmtTime, localDateStr } from "@shared/workforce";
import { clinicLocalToUtc } from "@shared/workspace";
import { clinicHhmm } from "@shared/attendance";
import type { FixAction, PunchProblem } from "@shared/punchFixes";
import { Field, Modal, btnGhost, btnPrimary, inputCls } from "./ui";

// Fixing clock-in / clock-out times (2026-10-05): click a time to change it, one-click fixes for each problem,
// a whole missed day (with lunch) in one step, and the day view against the schedule.

type Shift = { startTime: string; endTime: string } | null;
export interface PunchView {
  id: number; date: string; clockInAt: Date | string; clockOutAt: Date | string | null; minutes: number;
  lunch?: boolean; auto?: boolean; edited?: boolean; note?: string | null; shift?: Shift; missing?: boolean;
}

const nowHhmm = () => clinicHhmm(new Date());
const t12 = (hhmm: string) => fmtTime(hhmm);

/** Punch changes with toasts; every list refreshes after. */
export function usePunchActions() {
  const utils = trpc.useUtils();
  const onError = (e: { message: string }) => toast.error(e.message);
  const edit = trpc.workforce.punches.edit.useMutation({ onError });
  const add = trpc.workforce.punches.add.useMutation({ onError });
  const remove = trpc.workforce.punches.delete.useMutation({ onError });
  const confirm = trpc.workforce.fixes.confirm.useMutation({ onError });
  const dismiss = trpc.workforce.fixes.dismiss.useMutation({ onError });
  const refresh = () => void utils.workforce.invalidate();
  const ok = (msg: string) => { refresh(); toast.success(msg); return true; };
  const at = (date: string, hhmm: string) => clinicLocalToUtc(date, hhmm);
  // An out time earlier than the in time means the shift ran past midnight.
  const outAt = (date: string, inT: string, outT: string) => at(outT < inT ? addDays(date, 1) : date, outT);

  const saveTimes = async (punchId: number, date: string, inT: string, outT: string | null) =>
    (await edit.mutateAsync({ id: punchId, clockInAt: at(date, inT), clockOutAt: outT ? outAt(date, inT, outT) : null }).then(() => true, () => false)) && ok("Punch updated");

  const addTimes = async (userId: number, date: string, inT: string, outT: string, opts: { lunchFrom?: string; lunchTo?: string; note?: string } = {}) => {
    const note = opts.note?.trim() || null;
    if (opts.lunchFrom && opts.lunchTo) {
      const first = await add.mutateAsync({ userId, clockInAt: at(date, inT), clockOutAt: outAt(date, inT, opts.lunchFrom), lunch: true, note }).then(() => true, () => false);
      if (!first) return false;
      const second = await add.mutateAsync({ userId, clockInAt: outAt(date, inT, opts.lunchTo), clockOutAt: outAt(date, inT, outT), note }).then(() => true, () => false);
      return second ? ok("Day added (with lunch)") : (refresh(), false);
    }
    return (await add.mutateAsync({ userId, clockInAt: at(date, inT), clockOutAt: outAt(date, inT, outT), note }).then(() => true, () => false)) && ok("Time added");
  };

  const removePunch = async (punchId: number) =>
    (await remove.mutateAsync(punchId).then(() => true, () => false)) && ok("Punch deleted");

  /** A one-click fix from the Needs fixing list. */
  const run = async (p: PunchProblem, a: FixAction) => {
    if (a.type === "edit") return saveTimes(a.punchId, p.date, a.clockIn, a.clockOut);
    if (a.type === "add") return addTimes(p.userId, p.date, a.clockIn, a.clockOut);
    if (a.type === "delete") return removePunch(a.punchId);
    if (a.type === "confirm") return (await confirm.mutateAsync({ punchId: a.punchId }).then(() => true, () => false)) && ok("Marked as checked");
    if (a.type === "dismiss") return (await dismiss.mutateAsync({ userId: p.userId, date: p.date, ref: p.ref }).then(() => true, () => false)) && ok("Got it");
    return false;
  };

  return { saveTimes, addTimes, removePunch, run, busy: edit.isPending || add.isPending || remove.isPending || confirm.isPending || dismiss.isPending };
}

function Chip({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600 hover:border-slate-300 hover:bg-slate-50">{children}</button>;
}

/** Edit a punch's times in place: type them or tap scheduled start / end / now. Enter saves, Esc cancels. */
export function TimeEditor({ punchId, date, clockIn, clockOut, shift, onClose }: { punchId: number; date: string; clockIn: string; clockOut: string | null; shift?: Shift; onClose: () => void }) {
  const actions = usePunchActions();
  const [inT, setIn] = useState(clockIn);
  const [outT, setOut] = useState(clockOut ?? "");
  const isToday = date === localDateStr();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const save = async () => {
    if (!inT) return toast.error("Enter the clock-in time.");
    if (!outT && !isToday) return toast.error("Enter the clock-out time.");
    if (await actions.saveTimes(punchId, date, inT, outT || null)) onClose();
  };
  return (
    <form className="flex flex-wrap items-end gap-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-2.5"
      onSubmit={(e) => { e.preventDefault(); void save(); }} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">In
        <input ref={first} type="time" required value={inT} onChange={(e) => setIn(e.target.value)} className={`${inputCls} !w-32 !py-1.5 mt-0.5`} aria-label="Clock in" />
        {shift && <span className="mt-1 flex gap-1"><Chip onClick={() => setIn(shift.startTime)}>{t12(shift.startTime)} scheduled</Chip></span>}
      </label>
      <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Out
        <input type="time" value={outT} onChange={(e) => setOut(e.target.value)} className={`${inputCls} !w-32 !py-1.5 mt-0.5`} aria-label="Clock out" />
        <span className="mt-1 flex gap-1">
          {shift && <Chip onClick={() => setOut(shift.endTime)}>{t12(shift.endTime)} scheduled</Chip>}
          {isToday && <Chip onClick={() => setOut(nowHhmm())}>Now</Chip>}
          {isToday && <Chip onClick={() => setOut("")}>Still working</Chip>}
        </span>
      </label>
      <div className="flex gap-1.5 pb-0.5">
        <button type="submit" disabled={actions.busy} className={`${btnPrimary} !px-3 !py-1.5`}>{actions.busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save</button>
        <button type="button" onClick={onClose} className={`${btnGhost} !px-2.5 !py-1.5`} aria-label="Cancel"><X size={14} /></button>
      </div>
    </form>
  );
}

/** One punch: click the times to change them. */
export function PunchLine({ punch, onDeleted }: { punch: PunchView; onDeleted?: () => void }) {
  const [editing, setEditing] = useState(false);
  const actions = usePunchActions();
  const inT = clinicHhmm(punch.clockInAt);
  const outT = punch.clockOutAt ? clinicHhmm(punch.clockOutAt) : null;
  if (editing) return <TimeEditor punchId={punch.id} date={punch.date} clockIn={inT} clockOut={outT} shift={punch.shift} onClose={() => setEditing(false)} />;
  return (
    <div className={`group flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-1.5 py-1 ${punch.missing ? "bg-rose-50" : ""}`}>
      <button type="button" onClick={() => setEditing(true)} title="Change the times"
        className="rounded-md px-1.5 py-0.5 text-sm font-medium tabular-nums text-slate-800 underline decoration-dotted decoration-slate-300 underline-offset-4 hover:bg-white hover:decoration-slate-500">
        {t12(inT)} → {outT ? t12(outT) : punch.missing ? <span className="font-semibold text-rose-600">no clock-out</span> : <span className="text-emerald-700">on the clock</span>}
      </button>
      {punch.lunch && <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">lunch</span>}
      {punch.auto && <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">auto clock-out</span>}
      {punch.edited && !punch.auto && <span className="text-[10px] text-slate-400">edited</span>}
      {punch.clockOutAt && <span className="text-xs tabular-nums text-slate-500">{fmtDuration(punch.minutes)}</span>}
      {punch.note && <span className="max-w-[220px] truncate text-xs text-slate-400" title={punch.note}>{punch.note}</span>}
      <button type="button" disabled={actions.busy} onClick={() => { if (confirm(`Delete the ${t12(inT)} punch on ${fmtDay(punch.date)}?`)) void actions.removePunch(punch.id).then((ok) => ok && onDeleted?.()); }}
        className="ml-auto rounded p-1 text-slate-300 opacity-60 hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100" title="Delete" aria-label="Delete punch"><Trash2 size={13} /></button>
    </div>
  );
}

/** Add time someone forgot: a whole day in one step, with an optional lunch break. */
export function AddTimeDialog({ userId, name, date, clockIn, clockOut, onClose }: { userId: number; name: string; date: string; clockIn: string; clockOut: string; onClose: () => void }) {
  const actions = usePunchActions();
  const today = localDateStr();
  const [d, setD] = useState({ date, inT: clockIn, outT: clockOut, lunch: false, lunchFrom: "12:00", lunchTo: "12:30", note: "" });
  const submit = async () => {
    if (d.lunch && !(d.lunchFrom > d.inT && d.lunchTo > d.lunchFrom && d.lunchTo < d.outT)) return toast.error("Lunch has to fall between the clock-in and clock-out.");
    const ok = await actions.addTimes(userId, d.date, d.inT, d.outT, { ...(d.lunch ? { lunchFrom: d.lunchFrom, lunchTo: d.lunchTo } : {}), note: d.note });
    if (ok) onClose();
  };
  return (
    <Modal title={`Add time · ${name}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Date"><input type="date" required max={today} value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} className={inputCls} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Clock in"><input type="time" required value={d.inT} onChange={(e) => setD({ ...d, inT: e.target.value })} className={inputCls} /></Field>
          <Field label="Clock out"><input type="time" required value={d.outT} onChange={(e) => setD({ ...d, outT: e.target.value })} className={inputCls} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={d.lunch} onChange={(e) => setD({ ...d, lunch: e.target.checked })} className="accent-emerald-600" /> They took a lunch break
        </label>
        {d.lunch && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Lunch from"><input type="time" required value={d.lunchFrom} onChange={(e) => setD({ ...d, lunchFrom: e.target.value })} className={inputCls} /></Field>
            <Field label="Lunch to"><input type="time" required value={d.lunchTo} onChange={(e) => setD({ ...d, lunchTo: e.target.value })} className={inputCls} /></Field>
          </div>
        )}
        <Field label="Note (optional)"><input value={d.note} placeholder="e.g. Forgot to clock in" onChange={(e) => setD({ ...d, note: e.target.value })} className={inputCls} /></Field>
        <p className="text-xs text-slate-400">Clinic time (Central).</p>
        <button type="submit" disabled={actions.busy} className={`${btnPrimary} w-full`}>{actions.busy ? "Saving…" : "Add time"}</button>
      </form>
    </Modal>
  );
}

/** The buttons for one problem (the first is the suggested fix). */
function ProblemActions({ problem, compact, onAdd, onEdit }: {
  problem: PunchProblem; compact?: boolean;
  onAdd: (a: { clockIn: string; clockOut: string }) => void;
  onEdit: (a: { punchId: number; clockIn: string; clockOut: string | null }) => void;
}) {
  const actions = usePunchActions();
  return (
    <div className="flex flex-wrap gap-1.5">
      {problem.actions.map((a, i) => (
        <button key={i} type="button" disabled={actions.busy}
          onClick={() => {
            if (a.type === "open_add") onAdd(a);
            else if (a.type === "open_edit") onEdit(a);
            else void actions.run(problem, a);
          }}
          className={i === 0
            ? `inline-flex items-center gap-1 rounded-lg bg-slate-900 font-semibold text-white hover:bg-slate-800 disabled:opacity-50 ${compact ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-xs"}`
            : `inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50 ${compact ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-xs"}`}>
          {i === 0 && <Check size={12} />} {a.label}
        </button>
      ))}
    </div>
  );
}

function ProblemBody({ problem, compact }: { problem: PunchProblem; compact?: boolean }) {
  const [editing, setEditing] = useState<{ punchId: number; clockIn: string; clockOut: string | null } | null>(null);
  const [adding, setAdding] = useState<{ clockIn: string; clockOut: string } | null>(null);
  return (
    <>
      {editing
        ? <TimeEditor punchId={editing.punchId} date={problem.date} clockIn={editing.clockIn} clockOut={editing.clockOut} shift={problem.shift} onClose={() => setEditing(null)} />
        : <ProblemActions problem={problem} compact={compact} onAdd={setAdding} onEdit={setEditing} />}
      {adding && <AddTimeDialog userId={problem.userId} name={problem.name} date={problem.date} clockIn={adding.clockIn} clockOut={adding.clockOut} onClose={() => setAdding(null)} />}
    </>
  );
}

const sevChip = (s: PunchProblem["severity"]) => s === "fix"
  ? <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700"><AlertTriangle size={10} /> Fix</span>
  : <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700">Check</span>;

/** Workforce → Timesheets → Needs fixing. */
export function NeedsFixingPanel({ onOpenDay }: { onOpenDay: (date: string) => void }) {
  const [days, setDays] = useState(14);
  const q = trpc.workforce.fixes.list.useQuery({ days });
  const utils = trpc.useUtils();
  const decide = trpc.workforce.punchRequests.decide.useMutation({
    onSuccess: (_, v) => { toast.success(v.approve ? "Approved. The punch is fixed and they were told." : "Denied. They were told."); void utils.workforce.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  if (q.isLoading) return <Loader2 className="animate-spin text-slate-400" />;
  if (q.error) return <p className="text-sm text-rose-600">{q.error.message}</p>;
  const d = q.data!;
  const empty = d.problems.length === 0 && d.requests.length === 0;
  const req = (t: { clockIn: string | null; clockOut: string | null } | null) => t ? `${t.clockIn ? t12(t.clockIn) : "—"} → ${t.clockOut ? t12(t.clockOut) : "no clock-out"}` : "nothing (forgot to clock in)";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-slate-600">
          {empty ? "Nothing to fix." : <><b className="text-slate-900">{d.fixCount}</b> to fix{d.checkCount ? <> · <b className="text-slate-900">{d.checkCount}</b> to check</> : null}</>}
          <span className="text-slate-400"> · since {fmtDay(d.from, { month: "short", day: "numeric" })}</span>
        </p>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${inputCls} !w-auto !py-1.5 ml-auto`} aria-label="How far back">
          <option value={14}>Last 14 days</option><option value={30}>Last 30 days</option><option value={60}>Last 60 days</option>
        </select>
      </div>

      {d.requests.length > 0 && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800">Fix-my-punch requests ({d.requests.length})</h3>
          <ul className="space-y-2">
            {d.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-amber-100 bg-white px-3 py-2">
                <div className="min-w-[200px] flex-1">
                  <p className="text-sm font-semibold text-slate-800">{r.name} <span className="font-normal text-slate-500">· {fmtDay(r.date)}</span></p>
                  <p className="text-xs text-slate-500">Now {req(r.current)} · asks for <b className="text-slate-700">{req(r.requested)}</b></p>
                  <p className="text-xs italic text-slate-500">“{r.reason}”</p>
                </div>
                <button disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: true })} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"><Check size={12} /> Approve</button>
                <button disabled={decide.isPending} onClick={() => { const note = window.prompt("Why not? (they'll see this)") ?? undefined; if (note !== undefined) decide.mutate({ id: r.id, approve: false, managerNote: note || null }); }} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">Deny</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {empty && <p className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">Every punch in the last {days} days looks right. Missed clock-outs, missing days, automatic clock-outs and fix requests show up here.</p>}

      {d.problems.length > 0 && (
        <ul className="space-y-2">
          {d.problems.map((p) => (
            <li key={`${p.userId}|${p.date}|${p.ref}`} className="rounded-2xl border border-slate-200 bg-white p-3">
              <div className="mb-2 flex flex-wrap items-start gap-2">
                <div className="min-w-[200px] flex-1">
                  <p className="text-sm text-slate-800"><b>{p.name}</b> <span className="text-slate-500">· {fmtDay(p.date)}</span></p>
                  <p className="text-sm font-semibold text-slate-900">{p.title}</p>
                  <p className="text-xs text-slate-500">{p.detail}</p>
                </div>
                {sevChip(p.severity)}
                <button type="button" onClick={() => onOpenDay(p.date)} className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"><CalendarDays size={12} /> Day</button>
              </div>
              <ProblemBody problem={p} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Workforce → Timesheets → Day: everyone's punches next to their schedule. */
export function DayPanel({ date, setDate }: { date: string; setDate: (d: string) => void }) {
  const today = localDateStr();
  const q = trpc.workforce.fixes.day.useQuery({ date });
  const [adding, setAdding] = useState<{ userId: number; name: string; clockIn: string; clockOut: string } | null>(null);
  const rows = q.data?.rows ?? [];
  const scheduled = rows.filter((r) => r.shifts.some((s) => s.status === "scheduled")).length;
  const clocked = rows.filter((r) => r.punches.length).length;
  const toFix = rows.reduce((n, r) => n + r.problems.length, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setDate(addDays(date, -1))} className={`${btnGhost} !px-2`} aria-label="Previous day"><ChevronLeft size={16} /></button>
        <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} className={`${inputCls} !w-auto`} aria-label="Day" />
        <button onClick={() => setDate(addDays(date, 1))} disabled={date >= today} className={`${btnGhost} !px-2`} aria-label="Next day"><ChevronRight size={16} /></button>
        {date !== today && <button onClick={() => setDate(today)} className={btnGhost}>Today</button>}
        <p className="ml-1 text-sm font-semibold text-slate-800">{fmtDay(date, { weekday: "long", month: "long", day: "numeric" })}</p>
        {q.data && <p className="ml-auto text-xs text-slate-500">{scheduled} scheduled · {clocked} clocked in{toFix ? <> · <b className="text-rose-600">{toFix} to look at</b></> : null}</p>}
      </div>

      {q.isLoading && <Loader2 className="animate-spin text-slate-400" />}
      {q.error && <p className="text-sm text-rose-600">{q.error.message}</p>}
      {q.data && rows.length === 0 && <p className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">Nobody on the time clock.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-3xl border border-slate-200 bg-white">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-widest text-slate-400">
                <th className="px-4 py-3">Person</th><th className="px-3 py-3">Scheduled</th><th className="px-3 py-3">Clock in → out (click to change)</th>
                <th className="px-3 py-3 text-right">Hours</th><th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = r.shifts.find((x) => x.status === "scheduled");
                return (
                  <tr key={r.userId} className={`border-b border-slate-100 align-top ${r.problems.some((p) => p.severity === "fix") ? "bg-rose-50/30" : ""}`}>
                    <td className="px-4 py-2.5">
                      <p className="font-semibold text-slate-800">{r.name}{r.onTheClock && <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">On the clock</span>}</p>
                      <p className="text-xs text-slate-400">{[r.jobRoleName, r.homeClinicName].filter(Boolean).join(" · ")}</p>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">
                      {r.off ? <span className="font-semibold text-sky-700">Time off</span>
                        : r.shifts.length === 0 ? <span className="text-slate-400">Not scheduled</span>
                        : r.shifts.map((x) => <p key={x.id} className={x.status === "called_out" ? "text-slate-400 line-through" : ""}>{t12(x.startTime)} – {t12(x.endTime)}{x.clinicName ? ` · ${x.clinicName}` : ""}{x.status === "called_out" ? " (called out)" : ""}</p>)}
                    </td>
                    <td className="px-3 py-2">
                      {r.punches.length === 0 && <p className="px-1.5 py-1 text-xs text-slate-400">No punches</p>}
                      {r.punches.map((x) => <PunchLine key={x.id} punch={{ ...x, date, missing: !x.clockOutAt && date < today }} />)}
                      {r.problems.map((p) => (
                        <div key={p.ref} className="mt-1.5 rounded-xl border border-slate-100 bg-slate-50/70 p-2">
                          <p className="mb-1.5 text-xs"><b className={p.severity === "fix" ? "text-rose-700" : "text-sky-700"}>{p.title}.</b> <span className="text-slate-500">{p.detail}</span></p>
                          <ProblemBody problem={p} compact />
                        </div>
                      ))}
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-800">{r.workedMinutes ? fmtDuration(r.workedMinutes) : "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setAdding({ userId: r.userId, name: r.name, clockIn: s?.startTime ?? "09:00", clockOut: s?.endTime ?? "17:00" })}
                        className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"><Plus size={12} /> Add time</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddTimeDialog {...adding} date={date} onClose={() => setAdding(null)} />}
    </div>
  );
}

type SheetPunch = { id: number; workDate: string; clockInAt: Date | string; clockOutAt: Date | string | null; minutes: number; minutesLate: number; lunch: boolean; auto: boolean; edited: boolean; note: string | null; missingClockOut: boolean; clinicName: string | null; shift: { startTime: string; endTime: string } | null };

/** A person's punches by day (click a time to change it). */
export function PunchDays({ punches }: { punches: SheetPunch[] }) {
  const days = Array.from(new Set(punches.map((x) => x.workDate)));
  return (
    <div className="ml-5 max-w-3xl divide-y divide-slate-200/70">
      {days.map((d) => {
        const mine = punches.filter((x) => x.workDate === d);
        return (
          <div key={d} className="grid grid-cols-[130px_1fr] items-start gap-2 py-1">
            <div className="pt-1.5 text-xs font-medium text-slate-700">{fmtDay(d)}{mine[0]?.minutesLate ? <span className="block text-[11px] font-normal text-amber-600">{mine[0].minutesLate}m late</span> : null}</div>
            <div>{mine.map((x) => <PunchLine key={x.id} punch={{ ...x, date: x.workDate, missing: x.missingClockOut }} />)}</div>
          </div>
        );
      })}
    </div>
  );
}

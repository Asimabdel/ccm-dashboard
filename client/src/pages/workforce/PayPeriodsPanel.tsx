import { Fragment, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, Loader2, Lock, LockOpen, Plus, ThumbsUp } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { fmtDay, fmtDuration, localDateStr } from "@shared/workforce";
import { quickbooksSheet, toCsv } from "@shared/payPeriods";
import { AddTimeDialog, PunchDays } from "./PunchFixing";

const clockTime = (d: Date | string) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Workforce → Timesheets → Pay periods (every 2 weeks): each person's hours, whether they confirmed them,
 * approve, close the period (admins; punches in it can't change after), and the QuickBooks Payroll sheet.
 */
export function PayPeriodsPanel() {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const utils = trpc.useUtils();
  const [start, setStart] = useState<string | null>(null);
  const q = trpc.workforce.payPeriods.summary.useQuery({ start });
  const approve = trpc.workforce.payPeriods.approve.useMutation({ onSuccess: () => void utils.workforce.payPeriods.invalidate(), onError: (e) => toast.error(e.message) });
  const lock = trpc.workforce.payPeriods.setLocked.useMutation({
    onSuccess: (_, v) => { toast.success(v.locked ? "Pay period closed. Its punches can't change now." : "Pay period reopened."); void utils.workforce.payPeriods.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const [anchor, setAnchor] = useState("");
  // Click a person to see (and fix) their punches in this period.
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState<{ userId: number; name: string } | null>(null);
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const saveAnchor = trpc.workforce.payPeriods.setAnchor.useMutation({ onSuccess: () => { toast.success("Pay periods updated."); setStart(null); void utils.workforce.payPeriods.invalidate(); }, onError: (e) => toast.error(e.message) });

  if (q.isLoading) return <div className="py-6"><Loader2 className="animate-spin text-slate-400" /></div>;
  if (q.error) return <p className="text-sm text-rose-600">{q.error.message}</p>;
  const d = q.data!;
  const ready = d.people.filter((p) => !p.approvedAt && !p.missedClockOuts && !p.pendingFixes && p.confirmedAt && !p.confirmedChanged);
  const approvedAll = d.people.length > 0 && d.people.every((p) => p.approvedAt && !p.approvedChanged);
  const fileBase = `pay-period-${d.period.start}-to-${d.period.end}`;

  const approveAll = async () => {
    for (const p of ready) await approve.mutateAsync({ userId: p.userId, start: d.period.start }).catch(() => null);
    toast.success(`Approved ${ready.length}.`);
  };
  const quickbooks = () => download(`${fileBase}-quickbooks.csv`, toCsv(quickbooksSheet(d.period, d.people)));
  const detail = () => download(`${fileBase}-detail.csv`, toCsv([
    ["Employee", "Date", "Clock in", "Clock out", "Hours", "Lunch after", "Note"],
    ...d.people.flatMap((p) => p.punches.map((x) => [p.name, x.workDate, clockTime(x.clockInAt), x.clockOutAt ? clockTime(x.clockOutAt) : "MISSING", (x.minutes / 60).toFixed(2), x.lunch ? "Yes" : "", x.note ?? ""])),
  ]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" value={d.period.start} onChange={(e) => setStart(e.target.value)} aria-label="Pay period">
          {d.periods.map((p) => <option key={p.start} value={p.start}>{fmtDay(p.start, { month: "short", day: "numeric" })} – {fmtDay(p.end, { month: "short", day: "numeric", year: "numeric" })}{p.locked ? " · closed" : ""}</option>)}
        </select>
        {d.locked && <span className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white"><Lock size={12} /> Closed for payroll</span>}
        {!d.ended && <span className="text-xs text-slate-500">This period hasn't ended yet.</span>}
        {admin && d.ended && !d.closable && <span className="text-xs text-slate-500">It can be closed for payroll on Monday.</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {d.ended && !d.locked && ready.length > 0 && <button onClick={() => void approveAll()} disabled={approve.isPending} className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700"><ThumbsUp size={14} /> Approve {ready.length} confirmed</button>}
          {admin && d.closable && (d.locked
            ? <button onClick={() => lock.mutate({ start: d.period.start, locked: false })} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"><LockOpen size={14} /> Reopen</button>
            : <button onClick={() => { if (approvedAll || window.confirm("Not everyone's hours are approved. Close the period anyway?")) lock.mutate({ start: d.period.start, locked: true }); }} className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"><Lock size={14} /> Close for payroll</button>)}
          <button onClick={quickbooks} className="inline-flex items-center gap-1.5 rounded-xl bg-[hsl(17_66%_52%)] px-3 py-2 text-sm font-semibold text-white hover:brightness-110"><Download size={14} /> QuickBooks sheet</button>
          <button onClick={detail} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"><Download size={14} /> Day-by-day</button>
        </div>
      </div>
      <p className="text-xs text-slate-500">QuickBooks Online Payroll can't import hours from a file: in Run payroll, type each person's regular and overtime hours from the QuickBooks sheet (same order, alphabetical).</p>

      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr><th className="px-3 py-2">Person</th><th className="px-3 py-2 text-right">Regular</th><th className="px-3 py-2 text-right">Overtime</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2">Employee</th><th className="px-3 py-2">Approved</th></tr>
          </thead>
          <tbody>
            {d.people.map((p) => (
              <Fragment key={p.userId}>
              <tr className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <button type="button" onClick={() => toggle(p.userId)} className="flex items-center gap-1 text-left font-semibold text-slate-800 hover:text-slate-950" aria-expanded={open.has(p.userId)}>
                    {open.has(p.userId) ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}{p.name}
                  </button>
                  <p className="ml-5 text-xs text-slate-500">{[p.jobRoleName, p.homeClinicName].filter(Boolean).join(" · ")}</p>
                  {(p.missedClockOuts > 0 || p.pendingFixes > 0 || p.autoOuts > 0) && <p className="ml-5 mt-0.5 flex items-center gap-1 text-xs font-semibold text-amber-700"><AlertTriangle size={11} /> {[p.missedClockOuts ? `${p.missedClockOuts} missing clock-out` : null, p.autoOuts ? `${p.autoOuts} automatic clock-out to check` : null, p.pendingFixes ? `${p.pendingFixes} punch fix waiting` : null].filter(Boolean).join(" · ")}</p>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtDuration(p.regularMinutes)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${p.overtimeMinutes ? "font-semibold text-amber-700" : "text-slate-400"}`}>{p.overtimeMinutes ? fmtDuration(p.overtimeMinutes) : "—"}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtDuration(p.totalMinutes)}</td>
                <td className="px-3 py-2 text-xs">{p.confirmedAt ? (p.confirmedChanged ? <span className="font-semibold text-amber-700">Confirmed, then changed</span> : <span className="inline-flex items-center gap-1 font-semibold text-emerald-600"><CheckCircle2 size={12} /> Confirmed</span>) : <span className="text-slate-400">Not yet</span>}</td>
                <td className="px-3 py-2 text-xs">
                  {p.approvedAt && !p.approvedChanged ? <span className="inline-flex items-center gap-1 font-semibold text-emerald-600"><CheckCircle2 size={12} /> {p.approvedBy ?? "Approved"}</span>
                    : d.ended && !d.locked ? <button onClick={() => approve.mutate({ userId: p.userId, start: d.period.start })} disabled={approve.isPending || p.missedClockOuts > 0 || p.userId === user?.id} className="rounded-lg bg-slate-900 px-2.5 py-1 font-semibold text-white hover:bg-slate-800 disabled:opacity-40">{p.approvedChanged ? "Re-approve" : "Approve"}</button>
                    : <span className="text-slate-400">—</span>}
                </td>
              </tr>
              {open.has(p.userId) && (
                <tr className="border-t border-slate-100 bg-slate-50/50">
                  <td colSpan={6} className="px-3 py-2">
                    {p.punches.length ? <PunchDays punches={p.punches} /> : <p className="ml-5 text-xs text-slate-500">No punches in this period.</p>}
                    {!d.locked && <button onClick={() => setAdding({ userId: p.userId, name: p.name })} className="ml-5 mt-1 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100"><Plus size={12} /> Add time</button>}
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
            {d.people.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Nobody on the time clock in this period.</td></tr>}
          </tbody>
        </table>
      </div>
      {admin && !d.periods.some((p) => p.locked) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          Pay periods run every other Monday to Saturday, from {fmtDay(d.anchor, { month: "short", day: "numeric", year: "numeric" })}. Different start?
          <input type="date" className="rounded-lg border border-slate-200 px-2 py-1" value={anchor} onChange={(e) => setAnchor(e.target.value)} aria-label="First day of a pay period" />
          <button onClick={() => anchor && saveAnchor.mutate({ anchor })} disabled={!anchor || saveAnchor.isPending} className="rounded-lg border border-slate-200 px-2.5 py-1 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">Use this Monday</button>
        </div>
      )}
      {adding && <AddTimeDialog {...adding} date={d.period.end < localDateStr() ? d.period.end : localDateStr()} clockIn="09:00" clockOut="17:00" onClose={() => setAdding(null)} />}
    </div>
  );
}

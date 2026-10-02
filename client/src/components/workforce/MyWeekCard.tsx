import { useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Loader2, Pencil, Send, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { addDays, fmtDay, localDateStr } from "@shared/workforce";
import { WEEKDAYS, WEEKDAY_LABELS, describePattern, emptyPattern, patternProblem, weekdayOf, type WeekPattern } from "@shared/schedulePattern";

const inputCls = "px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400";
const STATUS: Record<string, string> = {
  applied: "bg-emerald-100 text-emerald-800", approved: "bg-emerald-100 text-emerald-800", pending: "bg-amber-100 text-amber-800",
  denied: "bg-rose-100 text-rose-700", cancelled: "bg-slate-100 text-slate-500",
};

/** The Monday after today (a natural start for a new week). */
function nextMonday(today: string) {
  let d = addDays(today, 1);
  while (weekdayOf(d) !== "mon") d = addDays(d, 1);
  return d;
}

/**
 * My Schedule → "My usual week": staff set the days, hours and clinic they usually work. The first
 * time it fills in their shifts right away; after that every change goes to their manager.
 */
export function MyWeekCard() {
  const utils = trpc.useUtils();
  const q = trpc.workforce.me.week.useQuery();
  const submit = trpc.workforce.me.submitWeek.useMutation();
  const cancel = trpc.workforce.me.cancelWeekRequest.useMutation();
  const today = localDateStr();
  const [editing, setEditing] = useState<WeekPattern | null>(null);
  const [from, setFrom] = useState(nextMonday(today));
  const [note, setNote] = useState("");

  if (!q.data?.eligible) return null;
  const d = q.data;
  const clinicName = (id: number | null) => (id ? d.clinics.find((c) => c.id === id)?.name ?? "Clinic" : "Remote");
  const problem = editing ? patternProblem(editing) : null;
  const refresh = () => { void utils.workforce.me.week.invalidate(); void utils.workforce.me.schedule.invalidate(); };

  const save = async () => {
    if (!editing || problem) return;
    if (!d.submitted && !window.confirm(`Save your usual week? Your shifts from ${fmtDay(from)} on will follow it. After this, changes go to your manager for approval.`)) return;
    try {
      const r = await submit.mutateAsync({ pattern: editing, effectiveFrom: from, note: note.trim() || null });
      toast.success(r.applied ? "Your schedule is saved and your shifts are updated." : "Sent to your manager for approval.");
      setEditing(null); setNote("");
      refresh();
    } catch (e) { toast.error((e as Error).message); }
  };
  const set = (day: (typeof WEEKDAYS)[number], patch: Partial<WeekPattern["mon"]>) => setEditing((p) => (p ? { ...p, [day]: { ...p[day], ...patch } } : p));

  return (
    <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-soft lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-slate-900"><CalendarClock size={18} className="text-emerald-600" /> My usual week</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {d.submitted ? "Changes go to your manager for approval." : "Set the days and hours you usually work. It takes effect right away; after that, changes go to your manager for approval."}
          </p>
        </div>
        {!editing && (
          <button onClick={() => setEditing(d.current ?? emptyPattern(d.homeClinicId ?? d.clinics[0]?.id ?? null))}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.98] transition">
            <Pencil size={15} /> {d.submitted ? "Request a change" : "Set my usual week"}
          </button>
        )}
      </div>

      {d.pending && !editing && (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-semibold text-amber-900">Change waiting for approval · starts {fmtDay(d.pending.effectiveFrom)}</p>
          <ul className="mt-1 text-sm text-amber-900">{(d.history.find((h) => h.id === d.pending!.id)?.summary ?? []).map((l, i) => <li key={i}>{l}</li>)}</ul>
          <button onClick={async () => { try { await cancel.mutateAsync(d.pending!.id); toast.success("Request cancelled."); refresh(); } catch (e) { toast.error((e as Error).message); } }}
            className="mt-1 text-xs text-amber-800 hover:text-rose-700">Cancel request</button>
        </div>
      )}

      {!editing && (
        d.current
          ? <ul className="mt-4 space-y-1 text-sm text-slate-700">{describePattern(d.current, clinicName).map((l, i) => <li key={i}>{l}</li>)}</ul>
          : <p className="mt-4 text-sm text-slate-500">No usual week yet.</p>
      )}

      {editing && (
        <div className="mt-4 space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead><tr className="text-left text-xs font-semibold text-slate-500"><th className="py-1.5">Day</th><th>Working</th><th>Start</th><th>End</th><th>Where</th></tr></thead>
              <tbody>
                {WEEKDAYS.map((day) => {
                  const x = editing[day];
                  return (
                    <tr key={day} className="border-t border-slate-100">
                      <td className="py-2 font-medium text-slate-800">{WEEKDAY_LABELS[day]}</td>
                      <td><input type="checkbox" className="size-4 accent-emerald-600" checked={x.work} onChange={(e) => set(day, { work: e.target.checked })} aria-label={`Working ${WEEKDAY_LABELS[day]}`} /></td>
                      <td><input type="time" disabled={!x.work} value={x.start} onChange={(e) => set(day, { start: e.target.value })} className={cn(inputCls, !x.work && "opacity-40")} aria-label={`${WEEKDAY_LABELS[day]} start`} /></td>
                      <td><input type="time" disabled={!x.work} value={x.end} onChange={(e) => set(day, { end: e.target.value })} className={cn(inputCls, !x.work && "opacity-40")} aria-label={`${WEEKDAY_LABELS[day]} end`} /></td>
                      <td>
                        <select disabled={!x.work} value={x.clinicId ?? ""} onChange={(e) => set(day, { clinicId: e.target.value ? Number(e.target.value) : null })} className={cn(inputCls, !x.work && "opacity-40")} aria-label={`${WEEKDAY_LABELS[day]} location`}>
                          {d.clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          <option value="">Remote</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs font-semibold text-slate-600">Starting
              <input type="date" min={addDays(today, 1)} value={from} onChange={(e) => setFrom(e.target.value)} className={cn(inputCls, "mt-1 block")} />
            </label>
            {d.submitted && (
              <label className="min-w-[14rem] flex-1 text-xs font-semibold text-slate-600">Note for your manager (optional)
                <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className={cn(inputCls, "mt-1 block w-full")} placeholder="e.g. school schedule changed" />
              </label>
            )}
          </div>
          {problem && <p className="text-sm text-rose-600">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            <button onClick={save} disabled={!!problem || submit.isPending}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60">
              {submit.isPending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} {d.submitted ? "Send for approval" : "Save my schedule"}
            </button>
            <button onClick={() => setEditing(null)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50"><X size={15} /> Cancel</button>
          </div>
          {d.submitted && d.pending && <p className="text-xs text-slate-500">Sending this replaces the request that's still waiting.</p>}
        </div>
      )}

      {d.history.filter((h) => h.status !== "pending").length > 0 && !editing && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-semibold text-slate-500">History</summary>
          <ul className="mt-2 space-y-1.5">
            {d.history.filter((h) => h.status !== "pending").map((h) => (
              <li key={h.id} className="text-xs text-slate-600">
                <span className={cn("mr-2 rounded-full px-2 py-0.5 font-semibold capitalize", STATUS[h.status])}>{h.kind === "first" ? "Set" : h.status}</span>
                from {fmtDay(h.effectiveFrom)}{h.managerNote ? ` · Manager: ${h.managerNote}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Copy, Trash2, UserX, Undo2 } from "lucide-react";
import { addDays, fmtDay, fmtDuration, fmtTime, localDateStr, shiftMinutes, weekDates, weekStart } from "@shared/workforce";
import { CoverageModal, type CoverageTarget } from "./CoverageModal";
import { Field, Modal, btnGhost, btnPrimary, inputCls } from "./ui";

// clinicId null = a remote shift.
interface ShiftDraft { id?: number; userId: number; clinicId: number | null; date: string; startTime: string; endTime: string; note: string; status?: string; covered?: boolean }

export function ScheduleTab() {
  const utils = trpc.useUtils();
  const [monday, setMonday] = useState(weekStart(localDateStr()));
  const [clinicId, setClinicId] = useState<number | undefined>();
  const days = weekDates(monday);
  const today = localDateStr();

  const clinics = trpc.clinics.list.useQuery();
  const people = trpc.workforce.people.list.useQuery();
  const sched = trpc.workforce.schedule.range.useQuery({ from: days[0], to: days[6], clinicId });
  const [draft, setDraft] = useState<ShiftDraft | null>(null);
  const [coverFor, setCoverFor] = useState<CoverageTarget | null>(null);

  const done = (msg: string) => { utils.workforce.invalidate(); setDraft(null); toast.success(msg); };
  const onError = (e: { message: string }) => toast.error(e.message);
  const save = trpc.workforce.schedule.saveShift.useMutation({ onSuccess: () => done("Shift saved"), onError });
  const remove = trpc.workforce.schedule.deleteShift.useMutation({ onSuccess: () => done("Shift removed"), onError });
  const callOut = trpc.workforce.schedule.callOut.useMutation({ onSuccess: () => done("Marked as called out"), onError });
  const undo = trpc.workforce.schedule.undoCallOut.useMutation({ onSuccess: () => done("Call-out undone"), onError });
  const copy = trpc.workforce.schedule.copyWeek.useMutation({
    onSuccess: (r) => { utils.workforce.invalidate(); toast.success(`Copied ${r.copied} shifts${r.skipped ? ` (${r.skipped} skipped — already scheduled)` : ""}`); },
    onError,
  });

  const shifts = sched.data?.shifts || [];
  const timeOff = sched.data?.timeOff || [];
  // Rows: active employees based at the selected clinic, plus anyone working there this week.
  const rows = useMemo(() => {
    const working = new Set(shifts.map((s) => s.userId));
    return (people.data || []).filter((p) => (p.profileId && p.active && (!clinicId || p.homeClinicId === clinicId)) || working.has(p.userId));
  }, [people.data, shifts, clinicId]);

  const newShift = (userId: number, date: string) => {
    const p = people.data?.find((x) => x.userId === userId);
    // Default to the person's usual hours: reuse their most recent shift this week if there is one.
    const last = shifts.filter((s) => s.userId === userId).slice(-1)[0];
    const where = clinicId ?? (last ? last.clinicId : p?.profileId ? p.homeClinicId : clinics.data?.[0]?.id ?? null);
    setDraft({ userId, date, clinicId: where, startTime: last?.startTime ?? "08:00", endTime: last?.endTime ?? "17:00", note: "" });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button className={btnGhost} onClick={() => setMonday(addDays(monday, -7))}>←</button>
        <span className="text-sm font-semibold text-slate-800 min-w-[170px] text-center">{fmtDay(days[0], { month: "short", day: "numeric" })} – {fmtDay(days[6], { month: "short", day: "numeric", year: "numeric" })}</span>
        <button className={btnGhost} onClick={() => setMonday(addDays(monday, 7))}>→</button>
        {monday !== weekStart(today) && <button className={btnGhost} onClick={() => setMonday(weekStart(today))}>This week</button>}
        <select value={clinicId ?? ""} onChange={(e) => setClinicId(e.target.value ? Number(e.target.value) : undefined)} className={`${inputCls} !w-auto`}>
          <option value="">All clinics</option>
          {(clinics.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className={`${btnGhost} ml-auto`} disabled={copy.isPending}
          onClick={() => { if (confirm(`Copy last week's shifts${clinicId ? " for this clinic" : ""} into this week?`)) copy.mutate({ fromWeekStart: addDays(monday, -7), toWeekStart: monday, clinicId }); }}>
          <Copy size={14} /> Copy last week
        </button>
      </div>

      {(sched.isLoading || people.isLoading) && <Loader2 className="animate-spin text-slate-400" />}
      {!people.isLoading && rows.length === 0 && (
        <p className="text-sm text-slate-500 bg-white border border-slate-200 rounded-2xl p-5">No employees to schedule yet. Open the <b>People</b> tab and give each employee a job role and home clinic — they'll appear here.</p>
      )}

      {rows.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left px-4 py-3 text-xs uppercase tracking-widest font-medium text-slate-400 w-48">Employee</th>
                {days.map((d) => (
                  <th key={d} className={`px-2 py-3 text-xs font-semibold text-center ${d === today ? "text-emerald-700 bg-emerald-50/60" : "text-slate-600"}`}>{fmtDay(d, { weekday: "short", day: "numeric" })}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const mine = shifts.filter((s) => s.userId === p.userId);
                const mins = mine.filter((s) => s.status === "scheduled").reduce((t, s) => t + shiftMinutes(s.startTime, s.endTime), 0);
                const over = p.hoursPerWeek != null && mins > p.hoursPerWeek * 60;
                return (
                  <tr key={p.userId} className="border-b border-slate-100 last:border-0 align-top">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-800 truncate">{p.name}</p>
                      <p className="text-xs text-slate-400 truncate">{p.jobRoleName ?? "No job role"}{p.homeClinicName ? ` · ${p.homeClinicName}` : ""}</p>
                      <p className={`text-xs mt-0.5 ${over ? "text-amber-600 font-semibold" : "text-slate-500"}`}>{fmtDuration(mins)}{p.hoursPerWeek ? ` / ${p.hoursPerWeek}h` : ""}</p>
                    </td>
                    {days.map((d) => {
                      const cell = mine.filter((s) => s.date === d);
                      const off = timeOff.find((t) => t.userId === p.userId && t.startDate <= d && t.endDate >= d);
                      return (
                        <td key={d} className={`px-1.5 py-2 ${d === today ? "bg-emerald-50/40" : ""}`}>
                          <div className="space-y-1 group min-h-[44px]">
                            {off && <div className={`px-2 py-1 rounded-lg text-[11px] font-semibold text-center ${off.status === "approved" ? "bg-violet-100 text-violet-800" : "bg-amber-50 text-amber-700 border border-dashed border-amber-300"}`}>{off.status === "approved" ? "Time off" : "Requested off"}</div>}
                            {cell.map((s) => (
                              <button key={s.id} onClick={() => setDraft({ ...s, note: s.note ?? "" })}
                                className={`w-full text-left px-2 py-1 rounded-lg text-[11px] leading-tight border transition hover:shadow-sm ${s.status === "called_out" ? (s.covered ? "bg-slate-100 border-slate-200 text-slate-500 line-through" : "bg-rose-100 border-rose-300 text-rose-800") : s.coversShiftId ? "bg-blue-50 border-blue-200 text-blue-900" : "bg-emerald-50 border-emerald-200 text-emerald-900"}`}>
                                <span className="block font-semibold">{fmtTime(s.startTime).replace(":00", "")} – {fmtTime(s.endTime).replace(":00", "")}</span>
                                {!clinicId && <span className="block truncate opacity-80">{s.clinicName}</span>}
                                {s.status === "called_out" && !s.covered && <span className="block font-bold no-underline">NEEDS COVERAGE</span>}
                              </button>
                            ))}
                            <button onClick={() => newShift(p.userId, d)} className="w-full flex items-center justify-center py-1 rounded-lg text-slate-300 hover:text-emerald-700 hover:bg-emerald-50 opacity-0 group-hover:opacity-100 focus:opacity-100 transition"><Plus size={14} /></button>
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
      )}

      {draft && (
        <Modal title={draft.id ? "Edit shift" : "Add shift"} onClose={() => setDraft(null)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate({ id: draft.id, userId: draft.userId, clinicId: draft.clinicId, date: draft.date, startTime: draft.startTime, endTime: draft.endTime, note: draft.note.trim() || null }); }}>
            <Field label="Employee">
              <select value={draft.userId} onChange={(e) => setDraft({ ...draft, userId: Number(e.target.value) })} className={inputCls}>
                {(people.data || []).filter((p) => p.profileId || p.userId === draft.userId).map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Clinic">
                <select value={draft.clinicId ?? ""} onChange={(e) => setDraft({ ...draft, clinicId: e.target.value ? Number(e.target.value) : null })} className={inputCls}>
                  {(clinics.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  <option value="">Remote (no clinic)</option>
                </select>
              </Field>
              <Field label="Date"><input type="date" required value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} className={inputCls} /></Field>
              <Field label="Start"><input type="time" required value={draft.startTime} onChange={(e) => setDraft({ ...draft, startTime: e.target.value })} className={inputCls} /></Field>
              <Field label="End"><input type="time" required value={draft.endTime} onChange={(e) => setDraft({ ...draft, endTime: e.target.value })} className={inputCls} /></Field>
            </div>
            <Field label="Note (optional)"><input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} className={inputCls} /></Field>
            <button type="submit" disabled={save.isPending} className={`${btnPrimary} w-full`}>{save.isPending ? "Saving…" : "Save shift"}</button>
          </form>

          {draft.id && (
            <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap gap-2">
              {draft.status === "called_out" ? (
                <>
                  {!draft.covered && <button className="px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700"
                    onClick={() => { const s = shifts.find((x) => x.id === draft.id); if (s) { setCoverFor(s); setDraft(null); } }}>Find coverage</button>}
                  <button className={btnGhost} onClick={() => undo.mutate(draft.id!)}><Undo2 size={14} /> Undo call-out</button>
                </>
              ) : (
                <button className={`${btnGhost} !text-rose-600`} onClick={() => callOut.mutate({ shiftId: draft.id! })}><UserX size={14} /> Called out</button>
              )}
              <button className={`${btnGhost} ml-auto`} onClick={() => { if (confirm("Delete this shift?")) remove.mutate(draft.id!); }}><Trash2 size={14} /> Delete</button>
            </div>
          )}
        </Modal>
      )}
      {coverFor && <CoverageModal shift={coverFor} onClose={() => setCoverFor(null)} />}
    </div>
  );
}

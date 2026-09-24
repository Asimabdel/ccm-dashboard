import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Star, ThumbsUp, MessageSquareWarning, ClipboardList } from "lucide-react";
import { addDays, fmtDuration, localDateStr, weekStart } from "@shared/workforce";
import { Field, Modal, btnPrimary, inputCls } from "./ui";

type RangeKey = "week" | "month" | "last30" | "last90";
const RANGES: Record<RangeKey, string> = { week: "This week", month: "This month", last30: "Last 30 days", last90: "Last 90 days" };
const KIND = {
  kudos: { label: "Kudos", icon: ThumbsUp, cls: "bg-emerald-100 text-emerald-800" },
  coaching: { label: "Coaching", icon: MessageSquareWarning, cls: "bg-amber-100 text-amber-800" },
  review: { label: "Review", icon: ClipboardList, cls: "bg-blue-100 text-blue-800" },
} as const;

function rateCls(v: number | null, good = 90, ok = 75) {
  if (v == null) return "text-slate-300";
  return v >= good ? "text-emerald-600" : v >= ok ? "text-amber-600" : "text-rose-600";
}

export function PerformanceTab() {
  const [rangeKey, setRangeKey] = useState<RangeKey>("month");
  const [clinicId, setClinicId] = useState<number | undefined>();
  const [selected, setSelected] = useState<{ userId: number; name: string | null } | null>(null);
  const clinics = trpc.clinics.list.useQuery();

  const range = useMemo(() => {
    const to = localDateStr();
    const from = rangeKey === "week" ? weekStart(to) : rangeKey === "month" ? `${to.slice(0, 7)}-01` : addDays(to, rangeKey === "last30" ? -29 : -89);
    return { from, to };
  }, [rangeKey]);
  const cards = trpc.workforce.performance.scorecards.useQuery({ ...range, clinicId });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {(Object.keys(RANGES) as RangeKey[]).map((k) => (
          <button key={k} onClick={() => setRangeKey(k)} className={`px-3 py-2 rounded-xl text-sm font-semibold transition ${rangeKey === k ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"}`}>{RANGES[k]}</button>
        ))}
        <select value={clinicId ?? ""} onChange={(e) => setClinicId(e.target.value ? Number(e.target.value) : undefined)} className={`${inputCls} !w-auto`}>
          <option value="">All clinics</option>
          {(clinics.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {cards.isLoading && <Loader2 className="animate-spin text-slate-400" />}
      {cards.data?.length === 0 && <p className="text-sm text-slate-500 bg-white border border-slate-200 rounded-2xl p-5">No employees with an active profile yet — set them up on the People tab.</p>}

      {!!cards.data?.length && (
        <div className="bg-white rounded-3xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-widest font-medium text-slate-400">
                <th className="text-left px-4 py-3">Employee</th>
                <th className="px-3 py-3 text-center">On time</th>
                <th className="px-3 py-3 text-center">Late</th>
                <th className="px-3 py-3 text-center">No-show</th>
                <th className="px-3 py-3 text-center">Call-outs</th>
                <th className="px-3 py-3 text-center">Hours worked / sched.</th>
                <th className="px-3 py-3 text-center">Duties done</th>
                <th className="px-3 py-3 text-center">Rating</th>
              </tr>
            </thead>
            <tbody>
              {cards.data.map((c) => (
                <tr key={c.userId} onClick={() => setSelected({ userId: c.userId, name: c.name })} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-800">{c.name}</p>
                    <p className="text-xs text-slate-400">{c.jobRoleName ?? "No job role"}{c.homeClinicName ? ` · ${c.homeClinicName}` : ""}</p>
                  </td>
                  <td className={`px-3 py-3 text-center font-bold ${rateCls(c.onTimeRate)}`}>{c.onTimeRate == null ? "—" : `${c.onTimeRate}%`}</td>
                  <td className="px-3 py-3 text-center text-slate-700">{c.late}{c.late > 0 && <span className="block text-[11px] text-slate-400">avg {c.avgMinutesLate} min</span>}</td>
                  <td className={`px-3 py-3 text-center ${c.noShow ? "text-rose-600 font-semibold" : "text-slate-700"}`}>{c.noShow}</td>
                  <td className="px-3 py-3 text-center text-slate-700">{c.calledOut}</td>
                  <td className="px-3 py-3 text-center text-slate-700">{fmtDuration(c.workedMinutes)} <span className="text-slate-400">/ {fmtDuration(c.scheduledMinutes)}</span></td>
                  <td className={`px-3 py-3 text-center font-bold ${rateCls(c.dutyRate, 90, 70)}`}>{c.dutyRate == null ? "—" : `${c.dutyRate}%`}<span className="block text-[11px] font-normal text-slate-400">{c.dutiesDone}/{c.dutiesExpected}</span></td>
                  <td className="px-3 py-3 text-center text-slate-700">{c.avgRating == null ? <span className="text-slate-300">—</span> : <span className="inline-flex items-center gap-1 font-semibold"><Star size={13} className="text-amber-500 fill-amber-400" /> {c.avgRating}</span>}<span className="block text-[11px] text-slate-400">{c.noteCount} notes</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-400">On time = clocked in within 5 minutes of the shift start. Duties done = daily checklist items completed on days the employee clocked in. Click a row to add kudos, coaching, or a review.</p>

      {selected && <NotesModal userId={selected.userId} name={selected.name} onClose={() => setSelected(null)} />}
    </div>
  );
}

function NotesModal({ userId, name, onClose }: { userId: number; name: string | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const notes = trpc.workforce.performance.notes.useQuery(userId);
  const [kind, setKind] = useState<keyof typeof KIND>("kudos");
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const add = trpc.workforce.performance.addNote.useMutation({
    onSuccess: () => { utils.workforce.performance.invalidate(); setNote(""); setRating(null); toast.success("Saved"); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Modal title={name ?? "Employee"} onClose={onClose} wide>
      <form className="space-y-3 p-4 rounded-2xl bg-slate-50 border border-slate-200" onSubmit={(e) => { e.preventDefault(); add.mutate({ userId, kind, rating: kind === "review" ? rating : null, note }); }}>
        <div className="flex gap-2">
          {(Object.keys(KIND) as (keyof typeof KIND)[]).map((k) => {
            const Icon = KIND[k].icon;
            return <button type="button" key={k} onClick={() => setKind(k)} className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold transition ${kind === k ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-600"}`}><Icon size={14} /> {KIND[k].label}</button>;
          })}
        </div>
        {kind === "review" && (
          <Field label="Overall rating">
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((n) => <button type="button" key={n} onClick={() => setRating(n)}><Star size={24} className={rating != null && n <= rating ? "text-amber-500 fill-amber-400" : "text-slate-300"} /></button>)}
            </div>
          </Field>
        )}
        <Field label="Note"><textarea required rows={3} value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder="What happened, and what good looks like next time." /></Field>
        <button type="submit" disabled={add.isPending || !note.trim()} className={`${btnPrimary} w-full`}>{add.isPending ? "Saving…" : "Save"}</button>
      </form>

      {notes.isLoading && <Loader2 className="animate-spin text-slate-400 mt-4" />}
      <ul className="mt-4 space-y-2">
        {(notes.data || []).map((n) => (
          <li key={n.id} className="rounded-2xl border border-slate-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${KIND[n.kind].cls}`}>{KIND[n.kind].label}</span>
              {n.rating != null && <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-slate-700"><Star size={12} className="text-amber-500 fill-amber-400" /> {n.rating}/5</span>}
              <span className="ml-auto text-[11px] text-slate-400">{new Date(n.createdAt).toLocaleDateString()} · {n.authorName ?? "Manager"}</span>
            </div>
            <p className="mt-1.5 text-sm text-slate-700 whitespace-pre-wrap">{n.note}</p>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

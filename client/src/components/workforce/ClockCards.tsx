import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BellRing, CheckCircle2, Loader2, Wrench } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtDay, fmtTime } from "@shared/workforce";
import { FixPunchDialog } from "./FixPunchDialog";

const inputCls = "w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:bg-slate-800 dark:border-slate-600";
const card = "bg-white rounded-3xl border border-slate-200 p-6 shadow-soft dark:bg-slate-800 dark:border-slate-700";
const STATUS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800", approved: "bg-emerald-100 text-emerald-800", denied: "bg-rose-100 text-rose-700", cancelled: "bg-slate-100 text-slate-500",
};
const phoneFmt = (p: string | null) => (p && p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p ?? "");

/** My Schedule: shift reminder texts to my own cell (I turn them on; the practice texts from its main number). */
export function ReminderTextsCard() {
  const utils = trpc.useUtils();
  const q = trpc.workforce.me.reminders.useQuery();
  const [phone, setPhone] = useState("");
  const [on, setOn] = useState(false);
  useEffect(() => { if (q.data) { setPhone(phoneFmt(q.data.mobilePhone)); setOn(q.data.textReminders); } }, [q.data]);
  const save = trpc.workforce.me.saveReminders.useMutation({
    onSuccess: () => { toast.success(on ? "Saved. You'll get a text when it's time to clock in or out." : "Saved. No reminder texts."); void utils.workforce.me.reminders.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  if (!q.data?.usesTimeClock) return null;
  return (
    <div className={card}>
      <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50"><BellRing size={18} className="text-emerald-600" /> Reminder texts</h2>
      <p className="mt-1 text-sm text-slate-500">A text when your shift is starting and you're not clocked in, when you've been on lunch an hour, and if you're still clocked in after your shift. MyPCP shows the same reminders on screen.</p>
      <div className="mt-4 space-y-3">
        <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">My cell number
          <input className={`${inputCls} mt-1`} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(713) 555-0123" />
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" className="mt-0.5 size-4 accent-emerald-600" checked={on} onChange={(e) => setOn(e.target.checked)} />
          <span>Text me shift reminders. <span className="text-slate-500">From the practice's number; reply STOP any time to stop. Message and data rates may apply.</span></span>
        </label>
        <button onClick={() => save.mutate({ mobilePhone: phone.trim() || null, textReminders: on })} disabled={save.isPending}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
          {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Save
        </button>
      </div>
    </div>
  );
}

/** My Schedule: on time this week / last week, and my fix-a-punch requests. */
export function MyPunchesCard() {
  const reminders = trpc.workforce.me.reminders.useQuery();
  const att = trpc.workforce.me.attendance.useQuery(undefined, { enabled: !!reminders.data?.usesTimeClock });
  const list = trpc.workforce.me.punchRequests.useQuery(undefined, { enabled: !!reminders.data?.usesTimeClock });
  const utils = trpc.useUtils();
  const cancel = trpc.workforce.me.cancelPunchRequest.useMutation({ onSuccess: () => { toast.success("Request cancelled."); void utils.workforce.me.punchRequests.invalidate(); }, onError: (e) => toast.error(e.message) });
  const [fixing, setFixing] = useState(false);
  if (!reminders.data?.usesTimeClock) return null;
  const a = att.data;
  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50">My time clock</h2>
        <button onClick={() => setFixing(true)} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"><Wrench size={14} /> Fix a punch</button>
      </div>
      {a && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          {([["This week", a.thisWeek], ["Last week", a.lastWeek]] as const).map(([label, w]) => (
            <div key={label} className="rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-600">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{w.due ? `${w.onTime} of ${w.due}` : "—"}</p>
              <p className="text-xs text-slate-500">{w.due ? (w.onTime === w.due ? "on time, every shift" : "shifts on time") : "no shifts yet"}</p>
            </div>
          ))}
        </div>
      )}
      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">Punch fixes</p>
      {(list.data ?? []).length === 0 && <p className="mt-1 text-sm text-slate-500">None. Forgot to clock out? Use Fix a punch.</p>}
      <ul className="mt-2 space-y-2">
        {(list.data ?? []).map((r) => (
          <li key={r.id} className="rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-600">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{fmtDay(r.workDate)} <span className="font-normal text-slate-500">· {[r.clockIn ? `in ${fmtTime(r.clockIn)}` : null, r.clockOut ? `out ${fmtTime(r.clockOut)}` : null].filter(Boolean).join(", ")}</span></p>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${STATUS[r.status] ?? ""}`}>{r.status}</span>
            </div>
            <p className="mt-0.5 text-xs text-slate-500">{r.reason}</p>
            {r.managerNote && <p className="mt-0.5 text-xs text-slate-500">Manager: {r.managerNote}</p>}
            {r.status === "pending" && <button onClick={() => cancel.mutate(r.id)} className="mt-1 text-xs text-slate-400 hover:text-rose-600">Cancel request</button>}
          </li>
        ))}
      </ul>
      <FixPunchDialog open={fixing} onClose={() => setFixing(false)} />
    </div>
  );
}

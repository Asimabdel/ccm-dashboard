import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Check, X } from "lucide-react";
import { fmtDay } from "@shared/workforce";
import { TIME_OFF_STATUS, TIME_OFF_TYPE } from "../MySchedulePage";
import { inputCls } from "./ui";

export function TimeOffTab() {
  const utils = trpc.useUtils();
  const list = trpc.workforce.timeOff.list.useQuery();
  const [notes, setNotes] = useState<Record<number, string>>({});
  const decide = trpc.workforce.timeOff.decide.useMutation({
    onSuccess: (res, vars) => {
      utils.workforce.invalidate();
      if (vars.status === "approved" && res.conflicts.length) {
        toast.warning(`Approved — ${res.conflicts.length} scheduled shift${res.conflicts.length > 1 ? "s" : ""} fall in those dates. Mark them called out on the Schedule tab to find coverage.`, { duration: 9000 });
      } else toast.success(`Request ${vars.status}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const rows = list.data || [];
  const pending = rows.filter((r) => r.status === "pending");
  const history = rows.filter((r) => r.status !== "pending");

  return (
    <div className="grid lg:grid-cols-2 gap-5">
      <div className="bg-white rounded-3xl border border-slate-200 p-6">
        <h3 className="font-bold tracking-tight text-slate-900">Waiting for your decision <span className="text-slate-400 font-medium">({pending.length})</span></h3>
        {list.isLoading && <Loader2 className="animate-spin text-slate-400 mt-4" />}
        {!list.isLoading && pending.length === 0 && <p className="mt-4 text-sm text-slate-500">Nothing pending.</p>}
        <ul className="mt-4 space-y-3">
          {pending.map((r) => (
            <li key={r.id} className="rounded-2xl border border-slate-200 p-4">
              <p className="text-sm font-semibold text-slate-800">{r.userName} <span className="font-normal text-slate-500">· {TIME_OFF_TYPE[r.type]}</span></p>
              <p className="text-sm text-slate-600">{fmtDay(r.startDate)}{r.endDate !== r.startDate && ` → ${fmtDay(r.endDate)}`}</p>
              {r.reason && <p className="text-xs text-slate-500 mt-1">"{r.reason}"</p>}
              <input placeholder="Note back to employee (optional)" value={notes[r.id] ?? ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} className={`${inputCls} mt-3`} />
              <div className="flex gap-2 mt-2">
                <button disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, status: "approved", managerNote: notes[r.id]?.trim() || null })}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60"><Check size={15} /> Approve</button>
                <button disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, status: "denied", managerNote: notes[r.id]?.trim() || null })}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60"><X size={15} /> Deny</button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 p-6">
        <h3 className="font-bold tracking-tight text-slate-900">History</h3>
        {!list.isLoading && history.length === 0 && <p className="mt-4 text-sm text-slate-500">No past requests.</p>}
        <ul className="mt-4 divide-y divide-slate-100">
          {history.map((r) => (
            <li key={r.id} className="py-2.5 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-800">{r.userName} <span className="text-slate-500 font-normal">· {TIME_OFF_TYPE[r.type]}</span></p>
                <p className="text-xs text-slate-500">{fmtDay(r.startDate)}{r.endDate !== r.startDate && ` → ${fmtDay(r.endDate)}`}{r.managerNote ? ` · ${r.managerNote}` : ""}</p>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold capitalize ${TIME_OFF_STATUS[r.status]}`}>{r.status}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

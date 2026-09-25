import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Building2, UserX } from "lucide-react";
import { addDays, fmtDay, fmtTime, localDateStr } from "@shared/workforce";
import { CoverageModal, type CoverageTarget } from "./CoverageModal";
import { StatCard, btnGhost, inputCls } from "./ui";

const STATE: Record<string, { label: string; cls: string }> = {
  clocked_in: { label: "Clocked in", cls: "bg-emerald-100 text-emerald-800" },
  done: { label: "Worked", cls: "bg-slate-100 text-slate-600" },
  upcoming: { label: "Upcoming", cls: "bg-blue-100 text-blue-800" },
  late: { label: "Late — not in", cls: "bg-amber-100 text-amber-800" },
  no_show: { label: "No-show", cls: "bg-rose-100 text-rose-700" },
  called_out: { label: "Called out", cls: "bg-rose-600 text-white" },
  // Not on the time clock (providers, salaried staff) or before their clock start date.
  scheduled: { label: "Scheduled", cls: "bg-slate-100 text-slate-600" },
};

export function TodayTab({ onOpenTimeOff }: { onOpenTimeOff: () => void }) {
  const utils = trpc.useUtils();
  const [date, setDate] = useState(localDateStr());
  const board = trpc.workforce.board.useQuery({ date }, { refetchInterval: 60000 });
  const [coverFor, setCoverFor] = useState<CoverageTarget | null>(null);
  const callOut = trpc.workforce.schedule.callOut.useMutation({
    onSuccess: () => { utils.workforce.invalidate(); toast.success("Marked as called out"); },
    onError: (e) => toast.error(e.message),
  });

  const all = (board.data?.clinics || []).flatMap((c) => c.shifts);
  const count = (s: string) => all.filter((x) => x.state === s).length;
  const openNeeds = all.filter((x) => x.state === "called_out" && !x.covered).length;

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <button className={btnGhost} onClick={() => setDate(addDays(date, -1))}>←</button>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className={`${inputCls} !w-auto`} />
        <button className={btnGhost} onClick={() => setDate(addDays(date, 1))}>→</button>
        {date !== localDateStr() && <button className={btnGhost} onClick={() => setDate(localDateStr())}>Today</button>}
        <span className="ml-2 text-sm font-semibold text-slate-700">{fmtDay(date, { weekday: "long", month: "long", day: "numeric" })}</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <StatCard label="Scheduled" value={all.filter((x) => x.status === "scheduled").length} sub="across all clinics" />
        <StatCard label="Clocked in" value={count("clocked_in")} accent="text-emerald-600" />
        <StatCard label="Late / no-show" value={count("late") + count("no_show")} accent="text-amber-600" />
        <StatCard label="Needs coverage" value={openNeeds} accent={openNeeds ? "text-rose-600" : "text-slate-900"} sub={`${count("called_out")} call-outs`} />
        <button onClick={onOpenTimeOff} className="text-left"><StatCard label="Time-off requests" value={board.data?.pendingTimeOff ?? 0} sub="pending — tap to review" accent="text-blue-600" /></button>
      </div>

      {board.isLoading && <Loader2 className="animate-spin text-slate-400" />}
      <div className="grid md:grid-cols-2 gap-4">
        {(board.data?.clinics || []).map((c) => (
          <div key={c.id ?? "remote"} className="bg-white rounded-3xl border border-slate-200 p-5">
            <h3 className="flex items-center gap-2 font-bold tracking-tight text-slate-900"><Building2 size={16} className="text-slate-400" /> {c.name}
              <span className="ml-auto text-xs font-medium text-slate-400">{c.shifts.filter((s) => s.status === "scheduled").length} on shift</span>
            </h3>
            {c.shifts.length === 0 && <p className="mt-3 text-sm text-slate-400">Nobody scheduled.</p>}
            <ul className="mt-3 divide-y divide-slate-100">
              {c.shifts.map((s) => (
                <li key={s.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800 truncate">{s.userName}{s.coversShiftId ? <span className="ml-1.5 text-[10px] uppercase tracking-wider text-blue-700">covering</span> : null}</p>
                    <p className="text-xs text-slate-500">{fmtTime(s.startTime)} – {fmtTime(s.endTime)}
                      {s.clockInAt && <> · in {new Date(s.clockInAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })}</>}
                      {s.minutesLate > 0 && <span className="text-amber-600 font-medium"> · {s.minutesLate} min late</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${STATE[s.state].cls}`}>{s.state === "called_out" && s.covered ? "Out · covered" : STATE[s.state].label}</span>
                    {s.state === "called_out" && !s.covered && (
                      <button onClick={() => setCoverFor(s)} className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700">Find coverage</button>
                    )}
                    {["upcoming", "late", "no_show", "scheduled"].includes(s.state) && (
                      <button title="Mark as called out" onClick={() => callOut.mutate({ shiftId: s.id })} className="p-1.5 rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><UserX size={15} /></button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {board.data && board.data.clinics.length === 0 && <p className="text-sm text-slate-500">Add your clinics on the Clinics page first.</p>}

      {coverFor && <CoverageModal shift={coverFor} onClose={() => setCoverFor(null)} />}
    </div>
  );
}

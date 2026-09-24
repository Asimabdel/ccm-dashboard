import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Loader2, Shuffle, Home } from "lucide-react";
import { fmtDay, fmtDuration, fmtTime } from "@shared/workforce";
import { Modal } from "./ui";

export interface CoverageTarget { id: number; userName: string | null; clinicName: string | null; date: string; startTime: string; endTime: string }

/** Ranked list of who can cover a called-out shift; one click assigns them. */
export function CoverageModal({ shift, onClose }: { shift: CoverageTarget; onClose: () => void }) {
  const utils = trpc.useUtils();
  const candidates = trpc.workforce.schedule.coverageCandidates.useQuery(shift.id);
  const assign = trpc.workforce.schedule.assignCoverage.useMutation({
    onSuccess: () => { utils.workforce.invalidate(); toast.success("Coverage assigned — they've been notified"); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Modal title="Find coverage" onClose={onClose}>
      <p className="text-sm text-slate-600">
        <b>{shift.userName}</b> is out at <b>{shift.clinicName}</b> on {fmtDay(shift.date)}, {fmtTime(shift.startTime)} – {fmtTime(shift.endTime)}.
        These teammates hold the same job, aren't working those hours, and aren't on approved time off.
      </p>
      {candidates.isLoading && <Loader2 className="animate-spin text-slate-400 mt-4" />}
      {candidates.data?.length === 0 && <p className="mt-4 text-sm text-slate-500">Nobody is free for this shift. Check the People tab — staff need a job role and an active profile to appear here.</p>}
      <ul className="mt-4 space-y-2">
        {(candidates.data || []).map((c) => (
          <li key={c.userId} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-slate-800">{c.name}</p>
              <p className="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
                {c.sameClinic
                  ? <span className="inline-flex items-center gap-1 text-emerald-700"><Home size={11} /> Same clinic</span>
                  : <span>{c.homeClinicName ?? "No home clinic"}</span>}
                {c.canFloat && !c.sameClinic && <span className="inline-flex items-center gap-1 text-blue-700"><Shuffle size={11} /> Floats</span>}
                <span>· {fmtDuration(c.weekMinutes)} scheduled this week</span>
              </p>
            </div>
            <button disabled={assign.isPending} onClick={() => assign.mutate({ shiftId: shift.id, userId: c.userId })}
              className="px-3 py-1.5 rounded-xl bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 disabled:opacity-60">Assign</button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

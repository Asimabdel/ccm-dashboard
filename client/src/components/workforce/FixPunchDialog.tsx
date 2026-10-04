import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Wrench } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { addDays, fmtDay, fmtTime, localDateStr } from "@shared/workforce";

const inputCls = "w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:bg-slate-800 dark:border-slate-600";
const labelCls = "block text-xs font-semibold text-slate-600 dark:text-slate-300";

/**
 * "Fix my punch": pick the day and the punch (or "I didn't clock in at all"), give the right times and
 * what happened; it goes to your office manager to approve.
 */
export function FixPunchDialog({ open, onClose, date, punchId }: { open: boolean; onClose: () => void; date?: string; punchId?: number }) {
  const utils = trpc.useUtils();
  const today = localDateStr();
  const [day, setDay] = useState(date ?? today);
  const [pick, setPick] = useState<number | "none" | null>(punchId ?? null);
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [reason, setReason] = useState("");
  const punches = trpc.workforce.me.punchDay.useQuery({ date: day }, { enabled: open });
  const send = trpc.workforce.me.requestPunchFix.useMutation({
    onSuccess: () => { toast.success("Sent to your manager. You'll get a notification when it's decided."); void utils.workforce.me.punchRequests.invalidate(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  useEffect(() => { if (open) { setDay(date ?? today); setPick(punchId ?? null); setReason(""); } }, [open, date, punchId, today]);
  // Prefill the chosen punch's times (or blanks for a day with no punch).
  useEffect(() => {
    if (pick === "none" || pick === null) { setClockIn(""); setClockOut(""); return; }
    const p = punches.data?.find((x) => x.id === pick);
    if (p) { setClockIn(p.clockIn); setClockOut(p.clockOut ?? ""); }
  }, [pick, punches.data]);
  useEffect(() => { if (punches.data && pick === null) setPick(punches.data.length ? (punches.data.find((p) => !p.clockOut)?.id ?? punches.data[0]!.id) : "none"); }, [punches.data, pick]);

  const chosen = typeof pick === "number" ? punches.data?.find((x) => x.id === pick) : null;
  const submit = () => send.mutate({
    workDate: day, punchId: typeof pick === "number" ? pick : null,
    clockIn: chosen && clockIn === chosen.clockIn ? null : clockIn || null,
    clockOut: chosen && clockOut === (chosen.clockOut ?? "") ? null : clockOut || null,
    reason,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !send.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Wrench size={16} /> Fix a punch</DialogTitle>
          <DialogDescription>Forgot to clock out, clocked in late by mistake, or didn't clock in at all? Your manager approves the change.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <label className={labelCls}>Day
            <input type="date" className={cn(inputCls, "mt-1")} value={day} min={addDays(today, -31)} max={today} onChange={(e) => { setDay(e.target.value); setPick(null); }} />
          </label>
          <div>
            <p className={labelCls}>Which punch?</p>
            {punches.isLoading ? <Loader2 size={14} className="mt-2 animate-spin text-slate-400" /> : (
              <div className="mt-1 space-y-1">
                {(punches.data ?? []).map((p) => (
                  <label key={p.id} className={cn("flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2", pick === p.id ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30" : "border-slate-200 dark:border-slate-600")}>
                    <input type="radio" checked={pick === p.id} onChange={() => setPick(p.id)} />
                    {fmtTime(p.clockIn)} → {p.clockOut ? fmtTime(p.clockOut) : <span className="font-semibold text-amber-700">no clock-out</span>}{p.lunch ? " (lunch)" : ""}
                  </label>
                ))}
                <label className={cn("flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2", pick === "none" ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30" : "border-slate-200 dark:border-slate-600")}>
                  <input type="radio" checked={pick === "none"} onChange={() => setPick("none")} /> I worked but didn't clock in at all
                </label>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>Clock in
              <input type="time" className={cn(inputCls, "mt-1")} value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
            </label>
            <label className={labelCls}>Clock out
              <input type="time" className={cn(inputCls, "mt-1")} value={clockOut} onChange={(e) => setClockOut(e.target.value)} />
            </label>
          </div>
          <label className={labelCls}>What happened?
            <textarea className={cn(inputCls, "mt-1")} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`e.g. "Forgot to clock out, left at 5:05" (${fmtDay(day)})`} />
          </label>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} disabled={send.isPending} className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700">Cancel</button>
            <button onClick={submit} disabled={send.isPending || !reason.trim() || pick === null} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
              {send.isPending ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />} Send to my manager
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, PhoneCall, PhoneForwarded } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { CALL_OUTCOMES, CALL_OUTCOME_LIST, type CallOutcome } from "@shared/phone";
import { OUTREACH_TABS, addBusinessDays, outcomeLabel, type OutreachStatus } from "@shared/outreach";
import { localDateStr } from "@shared/workforce";
import { cn } from "@/lib/utils";

/** What the server sends per row (see server/outreachDb.ts stateFor). */
export interface RowOutreach {
  status: OutreachStatus;
  tries: number;
  next: string | null;
  label: string;
  calls: number;
  last: { at: Date | string; outcome: string | null; by: string | null; manual: boolean } | null;
  lockedBy: string | null;
}

const STATUS_CLS: Record<OutreachStatus, string> = {
  to_call: "bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200",
  waiting: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  booked: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200",
  unreachable: "bg-rose-50 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200",
  closed: "bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300",
};

const fmtWhen = (d: Date | string) => {
  const dt = new Date(d);
  const today = localDateStr();
  return localDateStr(dt) === today ? dt.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }) : fmtShortDate(dt).replace(/, \d{4}$/, "");
};

/** To call · Waiting · Booked · Unreachable · Closed, with counts. */
export function StatusTabs({ value, counts, onChange }: { value: OutreachStatus; counts?: Record<string, number>; onChange: (s: OutreachStatus) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Call status">
      {OUTREACH_TABS.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} title={t.hint} onClick={() => onChange(t.key)}
          className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold", value === t.key ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300")}>
          {t.label} <span className={cn("tabular-nums", value === t.key ? "text-white/80" : "text-slate-400")}>{counts?.[t.key] ?? "…"}</span>
        </button>
      ))}
    </div>
  );
}

/** The call status of one patient on a list: where they stand, the last call, and who is calling them now. */
export function OutreachCell({ o, onLog }: { o: RowOutreach; onLog?: () => void }) {
  return (
    <div className="min-w-[150px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_CLS[o.status])}>{o.label}</span>
        {o.lockedBy && <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:bg-violet-500/15 dark:text-violet-200"><PhoneForwarded size={11} /> {o.lockedBy} is calling</span>}
      </div>
      {o.last && (
        <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
          {o.calls > 1 ? `${o.calls} calls · ` : ""}{outcomeLabel(o.last.outcome)}{o.last.by ? ` · ${o.last.by.replace(/\s*\(.*?\)/, "")}` : ""} · {fmtWhen(o.last.at)}{o.last.manual ? " (logged)" : ""}
        </p>
      )}
      {onLog && <button onClick={onLog} className="mt-0.5 text-[11px] font-semibold text-brand hover:underline">{o.last && !o.last.outcome ? "Add the result" : "Log a call"}</button>}
    </div>
  );
}

/** Outcome buttons, a call-back date and a note. */
export function OutcomePicker({ busy, submitLabel, onSubmit, autoFocusNote }: {
  busy: boolean; submitLabel: string; autoFocusNote?: boolean;
  onSubmit: (v: { outcome: CallOutcome; callBackOn: string | null; note: string | null }) => void;
}) {
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [callBackOn, setCallBackOn] = useState(() => addBusinessDays(localDateStr(), 1));
  const [note, setNote] = useState("");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {CALL_OUTCOME_LIST.map((o) => (
          <button key={o} type="button" onClick={() => setOutcome(o)}
            className={cn("rounded-lg border px-2.5 py-1.5 text-xs font-medium transition", outcome === o ? "border-brand bg-brand/10 text-slate-900 dark:text-slate-50" : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800")}>
            {CALL_OUTCOMES[o]}
          </button>
        ))}
      </div>
      {outcome === "call_back" && (
        <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
          Call back on
          <input type="date" value={callBackOn} min={localDateStr()} onChange={(e) => setCallBackOn(e.target.value)} className={cn(inputCls, "w-auto py-1")} />
        </label>
      )}
      <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} autoFocus={autoFocusNote}
        placeholder="Note (optional), e.g. booked Tue 10:40 with Dr. Narang" aria-label="Note" />
      <div className="flex justify-end">
        <Btn disabled={!outcome || busy} onClick={() => outcome && onSubmit({ outcome, callBackOn: outcome === "call_back" ? callBackOn || null : null, note: note.trim() || null })}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <PhoneCall size={14} />} {submitLabel}
        </Btn>
      </div>
    </div>
  );
}

/** Log a call made outside the RingCentral phone (or add the result of one that has none). */
export function LogCallDialog({ target, category, onClose }: { target: { key: string; name: string } | null; category: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [k, setK] = useState(0);
  useEffect(() => { if (target) setK((x) => x + 1); }, [target]);
  const record = trpc.workspace.outreach.record.useMutation({
    onSuccess: (r) => {
      toast.success(r.closed ? "Saved, and taken off the list." : r.logged ? "Call logged." : "Result saved.");
      void utils.workspace.opportunities.invalidate();
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>How did the call with {target?.name} go?</DialogTitle>
          <DialogDescription>For a call from a cell phone or any line outside MyPCP. A call you just made through MyPCP's phone gets this result instead of a second entry.</DialogDescription>
        </DialogHeader>
        <OutcomePicker key={k} busy={record.isPending} submitLabel="Save"
          onSubmit={(v) => target && record.mutate({ subjectKey: target.key, category, ...v })} />
      </DialogContent>
    </Dialog>
  );
}

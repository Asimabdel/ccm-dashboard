import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Undo2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDay, localDateStr } from "@shared/workforce";
import {
  OFFICE_TESTS, OFFICE_TEST_LABELS, OFFICE_TEST_STATE_LABELS, type OfficeTest, type OfficeTestRecordStatus, type OfficeTestState,
} from "@shared/officeTests";

export const TEST_PILL: Record<OfficeTest, string> = {
  abi_q: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900",
  pft: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-900",
  rmr: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900",
};
export const STATE_TEXT: Record<OfficeTestState, string> = {
  eligible: "text-emerald-700 dark:text-emerald-300", scheduled: "text-sky-700 dark:text-sky-300", done: "text-slate-500", declined: "text-rose-700 dark:text-rose-300", not_needed: "text-slate-500",
};
export const dayText = (d: string | null) => (d ? fmtDay(d, { month: "short", day: "numeric", year: "numeric" }) : "");

const STATUS_CHOICES: { key: OfficeTestRecordStatus; label: string; hint: string }[] = [
  { key: "scheduled", label: "Scheduled", hint: "Booked for a date (today or later)" },
  { key: "done", label: "Done", hint: "The test was performed" },
  { key: "declined", label: "Declined", hint: "The patient said no (hidden for 12 months)" },
  { key: "not_applicable", label: "Not needed", hint: "The provider says not needed (hidden for 12 months)" },
];

/** Mark one patient's tests: scheduled for a date, done, declined or not needed. */
export function MarkTestsDialog({ open, onClose, subjectKey, name, tests, initial }: {
  open: boolean; onClose: () => void; subjectKey: string; name: string; tests: OfficeTest[]; initial?: OfficeTestRecordStatus;
}) {
  const utils = trpc.useUtils();
  const today = localDateStr();
  const [picked, setPicked] = useState<OfficeTest[]>(tests);
  const [status, setStatus] = useState<OfficeTestRecordStatus>(initial ?? "scheduled");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  useEffect(() => { if (open) { setPicked(tests); setStatus(initial ?? "scheduled"); setDate(today); setNote(""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = trpc.workspace.officeTests.record.useMutation({
    onSuccess: () => { toast.success("Saved."); void utils.workspace.officeTests.invalidate(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const label = "mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark tests for {name}</DialogTitle>
          <DialogDescription>Their provider orders each test. Mark it here once it's booked or done.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (picked.length) save.mutate({ subjectKey, tests: picked, status, date, note: note || null }); }}>
          <div>
            <span className={label}>Tests</span>
            <div className="flex flex-wrap gap-2">
              {OFFICE_TESTS.filter((t) => tests.includes(t)).map((t) => (
                <label key={t} className={cn("flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ring-1", picked.includes(t) ? TEST_PILL[t] : "text-slate-500 ring-slate-200 dark:ring-slate-700")}>
                  <input type="checkbox" className="size-3.5 accent-brand" checked={picked.includes(t)} onChange={() => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))} />
                  {OFFICE_TEST_LABELS[t]}
                </label>
              ))}
            </div>
          </div>
          <div>
            <span className={label}>What happened</span>
            <div className="grid grid-cols-2 gap-2">
              {STATUS_CHOICES.map((s) => (
                <button type="button" key={s.key} onClick={() => setStatus(s.key)} title={s.hint}
                  className={cn("rounded-lg border px-3 py-2 text-left text-sm", status === s.key ? "border-brand bg-brand/5 font-semibold text-slate-900 dark:text-slate-50" : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800")}>
                  {s.label}
                  <span className="block text-[11px] font-normal text-slate-500">{s.hint}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">{status === "scheduled" ? "Appointment date" : "Date"}
              <input type="date" className={cn(inputCls, "mt-1")} value={date} min={status === "scheduled" ? today : undefined} max={status === "done" ? today : undefined} onChange={(e) => setDate(e.target.value)} required />
            </label>
            <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">Note (optional)
              <input className={cn(inputCls, "mt-1")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. at their 10/14 visit" />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="secondary" onClick={onClose}>Cancel</Btn>
            <Btn type="submit" disabled={!picked.length || save.isPending}>{save.isPending && <Loader2 size={14} className="animate-spin" />} Save</Btn>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Patient 360 → Testing: the in-office tests this patient qualifies for, where each stands, and the marks so far. */
export function OfficeTestsPanel({ subjectKey, name }: { subjectKey: string; name: string }) {
  const q = trpc.workspace.officeTests.forPatient.useQuery({ key: subjectKey });
  const utils = trpc.useUtils();
  const undo = trpc.workspace.officeTests.undo.useMutation({ onSuccess: () => void utils.workspace.officeTests.invalidate(), onError: (e) => toast.error(e.message) });
  const [mark, setMark] = useState<OfficeTest[] | null>(null);
  const d = q.data;
  if (!d || (!d.tests.length && !d.history.length)) return null;
  return (
    <div className="mb-5 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50">In-office tests</h4>
        {d.tests.length > 0 && <Btn size="sm" variant="secondary" onClick={() => setMark(d.tests.map((t) => t.test))}>Mark…</Btn>}
      </div>
      {d.tests.length === 0 && <p className="text-sm text-slate-500">Doesn't meet the criteria for ABI-Q, PFT or RMR right now.</p>}
      <ul className="space-y-2">
        {d.tests.map((t) => (
          <li key={t.test} className="flex flex-wrap items-start gap-2 text-sm">
            <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ring-1", TEST_PILL[t.test])}>{OFFICE_TEST_LABELS[t.test]}</span>
            <span className={cn("shrink-0 font-semibold", STATE_TEXT[t.state])}>
              {OFFICE_TEST_STATE_LABELS[t.state]}{t.state === "scheduled" && t.scheduledFor ? ` for ${dayText(t.scheduledFor)}` : ""}{t.state === "done" && t.lastDone ? ` (${dayText(t.lastDone)})` : ""}
            </span>
            <span className="min-w-0 flex-1 text-xs text-slate-500">{t.reasons.map((r) => r.why).join(" · ")}</span>
          </li>
        ))}
      </ul>
      {d.history.length > 0 && (
        <details className="mt-3 text-xs text-slate-500">
          <summary className="cursor-pointer font-semibold">History ({d.history.length})</summary>
          <ul className="mt-1 space-y-1">
            {d.history.map((h) => (
              <li key={h.id} className="flex items-center gap-2">
                <span className="w-24 tabular-nums">{dayText(h.date)}</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{h.label}</span>
                <span>{h.status === "not_applicable" ? "not needed" : h.status}</span>
                {h.note && <span className="truncate">· {h.note}</span>}
                <button className="ml-auto inline-flex items-center gap-1 hover:text-slate-800" onClick={() => undo.mutate({ id: h.id })} aria-label="Undo"><Undo2 size={12} /> Undo</button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {mark && <MarkTestsDialog open onClose={() => setMark(null)} subjectKey={subjectKey} name={name} tests={mark} />}
    </div>
  );
}

import { useState } from "react";
import { toast } from "sonner";
import { Ban, CheckCircle2, ClipboardPlus, Loader2, Trash2, XCircle } from "lucide-react";
import { Btn, ErrorNote, Loading, inputCls } from "@/components/workspace/ui";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { TESTS, TEST_GROUP_LABELS, TEST_STATE_LABELS, type TestGroup, type TestKey, type TestState } from "@shared/testing";
import { fmtDay, localDateStr } from "@shared/workforce";
import { cn } from "@/lib/utils";

/** Calendar dates (YYYY-MM-DD) have no time zone: format them as-is, never via midnight UTC. */
const fmtYmd = (s: string) => fmtDay(s, { month: "short", day: "numeric", year: "numeric" });

export const STATE_CLS: Record<TestState, string> = {
  due: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  no_record: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  due_soon: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  current: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  declined: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  not_applicable: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  needs_info: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
};

const methodLabel = (key: TestKey, method: string | null) => {
  const def = TESTS[key] as { methods?: Record<string, { label: string }> };
  return method && def.methods?.[method] ? def.methods[method].label : null;
};

/** One patient's tests and screenings: what applies, where they stand, and recording results. */
export function PatientTestingPanel({ subjectKey }: { subjectKey: string }) {
  const q = trpc.workspace.testing.person.useQuery(subjectKey);
  const utils = trpc.useUtils();
  const [recording, setRecording] = useState<{ key: TestKey; status: "done" | "not_applicable" | "declined" } | null>(null);
  const refresh = () => { void utils.workspace.testing.invalidate(); };
  const setSex = trpc.workspace.testing.setSex.useMutation({ onSuccess: () => { refresh(); toast.success("Saved"); }, onError: (e) => toast.error(e.message) });
  const del = trpc.workspace.testing.deleteRecord.useMutation({ onSuccess: () => { refresh(); toast.success("Removed"); }, onError: (e) => toast.error(e.message) });

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote message={q.error.message} />;
  const d = q.data!;
  const groups = (Object.keys(TEST_GROUP_LABELS) as TestGroup[]).map((g) => ({ g, items: d.statuses.filter((s) => s.group === g) })).filter((x) => x.items.length);

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-3 text-slate-600 dark:text-slate-300">
        <span>Age <b>{d.age ?? "unknown"}</b></span>
        <span className="flex items-center gap-1.5">Sex
          <select className={cn(inputCls, "w-auto py-1")} value={d.sex ?? ""} onChange={(e) => setSex.mutate({ subjectKey, sex: (e.target.value || null) as "F" | "M" | "X" | null })}>
            <option value="">Unknown</option><option value="F">Female</option><option value="M">Male</option><option value="X">Other</option>
          </select>
        </span>
        <span className="text-xs text-slate-400">Guideline reminders for the care team; the provider decides what to order.</span>
      </div>

      {groups.length === 0 && <p className="text-slate-500">No tests apply based on age, sex and the conditions on file.</p>}
      {groups.map(({ g, items }) => (
        <div key={g}>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1.5">{TEST_GROUP_LABELS[g]}</p>
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700">
            {items.map((s) => (
              <div key={s.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5">
                <div className="min-w-[200px] flex-1">
                  <p className="font-medium text-slate-900 dark:text-slate-50">{s.label}</p>
                  <p className="text-xs text-slate-500">{s.who} · {s.guideline}</p>
                </div>
                <span className={cn("px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap", STATE_CLS[s.state])}>{TEST_STATE_LABELS[s.state]}</span>
                <div className="w-52 text-xs text-slate-600 dark:text-slate-300">
                  {s.lastDone ? <>Last {fmtYmd(s.lastDone.date)}{methodLabel(s.key, s.lastDone.method) ? ` · ${methodLabel(s.key, s.lastDone.method)}` : ""}{s.lastDone.result ? ` · ${s.lastDone.result}` : ""}</> : s.state === "needs_info" ? "Set sex to check" : "Nothing on file"}
                  {s.dueOn && <span className="block text-slate-400">Next due {fmtYmd(s.dueOn)}</span>}
                </div>
                {s.state !== "needs_info" && (
                  <div className="flex gap-1">
                    <Btn size="sm" variant="secondary" onClick={() => setRecording({ key: s.key, status: "done" })}><ClipboardPlus size={13} /> Record</Btn>
                    <Btn size="sm" variant="ghost" title="Not needed for this patient (e.g. hysterectomy, colectomy)" onClick={() => setRecording({ key: s.key, status: "not_applicable" })}><Ban size={13} /></Btn>
                    <Btn size="sm" variant="ghost" title="Patient declined" onClick={() => setRecording({ key: s.key, status: "declined" })}><XCircle size={13} /></Btn>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {d.history.length > 0 && (
        <details className="rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-slate-600 dark:text-slate-300">History ({d.history.length})</summary>
          <ul className="mt-2 space-y-1">
            {d.history.slice(0, 50).map((h) => (
              <li key={h.id} className="flex items-center gap-3 text-xs text-slate-600 dark:text-slate-300">
                <span className="w-24">{fmtYmd(h.performedOn)}</span>
                <span className="flex-1">{h.label}{methodLabel(h.testKey, h.method ?? null) ? ` (${methodLabel(h.testKey, h.method ?? null)})` : ""}{h.status !== "done" ? ` — ${h.status === "declined" ? "declined" : "not needed"}` : ""}{h.result ? ` · ${h.result}` : ""}{h.note ? ` · ${h.note}` : ""}</span>
                <span className="text-slate-400">{h.source === "import" ? "Practice Fusion" : "MyPCP"}</span>
                {h.source === "manual" && <button aria-label="Remove" className="text-slate-400 hover:text-rose-600" onClick={() => { if (confirm("Remove this entry?")) del.mutate(h.id); }}><Trash2 size={13} /></button>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {recording && <RecordDialog subjectKey={subjectKey} testKey={recording.key} status={recording.status} onClose={() => setRecording(null)} onSaved={refresh} />}
    </div>
  );
}

function RecordDialog({ subjectKey, testKey, status, onClose, onSaved }: { subjectKey: string; testKey: TestKey; status: "done" | "not_applicable" | "declined"; onClose: () => void; onSaved: () => void }) {
  const def = TESTS[testKey] as { label: string; methods?: Record<string, { label: string }> };
  const [form, setForm] = useState({ performedOn: localDateStr(), method: def.methods ? Object.keys(def.methods)[0]! : "", result: "", note: "" });
  const save = trpc.workspace.testing.record.useMutation({
    onSuccess: () => { onSaved(); toast.success("Saved"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const title = status === "done" ? `Record ${def.label}` : status === "declined" ? `${def.label}: patient declined` : `${def.label}: not needed`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{status === "done" ? "When it was done. It's then counted until it's due again." : status === "declined" ? "Hidden from the due list for 12 months." : "Hidden until someone records this test (e.g. after a hysterectomy or colectomy)."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-xs font-semibold text-slate-600">Date
            <input type="date" max={localDateStr()} className={cn(inputCls, "mt-1")} value={form.performedOn} onChange={(e) => setForm({ ...form, performedOn: e.target.value })} />
          </label>
          {status === "done" && def.methods && (
            <label className="block text-xs font-semibold text-slate-600">Type
              <select className={cn(inputCls, "mt-1")} value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                {Object.entries(def.methods).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
              </select>
            </label>
          )}
          {status === "done" && (
            <label className="block text-xs font-semibold text-slate-600">Result (optional)
              <input className={cn(inputCls, "mt-1")} value={form.result} maxLength={120} placeholder="e.g. 7.1%" onChange={(e) => setForm({ ...form, result: e.target.value })} />
            </label>
          )}
          <label className="block text-xs font-semibold text-slate-600">Note (optional)
            <input className={cn(inputCls, "mt-1")} value={form.note} maxLength={1000} placeholder={status === "not_applicable" ? "e.g. hysterectomy 2019" : status === "declined" ? "e.g. prefers to wait" : "e.g. done at outside lab"} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
            <Btn disabled={save.isPending || !form.performedOn} onClick={() => save.mutate({ subjectKey, testKey, status, performedOn: form.performedOn, method: status === "done" && def.methods ? form.method : null, result: form.result || null, note: form.note || null })}>
              {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Save
            </Btn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

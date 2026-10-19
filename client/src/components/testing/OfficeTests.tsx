import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FileText, Loader2, Paperclip, Pencil, Undo2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileViewer, type ViewerFile } from "@/components/folder/FileViewer";
import { Btn, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { MAX_PATIENT_FILE_BYTES, PATIENT_FILE_MIME } from "@shared/folder";
import { fmtDay, localDateStr } from "@shared/workforce";
import {
  OFFICE_TESTS, OFFICE_TEST_LABELS, OFFICE_TEST_RESULT_FIELDS, OFFICE_TEST_STATE_LABELS,
  type OfficeTest, type OfficeTestRecordStatus, type OfficeTestState,
} from "@shared/officeTests";

export const TEST_PILL: Record<OfficeTest, string> = {
  abi_q: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900",
  pft: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-900",
  rmr: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900",
};
export const STATE_TEXT: Record<OfficeTestState, string> = {
  eligible: "text-emerald-700 dark:text-emerald-300", scheduled: "text-sky-700 dark:text-sky-300", missed: "text-orange-700 dark:text-orange-300",
  done: "text-slate-500", declined: "text-rose-700 dark:text-rose-300", not_needed: "text-slate-500",
};
export const dayText = (d: string | null) => (d ? fmtDay(d, { month: "short", day: "numeric", year: "numeric" }) : "");

const STATUS_CHOICES: { key: OfficeTestRecordStatus; label: string; hint: string }[] = [
  { key: "scheduled", label: "Scheduled", hint: "Booked for a date (today or later)" },
  { key: "done", label: "Done", hint: "The test was performed" },
  { key: "declined", label: "Declined", hint: "The patient said no (hidden for 12 months)" },
  { key: "not_applicable", label: "Not needed", hint: "The provider says not needed (hidden for 12 months)" },
];

type Values = Record<string, string>;
const label = "mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300";

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read the file."));
    r.readAsDataURL(file);
  });
}

/** Puts a test's report in the patient's folder (Test results) and returns its id. */
function useReportUpload() {
  const start = trpc.workspace.folder.startUpload.useMutation();
  const local = trpc.workspace.folder.uploadLocal.useMutation();
  const finish = trpc.workspace.folder.finishUpload.useMutation();
  return async (subjectKey: string, test: OfficeTest, date: string, file: File) => {
    const s = await start.mutateAsync({ subjectKey, fileName: file.name, mimeType: file.type, size: file.size, fileType: "test_result", title: `${OFFICE_TEST_LABELS[test]} report — ${dayText(date)}`, note: null });
    if (s.upload.url) {
      const r = await fetch(s.upload.url, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!r.ok) throw new Error(`Upload failed (${r.status}).`);
    } else {
      await local.mutateAsync({ id: s.id, base64: await toBase64(file) });
    }
    await finish.mutateAsync({ id: s.id });
    return s.id;
  };
}

/** Numbers from the form → what the server takes (blank fields left out). */
function resultsOf(test: OfficeTest, v: Values): Record<string, number | string> | null {
  const out: Record<string, number | string> = {};
  for (const f of OFFICE_TEST_RESULT_FIELDS[test]) {
    const x = (v[f.key] ?? "").trim();
    if (!x) continue;
    out[f.key] = f.kind === "number" ? Number(x) : x;
  }
  return Object.keys(out).length ? out : null;
}

/** The machine's numbers for one test (FEV1/FVC fills in from FEV1 and FVC). */
function ResultFields({ test, value, onChange }: { test: OfficeTest; value: Values; onChange: (v: Values) => void }) {
  const set = (k: string, x: string) => {
    const next = { ...value, [k]: x };
    if (test === "pft" && (k === "fev1" || k === "fvc") && !value.ratioTouched) {
      const fev1 = Number(next.fev1), fvc = Number(next.fvc);
      next.ratio = fev1 > 0 && fvc > 0 ? String(Math.round((fev1 / fvc) * 100)) : "";
    }
    if (k === "ratio") next.ratioTouched = "1";
    onChange(next);
  };
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {OFFICE_TEST_RESULT_FIELDS[test].map((f) => (
        <label key={f.key} className="text-[11px] font-semibold text-slate-500">
          {f.label}{f.unit ? ` (${f.unit})` : ""}
          {f.kind === "choice" ? (
            <select className={cn(inputCls, "mt-0.5 py-1.5")} value={value[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)}>
              <option value="">—</option>
              {f.choices!.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input type="number" inputMode="decimal" className={cn(inputCls, "mt-0.5 py-1.5")} value={value[f.key] ?? ""} min={f.min} max={f.max} step={f.step}
              onChange={(e) => set(f.key, e.target.value)} />
          )}
        </label>
      ))}
    </div>
  );
}

function ReportInput({ file, onPick }: { file: File | null; onPick: (f: File | null) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
      <Paperclip size={13} className="shrink-0 text-slate-400" />
      <span className="truncate">{file ? file.name : "Attach the report (PDF or photo, optional)"}</span>
      <input type="file" className="sr-only" accept={PATIENT_FILE_MIME.join(",")}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = "";
          if (f && !(PATIENT_FILE_MIME as readonly string[]).includes(f.type)) { toast.error("Add a PDF, JPG or PNG."); return; }
          if (f && f.size > MAX_PATIENT_FILE_BYTES) { toast.error("Files can be up to 25 MB."); return; }
          onPick(f);
        }} />
      {file && <button type="button" className="text-slate-400 hover:text-slate-700" onClick={(e) => { e.preventDefault(); onPick(null); }}>Remove</button>}
    </label>
  );
}

function PerformedBy({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const staff = trpc.workspace.tasks.assignees.useQuery(undefined, { staleTime: 5 * 60_000 });
  return (
    <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">Performed by
      <select className={cn(inputCls, "mt-1")} value={value ?? ""} onChange={(e) => onChange(Number(e.target.value) || null)}>
        {!staff.data && value && <option value={value}>Me</option>}
        {(staff.data ?? []).filter((u) => u.role !== "billing" || u.id === value).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </label>
  );
}

/** Mark one patient's tests: scheduled for a date, done (with the numbers and the report), declined or not needed. */
export function MarkTestsDialog({ open, onClose, subjectKey, name, tests, initial, initialDate }: {
  open: boolean; onClose: () => void; subjectKey: string; name: string; tests: OfficeTest[]; initial?: OfficeTestRecordStatus; initialDate?: string;
}) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const today = localDateStr();
  const [picked, setPicked] = useState<OfficeTest[]>(tests);
  const [status, setStatus] = useState<OfficeTestRecordStatus>(initial ?? "scheduled");
  const [date, setDate] = useState(initialDate ?? today);
  const [note, setNote] = useState("");
  const [values, setValues] = useState<Partial<Record<OfficeTest, Values>>>({});
  const [files, setFiles] = useState<Partial<Record<OfficeTest, File | null>>>({});
  const [performer, setPerformer] = useState<number | null>(user?.id ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setPicked(tests); setStatus(initial ?? "scheduled"); setDate(initialDate ?? today); setNote(""); setValues({}); setFiles({}); setPerformer(user?.id ?? null); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const record = trpc.workspace.officeTests.record.useMutation();
  const details = trpc.workspace.officeTests.saveDetails.useMutation();
  const upload = useReportUpload();
  const done = status === "done";

  const save = async () => {
    if (!picked.length) return;
    setBusy(true);
    try {
      const results = done ? Object.fromEntries(picked.map((t) => [t, resultsOf(t, values[t] ?? {})])) : null;
      const r = await record.mutateAsync({ subjectKey, tests: picked, status, date, note: note || null, results, performedByUserId: done ? performer : null });
      let attached = 0;
      if (done) {
        for (const t of picked) {
          const f = files[t];
          const id = r.ids[t];
          if (!f || !id) continue;
          const fileId = await upload(subjectKey, t, date, f);
          await details.mutateAsync({ id, fileId });
          attached++;
        }
      }
      toast.success(attached ? `Saved, with ${attached} report${attached === 1 ? "" : "s"} in ${name}'s folder.` : "Saved.");
      void utils.workspace.officeTests.invalidate();
      void utils.workspace.folder.invalidate();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Mark tests for {name}</DialogTitle>
          <DialogDescription>Their provider orders each test. Mark it here once it's booked or done.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
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
              <input type="date" className={cn(inputCls, "mt-1")} value={date} min={status === "scheduled" ? today : undefined} max={done ? today : undefined} onChange={(e) => setDate(e.target.value)} required />
            </label>
            {done ? <PerformedBy value={performer} onChange={setPerformer} /> : (
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">Note (optional)
                <input className={cn(inputCls, "mt-1")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. at their 10/14 visit" />
              </label>
            )}
          </div>
          {done && (
            <div className="space-y-3">
              <span className={label}>Results (optional — can be added later)</span>
              {OFFICE_TESTS.filter((t) => picked.includes(t)).map((t) => (
                <div key={t} className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold ring-1", TEST_PILL[t])}>{OFFICE_TEST_LABELS[t]}</span>
                  <ResultFields test={t} value={values[t] ?? {}} onChange={(v) => setValues((s) => ({ ...s, [t]: v }))} />
                  <ReportInput file={files[t] ?? null} onPick={(f) => setFiles((s) => ({ ...s, [t]: f }))} />
                </div>
              ))}
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Note (optional)
                <input className={cn(inputCls, "mt-1")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
              </label>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
            <Btn type="submit" disabled={!picked.length || busy}>{busy && <Loader2 size={14} className="animate-spin" />} Save</Btn>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A done test: add or correct the numbers, who did it, and the report. */
export function TestDetailsDialog({ open, onClose, id, test, date, subjectKey, name, initial }: {
  open: boolean; onClose: () => void; id: number; test: OfficeTest; date: string; subjectKey: string; name: string;
  initial?: { results?: Record<string, number | string> | null; performedByUserId?: number | null; hasReport?: boolean };
}) {
  const utils = trpc.useUtils();
  const [values, setValues] = useState<Values>({});
  const [performer, setPerformer] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setValues(Object.fromEntries(Object.entries(initial?.results ?? {}).map(([k, v]) => [k, String(v)])));
    setPerformer(initial?.performedByUserId ?? null);
    setFile(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const details = trpc.workspace.officeTests.saveDetails.useMutation();
  const upload = useReportUpload();
  const save = async () => {
    setBusy(true);
    try {
      const fileId = file ? await upload(subjectKey, test, date, file) : undefined;
      await details.mutateAsync({ id, results: resultsOf(test, values), performedByUserId: performer, ...(fileId ? { fileId } : {}) });
      toast.success(fileId ? `Saved. The report is in ${name}'s folder.` : "Saved.");
      void utils.workspace.officeTests.invalidate();
      void utils.workspace.folder.invalidate();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{OFFICE_TEST_LABELS[test]} results — {name}</DialogTitle>
          <DialogDescription>Done {dayText(date)}. The report goes in the patient's folder under Test results.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <ResultFields test={test} value={values} onChange={setValues} />
          <PerformedBy value={performer} onChange={setPerformer} />
          <div>
            {initial?.hasReport && !file && <p className="mb-1 text-xs text-slate-500">A report is attached. Attaching another replaces it here (the old one stays in the folder).</p>}
            <ReportInput file={file} onPick={setFile} />
          </div>
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
            <Btn type="submit" disabled={busy}>{busy && <Loader2 size={14} className="animate-spin" />} Save</Btn>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Opens a test's report from the patient's folder. */
export function ReportButton({ fileId, title = "Report" }: { fileId: number; title?: string }) {
  const [viewing, setViewing] = useState<ViewerFile | null>(null);
  const openFile = trpc.workspace.folder.openFile.useMutation({ onError: (e) => toast.error(e.message) });
  return (
    <>
      <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline" disabled={openFile.isPending}
        onClick={async () => { const r = await openFile.mutateAsync({ id: fileId }); setViewing({ title: r.title, mimeType: r.mimeType, url: r.url, base64: r.base64 }); }}>
        {openFile.isPending ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} {title}
      </button>
      <FileViewer file={viewing} onClose={() => setViewing(null)} />
    </>
  );
}

/** Patient 360 → Testing: the in-office tests this patient qualifies for, where each stands, and the marks so far. */
export function OfficeTestsPanel({ subjectKey, name }: { subjectKey: string; name: string }) {
  const q = trpc.workspace.officeTests.forPatient.useQuery({ key: subjectKey });
  const utils = trpc.useUtils();
  const undo = trpc.workspace.officeTests.undo.useMutation({ onSuccess: () => void utils.workspace.officeTests.invalidate(), onError: (e) => toast.error(e.message) });
  const [mark, setMark] = useState<OfficeTest[] | null>(null);
  const [editing, setEditing] = useState<NonNullable<typeof q.data>["history"][number] | null>(null);
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
              {OFFICE_TEST_STATE_LABELS[t.state]}{t.state === "scheduled" && t.scheduledFor ? ` for ${dayText(t.scheduledFor)}` : ""}{t.state === "missed" && t.scheduledFor ? ` (booked ${dayText(t.scheduledFor)})` : ""}{t.state === "done" && t.lastDone ? ` (${dayText(t.lastDone)})` : ""}
            </span>
            <span className="min-w-0 flex-1 text-xs text-slate-500">
              {t.state === "done" && t.results ? <b className="font-semibold text-slate-700 dark:text-slate-200">{t.results}{t.performedBy ? ` · by ${t.performedBy}` : ""} · </b> : null}
              {t.reasons.map((r) => r.why).join(" · ")}
            </span>
            {t.state === "done" && t.fileId && <ReportButton fileId={t.fileId} />}
          </li>
        ))}
      </ul>
      {d.history.length > 0 && (
        <details className="mt-3 text-xs text-slate-500" open={d.history.some((h) => h.status === "done")}>
          <summary className="cursor-pointer font-semibold">History ({d.history.length})</summary>
          <ul className="mt-1 space-y-1.5">
            {d.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="w-24 tabular-nums">{dayText(h.date)}</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{h.label}</span>
                <span>{h.status === "not_applicable" ? "not needed" : h.status}{h.source === "import" ? " (Practice Fusion)" : ""}</span>
                {h.results && <span className="text-slate-700 dark:text-slate-200">· {h.results}</span>}
                {h.performedBy && <span>· by {h.performedBy}</span>}
                {h.note && <span className="truncate">· {h.note}</span>}
                <span className="ml-auto flex items-center gap-3">
                  {h.fileId && <ReportButton fileId={h.fileId} />}
                  {h.status === "done" && (
                    <button className="inline-flex items-center gap-1 hover:text-slate-800" onClick={() => setEditing(h)}><Pencil size={12} /> {h.results || h.fileId ? "Edit results" : "Add results"}</button>
                  )}
                  {h.source !== "import" && <button className="inline-flex items-center gap-1 hover:text-slate-800" onClick={() => undo.mutate({ id: h.id })} aria-label="Undo"><Undo2 size={12} /> Undo</button>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {mark && <MarkTestsDialog open onClose={() => setMark(null)} subjectKey={subjectKey} name={name} tests={mark} />}
      {editing && (
        <TestDetailsDialog open onClose={() => setEditing(null)} id={editing.id} test={editing.test} date={editing.date} subjectKey={subjectKey} name={name}
          initial={{ results: editing.resultValues, performedByUserId: editing.performedByUserId, hasReport: !!editing.fileId }} />
      )}
    </div>
  );
}

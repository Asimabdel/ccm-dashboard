import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, UserCheck, Stethoscope, Link2Off } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fmtDay, fmtTime } from "@shared/workforce";
import { SCHEDULE_FIELD_LABELS, type ScheduleField } from "@shared/workspace";
import { Btn, FlowBadge, inputCls } from "./ui";
import { useWorkspace } from "./useWorkspace";
import { cn } from "@/lib/utils";

// Fields shown in the column-mapping editor, most important first.
const EDITABLE_FIELDS: ScheduleField[] = ["date", "time", "datetime", "patientName", "lastName", "firstName", "dob", "phone", "provider", "location", "visitType", "reason", "status", "duration", "endTime"];

type Preview = RouterOutputs["workspace"]["schedule"]["preview"];

export function ScheduleImportDialog({ open, onOpenChange, onImported }: { open: boolean; onOpenChange: (o: boolean) => void; onImported?: (firstDate: string | undefined) => void }) {
  const { clinics, clinicId } = useWorkspace();
  const utils = trpc.useUtils();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [defaultClinic, setDefaultClinic] = useState<string>("");
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [cancelMissing, setCancelMissing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  // Reset only when the dialog opens, so a late-loading clinic list can't wipe a chosen file.
  useEffect(() => {
    if (!open) return;
    setFileName(null);
    setCsv(null);
    setPreview(null);
    setMapping({});
    setCancelMissing(false);
    setDefaultClinic(clinicId ? String(clinicId) : clinics.length === 1 ? String(clinics[0]!.id) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const previewM = trpc.workspace.schedule.preview.useMutation({
    onSuccess: (p) => {
      setPreview(p);
      setMapping(p.mapping as Record<string, number>);
    },
    onError: (e) => toast.error(e.message),
  });
  const commitM = trpc.workspace.schedule.commit.useMutation({
    onSuccess: (r) => {
      toast.success(`Imported ${r.rows.toLocaleString()} appointments: ${r.created.toLocaleString()} new, ${r.updated.toLocaleString()} updated, ${r.unchanged.toLocaleString()} unchanged${r.cancelled ? `, ${r.cancelled} cancelled` : ""}.`);
      void utils.workspace.invalidate();
      onImported?.(r.dates[0]);
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const runPreview = (text: string, m?: Record<string, number>, clinic = defaultClinic) =>
    previewM.mutate({ csv: text, mapping: m, defaultClinicId: clinic ? Number(clinic) : null });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (/\.(xlsx?|xls)$/i.test(f.name)) {
      toast.error("That's an Excel file. In Excel, use File → Save As → CSV, then upload the CSV.");
      return;
    }
    if (f.size > 5_000_000) {
      toast.error("That file is larger than 5 MB. Export one day or one week at a time.");
      return;
    }
    const text = await f.text();
    setFileName(f.name);
    setCsv(text);
    setMapping({});
    runPreview(text);
  };

  const setField = (field: ScheduleField, col: number) => {
    const next = { ...mapping };
    if (col < 0) delete next[field];
    else next[field] = col;
    // Explicitly clear fields the user removed so auto-detect doesn't bring them back.
    const payload: Record<string, number> = { ...next };
    EDITABLE_FIELDS.forEach((f) => { if (!(f in next)) payload[f] = -1; });
    setMapping(next);
    if (csv) runPreview(csv, payload);
  };

  const p = preview;
  const ready = !!p && p.rowCount > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import the schedule from Practice Fusion</DialogTitle>
          <DialogDescription>
            Export the appointment report from Practice Fusion as a CSV file and upload it here — a day, a week or a whole year. Re-importing
            updates appointments instead of duplicating them: Practice Fusion's outcomes (seen, no-show, cancelled) are applied, and statuses
            already moved on the flow board are otherwise kept.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_220px] gap-3 items-end">
            <div>
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="w-full flex items-center gap-3 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-600 px-4 py-4 text-left hover:border-brand/60 transition-colors"
              >
                <FileUp size={22} className="text-slate-400 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{fileName ?? "Choose a CSV file"}</span>
                  <span className="block text-xs text-slate-500">{fileName ? "Click to choose a different file" : "Appointments export (.csv)"}</span>
                </span>
              </button>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">Clinic for this file</label>
              <select
                className={inputCls}
                value={defaultClinic}
                onChange={(e) => {
                  setDefaultClinic(e.target.value);
                  if (csv) runPreview(csv, Object.keys(mapping).length ? mapping : undefined, e.target.value);
                }}
              >
                <option value="">Match by provider or patient (recommended)</option>
                {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>

          {previewM.isPending && <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Reading the file…</p>}

          {p && !previewM.isPending && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat icon={CheckCircle2} label="Appointments" value={p.rowCount} detail={p.dates.length ? (p.dates.length === 1 ? fmtDay(p.dates[0]!) : `${fmtDay(p.dates[0]!)} – ${fmtDay(p.dates[p.dates.length - 1]!)}`) : "—"} />
                <Stat icon={UserCheck} label="Matched to patients" value={`${p.linked}`} detail="by name + date of birth" />
                <Stat icon={Stethoscope} label="Providers matched" value={`${p.providersMatched}`} detail={`of ${p.rowCount}`} />
                <Stat icon={AlertTriangle} label="Rows skipped" value={p.errorCount} detail={p.errorCount ? "see below" : "none"} tone={p.errorCount ? "warn" : undefined} />
              </div>

              {p.missingClinic > 0 && (
                <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                  {p.missingClinic} appointment(s) couldn't be matched to a clinic (their provider has no home clinic and the patient isn't on the CCM roster).
                  They'll still import and show under "All clinics" for managers. To place them, set the provider's clinic on the Providers page or pick a clinic above.
                </p>
              )}

              <details className="rounded-xl border border-slate-200 dark:border-slate-700" open={p.rowCount === 0}>
                <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200">Columns ({Object.keys(p.mapping).length} detected) — change if something looks wrong</summary>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 px-4 pb-4 pt-1">
                  {EDITABLE_FIELDS.map((f) => (
                    <label key={f} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-slate-600 dark:text-slate-300">{SCHEDULE_FIELD_LABELS[f]}</span>
                      <select className={cn(inputCls, "w-44 py-1.5")} value={mapping[f] ?? -1} onChange={(e) => setField(f, Number(e.target.value))}>
                        <option value={-1}>— not in file —</option>
                        {p.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </details>

              {p.sample.length > 0 && (
                <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800 text-xs text-slate-500">
                      <tr>
                        <th className="text-left font-medium px-3 py-2">Date</th>
                        <th className="text-left font-medium px-3 py-2">Time</th>
                        <th className="text-left font-medium px-3 py-2">Patient</th>
                        <th className="text-left font-medium px-3 py-2">Provider</th>
                        <th className="text-left font-medium px-3 py-2">Type</th>
                        <th className="text-left font-medium px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                      {p.sample.map((r) => (
                        <tr key={r.rowNumber}>
                          <td className="px-3 py-2 whitespace-nowrap">{fmtDay(r.date)}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{fmtTime(r.time)}</td>
                          <td className="px-3 py-2">
                            <span className="inline-flex items-center gap-1.5">
                              {r.patientName}
                              {r.linked ? <UserCheck size={13} className="text-emerald-600" aria-label="Matched to a patient" /> : <Link2Off size={13} className="text-slate-300" aria-label="Not matched" />}
                            </span>
                          </td>
                          <td className={cn("px-3 py-2", !r.providerMatched && "text-slate-400")}>{r.provider ?? "—"}</td>
                          <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{r.visitType ?? "—"}</td>
                          <td className="px-3 py-2"><FlowBadge status={r.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {p.rowCount > p.sample.length && <p className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100 dark:border-slate-700">…and {p.rowCount - p.sample.length} more</p>}
                </div>
              )}

              {p.errors.length > 0 && (
                <details className="rounded-xl border border-amber-200 dark:border-amber-900">
                  <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-amber-800 dark:text-amber-300">{p.errorCount} row(s) will be skipped</summary>
                  <ul className="px-4 pb-3 text-xs text-slate-600 dark:text-slate-300 space-y-1">
                    {p.errors.map((e) => <li key={e.rowNumber}>Row {e.rowNumber}: {e.message}</li>)}
                  </ul>
                </details>
              )}

              <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input type="checkbox" className="mt-1" checked={cancelMissing} onChange={(e) => setCancelMissing(e.target.checked)} />
                <span>
                  Mark appointments as cancelled if they're no longer in this file
                  <span className="block text-xs text-slate-500">Only for the dates and clinics in this file, and only appointments still "Scheduled". Use this when re-importing an updated schedule.</span>
                </span>
              </label>

              <p className="text-xs text-slate-500">
                Patients that don't match the CCM roster are still added to the schedule — they just won't link to a patient profile. Nothing is written back to Practice Fusion.
              </p>
            </>
          )}

          <div className="flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Btn>
            <Btn
              disabled={!ready || commitM.isPending || previewM.isPending}
              onClick={() => {
                if (!csv) return;
                const payload: Record<string, number> = { ...mapping };
                EDITABLE_FIELDS.forEach((f) => { if (!(f in mapping)) payload[f] = -1; });
                commitM.mutate({ csv, mapping: payload, defaultClinicId: defaultClinic ? Number(defaultClinic) : null, cancelMissing, fileName });
              }}
            >
              {commitM.isPending && <Loader2 size={15} className="animate-spin" />}
              Import {p?.rowCount ? `${p.rowCount} appointments` : ""}
            </Btn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ icon: Icon, label, value, detail, tone }: { icon: React.ElementType; label: string; value: React.ReactNode; detail: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl bg-slate-50 dark:bg-slate-800 p-3">
      <p className="text-xs text-slate-500 flex items-center gap-1.5"><Icon size={13} /> {label}</p>
      <p className={cn("mt-1 text-xl font-bold tabular-nums", tone === "warn" ? "text-amber-700" : "text-slate-900 dark:text-slate-50")}>{value}</p>
      <p className="text-[11px] text-slate-500 truncate">{detail}</p>
    </div>
  );
}

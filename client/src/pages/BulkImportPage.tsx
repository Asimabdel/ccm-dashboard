import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Loader2, Upload, FileText, AlertTriangle, CheckCircle2, ArrowLeft, Download } from "lucide-react";
import { STATUS_LABELS } from "@/lib/ccm";

const SAMPLE_DRMAI = `Name,Provider,Wellness Call,Date Completed,Next Appointment,Notes
Doe, Jane,Dr. Mai,Completed,6/3,8/15,Doing well
Smith, John,Dr. Mai,Not Completed,,7/1,Left voicemail`;

const TEMPLATE_LABELS: Record<string, string> = {
  drmai: "Dr.Mai CCMs export",
  chartnotes: "Chart Notes Report export",
  generic: "Generic patient sheet",
  unknown: "Unknown",
};

export default function BulkImportPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [, setLocation] = useLocation();
  const [csv, setCsv] = useState("");
  const [defaultClinicId, setDefaultClinicId] = useState(0);
  const [defaultProviderId, setDefaultProviderId] = useState(0);
  const [defaultStaffId, setDefaultStaffId] = useState(0);
  const [skipExisting, setSkipExisting] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const staff = trpc.staff.all.useQuery(undefined, { enabled: !!user });

  const preview = trpc.patients.bulkImportPreview.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const commit = trpc.patients.bulkImportCommit.useMutation({
    onSuccess: (r) => {
      toast.success(`Imported ${r.inserted} patients. Skipped ${r.skippedDuplicates} duplicates, ${r.invalid} invalid rows.`);
      utils.patients.list.invalidate();
      utils.patients.duplicates.invalidate();
      setLocation("/patients");
    },
    onError: (e) => toast.error(e.message),
  });

  const canImport = !!user && ["admin", "front_desk"].includes(user.role);

  const data = preview.data;
  const inBatch = useMemo(() => new Set(data?.inBatchDuplicates || []), [data]);
  const existing: Record<string, number[]> = (data?.existingDuplicates as Record<string, number[]>) || {};
  const validCount = (data?.rows || []).filter((r) => r.errors.length === 0).length;

  const onFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result || ""));
    reader.readAsText(f);
  };

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  if (!canImport) {
    return (
      <CCMDashboardLayout title="Bulk Import">
        <div className="bg-white rounded-3xl border border-slate-200 p-10 text-center text-slate-600">
          You do not have permission to import patients. This action is limited to Admin and Front Desk roles.
        </div>
      </CCMDashboardLayout>
    );
  }

  const field = "px-3 py-2 rounded-xl border border-slate-300 text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_45%)]";

  return (
    <CCMDashboardLayout title="Bulk Import Patients">
      <button onClick={() => setLocation("/patients")} className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 mb-4">
        <ArrowLeft size={15} /> Back to Patient Database
      </button>

      <div className="grid lg:grid-cols-5 gap-5">
        {/* Left: input */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white rounded-3xl border border-slate-200 p-5 shadow-sm">
            <h3 className="font-semibold text-slate-900 mb-1 flex items-center gap-2"><FileText size={16} /> Paste or upload CSV</h3>
            <p className="text-xs text-slate-600 mb-2">
              Accepts your two export formats directly — the <span className="font-semibold">Dr.Mai CCMs</span> sheet and the
              <span className="font-semibold"> Chart Notes Report</span> — as well as a generic sheet with a <span className="font-semibold">name</span> column.
              Only the patient name is required; any other missing details can be filled in manually later.
            </p>
            <textarea
              value={csv} onChange={(e) => setCsv(e.target.value)}
              placeholder="Paste CSV here…"
              className="w-full h-52 px-3 py-2 rounded-xl border border-slate-300 text-xs font-mono bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_45%)]"
            />
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
              <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"><Upload size={14} /> Upload file</button>
              <button onClick={() => setCsv(SAMPLE_DRMAI)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"><Download size={14} /> Load sample</button>
              <button disabled={!csv.trim() || preview.isPending} onClick={() => preview.mutate({ csv })}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-50 active:scale-[0.97] transition-transform">
                {preview.isPending ? <Loader2 size={14} className="animate-spin" /> : null} Preview
              </button>
            </div>
          </div>

          {data && !data.headerError && (
            <div className="bg-white rounded-3xl border border-slate-200 p-5 space-y-3 shadow-sm">
              <h3 className="font-semibold text-slate-900 text-sm">Commit settings</h3>
              {data.template && (
                <p className="text-xs text-slate-600">
                  Detected format: <span className="font-semibold text-slate-800">{TEMPLATE_LABELS[data.template] || data.template}</span>
                </p>
              )}
              <div>
                <label className="text-xs text-slate-600">Default clinic (optional — only used if a row's clinic can't be matched)</label>
                <select className={`${field} w-full`} value={defaultClinicId} onChange={(e) => setDefaultClinicId(Number(e.target.value))}>
                  <option value={0}>No default (leave blank)</option>
                  {(data.clinicOptions || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-600">Default provider (optional — only used if a row's provider can't be matched)</label>
                <select className={`${field} w-full`} value={defaultProviderId} onChange={(e) => setDefaultProviderId(Number(e.target.value))}>
                  <option value={0}>No default (leave blank)</option>
                  {(data.providerOptions || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">Providers in the file are auto-matched to existing providers — name variations (e.g. "Dr. Sudad", "Sudad Al Hadad") are consolidated. See the Provider column in the preview.</p>
              </div>
              <div>
                <label className="text-xs text-slate-600">Assign all to employee (optional — puts every imported patient on this person's worklist)</label>
                <select className={`${field} w-full`} value={defaultStaffId} onChange={(e) => setDefaultStaffId(Number(e.target.value))}>
                  <option value={0}>Leave unassigned</option>
                  {(staff.data || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="accent-slate-900" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />
                Skip patients that already exist (matching name)
              </label>
              <button
                disabled={commit.isPending || validCount === 0}
                onClick={() => commit.mutate({ csv, defaultClinicId: defaultClinicId || undefined, defaultProviderId: defaultProviderId || undefined, defaultStaffId: defaultStaffId || undefined, skipExistingDuplicates: skipExisting })}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[hsl(200_100%_45%)] text-white text-sm font-semibold hover:brightness-95 disabled:opacity-50 active:scale-[0.98] transition-transform">
                {commit.isPending ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
                Import {validCount} valid {validCount === 1 ? "patient" : "patients"}
              </button>
            </div>
          )}
        </div>

        {/* Right: preview */}
        <div className="lg:col-span-3">
          {data?.headerError && (
            <div className="bg-rose-50 border border-rose-200 rounded-3xl p-5 text-sm text-rose-700 flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {data.headerError}
            </div>
          )}
          {data && !data.headerError && (
            <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
              <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm font-semibold text-slate-800">{data.rows.length} rows · {validCount} valid · {data.rows.length - validCount} with errors</p>
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle size={11} /> Duplicate name</span>
                </div>
              </div>
              <div className="overflow-x-auto max-h-[60vh]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-100">
                    <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                      <th className="px-4 py-2 font-medium">Row</th>
                      <th className="px-4 py-2 font-medium">Name</th>
                      <th className="px-4 py-2 font-medium">Provider</th>
                      <th className="px-4 py-2 font-medium">Last Called</th>
                      <th className="px-4 py-2 font-medium">Next Appt</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => {
                      const key = r.name.toLowerCase().replace(/\s+/g, " ").trim();
                      const isExisting = !!existing[key];
                      const isInBatch = inBatch.has(r.rowNumber);
                      const hasError = r.errors.length > 0;
                      return (
                        <tr key={r.rowNumber} className={`border-b border-slate-100 last:border-0 ${hasError ? "bg-rose-50/40" : ""}`}>
                          <td className="px-4 py-2 text-slate-500">{r.rowNumber}</td>
                          <td className="px-4 py-2 font-medium text-slate-900">{r.name || <span className="text-rose-500">(missing)</span>}</td>
                          <td className="px-4 py-2 text-slate-700">
                            {r.resolvedProviderName ? (
                              <div>
                                <span className="text-slate-800">{r.resolvedProviderName}</span>
                                {r.provider && r.provider.toLowerCase() !== r.resolvedProviderName.toLowerCase() && (
                                  <span className="block text-[10px] text-slate-400">from "{r.provider}"</span>
                                )}
                              </div>
                            ) : r.provider ? (
                              <span className="text-amber-700" title="No matching provider in the system — will be left blank">{r.provider} <span className="text-[10px]">(unmatched)</span></span>
                            ) : <span className="text-slate-400">—</span>}
                          </td>
                          <td className="px-4 py-2 text-slate-700">{r.lastCalled || <span className="text-slate-400">—</span>}</td>
                          <td className="px-4 py-2 text-slate-700">{r.nextAppointment || <span className="text-slate-400">—</span>}</td>
                          <td className="px-4 py-2 text-slate-700">
                            {r.resolvedStatus ? (
                              <div>
                                <span className={r.resolvedStatus === "completed" ? "text-emerald-700 font-medium" : "text-slate-800"}>{STATUS_LABELS[r.resolvedStatus] ?? r.resolvedStatus}</span>
                                {r.wellnessCallStatus && (STATUS_LABELS[r.resolvedStatus] ?? "").toLowerCase() !== r.wellnessCallStatus.toLowerCase() && (
                                  <span className="block text-[10px] text-slate-400">from "{r.wellnessCallStatus}"</span>
                                )}
                              </div>
                            ) : r.wellnessCallStatus ? (
                              <span className="text-amber-700" title="No matching status — task will start as Not Started">{r.wellnessCallStatus} <span className="text-[10px]">(unmatched)</span></span>
                            ) : <span className="text-slate-400">—</span>}
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex flex-wrap gap-1">
                              {hasError && r.errors.map((e, i) => (
                                <span key={i} className="px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 text-[10px] font-medium">{e}</span>
                              ))}
                              {isInBatch && <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-medium inline-flex items-center gap-1"><AlertTriangle size={9} /> Dup in file</span>}
                              {isExisting && <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-medium inline-flex items-center gap-1"><AlertTriangle size={9} /> Already exists</span>}
                              {!hasError && !isInBatch && !isExisting && <span className="px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-medium">OK</span>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {!data && (
            <div className="bg-white rounded-3xl border border-dashed border-slate-300 p-12 text-center text-slate-500">
              <Upload size={28} className="mx-auto mb-3 text-slate-300" />
              Paste or upload a CSV, then click Preview to validate and check for duplicates before importing.
            </div>
          )}
        </div>
      </div>
    </CCMDashboardLayout>
  );
}

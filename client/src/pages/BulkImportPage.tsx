import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Loader2, Upload, FileText, AlertTriangle, CheckCircle2, ArrowLeft, Download } from "lucide-react";

const SAMPLE = `name,dateOfBirth,phoneNumber,clinic,provider,preferredLanguage,chronicConditions,insurance,riskLevel,consentStatus,rpmEnrolled,rpmDeviceType
Jane Doe,1955-03-12,555-201-3344,,,English,Hypertension;Type 2 Diabetes,Medicare,high,consented,yes,BP cuff
John Smith,1948-07-22,555-330-1188,,,Spanish,COPD,Medicare,medium,pending,no,`;

export default function BulkImportPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [, setLocation] = useLocation();
  const [csv, setCsv] = useState("");
  const [defaultClinicId, setDefaultClinicId] = useState(0);
  const [defaultProviderId, setDefaultProviderId] = useState(0);
  const [skipExisting, setSkipExisting] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

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
    return <div className="min-h-screen flex items-center justify-center bg-[hsl(240_10%_97%)]"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  if (!canImport) {
    return (
      <CCMDashboardLayout title="Bulk Import">
        <div className="bg-white rounded-3xl border border-slate-100 p-10 text-center text-slate-500">
          You do not have permission to import patients. This action is limited to Admin and Front Desk roles.
        </div>
      </CCMDashboardLayout>
    );
  }

  const field = "px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]";

  return (
    <CCMDashboardLayout title="Bulk Import Patients">
      <button onClick={() => setLocation("/patients")} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mb-4">
        <ArrowLeft size={15} /> Back to Patient Database
      </button>

      <div className="grid lg:grid-cols-5 gap-5">
        {/* Left: input */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white rounded-3xl border border-slate-100 p-5">
            <h3 className="font-semibold text-slate-800 mb-1 flex items-center gap-2"><FileText size={16} /> Paste or upload CSV</h3>
            <p className="text-xs text-slate-400 mb-3">Required columns: <span className="font-medium">name</span>, <span className="font-medium">phoneNumber</span>. Optional: dateOfBirth, clinic, provider, preferredLanguage, chronicConditions (use ; between), insurance, riskLevel, consentStatus, rpmEnrolled (yes/no), rpmDeviceType.</p>
            <textarea
              value={csv} onChange={(e) => setCsv(e.target.value)}
              placeholder="Paste CSV here…"
              className="w-full h-52 px-3 py-2 rounded-xl border border-slate-200 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]"
            />
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
              <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-700 hover:bg-slate-50"><Upload size={14} /> Upload file</button>
              <button onClick={() => setCsv(SAMPLE)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-700 hover:bg-slate-50"><Download size={14} /> Load sample</button>
              <button disabled={!csv.trim() || preview.isPending} onClick={() => preview.mutate({ csv })}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-50">
                {preview.isPending ? <Loader2 size={14} className="animate-spin" /> : null} Preview
              </button>
            </div>
          </div>

          {data && !data.headerError && (
            <div className="bg-white rounded-3xl border border-slate-100 p-5 space-y-3">
              <h3 className="font-semibold text-slate-800 text-sm">Commit settings</h3>
              <div>
                <label className="text-xs text-slate-500">Default clinic (used when row has no clinic)</label>
                <select className={`${field} w-full`} value={defaultClinicId} onChange={(e) => setDefaultClinicId(Number(e.target.value))}>
                  <option value={0}>Select clinic…</option>
                  {(data.clinicOptions || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500">Default provider (used when row has no provider)</label>
                <select className={`${field} w-full`} value={defaultProviderId} onChange={(e) => setDefaultProviderId(Number(e.target.value))}>
                  <option value={0}>Select provider…</option>
                  {(data.providerOptions || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="accent-slate-900" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />
                Skip patients that already exist (matching name)
              </label>
              <button
                disabled={commit.isPending || validCount === 0 || !defaultClinicId || !defaultProviderId}
                onClick={() => commit.mutate({ csv, defaultClinicId, defaultProviderId, skipExistingDuplicates: skipExisting })}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[hsl(200_100%_45%)] text-white text-sm font-semibold hover:brightness-95 disabled:opacity-50">
                {commit.isPending ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
                Import {validCount} valid {validCount === 1 ? "patient" : "patients"}
              </button>
              {(!defaultClinicId || !defaultProviderId) && <p className="text-[11px] text-amber-600">Select a default clinic and provider to enable import.</p>}
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
            <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm font-semibold text-slate-700">{data.rows.length} rows · {validCount} valid · {data.rows.length - validCount} with errors</p>
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle size={11} /> Duplicate name</span>
                </div>
              </div>
              <div className="overflow-x-auto max-h-[60vh]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                      <th className="px-4 py-2 font-medium">Row</th>
                      <th className="px-4 py-2 font-medium">Name</th>
                      <th className="px-4 py-2 font-medium">Phone</th>
                      <th className="px-4 py-2 font-medium">RPM</th>
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
                        <tr key={r.rowNumber} className={`border-b border-slate-50 last:border-0 ${hasError ? "bg-rose-50/40" : ""}`}>
                          <td className="px-4 py-2 text-slate-400">{r.rowNumber}</td>
                          <td className="px-4 py-2 font-medium text-slate-800">{r.name || <span className="text-rose-500">(missing)</span>}</td>
                          <td className="px-4 py-2 text-slate-600">{r.phoneNumber || <span className="text-rose-500">(missing)</span>}</td>
                          <td className="px-4 py-2 text-slate-600">{r.rpmEnrolled ? "Yes" : "No"}{r.rpmDeviceType ? ` · ${r.rpmDeviceType}` : ""}</td>
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
            <div className="bg-white rounded-3xl border border-dashed border-slate-200 p-12 text-center text-slate-400">
              <Upload size={28} className="mx-auto mb-3 text-slate-300" />
              Paste or upload a CSV, then click Preview to validate and check for duplicates before importing.
            </div>
          )}
        </div>
      </div>
    </CCMDashboardLayout>
  );
}

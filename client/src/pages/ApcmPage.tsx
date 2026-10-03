import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Activity, Search, X, CheckCircle2, XCircle, FileText, Download, AlertTriangle } from "lucide-react";
import {
  APCM_LEVEL_LABELS, APCM_CPT_BY_LEVEL, apcmLevelBadgeClass, apcmLevelFrom, currentMonthStr,
} from "@/lib/ccm";
import { buildStandardApcmCarePlan } from "@shared/carePlan";
import { autoApcmMonths, isAutoApcmMonth } from "@shared/apcmRules";

/** Who goes first: did a CCM with us before (from Aug 2026: automatic APCM), then reached this year, then not reached. */
const PRIORITY: Record<number, { label: string; short: string; cls: string }> = {
  1: { label: "Did a CCM before, no CCM this month", short: "1 · Did a CCM before", cls: "bg-emerald-100 text-emerald-800" },
  2: { label: "Reached this year, never completed a CCM", short: "2 · Reached, no CCM", cls: "bg-sky-100 text-sky-800" },
  3: { label: "Not reached this year", short: "3 · Not reached", cls: "bg-slate-100 text-slate-600" },
};
const priorityLabel = (p: number, auto: boolean) => (p === 1 && auto ? "Automatic APCM" : `Priority ${p}`);

/** CSV of the list as shown (for billing). */
function downloadCsv(month: string, rows: any[], suffix: string) {
  const esc = (v: unknown) => { const t = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = ["Patient", "Date of birth", "List", "CCMs done before", "Last CCM", "APCM level", "G-code", "QMB", "APCM consent", "Care plan", "Initiating visit", "Status", "Care coordinator"];
  const lines = rows.map((r) => {
    const level = r.apcmLevel || apcmLevelFrom(((r.chronicConditions as string[]) || []).length, !!r.isQMB);
    return [
      r.name, r.dateOfBirth ? new Date(r.dateOfBirth).toISOString().slice(0, 10) : "",
      r.priority ? (r.autoApcm ? "Automatic APCM" : PRIORITY[r.priority].label) : "Billed as CCM",
      r.ccmCompletedBefore ?? 0, r.lastCcmCompleted ?? "", String(level).replace("level_", "Level "), APCM_CPT_BY_LEVEL[level] || "G0556",
      r.isQMB ? "Yes" : "No", r.apcmConsentStatus || "pending", r.hasCarePlan ? "Yes" : "No", r.hasVisit ? "Yes" : "No",
      (CATEGORY[r.category] || CATEGORY.needs_setup).label, r.staffName || "",
    ].map(esc).join(",");
  });
  const blob = new Blob([[head.join(","), ...lines].join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `apcm-${month}${suffix}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** "2026-09" → "September 2026". */
function monthLabel(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function monthFromUrl() {
  const m = new URLSearchParams(window.location.search).get("month");
  return m && /^\d{4}-\d{2}$/.test(m) ? m : currentMonthStr();
}

const CATEGORY: Record<string, { label: string; cls: string }> = {
  ready: { label: "Ready to bill", cls: "bg-emerald-100 text-emerald-800" },
  needs_setup: { label: "Needs setup", cls: "bg-amber-100 text-amber-800" },
  ccm_done: { label: "CCM this month", cls: "bg-slate-200 text-slate-600" },
};

export default function ApcmPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const utils = trpc.useUtils();
  const [month, setMonthState] = useState(monthFromUrl);
  const [category, setCategory] = useState<"" | "ready" | "needs_setup" | "ccm_done">("");
  // From August 2026 the list opens on the automatic APCM patients.
  const [priority, setPriority] = useState<0 | 1 | 2 | 3>(() => (isAutoApcmMonth(monthFromUrl()) ? 1 : 0));
  const [exporting, setExporting] = useState(false);
  const setMonth = (m: string) => {
    setMonthState(m);
    setLimit(100);
    setPriority(isAutoApcmMonth(m) && category !== "ccm_done" ? 1 : 0);
    const u = new URL(window.location.href);
    if (m === currentMonthStr()) u.searchParams.delete("month"); else u.searchParams.set("month", m);
    window.history.replaceState(null, "", u.toString());
  };
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);
  const [carePlanFor, setCarePlanFor] = useState<any | null>(null);

  const filters = useMemo(() => ({ month, category: category || undefined, priority: priority || undefined, search: search.trim() || undefined, limit }), [month, category, priority, search, limit]);
  const q = trpc.apcm.overview.useQuery(filters, { enabled: !!user });
  const mut = trpc.patients.updateAPCM.useMutation({
    onSuccess: () => { utils.apcm.overview.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const applyPlans = trpc.apcm.applyStandardCarePlan.useMutation({
    onSuccess: (r) => { utils.apcm.overview.invalidate(); toast.success(`Standard care plan applied to ${r.applied.toLocaleString()}${r.remaining ? ` · ${r.remaining.toLocaleString()} still to go` : " · all done"}.`); },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  if (!["admin", "staff", "billing"].includes(user.role)) {
    return <CCMDashboardLayout title="APCM"><p className="text-slate-400 font-light">This area is for care coordinators and billing.</p></CCMDashboardLayout>;
  }

  const s = q.data?.stats;
  const rows = q.data?.rows || [];
  const total = q.data?.total || 0;
  const setupPct = s && s.total ? Math.round(((s.total - s.needsSetup - s.ccmDone) / Math.max(1, s.total - s.ccmDone)) * 100) : 0;
  const auto = isAutoApcmMonth(month);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await utils.apcm.overview.fetch({ ...filters, limit: 2000 });
      downloadCsv(month, all.rows, priority === 1 && auto ? "-automatic" : priority ? `-priority-${priority}` : category ? `-${category}` : "");
    } catch (e) { toast.error((e as Error).message); } finally { setExporting(false); }
  };

  return (
    <CCMDashboardLayout title={`APCM — ${monthLabel(month)}`}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex flex-wrap p-1 rounded-2xl bg-slate-100" role="group" aria-label="Month">
          {autoApcmMonths(currentMonthStr()).map((m) => (
            <button key={m} onClick={() => setMonth(m)} aria-pressed={month === m}
              className={`px-3.5 py-1.5 rounded-xl text-sm font-semibold transition ${month === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {monthLabel(m)}{m === currentMonthStr() ? " (so far)" : ""}
            </button>
          ))}
        </div>
        <input type="month" value={month} max={currentMonthStr()} onChange={(e) => e.target.value && setMonth(e.target.value)}
          aria-label="Other month" title="Other month" className="px-3 py-1.5 rounded-xl border border-slate-200 text-sm" />
      </div>
      <p className="text-sm text-slate-500 font-light max-w-3xl mb-5">
        {auto ? (
          <>From August 2026, a patient who <b>did a CCM with us before</b> but had <b>no CCM completed in {monthLabel(month)}</b> is
            on that month's <b>automatic APCM</b> list (G0556/57/58 by complexity). Patients whose CCM was completed that month bill CCM instead,
            since Medicare doesn't pay both in the same month.</>
        ) : (
          <>Advanced Primary Care Management covers every active CCM patient. It bills the monthly complexity G-code
            (G0556/57/58) for anyone who <b>didn't</b> get a completed CCM that month, once their <b>consent + care plan</b> are on file.</>
        )}
      </p>
      {auto && s && s.autoApcm > s.autoConsented && (
        <div className="mb-5 flex max-w-3xl gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <p>
            <b>{(s.autoApcm - s.autoConsented).toLocaleString()} of {s.autoApcm.toLocaleString()}</b> automatic APCM patients have no APCM consent on file,
            so they can't be billed as APCM yet. Medicare needs the patient's <b>own APCM consent</b> (verbal or written, documented in the chart,
            before APCM is billed); <b>a CCM consent doesn't count</b>. Mark the consent on each row once you have it. Check with your biller
            about months that passed before the consent was given.
          </p>
        </div>
      )}

      {/* Stats */}
      {s && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <StatCard label="APCM Covered" value={s.total} sub="active CCM patients" accent="text-slate-900" />
          <StatCard label="Ready to bill" value={s.ready} sub="consent · visit · care plan met" accent="text-emerald-600" />
          <StatCard label="Needs setup" value={s.needsSetup} sub={`${s.consented} consented · ${s.withCarePlan} w/ care plan`} accent="text-amber-600" />
          <StatCard label={month === currentMonthStr() ? "CCM this month" : "CCM that month"} value={s.ccmDone} sub="billing CCM, off APCM" accent="text-slate-500" />
        </div>
      )}
      {s && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
          {([1, 2, 3] as const).map((p) => (
            <button key={p} onClick={() => { setPriority(priority === p ? 0 : p); setLimit(100); }} aria-pressed={priority === p}
              className={`text-left bg-white rounded-2xl border p-4 transition ${priority === p ? "border-indigo-400 ring-2 ring-indigo-200" : "border-slate-100 hover:border-slate-200"}`}>
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">{priorityLabel(p, auto)}</p>
              <p className="text-2xl font-bold mt-0.5 font-mono tabular-nums text-slate-900">{(p === 1 ? s.tier1 : p === 2 ? s.tier2 : s.tier3).toLocaleString()}</p>
              <p className="text-xs text-slate-500 mt-0.5">{PRIORITY[p].label}{p === 1 && auto ? ` · ${s.autoConsented.toLocaleString()} consented · ${s.autoReady.toLocaleString()} ready` : ""}</p>
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="inline-flex p-1 rounded-2xl bg-slate-100">
          {([["", "All"], ["needs_setup", "Needs setup"], ["ready", "Ready"], ["ccm_done", "CCM done"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => { setCategory(k); if (k === "ccm_done") setPriority(0); setLimit(100); }}
              className={`px-3.5 py-1.5 rounded-xl text-sm font-semibold transition ${category === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[180px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setLimit(100); }} placeholder="Search patient…"
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
        </div>
        <button onClick={exportCsv} disabled={exporting || !total}
          title="Download this list (as filtered) as a spreadsheet"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap">
          {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Download list
        </button>
        {["admin", "staff"].includes(user.role) && s && s.total - s.withCarePlan > 0 && (
          <button onClick={() => applyPlans.mutate({})} disabled={applyPlans.isPending}
            title="Fill a standard, personalized care plan for every APCM patient who doesn't have one yet"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:brightness-110 active:scale-[0.98] disabled:opacity-50 transition whitespace-nowrap">
            {applyPlans.isPending ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />} Apply standard care plan ({(s.total - s.withCarePlan).toLocaleString()})
          </button>
        )}
      </div>

      {q.isLoading && <div className="py-16 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>}
      {!q.isLoading && rows.length === 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 py-16 text-center">
          <Activity className="mx-auto text-slate-300 mb-3" size={32} />
          <p className="text-slate-400 font-light">{s && s.total === 0 ? "No active CCM patients to cover with APCM." : "No patients match this filter."}</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                  <th className="px-4 py-3 font-medium">Patient</th>
                  <th className="px-4 py-3 font-medium">Priority</th>
                  <th className="px-4 py-3 font-medium">Level / G-code</th>
                  <th className="px-4 py-3 font-medium text-center">QMB</th>
                  <th className="px-4 py-3 font-medium">Consent</th>
                  <th className="px-4 py-3 font-medium text-center">Init. visit</th>
                  <th className="px-4 py-3 font-medium text-center">Care plan</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => {
                  const level = r.apcmLevel || apcmLevelFrom(((r.chronicConditions as string[]) || []).length, !!r.isQMB);
                  const cpt = APCM_CPT_BY_LEVEL[level] || "G0556";
                  const cat = CATEGORY[r.category] || CATEGORY.needs_setup;
                  const busy = mut.isPending && mut.variables?.id === r.id;
                  return (
                    <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <a href={`/patients/${r.id}`} className="font-semibold text-slate-800 hover:text-indigo-700 hover:underline">{r.name}</a>
                        <div className="text-xs text-slate-400">{r.staffName || "Unassigned"}{r.ccmEnrollmentStatus && r.ccmEnrollmentStatus !== "active" ? " · no longer in CCM" : ""}</div>
                      </td>
                      <td className="px-4 py-3">
                        {r.priority ? (
                          <>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${PRIORITY[r.priority].cls}`}>{r.autoApcm ? "Automatic APCM" : PRIORITY[r.priority].short}</span>
                            {r.ccmCompletedBefore > 0 && <div className="text-[11px] text-slate-400 mt-0.5">{r.ccmCompletedBefore} CCM{r.ccmCompletedBefore === 1 ? "" : "s"} before · last {monthLabel(r.lastCcmCompleted)}</div>}
                          </>
                        ) : <span className="text-[11px] text-slate-400">Billed as CCM</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold ${apcmLevelBadgeClass(level)}`}>{APCM_LEVEL_LABELS[level]}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <input type="checkbox" checked={!!r.isQMB} disabled={busy} onChange={(e) => mut.mutate({ id: r.id, isQMB: e.target.checked })} className="accent-indigo-600" />
                      </td>
                      <td className="px-4 py-3">
                        <select value={r.apcmConsentStatus || "pending"} disabled={busy}
                          onChange={(e) => mut.mutate({ id: r.id, apcmConsentStatus: e.target.value as any, apcmConsentDate: e.target.value === "consented" ? new Date() : null })}
                          className={`px-2 py-1 rounded-lg border text-xs font-semibold ${r.consented ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-600"}`}>
                          <option value="pending">Pending</option>
                          <option value="consented">Consented</option>
                          <option value="declined">Declined</option>
                        </select>
                      </td>
                      <td className="px-4 py-3 text-center">{r.hasVisit ? <CheckCircle2 size={16} className="text-emerald-500 mx-auto" /> : <XCircle size={16} className="text-slate-300 mx-auto" />}</td>
                      <td className="px-4 py-3 text-center">
                        <button onClick={() => setCarePlanFor(r)} className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold ${r.hasCarePlan ? "text-emerald-700 hover:bg-emerald-50" : "text-indigo-600 hover:bg-indigo-50"}`}>
                          {r.hasCarePlan ? <><CheckCircle2 size={13} /> View</> : <><FileText size={13} /> Add</>}
                        </button>
                      </td>
                      <td className="px-4 py-3"><span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${cat.cls}`}>{cat.label}{r.category === "ready" ? ` · ${cpt}` : ""}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total > rows.length && (
            <div className="p-4 text-center border-t border-slate-100">
              <button onClick={() => setLimit((l) => Math.min(l + 200, 2000))} disabled={q.isFetching}
                className="px-4 py-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                {q.isFetching ? "Loading…" : `Load more (${rows.length} of ${total.toLocaleString()})`}
              </button>
            </div>
          )}
        </div>
      )}

      {carePlanFor && (
        <CarePlanModal
          patient={carePlanFor}
          onClose={() => setCarePlanFor(null)}
          onSave={(text) => { mut.mutate({ id: carePlanFor.id, apcmCarePlan: text }, { onSuccess: () => { toast.success("Care plan saved."); setCarePlanFor(null); } }); }}
          pending={mut.isPending}
        />
      )}
    </CCMDashboardLayout>
  );
}

function StatCard({ label, value, sub, accent }: { label: string; value: number; sub?: string; accent?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-4">
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-0.5 font-mono tabular-nums ${accent || "text-slate-900"}`}>{value.toLocaleString()}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function CarePlanModal({ patient, onClose, onSave, pending }: { patient: any; onClose: () => void; onSave: (text: string) => void; pending: boolean }) {
  const detail = trpc.patients.detail.useQuery(patient.id);
  const existing = (detail.data?.patient as any)?.apcmCarePlan || "";
  const [text, setText] = useState<string | null>(null);
  const value = text ?? existing;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-1">
          <h3 className="text-lg font-bold text-slate-900">{patient.name} — APCM care plan</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X size={18} /></button>
        </div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs text-slate-400">Problems · goals · interventions · care team · 24/7 access · follow-up. Required before APCM can bill.</p>
          <button type="button" onClick={() => setText(buildStandardApcmCarePlan({ name: patient.name, conditions: (patient.chronicConditions as string[]) || [] }))}
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 whitespace-nowrap">Insert standard template</button>
        </div>
        {detail.isLoading ? <div className="py-10 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div> : (
          <textarea value={value} onChange={(e) => setText(e.target.value)} rows={7}
            placeholder="e.g. Problems: HTN, T2DM. Goals: BP < 130/80, A1c < 8. Interventions: med review, home BP monitoring, dietitian referral. Care team: Dr. Mansour + coordinator. 24/7 access line given. Follow-up: monthly APCM check-in."
            className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300 mb-4" />
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-500 hover:bg-slate-100">Cancel</button>
          <button disabled={pending || value === existing || detail.isLoading} onClick={() => onSave(value)}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:brightness-110 disabled:opacity-40 transition">
            {pending ? <Loader2 size={15} className="animate-spin" /> : <><FileText size={14} /> Save care plan</>}
          </button>
        </div>
      </div>
    </div>
  );
}

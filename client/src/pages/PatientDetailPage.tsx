import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useParams, useLocation } from "wouter";
import { useState } from "react";
import { ArrowLeft, Loader2, Phone, Calendar, Shield, Globe, User, Activity, FileText, ClipboardList, Pencil, Trash2, CheckCircle2, XCircle, Brain, Stethoscope } from "lucide-react";
import { toast } from "sonner";
import {
  STATUS_LABELS, statusBadgeClass, fmtDate, toDateInput, FOLLOWUP_TYPE_LABELS, FOLLOWUP_STATUS_LABELS,
  BHI_STATUS_LABELS, BHI_CONDITION_OPTIONS, BHI_CONDITION_ICD10, BHI_CONSENT_DISCLOSURES, bhiCompliance, programBadgeClass,
  APCM_LEVEL_LABELS, apcmLevelBadgeClass, apcmLevelFrom, APCM_CONSENT_DISCLOSURES, apcmCompliance,
} from "@/lib/ccm";
import { buildStandardApcmCarePlan } from "@shared/carePlan";
import { PatientFormDialog, type PatientLike } from "@/components/PatientFormDialog";
import { MedRefillPanel } from "@/components/MedRefillPanel";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { PhoneLink } from "@/components/phone/PhoneLink";

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-3xl p-6 border border-slate-100">
      <h3 className="font-bold text-slate-900 tracking-tight mb-4 flex items-center gap-2"><Icon size={18} className="text-slate-400" /> {title}</h3>
      {children}
    </div>
  );
}

/** Behavioral Health Integration (BHI, 99484) enrollment + consent + compliance panel. */
function BhiSection({ patient, canEdit }: { patient: any; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const conditions: string[] = (patient.bhiConditions as string[]) || [];
  const status = patient.bhiEnrollmentStatus || "not_enrolled";
  const enrolled = status === "active";
  const [carePlan, setCarePlan] = useState<string>(patient.bhiCarePlan || "");
  const mut = trpc.patients.updateBHI.useMutation({
    onSuccess: () => { utils.patients.detail.invalidate(patient.id); toast.success("BHI updated."); },
    onError: (e) => toast.error(e.message),
  });
  const toggleCondition = (c: string) => {
    const next = conditions.includes(c) ? conditions.filter((x) => x !== c) : [...conditions, c];
    mut.mutate({ id: patient.id, bhiConditions: next });
  };
  const sel = "px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-300";
  const checks = bhiCompliance(patient);
  const metCount = checks.filter((c) => c.ok).length;

  return (
    <div className="bg-white rounded-3xl p-6 border border-violet-100">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Brain size={18} className="text-violet-500" /> Behavioral Health Integration
        </h3>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${enrolled ? programBadgeClass("bhi") : "bg-slate-100 text-slate-500"}`}>{BHI_STATUS_LABELS[status] || status}</span>
      </div>

      {!enrolled && status === "not_enrolled" ? (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-slate-500 font-light">Not enrolled in BHI. Enroll patients with a behavioral-health condition (depression, anxiety, SUD, etc.) to track them independently of CCM.</p>
          {canEdit && (
            <button onClick={() => mut.mutate({ id: patient.id, bhiEnrollmentStatus: "active" })} disabled={mut.isPending}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-violet-600 text-white text-sm font-semibold hover:brightness-110 active:scale-[0.97] disabled:opacity-50 transition whitespace-nowrap">
              <Brain size={14} /> Enroll in BHI
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {/* Compliance checklist — everything required before 99484 can be billed */}
          <div className={`rounded-2xl p-4 ${metCount === checks.length ? "bg-emerald-50/70 border border-emerald-100" : "bg-amber-50/60 border border-amber-100"}`}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">BHI billing requirements</p>
              <span className={`text-xs font-bold ${metCount === checks.length ? "text-emerald-700" : "text-amber-700"}`}>{metCount}/{checks.length} met</span>
            </div>
            <div className="grid sm:grid-cols-2 gap-1.5">
              {checks.map((c) => (
                <div key={c.key} className="flex items-center gap-2 text-sm">
                  {c.ok ? <CheckCircle2 size={15} className="text-emerald-500 shrink-0" /> : <XCircle size={15} className="text-slate-300 shrink-0" />}
                  <span className={c.ok ? "text-slate-700" : "text-slate-500"}>{c.label}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-2">Plus ≥20 min of documented clinical time per month (tracked on each BHI call).</p>
          </div>

          {canEdit && (
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Enrollment status</label>
                <select className={sel + " w-full"} value={status} onChange={(e) => mut.mutate({ id: patient.id, bhiEnrollmentStatus: e.target.value as any })}>
                  {["active", "inactive", "declined", "transferred", "not_enrolled"].map((s) => <option key={s} value={s}>{BHI_STATUS_LABELS[s]}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5 flex items-center gap-1"><Stethoscope size={12} /> Initiating visit date <span className="text-slate-300" title="Required for new patients or anyone not seen in the prior 12 months (E/M, AWV, or IPPE)">(E/M · AWV · IPPE)</span></label>
                <input type="date" className={sel + " w-full"} defaultValue={toDateInput(patient.bhiInitiatingVisitDate)}
                  onChange={(e) => mut.mutate({ id: patient.id, bhiInitiatingVisitDate: e.target.value ? new Date(e.target.value + "T00:00:00") : null })} />
              </div>
            </div>
          )}

          {/* Consent — with the disclosures CMS requires be given to the patient */}
          <div className="rounded-2xl border border-slate-100 p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
              <p className="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><Shield size={14} className="text-violet-500" /> BHI consent {patient.bhiConsentDate && <span className="text-xs font-normal text-slate-400">· {fmtDate(patient.bhiConsentDate)}</span>}</p>
              {canEdit && (
                <select className={sel} value={patient.bhiConsentStatus || "pending"}
                  onChange={(e) => mut.mutate({ id: patient.id, bhiConsentStatus: e.target.value as any, bhiConsentDate: e.target.value === "consented" ? new Date() : null })}>
                  <option value="pending">Consent pending</option>
                  <option value="consented">Consented</option>
                  <option value="declined">Declined</option>
                </select>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mb-2">Read to the patient and document before marking consented:</p>
            <ul className="space-y-1">
              {BHI_CONSENT_DISCLOSURES.map((d) => (
                <li key={d} className="text-[12px] text-slate-500 flex items-start gap-1.5"><span className="text-violet-400 mt-0.5">•</span>{d}</li>
              ))}
            </ul>
          </div>

          {/* Behavioral-health diagnosis (with ICD-10 for the claim) */}
          <div>
            <p className="text-xs text-slate-400 mb-2">Behavioral-health diagnosis</p>
            <div className="flex flex-wrap gap-2">
              {BHI_CONDITION_OPTIONS.map((c) => {
                const on = conditions.includes(c);
                const icd = BHI_CONDITION_ICD10[c];
                return (
                  <button key={c} disabled={!canEdit || mut.isPending} onClick={() => toggleCondition(c)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${on ? "bg-violet-100 text-violet-800 border-violet-200" : "bg-white text-slate-500 border-slate-200 hover:border-violet-200"} ${canEdit ? "cursor-pointer" : "cursor-default"}`}>
                    {c}{on && icd ? <span className="ml-1.5 font-mono text-[10px] text-violet-500">{icd}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Behavioral care plan */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5 flex items-center gap-1"><FileText size={12} /> Behavioral care plan <span className="text-slate-300">(condition · goals · interventions · follow-up)</span></label>
            <textarea value={carePlan} onChange={(e) => setCarePlan(e.target.value)} readOnly={!canEdit} rows={4}
              placeholder="e.g. Dx: Major depressive disorder (F32.9). Goal: PHQ-9 < 10 within 3 months. Interventions: continue sertraline, weekly counseling referral, sleep hygiene education. Follow-up: monthly BHI check-in, re-score PHQ-9."
              className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-violet-300" />
            {canEdit && (
              <div className="flex justify-end mt-2">
                <button onClick={() => mut.mutate({ id: patient.id, bhiCarePlan: carePlan })} disabled={mut.isPending || carePlan === (patient.bhiCarePlan || "")}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-violet-600 text-white text-xs font-semibold hover:brightness-110 disabled:opacity-40 transition">
                  <FileText size={13} /> Save care plan
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Advanced Primary Care Management (APCM, G0556/57/58) enrollment + consent + compliance panel. */
function ApcmSection({ patient, canEdit }: { patient: any; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const ccmActive = patient.ccmEnrollmentStatus === "active";
  const [carePlan, setCarePlan] = useState<string>(patient.apcmCarePlan || "");
  const mut = trpc.patients.updateAPCM.useMutation({
    onSuccess: () => { utils.patients.detail.invalidate(patient.id); toast.success("APCM updated."); },
    onError: (e) => toast.error(e.message),
  });
  const sel = "px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-300";
  const conditionCount = ((patient.chronicConditions as string[]) || []).length;
  const level = patient.apcmLevel || apcmLevelFrom(conditionCount, !!patient.isQMB);
  const checks = apcmCompliance(patient);
  const metCount = checks.filter((c) => c.ok).length;

  return (
    <div className="bg-white rounded-3xl p-6 border border-indigo-100">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Activity size={18} className="text-indigo-500" /> Advanced Primary Care Management
        </h3>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${ccmActive ? programBadgeClass("apcm") : "bg-slate-100 text-slate-500"}`}>{ccmActive ? "Auto · mirrors CCM" : "Follows CCM"}</span>
      </div>

      {!ccmActive ? (
        <p className="text-sm text-slate-500 font-light">APCM automatically covers your active CCM patients. This patient isn't CCM-active, so there's nothing to bill for APCM — reactivate their CCM to include them.</p>
      ) : (
        <div className="space-y-5">
          <p className="text-xs text-slate-500 font-light -mt-1 leading-relaxed">Every active CCM patient is covered by APCM automatically. APCM bills each month the patient does <b>not</b> get a completed CCM — once consent + care plan are on file. Complete a CCM and they drop off APCM for that month (you can't bill both).</p>
          {/* Complexity level → G-code (auto-computed from conditions + QMB) */}
          <div className="flex items-center gap-3 flex-wrap rounded-2xl bg-indigo-50/60 border border-indigo-100 p-4">
            <span className={`px-3 py-1 rounded-full text-xs font-bold ${apcmLevelBadgeClass(level)}`}>{APCM_LEVEL_LABELS[level] || level}</span>
            <span className="text-xs text-slate-500">CCM patient → Level 2 minimum (2+ chronic conditions){patient.isQMB ? " · QMB → Level 3" : ""}</span>
            {canEdit && (
              <label className="ml-auto inline-flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                <input type="checkbox" checked={!!patient.isQMB} onChange={(e) => mut.mutate({ id: patient.id, isQMB: e.target.checked })} className="accent-indigo-600" />
                Qualified Medicare Beneficiary (QMB → Level 3)
              </label>
            )}
          </div>

          {/* Compliance checklist — required before an APCM G-code can bill (NO time rule) */}
          <div className={`rounded-2xl p-4 ${metCount === checks.length ? "bg-emerald-50/70 border border-emerald-100" : "bg-amber-50/60 border border-amber-100"}`}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">APCM billing requirements</p>
              <span className={`text-xs font-bold ${metCount === checks.length ? "text-emerald-700" : "text-amber-700"}`}>{metCount}/{checks.length} met</span>
            </div>
            <div className="grid sm:grid-cols-2 gap-1.5">
              {checks.map((c) => (
                <div key={c.key} className="flex items-center gap-2 text-sm">
                  {c.ok ? <CheckCircle2 size={15} className="text-emerald-500 shrink-0" /> : <XCircle size={15} className="text-slate-300 shrink-0" />}
                  <span className={c.ok ? "text-slate-700" : "text-slate-500"}>{c.label}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-2">No monthly time threshold — APCM is a bundled service, not time-based.</p>
          </div>

          {canEdit && (
            <div>
              <label className="block text-xs text-slate-400 mb-1.5 flex items-center gap-1"><Stethoscope size={12} /> Initiating visit date <span className="text-slate-300" title="Required for new patients or anyone not seen in the prior 3 years">(within 3 years)</span></label>
              <input type="date" className={sel + " w-full sm:w-64"} defaultValue={toDateInput(patient.apcmInitiatingVisitDate)}
                onChange={(e) => mut.mutate({ id: patient.id, apcmInitiatingVisitDate: e.target.value ? new Date(e.target.value + "T00:00:00") : null })} />
            </div>
          )}

          {/* Consent — with the disclosures given to the patient */}
          <div className="rounded-2xl border border-slate-100 p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
              <p className="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><Shield size={14} className="text-indigo-500" /> APCM consent {patient.apcmConsentDate && <span className="text-xs font-normal text-slate-400">· {fmtDate(patient.apcmConsentDate)}</span>}</p>
              {canEdit && (
                <select className={sel} value={patient.apcmConsentStatus || "pending"}
                  onChange={(e) => mut.mutate({ id: patient.id, apcmConsentStatus: e.target.value as any, apcmConsentDate: e.target.value === "consented" ? new Date() : null })}>
                  <option value="pending">Consent pending</option>
                  <option value="consented">Consented</option>
                  <option value="declined">Declined</option>
                </select>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mb-2">Read to the patient and document before marking consented:</p>
            <ul className="space-y-1">
              {APCM_CONSENT_DISCLOSURES.map((d) => (
                <li key={d} className="text-[12px] text-slate-500 flex items-start gap-1.5"><span className="text-indigo-400 mt-0.5">•</span>{d}</li>
              ))}
            </ul>
          </div>

          {/* Comprehensive care plan */}
          <div>
            <label className="block text-xs text-slate-400 mb-1.5 flex items-center gap-1"><FileText size={12} /> Comprehensive care plan <span className="text-slate-300">(problems · goals · interventions · care team · follow-up)</span></label>
            <textarea value={carePlan} onChange={(e) => setCarePlan(e.target.value)} readOnly={!canEdit} rows={4}
              placeholder="e.g. Problems: HTN, T2DM. Goals: BP < 130/80, A1c < 8. Interventions: med review, home BP monitoring, dietitian referral. Care team: Dr. Mansour + coordinator. 24/7 access line given. Follow-up: monthly APCM check-in."
              className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300" />
            {canEdit && (
              <div className="flex justify-between items-center mt-2">
                <button type="button" onClick={() => setCarePlan(buildStandardApcmCarePlan({ name: patient.name, conditions: (patient.chronicConditions as string[]) || [] }))}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-800">Insert standard template</button>
                <button onClick={() => mut.mutate({ id: patient.id, apcmCarePlan: carePlan })} disabled={mut.isPending || carePlan === (patient.apcmCarePlan || "")}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:brightness-110 disabled:opacity-40 transition">
                  <FileText size={13} /> Save care plan
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** "2026-06" -> "June 2026" */
function monthLabel(m: string) {
  const [y, mo] = m.split("-").map(Number);
  if (!y || !mo) return m;
  return new Date(y, mo - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

const COMPLETED_STATUSES = ["completed", "ready_for_billing", "billed", "needs_provider_review"];

/** The CCM record. `embedded` renders it inside Patient 360 (no page chrome). */
export default function PatientDetailPage({ embedded = false, patientId }: { embedded?: boolean; patientId?: number } = {}) {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const params = useParams();
  const [, setLocation] = useLocation();
  const id = patientId ?? Number(params.id);
  const detail = trpc.patients.detail.useQuery(id, { enabled: !!user && !!id });
  const utils = trpc.useUtils();
  const canEdit = !!user && ["admin", "staff", "front_desk"].includes(user.role);
  const canDelete = !!user && user.role === "admin";
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const updateDates = trpc.patients.updateDates.useMutation({
    onSuccess: () => { utils.patients.detail.invalidate(id); toast.success("Dates updated."); },
    onError: (e) => toast.error(e.message),
  });
  const removePatient = trpc.patients.remove.useMutation({
    onSuccess: () => { toast.success("Patient deleted."); setLocation("/patients"); },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) {
    return embedded ? null : <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const d = detail.data;

  const body = (
    <>
      {detail.isLoading && <div className="py-20 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>}
      {!detail.isLoading && !d && <p className="text-slate-400 font-light">Patient not found.</p>}

      {d && (
        <div className="space-y-6">
          {/* Header */}
          <div className="bg-white rounded-3xl p-6 border border-slate-100">
            <div className="flex items-start justify-between flex-wrap gap-4">
              <div>
                {embedded ? (
                  <h2 className="text-lg font-bold tracking-tight text-slate-900">Care management record</h2>
                ) : (
                  <h2 className="text-2xl font-extrabold tracking-tight text-slate-900">{d.patient.name}</h2>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-slate-500">
                  <span className="flex items-center gap-1.5"><Phone size={14} /> <PhoneLink phone={d.patient.phoneNumber} context={{ patientId: d.patient.id, name: d.patient.name, source: "patient" }} /></span>
                  <span className="flex items-center gap-1.5"><Calendar size={14} /> {fmtDate(d.patient.dateOfBirth)}</span>
                  <span className="flex items-center gap-1.5"><Globe size={14} /> {d.patient.preferredLanguage}</span>
                  <span className="flex items-center gap-1.5"><Shield size={14} /> {d.patient.insurance || "—"}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`px-3 py-1.5 rounded-full text-xs font-semibold ${statusBadgeClass(d.patient.ccmEnrollmentStatus ?? "active")}`} title="CCM enrollment">CCM: {d.patient.ccmEnrollmentStatus}</span>
                {d.patient.bhiEnrollmentStatus === "active" && (
                  <span className={`px-3 py-1.5 rounded-full text-xs font-semibold ${programBadgeClass("bhi")}`} title="Behavioral Health Integration">BHI: active</span>
                )}
                {canEdit && (
                  <button onClick={() => setEditOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50">
                    <Pencil size={13} /> Edit
                  </button>
                )}
                {canDelete && (
                  <button onClick={() => setDeleteOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-rose-200 text-rose-600 text-xs font-semibold hover:bg-rose-50">
                    <Trash2 size={13} /> Delete
                  </button>
                )}
              </div>
            </div>
            <div className="mt-5 grid sm:grid-cols-3 gap-4 text-sm">
              <div className="rounded-2xl bg-slate-50 p-3"><p className="text-xs text-slate-400 flex items-center gap-1.5"><User size={12} /> Provider</p><p className="mt-1 font-semibold text-slate-800">{d.provider?.name || "—"}</p></div>
              <div className="rounded-2xl bg-slate-50 p-3"><p className="text-xs text-slate-400">Clinic</p><p className="mt-1 font-semibold text-slate-800">{d.clinic?.name || "—"}</p></div>
              <div className="rounded-2xl bg-slate-50 p-3"><p className="text-xs text-slate-400">Assigned Staff</p><p className="mt-1 font-semibold text-slate-800">{d.staff?.name || "Unassigned"}</p></div>
            </div>
          </div>

          {/* Care Schedule */}
          <Section title="Care Schedule" icon={Calendar}>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-xs text-slate-400 flex items-center gap-1.5"><Phone size={12} /> Last Called</p>
                {canEdit ? (
                  <input type="date" defaultValue={toDateInput(d.patient.lastCalledAt)}
                    className="mt-1.5 w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)]"
                    onChange={(e) => updateDates.mutate({ id, lastCalledAt: e.target.value ? new Date(e.target.value + "T00:00:00") : null })} />
                ) : <p className="mt-1.5 font-semibold text-slate-800">{fmtDate(d.patient.lastCalledAt)}</p>}
                <p className="text-[11px] text-slate-400 mt-1.5">Auto-updates when a CCM call is completed.</p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-xs text-slate-400 flex items-center gap-1.5"><Calendar size={12} /> Next Appointment</p>
                {canEdit ? (
                  <input type="date" defaultValue={toDateInput(d.patient.nextAppointment)}
                    className="mt-1.5 w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)]"
                    onChange={(e) => updateDates.mutate({ id, nextAppointment: e.target.value ? new Date(e.target.value + "T00:00:00") : null })} />
                ) : <p className="mt-1.5 font-semibold text-slate-800">{fmtDate(d.patient.nextAppointment)}</p>}
                <p className="text-[11px] text-slate-400 mt-1.5">Appears on the dashboard's Upcoming Appointments.</p>
              </div>
            </div>
          </Section>

          {/* Conditions */}
          <Section title="Chronic Conditions" icon={Activity}>
            <div className="flex flex-wrap gap-2">
              {(d.patient.chronicConditions as string[] || []).length === 0 && <p className="text-sm text-slate-400 font-light">None recorded.</p>}
              {(d.patient.chronicConditions as string[] || []).map((c) => (
                <span key={c} className="px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 text-sm font-medium">{c}</span>
              ))}
            </div>
          </Section>

          {/* Behavioral Health Integration (BHI 99484) enrollment */}
          <BhiSection patient={d.patient} canEdit={canEdit} />

          {/* Advanced Primary Care Management (APCM G0556/57/58) enrollment */}
          <ApcmSection patient={d.patient} canEdit={canEdit} />

          {/* Medication refill requests → provider (coordinators) */}
          {user && ["admin", "staff"].includes(user.role) && (
            <MedRefillPanel patientId={d.patient.id} providerName={d.provider?.name} />
          )}

          {/* CCM Call History — monthly call log with documentation */}
          <Section title="CCM Call History" icon={ClipboardList}>
            {(() => {
              const noteByTask = new Map<number, (typeof d.notes)[number]>();
              for (const n of d.notes) if (n.ccmTaskId != null) noteByTask.set(n.ccmTaskId, n);
              const completedCount = d.tasks.filter((t) => COMPLETED_STATUSES.includes(t.status ?? "")).length;
              if (d.tasks.length === 0) {
                return <p className="text-sm text-slate-400 font-light">No calls recorded yet. A monthly call task is created automatically for active patients.</p>;
              }
              return (
                <>
                  <p className="text-sm text-slate-500 mb-3">
                    <span className="font-semibold text-slate-800">{completedCount}</span> completed {completedCount === 1 ? "call" : "calls"} across {d.tasks.length} {d.tasks.length === 1 ? "month" : "months"}.
                  </p>
                  <div className="space-y-3">
                    {d.tasks.map((t) => {
                      const note = noteByTask.get(t.id);
                      const done = COMPLETED_STATUSES.includes(t.status ?? "");
                      const completedBy = t.completedByStaffId ? d.completedByName[t.completedByStaffId] : null;
                      return (
                        <div key={t.id} className="rounded-2xl border border-slate-100 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-3">
                              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${done ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
                                {done ? <CheckCircle2 size={18} /> : <Phone size={16} />}
                              </div>
                              <div>
                                <p className="font-semibold text-slate-800">{monthLabel(t.month)}</p>
                                <p className="text-xs text-slate-400">
                                  {t.dateContacted ? `Called ${fmtDate(t.dateContacted)}` : t.completedAt ? `Completed ${fmtDate(t.completedAt)}` : "Not yet contacted"}
                                  {completedBy ? ` · by ${completedBy}` : ""}
                                </p>
                              </div>
                            </div>
                            <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${statusBadgeClass(t.status ?? "not_started")}`}>{STATUS_LABELS[t.status ?? "not_started"] || t.status}</span>
                          </div>
                          {note?.generatedNote && (
                            <details className="mt-3">
                              <summary className="text-xs font-semibold text-[hsl(17_70%_42%)] cursor-pointer select-none flex items-center gap-1">
                                <FileText size={12} /> View call note
                              </summary>
                              <p className="mt-2 text-sm text-slate-700 whitespace-pre-wrap rounded-xl bg-slate-50 p-3">{note.generatedNote}</p>
                            </details>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}
          </Section>

          {/* Follow-ups */}
          <Section title="Follow-up Items" icon={Calendar}>
            <div className="space-y-2">
              {d.followUps.length === 0 && <p className="text-sm text-slate-400 font-light">No follow-up items.</p>}
              {d.followUps.map((f) => (
                <div key={f.id} className="flex items-center justify-between p-3 rounded-2xl bg-slate-50">
                  <div>
                    <p className="font-medium text-slate-800">{FOLLOWUP_TYPE_LABELS[f.type] || f.type}</p>
                    {f.notes && <p className="text-xs text-slate-400">{f.notes}</p>}
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${statusBadgeClass(f.status ?? "pending")}`}>{FOLLOWUP_STATUS_LABELS[f.status ?? "pending"] || f.status}</span>
                </div>
              ))}
            </div>
          </Section>

          <PatientFormDialog
            mode="edit"
            patient={d.patient as PatientLike}
            open={editOpen}
            onOpenChange={setEditOpen}
            onDone={() => utils.patients.detail.invalidate(id)}
          />

          <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete patient?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes <span className="font-semibold text-slate-700">{d.patient.name}</span> and all of their CCM tasks, notes, follow-ups, and billing records. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => { e.preventDefault(); removePatient.mutate(d.patient.id); }}
                  className="bg-rose-600 hover:bg-rose-700 focus:ring-rose-600"
                >
                  {removePatient.isPending ? "Deleting…" : "Delete patient"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </>
  );

  if (embedded) return body;
  return (
    <CCMDashboardLayout title="Patient Profile">
      <button onClick={() => setLocation("/patients")} className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 mb-4">
        <ArrowLeft size={16} /> Back to Patients
      </button>
      {body}
    </CCMDashboardLayout>
  );
}

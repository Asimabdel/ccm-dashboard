import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useParams, useLocation } from "wouter";
import { ArrowLeft, Loader2, Phone, Calendar, Shield, Globe, User, Activity, FileText, ClipboardList } from "lucide-react";
import {
  PRIORITY_LABELS, STATUS_LABELS, priorityBadgeClass, statusBadgeClass, fmtDate, FOLLOWUP_TYPE_LABELS, FOLLOWUP_STATUS_LABELS,
} from "@/lib/ccm";

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-3xl p-6 border border-slate-100">
      <h3 className="font-bold text-slate-900 tracking-tight mb-4 flex items-center gap-2"><Icon size={18} className="text-slate-400" /> {title}</h3>
      {children}
    </div>
  );
}

export default function PatientDetailPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const params = useParams();
  const [, setLocation] = useLocation();
  const id = Number(params.id);
  const detail = trpc.patients.detail.useQuery(id, { enabled: !!user && !!id });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-[hsl(240_10%_97%)]"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const d = detail.data;

  return (
    <CCMDashboardLayout title="Patient Profile">
      <button onClick={() => setLocation("/patients")} className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 mb-4">
        <ArrowLeft size={16} /> Back to Patients
      </button>

      {detail.isLoading && <div className="py-20 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></div>}
      {!detail.isLoading && !d && <p className="text-slate-400 font-light">Patient not found.</p>}

      {d && (
        <div className="space-y-6">
          {/* Header */}
          <div className="bg-white rounded-3xl p-6 border border-slate-100">
            <div className="flex items-start justify-between flex-wrap gap-4">
              <div>
                <h2 className="text-2xl font-extrabold tracking-tight text-slate-900">{d.patient.name}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-slate-500">
                  <span className="flex items-center gap-1.5"><Phone size={14} /> {d.patient.phoneNumber}</span>
                  <span className="flex items-center gap-1.5"><Calendar size={14} /> {fmtDate(d.patient.dateOfBirth)}</span>
                  <span className="flex items-center gap-1.5"><Globe size={14} /> {d.patient.preferredLanguage}</span>
                  <span className="flex items-center gap-1.5"><Shield size={14} /> {d.patient.insurance || "-"}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-3 py-1.5 rounded-full text-xs font-semibold ${priorityBadgeClass(d.patient.riskLevel ?? "medium")}`}>{PRIORITY_LABELS[d.patient.riskLevel ?? "medium"]} Risk</span>
                <span className={`px-3 py-1.5 rounded-full text-xs font-semibold ${statusBadgeClass(d.patient.ccmEnrollmentStatus ?? "active")}`}>{d.patient.ccmEnrollmentStatus}</span>
              </div>
            </div>
            <div className="mt-5 grid sm:grid-cols-3 gap-4 text-sm">
              <div className="rounded-2xl bg-slate-50 p-3"><p className="text-xs text-slate-400 flex items-center gap-1.5"><User size={12} /> Provider</p><p className="mt-1 font-semibold text-slate-800">{d.provider?.name || "-"}</p></div>
              <div className="rounded-2xl bg-slate-50 p-3"><p className="text-xs text-slate-400">Clinic</p><p className="mt-1 font-semibold text-slate-800">{d.clinic?.name || "-"}</p></div>
              <div className="rounded-2xl bg-slate-50 p-3"><p className="text-xs text-slate-400">Assigned Staff</p><p className="mt-1 font-semibold text-slate-800">{d.staff?.name || "Unassigned"}</p></div>
            </div>
          </div>

          {/* Conditions */}
          <Section title="Chronic Conditions" icon={Activity}>
            <div className="flex flex-wrap gap-2">
              {(d.patient.chronicConditions as string[] || []).length === 0 && <p className="text-sm text-slate-400 font-light">None recorded.</p>}
              {(d.patient.chronicConditions as string[] || []).map((c) => (
                <span key={c} className="px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 text-sm font-medium">{c}</span>
              ))}
            </div>
          </Section>

          {/* CCM Task history */}
          <Section title="CCM Task History" icon={ClipboardList}>
            <div className="space-y-2">
              {d.tasks.length === 0 && <p className="text-sm text-slate-400 font-light">No CCM tasks yet.</p>}
              {d.tasks.map((t) => (
                <div key={t.id} className="flex items-center justify-between p-3 rounded-2xl bg-slate-50">
                  <div>
                    <p className="font-medium text-slate-800">{t.month}</p>
                    <p className="text-xs text-slate-400">Contacted {fmtDate(t.dateContacted)}</p>
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${statusBadgeClass(t.status ?? "not_started")}`}>{STATUS_LABELS[t.status ?? "not_started"] || t.status}</span>
                </div>
              ))}
            </div>
          </Section>

          {/* Notes */}
          <Section title="CCM Documentation Notes" icon={FileText}>
            <div className="space-y-3">
              {d.notes.length === 0 && <p className="text-sm text-slate-400 font-light">No notes yet.</p>}
              {d.notes.map((n) => (
                <div key={n.id} className="p-4 rounded-2xl bg-slate-50">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-slate-500">{fmtDate(n.createdAt)}</p>
                  </div>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap line-clamp-6">{n.generatedNote || "-"}</p>
                </div>
              ))}
            </div>
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
        </div>
      )}
    </CCMDashboardLayout>
  );
}

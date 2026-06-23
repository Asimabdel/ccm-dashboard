import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useParams, useLocation } from "wouter";
import { useState } from "react";
import { ArrowLeft, Loader2, Phone, Calendar, Shield, Globe, User, Activity, FileText, ClipboardList, Pencil, Trash2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import {
  STATUS_LABELS, statusBadgeClass, fmtDate, toDateInput, FOLLOWUP_TYPE_LABELS, FOLLOWUP_STATUS_LABELS,
} from "@/lib/ccm";
import { PatientFormDialog, type PatientLike } from "@/components/PatientFormDialog";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-3xl p-6 border border-slate-100">
      <h3 className="font-bold text-slate-900 tracking-tight mb-4 flex items-center gap-2"><Icon size={18} className="text-slate-400" /> {title}</h3>
      {children}
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

export default function PatientDetailPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const params = useParams();
  const [, setLocation] = useLocation();
  const id = Number(params.id);
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
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
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
                  <span className="flex items-center gap-1.5"><Shield size={14} /> {d.patient.insurance || "—"}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`px-3 py-1.5 rounded-full text-xs font-semibold ${statusBadgeClass(d.patient.ccmEnrollmentStatus ?? "active")}`}>{d.patient.ccmEnrollmentStatus}</span>
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
                    className="mt-1.5 w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]"
                    onChange={(e) => updateDates.mutate({ id, lastCalledAt: e.target.value ? new Date(e.target.value + "T00:00:00") : null })} />
                ) : <p className="mt-1.5 font-semibold text-slate-800">{fmtDate(d.patient.lastCalledAt)}</p>}
                <p className="text-[11px] text-slate-400 mt-1.5">Auto-updates when a CCM call is completed.</p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-xs text-slate-400 flex items-center gap-1.5"><Calendar size={12} /> Next Appointment</p>
                {canEdit ? (
                  <input type="date" defaultValue={toDateInput(d.patient.nextAppointment)}
                    className="mt-1.5 w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]"
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
                              <summary className="text-xs font-semibold text-[hsl(200_100%_40%)] cursor-pointer select-none flex items-center gap-1">
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
    </CCMDashboardLayout>
  );
}

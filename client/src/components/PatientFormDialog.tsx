import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Loader2, UserPlus, Save } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { PRIORITY_LABELS } from "@/lib/ccm";

const CONDITIONS = [
  "Hypertension", "Type 2 Diabetes", "COPD", "CHF", "CKD", "Hyperlipidemia",
  "Atrial Fibrillation", "Asthma", "Osteoarthritis", "Depression", "Obesity", "GERD",
];
const RISK_OPTIONS = ["high", "medium", "low"] as const;

export type PatientLike = {
  id: number;
  name: string;
  phoneNumber: string;
  dateOfBirth?: string | Date | null;
  insurance?: string | null;
  clinicId: number;
  providerId: number;
  priorityLevel?: string | null;
  riskLevel?: string | null;
  consentStatus?: string | null;
  preferredLanguage?: string | null;
  assignedStaffId?: number | null;
  chronicConditions?: string[] | null;
  ccmEnrollmentStatus?: string | null;
};

const EMPTY = {
  name: "", phoneNumber: "", clinicId: 0, providerId: 0, insurance: "",
  preferredLanguage: "English", priorityLevel: "medium" as "high" | "medium" | "low",
  consentStatus: "pending" as "consented" | "pending" | "declined",
  assignedStaffId: 0, conditions: [] as string[], dob: "",
  ccmEnrollmentStatus: "active" as "active" | "inactive" | "declined",
};

/** Create or edit a patient. Controlled via `open` / `onOpenChange`. */
export function PatientFormDialog({ mode, patient, open, onOpenChange, onDone }: {
  mode: "create" | "edit";
  patient?: PatientLike | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const clinics = trpc.clinics.list.useQuery(undefined, { enabled: open });
  const providers = trpc.providers.all.useQuery(undefined, { enabled: open });
  const staff = trpc.staff.all.useQuery(undefined, { enabled: open });
  const [form, setForm] = useState({ ...EMPTY });

  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && patient) {
      setForm({
        name: patient.name ?? "",
        phoneNumber: patient.phoneNumber ?? "",
        clinicId: patient.clinicId ?? 0,
        providerId: patient.providerId ?? 0,
        insurance: patient.insurance ?? "",
        preferredLanguage: patient.preferredLanguage ?? "English",
        priorityLevel: ((patient.priorityLevel ?? patient.riskLevel ?? "medium") as "high" | "medium" | "low"),
        consentStatus: ((patient.consentStatus ?? "pending") as "consented" | "pending" | "declined"),
        assignedStaffId: patient.assignedStaffId ?? 0,
        conditions: (patient.chronicConditions as string[]) ?? [],
        dob: patient.dateOfBirth ? new Date(patient.dateOfBirth).toISOString().slice(0, 10) : "",
        ccmEnrollmentStatus: ((patient.ccmEnrollmentStatus ?? "active") as "active" | "inactive" | "declined"),
      });
    } else {
      setForm({ ...EMPTY });
    }
  }, [open, mode, patient]);

  const create = trpc.patients.create.useMutation({
    onSuccess: () => { toast.success("Patient enrolled."); onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.patients.update.useMutation({
    onSuccess: () => { toast.success("Patient updated."); onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e.message),
  });
  const pending = create.isPending || update.isPending;

  const submit = () => {
    if (!form.name || !form.phoneNumber || !form.clinicId || !form.providerId) {
      toast.error("Name, phone, clinic, and provider are required.");
      return;
    }
    const common = {
      name: form.name,
      phoneNumber: form.phoneNumber,
      clinicId: form.clinicId,
      providerId: form.providerId,
      insurance: form.insurance || undefined,
      preferredLanguage: form.preferredLanguage,
      priorityLevel: form.priorityLevel,
      riskLevel: form.priorityLevel,
      consentStatus: form.consentStatus,
      assignedStaffId: form.assignedStaffId || undefined,
      chronicConditions: form.conditions,
      dateOfBirth: form.dob ? new Date(form.dob) : undefined,
    };
    if (mode === "edit" && patient) {
      update.mutate({ id: patient.id, ...common, ccmEnrollmentStatus: form.ccmEnrollmentStatus });
    } else {
      create.mutate(common);
    }
  };

  const field = "w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === "edit" ? <><Save size={18} /> Edit Patient</> : <><UserPlus size={18} /> Enroll New Patient</>}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-slate-500">Full Name *</label><input className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className="text-xs font-medium text-slate-500">Phone *</label><input className={field} value={form.phoneNumber} onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-slate-500">Date of Birth</label><input type="date" className={field} value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} /></div>
            <div><label className="text-xs font-medium text-slate-500">Insurance</label><input className={field} value={form.insurance} onChange={(e) => setForm({ ...form, insurance: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">Clinic *</label>
              <select className={field} value={form.clinicId} onChange={(e) => setForm({ ...form, clinicId: Number(e.target.value) })}>
                <option value={0}>Select clinic</option>
                {(clinics.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Provider *</label>
              <select className={field} value={form.providerId} onChange={(e) => setForm({ ...form, providerId: Number(e.target.value) })}>
                <option value={0}>Select provider</option>
                {(providers.data || []).map((p) => <option key={p.provider.id} value={p.provider.id}>{p.provider.name}{p.clinicName ? ` — ${p.clinicName}` : ""}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">Priority</label>
              <select className={field} value={form.priorityLevel} onChange={(e) => setForm({ ...form, priorityLevel: e.target.value as "high" | "medium" | "low" })}>
                {RISK_OPTIONS.map((r) => <option key={r} value={r}>{PRIORITY_LABELS[r]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Consent</label>
              <select className={field} value={form.consentStatus} onChange={(e) => setForm({ ...form, consentStatus: e.target.value as "consented" | "pending" | "declined" })}>
                <option value="pending">Pending</option>
                <option value="consented">Consented</option>
                <option value="declined">Declined</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">Language</label>
              <input className={field} value={form.preferredLanguage} onChange={(e) => setForm({ ...form, preferredLanguage: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Assigned Staff</label>
              <select className={field} value={form.assignedStaffId} onChange={(e) => setForm({ ...form, assignedStaffId: Number(e.target.value) })}>
                <option value={0}>Unassigned</option>
                {(staff.data || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          {mode === "edit" && (
            <div>
              <label className="text-xs font-medium text-slate-500">Enrollment Status</label>
              <select className={field} value={form.ccmEnrollmentStatus} onChange={(e) => setForm({ ...form, ccmEnrollmentStatus: e.target.value as "active" | "inactive" | "declined" })}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="declined">Declined</option>
              </select>
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-slate-500">Chronic Conditions</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {CONDITIONS.map((c) => {
                const on = form.conditions.includes(c);
                return (
                  <button key={c} type="button"
                    onClick={() => setForm({ ...form, conditions: on ? form.conditions.filter((x) => x !== c) : [...form.conditions, c] })}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border ${on ? "bg-[hsl(200_100%_50%)] text-white border-transparent" : "border-slate-200 text-slate-600 hover:border-slate-300"}`}>
                    {c}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <button onClick={submit} disabled={pending} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-60">
            {pending ? <Loader2 size={16} className="animate-spin" /> : mode === "edit" ? <Save size={16} /> : <UserPlus size={16} />}
            {mode === "edit" ? "Save changes" : "Enroll"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

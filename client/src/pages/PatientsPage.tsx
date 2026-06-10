import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Search, Plus, Loader2, UserPlus, X } from "lucide-react";
import { PRIORITY_LABELS, priorityBadgeClass, statusBadgeClass } from "@/lib/ccm";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";

const CONDITIONS = [
  "Hypertension", "Type 2 Diabetes", "COPD", "CHF", "CKD", "Hyperlipidemia",
  "Atrial Fibrillation", "Asthma", "Osteoarthritis", "Depression", "Obesity", "GERD",
];

const RISK_OPTIONS = ["high", "medium", "low"] as const;

function EnrollDialog({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const clinics = trpc.clinics.list.useQuery(undefined, { enabled: open });
  const providers = trpc.providers.all.useQuery(undefined, { enabled: open });
  const staff = trpc.staff.all.useQuery(undefined, { enabled: open });

  const [form, setForm] = useState({
    name: "", phoneNumber: "", clinicId: 0, providerId: 0, insurance: "",
    preferredLanguage: "English", riskLevel: "medium" as "high" | "medium" | "low",
    consentStatus: "pending" as "consented" | "pending" | "declined",
    assignedStaffId: 0, conditions: [] as string[], dob: "",
  });

  const create = trpc.patients.create.useMutation({
    onSuccess: () => {
      toast.success("Patient enrolled.");
      setOpen(false);
      setForm({ ...form, name: "", phoneNumber: "", insurance: "", conditions: [], dob: "" });
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });

  const submit = () => {
    if (!form.name || !form.phoneNumber || !form.clinicId || !form.providerId) {
      toast.error("Name, phone, clinic, and provider are required.");
      return;
    }
    create.mutate({
      name: form.name,
      phoneNumber: form.phoneNumber,
      clinicId: form.clinicId,
      providerId: form.providerId,
      insurance: form.insurance || undefined,
      preferredLanguage: form.preferredLanguage,
      riskLevel: form.riskLevel,
      priorityLevel: form.riskLevel,
      consentStatus: form.consentStatus,
      assignedStaffId: form.assignedStaffId || undefined,
      chronicConditions: form.conditions,
      dateOfBirth: form.dob ? new Date(form.dob) : undefined,
    });
  };

  const field = "w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800">
          <Plus size={16} /> Enroll Patient
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><UserPlus size={18} /> Enroll New Patient</DialogTitle>
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
              <label className="text-xs font-medium text-slate-500">Risk Level</label>
              <select className={field} value={form.riskLevel} onChange={(e) => setForm({ ...form, riskLevel: e.target.value as any })}>
                {RISK_OPTIONS.map((r) => <option key={r} value={r}>{PRIORITY_LABELS[r]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Consent</label>
              <select className={field} value={form.consentStatus} onChange={(e) => setForm({ ...form, consentStatus: e.target.value as any })}>
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
          <button onClick={submit} disabled={create.isPending} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-60">
            {create.isPending ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />} Enroll
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function PatientsPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [riskFilter, setRiskFilter] = useState<string>("");
  const [clinicFilter, setClinicFilter] = useState<number>(0);

  const clinics = trpc.clinics.list.useQuery(undefined, { enabled: !!user });
  const filters = useMemo(() => ({
    search: search || undefined,
    riskLevel: (riskFilter || undefined) as any,
    clinicId: clinicFilter || undefined,
  }), [search, riskFilter, clinicFilter]);
  const patients = trpc.patients.list.useQuery(filters, { enabled: !!user });
  const utils = trpc.useUtils();

  const canEnroll = !!user && ["admin", "staff", "front_desk"].includes(user.role);

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-[hsl(240_10%_97%)]"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const field = "px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]";

  return (
    <CCMDashboardLayout title="Patient Database">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or phone…"
            className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select className={field} value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)}>
            <option value="">All Risk Levels</option>
            <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
          </select>
          <select className={field} value={clinicFilter} onChange={(e) => setClinicFilter(Number(e.target.value))}>
            <option value={0}>All Clinics</option>
            {(clinics.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {(search || riskFilter || clinicFilter) && (
            <button onClick={() => { setSearch(""); setRiskFilter(""); setClinicFilter(0); }} className="inline-flex items-center gap-1 px-3 py-2 rounded-xl text-sm text-slate-500 hover:bg-slate-100">
              <X size={14} /> Clear
            </button>
          )}
          {canEnroll && <EnrollDialog onDone={() => utils.patients.list.invalidate()} />}
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-slate-100 bg-slate-50/50">
                <th className="px-5 py-3 font-medium">Patient</th>
                <th className="px-5 py-3 font-medium">Conditions</th>
                <th className="px-5 py-3 font-medium">Provider</th>
                <th className="px-5 py-3 font-medium">Clinic</th>
                <th className="px-5 py-3 font-medium">Risk</th>
                <th className="px-5 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {patients.isLoading && (
                <tr><td colSpan={6} className="px-5 py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></td></tr>
              )}
              {!patients.isLoading && (patients.data || []).length === 0 && (
                <tr><td colSpan={6} className="px-5 py-12 text-center text-slate-400 font-light">No patients found.</td></tr>
              )}
              {(patients.data || []).map((r) => (
                <tr key={r.patient.id} onClick={() => setLocation(`/patients/${r.patient.id}`)}
                  className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60 cursor-pointer">
                  <td className="px-5 py-3">
                    <p className="font-semibold text-slate-800">{r.patient.name}</p>
                    <p className="text-xs text-slate-400">{r.patient.phoneNumber}</p>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1 max-w-[220px]">
                      {(r.patient.chronicConditions as string[] || []).slice(0, 3).map((c) => (
                        <span key={c} className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[11px]">{c}</span>
                      ))}
                      {(r.patient.chronicConditions as string[] || []).length > 3 && (
                        <span className="px-2 py-0.5 text-[11px] text-slate-400">+{(r.patient.chronicConditions as string[]).length - 3}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-slate-600">{r.providerName || "—"}</td>
                  <td className="px-5 py-3 text-slate-600">{r.clinicName || "—"}</td>
                  <td className="px-5 py-3"><span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${priorityBadgeClass(r.patient.riskLevel ?? "medium")}`}>{PRIORITY_LABELS[r.patient.riskLevel ?? "medium"] || r.patient.riskLevel}</span></td>
                  <td className="px-5 py-3"><span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${statusBadgeClass(r.patient.ccmEnrollmentStatus ?? "active")}`}>{r.patient.ccmEnrollmentStatus}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-sm font-light text-slate-400">{(patients.data || []).length} patients</p>
    </CCMDashboardLayout>
  );
}

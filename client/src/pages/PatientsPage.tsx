import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Search, Plus, Loader2, UserPlus, X, Upload, AlertTriangle, Activity, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { PRIORITY_LABELS, priorityBadgeClass, statusBadgeClass, RPM_STATUS_LABELS, fmtDate, toDateInput } from "@/lib/ccm";
import { cn } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type SortKey = "name" | "risk" | "provider" | "clinic" | "lastCalled" | "nextAppt" | "status";
type SortState = { key: SortKey; dir: "asc" | "desc" };

/** Clickable, sticky table header cell with a sort indicator. */
function SortTh({ label, k, sort, onSort, className }: {
  label: string; k: SortKey; sort: SortState; onSort: (k: SortKey) => void; className?: string;
}) {
  const active = sort.key === k;
  return (
    <th
      onClick={() => onSort(k)}
      className={cn("px-5 py-3 font-medium select-none cursor-pointer hover:text-slate-600 transition-colors bg-slate-50", className)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (sort.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ChevronsUpDown size={12} className="text-slate-300" />}
      </span>
    </th>
  );
}

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
    preferredLanguage: "English", priorityLevel: "medium" as "high" | "medium" | "low",
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
      priorityLevel: form.priorityLevel,
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
              <label className="text-xs font-medium text-slate-500">Priority</label>
              <select className={field} value={form.priorityLevel} onChange={(e) => setForm({ ...form, priorityLevel: e.target.value as any })}>
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
  const [clinicFilter, setClinicFilter] = useState<number>(0);
  const [riskFilter, setRiskFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [sort, setSort] = useState<SortState>({ key: "name", dir: "asc" });

  const onSort = (k: SortKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: "asc" }));

  const clinics = trpc.clinics.list.useQuery(undefined, { enabled: !!user });
  const filters = useMemo(() => ({
    search: search || undefined,
    clinicId: clinicFilter || undefined,
    riskLevel: (riskFilter || undefined) as "high" | "medium" | "low" | undefined,
    enrollmentStatus: statusFilter || undefined,
  }), [search, clinicFilter, riskFilter, statusFilter]);
  const patients = trpc.patients.list.useQuery(filters, { enabled: !!user });
  const hasFilters = !!(search || clinicFilter || riskFilter || statusFilter);

  const sortedPatients = useMemo(() => {
    const rows = [...(patients.data || [])];
    const dir = sort.dir === "asc" ? 1 : -1;
    const riskOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
    const time = (d: unknown) => (d ? new Date(d as string).getTime() : 0);
    rows.sort((a, b) => {
      let av: string | number = 0, bv: string | number = 0;
      switch (sort.key) {
        case "name": av = a.patient.name?.toLowerCase() ?? ""; bv = b.patient.name?.toLowerCase() ?? ""; break;
        case "risk": av = riskOrder[a.patient.riskLevel ?? ""] ?? 0; bv = riskOrder[b.patient.riskLevel ?? ""] ?? 0; break;
        case "provider": av = a.providerName ?? ""; bv = b.providerName ?? ""; break;
        case "clinic": av = a.clinicName ?? ""; bv = b.clinicName ?? ""; break;
        case "lastCalled": av = time(a.patient.lastCalledAt); bv = time(b.patient.lastCalledAt); break;
        case "nextAppt": av = time(a.patient.nextAppointment); bv = time(b.patient.nextAppointment); break;
        case "status": av = a.patient.ccmEnrollmentStatus ?? ""; bv = b.patient.ccmEnrollmentStatus ?? ""; break;
      }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
    return rows;
  }, [patients.data, sort]);
  const duplicates = trpc.patients.duplicates.useQuery(undefined, { enabled: !!user });
  const utils = trpc.useUtils();

  const canEnroll = !!user && ["admin", "staff", "front_desk"].includes(user.role);
  const canImport = !!user && ["admin", "front_desk"].includes(user.role);

  const updateRPM = trpc.patients.updateRPM.useMutation({
    onSuccess: () => { utils.patients.list.invalidate(); toast.success("RPM updated."); },
    onError: (e) => toast.error(e.message),
  });
  const updateDates = trpc.patients.updateDates.useMutation({
    onSuccess: () => { utils.patients.list.invalidate(); toast.success("Dates updated."); },
    onError: (e) => toast.error(e.message),
  });

  // Set of patient ids that share a name with another patient
  const dupIds = useMemo(() => {
    const s = new Set<number>();
    const groups = duplicates.data || {};
    for (const key of Object.keys(groups)) for (const id of groups[key].ids) s.add(id);
    return s;
  }, [duplicates.data]);

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
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
          <select className={field} value={clinicFilter} onChange={(e) => setClinicFilter(Number(e.target.value))}>
            <option value={0}>All Clinics</option>
            {(clinics.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className={field} value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)}>
            <option value="">All Risk</option>
            <option value="high">High risk</option>
            <option value="medium">Medium risk</option>
            <option value="low">Low risk</option>
          </select>
          <select className={field} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="declined">Declined</option>
          </select>
          {hasFilters && (
            <button onClick={() => { setSearch(""); setClinicFilter(0); setRiskFilter(""); setStatusFilter(""); }} className="inline-flex items-center gap-1 px-3 py-2 rounded-xl text-sm text-slate-500 hover:bg-slate-100">
              <X size={14} /> Clear
            </button>
          )}
          {canImport && (
            <button onClick={() => setLocation("/patients/import")} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 text-slate-700 text-sm font-semibold hover:bg-slate-50">
              <Upload size={16} /> Bulk Import
            </button>
          )}
          {canEnroll && <EnrollDialog onDone={() => utils.patients.list.invalidate()} />}
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 shadow-[0_1px_0_0_rgb(241_245_249)]">
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                <SortTh label="Patient" k="name" sort={sort} onSort={onSort} />
                <SortTh label="Risk" k="risk" sort={sort} onSort={onSort} />
                <th className="px-5 py-3 font-medium bg-slate-50">Conditions</th>
                <SortTh label="Provider" k="provider" sort={sort} onSort={onSort} />
                <SortTh label="Clinic" k="clinic" sort={sort} onSort={onSort} />
                <SortTh label="Last Called" k="lastCalled" sort={sort} onSort={onSort} />
                <SortTh label="Next Appt" k="nextAppt" sort={sort} onSort={onSort} />
                <SortTh label="Status" k="status" sort={sort} onSort={onSort} />
                <th className="px-5 py-3 font-medium bg-slate-50">RPM</th>
              </tr>
            </thead>
            <tbody>
              {patients.isLoading && Array.from({ length: 6 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-slate-50 last:border-0">
                  <td colSpan={9} className="px-5 py-3.5"><div className="h-8 rounded-lg bg-slate-100 animate-pulse" /></td>
                </tr>
              ))}
              {!patients.isLoading && sortedPatients.length === 0 && (
                <tr><td colSpan={9} className="px-5 py-16 text-center">
                  <Search className="mx-auto text-slate-300 mb-2" size={28} />
                  <p className="text-slate-500 font-medium">No patients found</p>
                  <p className="text-sm font-light text-slate-400 mt-0.5">{hasFilters ? "Try adjusting your filters." : "Enroll a patient to get started."}</p>
                </td></tr>
              )}
              {!patients.isLoading && sortedPatients.map((r) => (
                <tr key={r.patient.id} onClick={() => setLocation(`/patients/${r.patient.id}`)}
                  className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60 cursor-pointer">
                  <td className="px-5 py-3">
                    <p className="font-semibold text-slate-800 flex items-center gap-1.5">
                      {r.patient.name}
                      {dupIds.has(r.patient.id) && (
                        <span title="Possible duplicate: another patient shares this name" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-semibold">
                          <AlertTriangle size={10} /> Duplicate
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-slate-400">{r.patient.phoneNumber}</p>
                  </td>
                  <td className="px-5 py-3">
                    {r.patient.riskLevel ? (
                      <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${priorityBadgeClass(r.patient.riskLevel)}`}>{PRIORITY_LABELS[r.patient.riskLevel] ?? r.patient.riskLevel}</span>
                    ) : <span className="text-slate-300">—</span>}
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
                  <td className="px-5 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    {canEnroll ? (
                      <input type="date" defaultValue={toDateInput(r.patient.lastCalledAt)}
                        className="px-2 py-1 rounded-lg border border-slate-200 text-xs bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]"
                        onChange={(e) => updateDates.mutate({ id: r.patient.id, lastCalledAt: e.target.value ? new Date(e.target.value + "T00:00:00") : null })} />
                    ) : <span className="text-slate-600 text-sm">{fmtDate(r.patient.lastCalledAt)}</span>}
                  </td>
                  <td className="px-5 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    {canEnroll ? (
                      <input type="date" defaultValue={toDateInput(r.patient.nextAppointment)}
                        className="px-2 py-1 rounded-lg border border-slate-200 text-xs bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)]"
                        onChange={(e) => updateDates.mutate({ id: r.patient.id, nextAppointment: e.target.value ? new Date(e.target.value + "T00:00:00") : null })} />
                    ) : <span className="text-slate-600 text-sm">{fmtDate(r.patient.nextAppointment)}</span>}
                  </td>
                  <td className="px-5 py-3"><span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${statusBadgeClass(r.patient.ccmEnrollmentStatus ?? "active")}`}>{r.patient.ccmEnrollmentStatus}</span></td>
                  <td className="px-5 py-3" onClick={(e) => e.stopPropagation()}>
                    {canEnroll ? (
                      <Popover>
                        <PopoverTrigger asChild>
                          <button className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${r.patient.rpmEnrolled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"} hover:brightness-95`}>
                            <Activity size={11} /> {r.patient.rpmEnrolled ? (RPM_STATUS_LABELS[r.patient.rpmStatus ?? "enrolled"] || "Enrolled") : "Not Enrolled"}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-60 space-y-2" align="end">
                          <p className="text-xs font-semibold text-slate-700">RPM Enrollment</p>
                          <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" className="accent-emerald-600" checked={!!r.patient.rpmEnrolled}
                              onChange={(e) => updateRPM.mutate({ id: r.patient.id, rpmEnrolled: e.target.checked, rpmStatus: e.target.checked ? "enrolled" : "not_enrolled" })} />
                            Enrolled in RPM
                          </label>
                          <div>
                            <label className="text-[11px] text-slate-500">Status</label>
                            <select className="w-full px-2 py-1.5 rounded-lg border border-slate-200 text-sm" value={r.patient.rpmStatus ?? "not_enrolled"}
                              onChange={(e) => updateRPM.mutate({ id: r.patient.id, rpmStatus: e.target.value as any, rpmEnrolled: !(["not_enrolled", "declined"].includes(e.target.value)) })}>
                              {Object.keys(RPM_STATUS_LABELS).map((s) => <option key={s} value={s}>{RPM_STATUS_LABELS[s]}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="text-[11px] text-slate-500">Device Type</label>
                            <input className="w-full px-2 py-1.5 rounded-lg border border-slate-200 text-sm" defaultValue={r.patient.rpmDeviceType ?? ""}
                              placeholder="e.g. BP cuff, glucometer"
                              onBlur={(e) => { if (e.target.value !== (r.patient.rpmDeviceType ?? "")) updateRPM.mutate({ id: r.patient.id, rpmDeviceType: e.target.value || null }); }} />
                          </div>
                        </PopoverContent>
                      </Popover>
                    ) : (
                      <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${r.patient.rpmEnrolled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`}>{r.patient.rpmEnrolled ? (RPM_STATUS_LABELS[r.patient.rpmStatus ?? "enrolled"] || "Enrolled") : "Not Enrolled"}</span>
                    )}
                  </td>
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

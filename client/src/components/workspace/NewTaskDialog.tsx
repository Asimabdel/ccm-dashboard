import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { localDateStr } from "@shared/workforce";
import { TASK_CATEGORIES, TASK_CATEGORY_LABELS, TASK_PRIORITIES, TASK_PRIORITY_LABELS, WORKSPACE_ROLE_LABELS } from "@shared/workspace";
import { Btn, inputCls } from "./ui";
import { useWorkspace } from "./useWorkspace";

export interface NewTaskDefaults {
  patientId?: number;
  patientName?: string;
  clinicId?: number | null;
  title?: string;
  category?: string;
}

export function NewTaskDialog({ open, onOpenChange, defaults }: { open: boolean; onOpenChange: (o: boolean) => void; defaults?: NewTaskDefaults }) {
  const { caps, clinics, clinicId: selectedClinic, user } = useWorkspace();
  const utils = trpc.useUtils();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("other");
  const [priority, setPriority] = useState("normal");
  const [dueDate, setDueDate] = useState(localDateStr());
  const [assign, setAssign] = useState("me");
  const [clinicId, setClinicId] = useState<string>("");
  const [patient, setPatient] = useState<{ id: number; name: string } | null>(null);
  const [patientSearch, setPatientSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle(defaults?.title ?? "");
    setDescription("");
    setCategory(defaults?.category ?? "other");
    setPriority("normal");
    setDueDate(localDateStr());
    setAssign("me");
    setClinicId(String(defaults?.clinicId ?? selectedClinic ?? ""));
    setPatient(defaults?.patientId ? { id: defaults.patientId, name: defaults.patientName ?? "Patient" } : null);
    setPatientSearch("");
    // Callers pass `defaults` inline; reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(patientSearch.trim()), 250);
    return () => clearTimeout(t);
  }, [patientSearch]);

  // Roster search is for full-record roles; MAs attach patients from Patient Flow instead.
  const canSearchPatients = !!caps?.patientFull;
  const results = trpc.patients.list.useQuery({ search: debounced }, { enabled: open && canSearchPatients && !patient && debounced.length >= 2 });
  const assignees = trpc.workspace.tasks.assignees.useQuery(undefined, { enabled: open && !!caps?.assignTasks, staleTime: 5 * 60_000 });

  const create = trpc.workspace.tasks.create.useMutation({
    onSuccess: () => {
      toast.success("Task created.");
      void utils.workspace.tasks.invalidate();
      void utils.workspace.home.invalidate();
      void utils.workspace.patients.summary.invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return toast.error("Give the task a title.");
    create.mutate({
      title: title.trim(),
      description: description.trim() || null,
      patientId: patient?.id ?? null,
      clinicId: clinicId ? Number(clinicId) : null,
      assignedUserId: assign === "me" ? user?.id ?? null : assign.startsWith("u") ? Number(assign.slice(1)) : null,
      assignedRole: assign.startsWith("r") ? (assign.slice(1) as "staff") : null,
      priority,
      category,
      dueDate: dueDate || null,
    });
  };

  const label = "block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>Operational work only — clinical documentation stays in Practice Fusion.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className={label} htmlFor="nt-title">Title</label>
            <input id="nt-title" className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} autoFocus placeholder="e.g. Call to reschedule missed visit" />
          </div>

          <div>
            <label className={label}>Patient (optional)</label>
            {patient ? (
              <div className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-slate-600 px-3 py-2 text-sm">
                <span className="font-medium">{patient.name}</span>
                {!defaults?.patientId && <button type="button" onClick={() => setPatient(null)} aria-label="Remove patient"><X size={15} className="text-slate-400" /></button>}
              </div>
            ) : canSearchPatients ? (
              <div className="relative">
                <input className={inputCls} value={patientSearch} onChange={(e) => setPatientSearch(e.target.value)} placeholder="Search by name or phone" />
                {debounced.length >= 2 && (
                  <div className="absolute z-10 mt-1 w-full rounded-xl border border-slate-200 dark:border-slate-600 bg-white shadow-lg max-h-56 overflow-y-auto">
                    {results.isFetching && <p className="px-3 py-2 text-xs text-slate-400">Searching…</p>}
                    {!results.isFetching && (results.data ?? []).length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No matches</p>}
                    {(results.data ?? []).slice(0, 8).map((r) => (
                      <button type="button" key={r.patient.id} onClick={() => { setPatient({ id: r.patient.id, name: r.patient.name }); if (!clinicId && r.patient.clinicId) setClinicId(String(r.patient.clinicId)); }} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700">
                        {r.patient.name} <span className="text-xs text-slate-400">{r.clinicName ?? ""}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-500">Open a patient from Patient Flow to attach them to a task.</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Category</label>
              <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
                {TASK_CATEGORIES.map((c) => <option key={c} value={c}>{TASK_CATEGORY_LABELS[c]}</option>)}
              </select>
            </div>
            <div>
              <label className={label}>Priority</label>
              <select className={inputCls} value={priority} onChange={(e) => setPriority(e.target.value)}>
                {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{TASK_PRIORITY_LABELS[p]}</option>)}
              </select>
            </div>
            <div>
              <label className={label}>Due date</label>
              <input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div>
              <label className={label}>Clinic</label>
              <select className={inputCls} value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
                <option value="">No specific clinic</option>
                {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={label}>Assign to</label>
            {caps?.assignTasks ? (
              <select className={inputCls} value={assign} onChange={(e) => setAssign(e.target.value)}>
                <option value="me">Me</option>
                <optgroup label="Team queue">
                  {["staff", "front_desk", "medical_assistant", "provider", "billing"].map((r) => <option key={r} value={`r${r}`}>{WORKSPACE_ROLE_LABELS[r]} queue</option>)}
                </optgroup>
                <optgroup label="People">
                  {(assignees.data ?? []).filter((u) => u.id !== user?.id).map((u) => <option key={u.id} value={`u${u.id}`}>{u.name}</option>)}
                </optgroup>
              </select>
            ) : (
              <p className="text-sm text-slate-600 dark:text-slate-300">You</p>
            )}
          </div>

          <div>
            <label className={label}>Details (optional)</label>
            <textarea className={`${inputCls} min-h-[80px]`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Btn type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Btn>
            <Btn type="submit" disabled={create.isPending}>{create.isPending && <Loader2 size={15} className="animate-spin" />} Create task</Btn>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

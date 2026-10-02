import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, HeartPulse, Loader2, User, Users, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { WORKSPACE_ROLE_LABELS } from "@shared/workspace";
import { Btn, inputCls } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { cn } from "@/lib/utils";
import { PatientSearchBox, type PickedPatient } from "./PatientSearchBox";

export type NewConversationMode = "dm" | "group" | "patient";

const MODES: { key: NewConversationMode; label: string; icon: React.ElementType }[] = [
  { key: "dm", label: "Direct message", icon: User },
  { key: "group", label: "Group", icon: Users },
  { key: "patient", label: "About a patient", icon: HeartPulse },
];

/**
 * Start a conversation: a direct message with one person, a named group, or a conversation about a
 * patient with the people working on it. Opening a direct message that already exists reopens it.
 */
export function NewConversationDialog({ open, onOpenChange, mode: startMode = "dm", patient: fixedPatient, onOpened }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode?: NewConversationMode;
  /** Started from a patient's page: the patient is set. */
  patient?: PickedPatient;
  onOpened: (conversationId: number) => void;
}) {
  const { caps, user, clinics } = useWorkspace();
  const [mode, setMode] = useState<NewConversationMode>(startMode);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [title, setTitle] = useState("");
  const [patient, setPatient] = useState<PickedPatient | null>(fixedPatient ?? null);

  useEffect(() => {
    if (!open) return;
    setMode(startMode);
    setQ("");
    setPicked([]);
    setTitle("");
    setPatient(fixedPatient ?? null);
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const people = trpc.workspace.chat.people.useQuery(undefined, { enabled: open, staleTime: 60_000 });
  const clinicName = useMemo(() => new Map(clinics.map((c) => [c.id, c.name])), [clinics]);
  const list = (people.data ?? []).filter((p) => p.id !== user?.id && (!q.trim() || (p.name ?? "").toLowerCase().includes(q.trim().toLowerCase())));

  const done = (r: { id: number }) => { onOpenChange(false); onOpened(r.id); };
  const direct = trpc.workspace.chat.direct.useMutation({ onSuccess: done, onError: (e) => toast.error(e.message) });
  const group = trpc.workspace.chat.createGroup.useMutation({ onSuccess: done, onError: (e) => toast.error(e.message) });
  const busy = direct.isPending || group.isPending;

  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const canPatient = !!caps?.flowView;
  const modes = MODES.filter((m) => m.key !== "patient" || canPatient).filter((m) => !fixedPatient || m.key === "patient");

  const submit = () => {
    if (mode === "group") {
      if (!title.trim()) return toast.error("Give the group a name.");
      if (!picked.length) return toast.error("Pick at least one person.");
      group.mutate({ title: title.trim(), memberIds: picked });
    } else if (mode === "patient") {
      if (!patient) return toast.error("Pick the patient.");
      if (!picked.length) return toast.error("Pick at least one person.");
      group.mutate({ memberIds: picked, subjectKey: patient.key, title: title.trim() || null });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
          <DialogDescription>Only the people in a conversation can read it.</DialogDescription>
        </DialogHeader>

        {modes.length > 1 && (
          <div className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-900" role="tablist">
            {modes.map((m) => (
              <button key={m.key} role="tab" aria-selected={mode === m.key} onClick={() => { setMode(m.key); setPicked([]); }}
                className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold", mode === m.key ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-50" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200")}>
                <m.icon size={14} /> {m.label}
              </button>
            ))}
          </div>
        )}

        <div className="space-y-3">
          {mode === "patient" && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">Patient</label>
              {patient ? (
                <div className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-600">
                  <span className="font-medium">{patient.name}</span>
                  {!fixedPatient && <button type="button" onClick={() => setPatient(null)} aria-label="Remove patient"><X size={15} className="text-slate-400" /></button>}
                </div>
              ) : <PatientSearchBox onPick={setPatient} autoFocus />}
            </div>
          )}
          {mode !== "dm" && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300" htmlFor="nc-title">{mode === "patient" ? "Name (optional)" : "Group name"}</label>
              <input id="nc-title" className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160}
                placeholder={mode === "patient" ? `About ${patient?.name ?? "the patient"}` : "e.g. Katy front desk"} />
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">{mode === "dm" ? "Who?" : `People${picked.length ? ` (${picked.length})` : ""}`}</label>
            <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names" aria-label="Search names" autoFocus={mode === "dm"} />
            <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700">
              {people.isLoading && <p className="px-3 py-3 text-xs text-slate-400">Loading…</p>}
              {!people.isLoading && list.length === 0 && <p className="px-3 py-3 text-xs text-slate-400">Nobody matches.</p>}
              {list.map((p) => {
                const on = picked.includes(p.id);
                return (
                  <button key={p.id} type="button" disabled={busy}
                    onClick={() => (mode === "dm" ? direct.mutate({ userId: p.id }) : toggle(p.id))}
                    className={cn("flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2 text-left text-sm last:border-0 hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-700/50", on && "bg-brand-soft/60 dark:bg-brand/10")}>
                    {mode !== "dm" && (
                      <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", on ? "border-brand bg-brand text-white" : "border-slate-300 dark:border-slate-500")}>{on && <Check size={11} />}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-800 dark:text-slate-100">{p.name}</span>
                    <span className="shrink-0 text-xs text-slate-400">{[WORKSPACE_ROLE_LABELS[p.role] ?? p.role, p.clinicId ? clinicName.get(p.clinicId) : null].filter(Boolean).join(" · ")}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {mode !== "dm" && (
          <div className="flex justify-end gap-2 pt-1">
            <Btn type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Btn>
            <Btn type="button" disabled={busy} onClick={submit}>{busy && <Loader2 size={15} className="animate-spin" />} Start conversation</Btn>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

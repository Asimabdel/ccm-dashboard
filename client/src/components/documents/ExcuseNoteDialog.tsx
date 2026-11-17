import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, inputCls } from "@/components/workspace/ui";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export type DocSubject = Pick<RouterOutputs["workspace"]["documents"]["searchPatients"][number], "key" | "name" | "dob">;

/** Pick a patient by name (optional), or change the one picked. */
export function PatientPick({ open, picked, onPick, autoFocus = true, locked = false }: { open: boolean; picked: DocSubject | null; onPick: (s: DocSubject | null) => void; autoFocus?: boolean; locked?: boolean }) {
  const [q, setQ] = useState("");
  useEffect(() => { if (open) setQ(""); }, [open]);
  const search = trpc.workspace.documents.searchPatients.useQuery({ q: q.trim() }, { enabled: open && q.trim().length >= 2 && !picked });
  if (picked) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
        <span><b>{picked.name}</b>{picked.dob ? <span className="text-xs text-slate-500"> · DOB {picked.dob}</span> : null}</span>
        {!locked && <button type="button" className="text-xs font-semibold text-brand hover:underline" onClick={() => onPick(null)}>Change</button>}
      </div>
    );
  }
  return (
    <>
      <input className={inputCls} placeholder="Search patients by name (optional)" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} />
      <ul className="max-h-56 space-y-1 overflow-y-auto">
        {(search.data ?? []).map((s) => (
          <li key={s.key}>
            <button type="button" onClick={() => onPick(s)} className="w-full rounded-md px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
              <b>{s.name}</b> <span className="text-xs text-slate-500">{s.dob ? `DOB ${s.dob}` : ""}{s.clinicName ? ` · ${s.clinicName}` : ""}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * A work / school excuse note: pick the provider (their letterhead) and the patient, and it opens ready to fill in.
 * From a patient's page the patient comes already picked, and so does their own provider when they have one.
 */
export function ExcuseNoteDialog({ open, onClose, onCreated, subject = null, providerId: preferredProvider = null }: {
  open: boolean; onClose: () => void; onCreated: (id: number) => void; subject?: DocSubject | null; providerId?: number | null;
}) {
  const { user } = useAuth();
  const providers = trpc.workspace.documents.letterProviders.useQuery(undefined, { enabled: open });
  const [providerId, setProviderId] = useState("");
  const [picked, setPicked] = useState<DocSubject | null>(null);
  useEffect(() => {
    if (!open) return;
    setPicked(subject);
    const list = providers.data ?? [];
    // A provider making their own note starts with themselves (their full name begins the printed one);
    // otherwise the patient's own provider.
    const me = (user?.name ?? "").replace(/^\s*dr\.?\s+/i, "").trim().toLowerCase();
    const mine = me.includes(" ") ? list.find((p) => p.name.toLowerCase().replace(/^\s*dr\.?\s+/i, "").startsWith(me)) : undefined;
    const theirs = preferredProvider ? list.find((p) => p.id === preferredProvider) : undefined;
    setProviderId(mine ? String(mine.id) : theirs ? String(theirs.id) : "");
  }, [open, providers.data, user?.name, subject, preferredProvider]);
  const make = trpc.workspace.documents.excuseNote.useMutation({
    onSuccess: (r) => { onClose(); if (r.coSigner) toast.success("Fill it in, then send it to the provider to sign."); onCreated(r.id); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New excuse note</DialogTitle>
          <DialogDescription>A work or school note on the provider's letterhead. The patient's name, date of birth and today's date fill in; you add the dates and restrictions, and the provider signs.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <label className="block text-xs font-semibold text-slate-500">Provider
            <select className={cn(inputCls, "mt-1")} value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">{providers.isLoading ? "Loading…" : "Pick the provider…"}</option>
              {(providers.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === preferredProvider ? " · their provider" : ""}</option>)}
            </select>
          </label>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-500">Patient</p>
            <PatientPick open={open} picked={picked} onPick={setPicked} autoFocus={false} locked={!!subject} />
          </div>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
            <Btn disabled={!providerId || make.isPending} onClick={() => make.mutate({ providerId: Number(providerId), subjectKey: picked?.key ?? null })}>
              {make.isPending && <Loader2 size={14} className="animate-spin" />} Make the note
            </Btn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
